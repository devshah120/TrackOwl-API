import express from 'express';
import mongoose from 'mongoose';
import crypto from 'crypto';
import Plan from '../models/Plan.js';
import SubscriptionPayment from '../models/SubscriptionPayment.js';
import User from '../models/User.js';
import { protect, requireCompanyAdmin } from '../middleware/auth.js';
import { recordAudit } from '../utils/audit.js';
import {
  ensurePlans,
  getBillingSettings,
  getSubscription,
  describe,
  usageFor,
  priceFor,
  applyPayment
} from '../services/subscriptions.js';
import {
  razorpayConfigured,
  razorpayKeyId,
  createOrder,
  fetchPayment,
  verifyCheckoutSignature,
  verifyWebhookSignature
} from '../services/razorpay.js';

// The customer's side of billing: the public plan list for the pricing page,
// the account's current plan, Razorpay checkout and its confirmation, and the
// Razorpay webhook. Mounted at /api/subscription; the public plan list also
// at /api/plans (see server.js).
//
// Paying is the account owner's job (Company Admin). Any seat may see the
// status, so a staff member can tell why the app is locked.

export const publicPlansRouter = express.Router();
const router = express.Router();

const isId = (v) => mongoose.Types.ObjectId.isValid(v);

const planForPublic = (p) => ({
  id: String(p._id),
  key: p.key,
  name: p.name,
  description: p.description,
  monthlyPrice: p.monthlyPrice,
  yearlyPrice: p.yearlyPrice,
  features: p.features,
  maxVehicles: p.maxVehicles,
  maxUsers: p.maxUsers,
  highlight: p.highlight
});

// GET /api/plans — what the pricing page shows. No auth: it is the public site.
publicPlansRouter.get('/', async (req, res) => {
  try {
    await ensurePlans();
    const [plans, settings] = await Promise.all([Plan.find({ active: true }).sort({ sortOrder: 1, monthlyPrice: 1 }).lean(), getBillingSettings()]);
    res.json({ success: true, plans: plans.map(planForPublic), trialDays: settings.trialDays });
  } catch (error) {
    console.error('[plans] public list failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to load plans' });
  }
});

// GET /api/subscription — the account's plan, status, usage, and payments.
router.get('/', protect, async (req, res) => {
  try {
    await ensurePlans();
    const [sub, settings, usage, plans, payments] = await Promise.all([
      getSubscription(req.accountId),
      getBillingSettings(),
      usageFor(req.accountId),
      Plan.find({ active: true }).sort({ sortOrder: 1, monthlyPrice: 1 }).lean(),
      SubscriptionPayment.find({ owner: req.accountId, status: 'paid' }).sort({ paidAt: -1 }).limit(24).lean()
    ]);
    res.json({
      success: true,
      subscription: describe(sub, settings),
      usage,
      plans: plans.map(planForPublic),
      payments: payments.map((p) => ({
        id: String(p._id),
        planName: p.planName,
        cycle: p.cycle,
        amount: p.amountPaise / 100,
        paidAt: p.paidAt,
        periodStart: p.periodStart,
        periodEnd: p.periodEnd,
        method: p.method,
        receipt: p.receipt,
        razorpayPaymentId: p.razorpayPaymentId
      })),
      history: (sub.history || []).slice(-20).reverse(),
      canPay: req.user.role === 'company_admin',
      razorpayReady: razorpayConfigured()
    });
  } catch (error) {
    console.error('[subscription] read failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to load your plan' });
  }
});

// POST /api/subscription/checkout { plan, cycle } — create a Razorpay order
// for one period of the chosen plan. The amount comes from the plan on the
// server; the browser never states a price.
router.post('/checkout', protect, requireCompanyAdmin, async (req, res) => {
  try {
    if (!razorpayConfigured()) {
      return res.status(503).json({ success: false, error: 'Online payment is not set up yet. Please contact support.' });
    }
    const cycle = req.body?.cycle === 'yearly' ? 'yearly' : 'monthly';
    const planRef = req.body?.plan;
    const plan = await Plan.findOne(isId(planRef) ? { _id: planRef, active: true } : { key: String(planRef || '').toLowerCase(), active: true }).lean();
    if (!plan) return res.status(404).json({ success: false, error: 'That plan is not available' });

    const amount = priceFor(plan, cycle);
    const amountPaise = Math.round(amount * 100);
    if (amountPaise < 100) return res.status(400).json({ success: false, error: 'This plan has no price set' });

    // A plan with a vehicle limit the account already exceeds would be
    // blocked the moment it was bought. Say so before taking the money.
    if (plan.maxVehicles) {
      const usage = await usageFor(req.accountId);
      if (usage.vehicles > plan.maxVehicles) {
        return res.status(409).json({
          success: false,
          error: `You have ${usage.vehicles} vehicles; ${plan.name} allows ${plan.maxVehicles}. Choose a larger plan or remove vehicles first.`
        });
      }
    }

    const receipt = `TO-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    const order = await createOrder({
      amountPaise,
      receipt,
      notes: { account: String(req.accountId), plan: plan.key, cycle }
    });

    await SubscriptionPayment.create({
      owner: req.accountId,
      plan: plan._id,
      planName: plan.name,
      cycle,
      amountPaise,
      receipt,
      razorpayOrderId: order.id,
      createdBy: req.user._id
    });

    const owner = await User.findById(req.accountId).select('name email mobile company').lean();
    res.json({
      success: true,
      keyId: razorpayKeyId(),
      orderId: order.id,
      amount: amountPaise,
      currency: 'INR',
      name: 'TrackOwl',
      description: `${plan.name} plan — ${cycle === 'yearly' ? '1 year' : '1 month'}`,
      prefill: { name: owner?.name || '', email: owner?.email || '', contact: owner?.mobile || '' },
      notes: { company: owner?.company || '' }
    });
  } catch (error) {
    console.error('[subscription] checkout failed:', error.message);
    res.status(502).json({ success: false, error: `Could not start the payment: ${error.message}` });
  }
});

// POST /api/subscription/verify — Checkout's success handler posts the three
// values here. Only a valid signature activates anything.
router.post('/verify', protect, async (req, res) => {
  try {
    const { razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature } = req.body || {};
    const payment = await SubscriptionPayment.findOne({ razorpayOrderId: orderId, owner: req.accountId });
    if (!payment) return res.status(404).json({ success: false, error: 'Payment not found' });

    if (!verifyCheckoutSignature({ orderId, paymentId, signature })) {
      await SubscriptionPayment.updateOne({ _id: payment._id, status: 'created' }, { $set: { status: 'failed', failureReason: 'Signature mismatch' } });
      return res.status(400).json({ success: false, error: 'The payment could not be verified. If money was deducted it will be refunded by Razorpay.' });
    }

    // The method (UPI, card…) for the receipt. Not needed to activate, so a
    // lookup failure does not hold anything up.
    let method = '';
    try {
      method = (await fetchPayment(paymentId))?.method || '';
    } catch {
      method = '';
    }

    const result = await applyPayment(orderId, { paymentId, signature, method });
    if (!result.alreadyApplied) {
      await recordAudit(req, {
        entity: 'company',
        entityId: req.accountId,
        action: 'update',
        label: payment.planName,
        summary: `Plan ${payment.planName} (${payment.cycle}) paid — ₹${payment.amountPaise / 100}, Razorpay ${paymentId}`,
        changes: [{ field: 'subscription', label: 'Plan', from: null, to: `${payment.planName} (${payment.cycle})` }]
      });
    }
    const settings = await getBillingSettings();
    const sub = await getSubscription(req.accountId);
    res.json({ success: true, subscription: describe(sub, settings) });
  } catch (error) {
    console.error('[subscription] verify failed:', error.message);
    res.status(500).json({ success: false, error: 'Payment received but activation failed — it will complete automatically, or contact support with your payment id.' });
  }
});

// POST /api/subscription/failed — Checkout reported a failure; record why.
router.post('/failed', protect, async (req, res) => {
  const { orderId, reason } = req.body || {};
  await SubscriptionPayment.updateOne(
    { razorpayOrderId: orderId, owner: req.accountId, status: 'created' },
    { $set: { failureReason: String(reason || '').slice(0, 300) } }
  ).catch(() => {});
  res.json({ success: true });
});

// POST /api/subscription/webhook — Razorpay → us. Configure in the Razorpay
// dashboard with events payment.captured and order.paid, URL
// https://<your host>/api/subscription/webhook. The backstop for a customer
// who paid and closed the tab before the browser could call /verify.
router.post('/webhook', async (req, res) => {
  if (!verifyWebhookSignature(req.rawBody, req.get('X-Razorpay-Signature'))) {
    return res.status(400).json({ success: false, error: 'Invalid signature' });
  }
  try {
    const event = req.body?.event;
    const entity = req.body?.payload?.payment?.entity;
    if (['payment.captured', 'order.paid'].includes(event) && entity?.order_id) {
      const known = await SubscriptionPayment.exists({ razorpayOrderId: entity.order_id });
      if (known) await applyPayment(entity.order_id, { paymentId: entity.id, method: entity.method || '' });
    }
    if (event === 'payment.failed' && entity?.order_id) {
      await SubscriptionPayment.updateOne(
        { razorpayOrderId: entity.order_id, status: 'created' },
        { $set: { failureReason: String(entity.error_description || 'Payment failed').slice(0, 300) } }
      );
    }
    res.json({ success: true });
  } catch (error) {
    console.error('[subscription] webhook failed:', error.message);
    // 500 so Razorpay retries.
    res.status(500).json({ success: false });
  }
});

export default router;
