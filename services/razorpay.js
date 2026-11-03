import crypto from 'crypto';
import BillingSetting from '../models/BillingSetting.js';
import { decryptSecret } from '../utils/secretBox.js';

// Razorpay, over its REST API with Node's own fetch — no SDK to install.
//
// Credentials come from the Super Admin panel (Plans & Billing → Trial &
// Settings), stored encrypted on BillingSetting.razorpay. If none are saved
// there, RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET in .env are used.
//
// No webhook is required. A payment is confirmed by the browser callback
// (/api/subscription/verify), and any order still unconfirmed — the customer
// closed the tab — is checked against Razorpay by the scheduler
// (reconcilePendingPayments in services/subscriptions.js). The webhook route
// stays in place, dormant, and works only if RAZORPAY_WEBHOOK_SECRET is set.
//
// Every payment is confirmed by checking Razorpay's signature on the server.
// Nothing the browser says about a payment is trusted on its own.

const API = 'https://api.razorpay.com/v1';

// Read on every payment call, but not from the database every time: a short
// cache, cleared the moment the Super Admin saves new keys.
let cached = null;
const CACHE_MS = 30 * 1000;

export const invalidateRazorpayConfig = () => {
  cached = null;
};

export const getRazorpayConfig = async () => {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;
  const stored = (await BillingSetting.findOne({ singleton: 'billing' }).select('razorpay').lean())?.razorpay || {};
  const fromPanel = Boolean(stored.keyId && stored.keySecretEnc);
  const value = {
    keyId: fromPanel ? stored.keyId : process.env.RAZORPAY_KEY_ID || '',
    keySecret: fromPanel ? decryptSecret(stored.keySecretEnc) : process.env.RAZORPAY_KEY_SECRET || '',
    webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET || '',
    source: fromPanel ? 'panel' : process.env.RAZORPAY_KEY_ID ? 'env' : 'none'
  };
  value.configured = Boolean(value.keyId && value.keySecret);
  value.mode = value.keyId.startsWith('rzp_live_') ? 'live' : value.keyId.startsWith('rzp_test_') ? 'test' : null;
  cached = { at: Date.now(), value };
  return value;
};

const call = async (method, path, body, config = null) => {
  const cfg = config || (await getRazorpayConfig());
  if (!cfg.keyId || !cfg.keySecret) throw new Error('Razorpay is not set up');
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Basic ${Buffer.from(`${cfg.keyId}:${cfg.keySecret}`).toString('base64')}`,
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(data?.error?.description || `Razorpay returned HTTP ${res.status}`);
    error.status = res.status;
    throw error;
  }
  return data;
};

// https://razorpay.com/docs/api/orders/create/
export const createOrder = ({ amountPaise, receipt, notes = {} }) =>
  call('POST', '/orders', { amount: amountPaise, currency: 'INR', receipt, notes, payment_capture: 1 });

export const fetchPayment = (paymentId) => call('GET', `/payments/${encodeURIComponent(paymentId)}`);

// Every payment attempt made against an order — how an unconfirmed checkout
// is found to have been paid after all.
export const fetchOrderPayments = (orderId) => call('GET', `/orders/${encodeURIComponent(orderId)}/payments`);

// "Test connection" in the panel: a harmless authenticated read. Proves the
// key id and secret belong together without creating anything.
export const testCredentials = async (keyId, keySecret) => {
  await call('GET', '/orders?count=1', null, { keyId, keySecret });
  return true;
};

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

// Checkout's success handler hands back order id, payment id and a signature:
// HMAC-SHA256 of "order_id|payment_id" with the key secret.
export const verifyCheckoutSignature = async ({ orderId, paymentId, signature }) => {
  const { keySecret } = await getRazorpayConfig();
  if (!orderId || !paymentId || !signature || !keySecret) return false;
  const expected = crypto.createHmac('sha256', keySecret).update(`${orderId}|${paymentId}`).digest('hex');
  return safeEqual(expected, signature);
};

// Webhooks are signed over the raw request body with the webhook secret
// (header X-Razorpay-Signature).
export const verifyWebhookSignature = async (rawBody, signature) => {
  const { webhookSecret } = await getRazorpayConfig();
  if (!rawBody || !signature || !webhookSecret) return false;
  const expected = crypto.createHmac('sha256', webhookSecret).update(rawBody).digest('hex');
  return safeEqual(expected, signature);
};
