import crypto from 'crypto';

// Razorpay, over its REST API with Node's own fetch — no SDK to install.
//
// Configuration (backend .env):
//   RAZORPAY_KEY_ID          rzp_test_… or rzp_live_…  (also sent to the browser)
//   RAZORPAY_KEY_SECRET      never leaves the server
//   RAZORPAY_WEBHOOK_SECRET  the secret set on the webhook in the Razorpay
//                            dashboard (Settings → Webhooks)
//
// Every payment is confirmed by checking Razorpay's signature on the server.
// Nothing the browser says about a payment is trusted on its own.

const API = 'https://api.razorpay.com/v1';

export const razorpayConfigured = () => Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
export const razorpayKeyId = () => process.env.RAZORPAY_KEY_ID || '';

const authHeader = () =>
  `Basic ${Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString('base64')}`;

const call = async (method, path, body) => {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: authHeader(), 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = data?.error?.description || `Razorpay returned HTTP ${res.status}`;
    const error = new Error(message);
    error.status = res.status;
    throw error;
  }
  return data;
};

// https://razorpay.com/docs/api/orders/create/
export const createOrder = ({ amountPaise, receipt, notes = {} }) =>
  call('POST', '/orders', { amount: amountPaise, currency: 'INR', receipt, notes, payment_capture: 1 });

export const fetchPayment = (paymentId) => call('GET', `/payments/${encodeURIComponent(paymentId)}`);

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

// Checkout's success handler hands back order id, payment id and a signature:
// HMAC-SHA256 of "order_id|payment_id" with the key secret.
export const verifyCheckoutSignature = ({ orderId, paymentId, signature }) => {
  if (!orderId || !paymentId || !signature || !process.env.RAZORPAY_KEY_SECRET) return false;
  const expected = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(`${orderId}|${paymentId}`).digest('hex');
  return safeEqual(expected, signature);
};

// Webhooks are signed over the raw request body with the webhook secret
// (header X-Razorpay-Signature).
export const verifyWebhookSignature = (rawBody, signature) => {
  if (!rawBody || !signature || !process.env.RAZORPAY_WEBHOOK_SECRET) return false;
  const expected = crypto.createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET).update(rawBody).digest('hex');
  return safeEqual(expected, signature);
};
