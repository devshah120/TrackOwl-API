import express from 'express';
import mongoose from 'mongoose';
import Plan from '../models/Plan.js';
import BillingSetting from '../models/BillingSetting.js';
import Subscription from '../models/Subscription.js';
import SubscriptionPayment from '../models/SubscriptionPayment.js';
import User from '../models/User.js';
import { protect, requireSuperAdmin } from '../middleware/auth.js';
import { recordAudit } from '../utils/audit.js';
import { ROLES } from '../utils/permissions.js';
import {
  ensurePlans,
  getBillingSettings,
  getSubscription,
  describe,
  usageFor,
  invalidateAccess
} from '../services/subscriptions.js';
import { getRazorpayConfig, invalidateRazorpayConfig, testCredentials } from '../services/razorpay.js';
import { encryptSecret, maskSecret } from '../utils/secretBox.js';

// Plans & Billing for the platform operator (Super Admin only): the plans and
// what each includes, the trial and grace settings, every client's
// subscription, and the payment log. Mounted at /api/admin/billing.

const router = express.Router();
router.use(protect, requireSuperAdmin);

const isId = (v) => mongoose.Types.ObjectId.isValid(v);
const DAY = 24 * 60 * 60 * 1000;

const audit = (req, label, summary, changes = []) =>
  recordAudit(req, { entity: 'company', action: 'update', label, summary, changes, account: null });

// --- plans ------------------------------------------------------------------

const buildPlan = (body = {}, { partial = false } = {}) => {
  const out = {};
  const need = (k) => !partial || body[k] !== undefined;
  if (need('key')) {
    const key = String(body.key || '').trim().toLowerCase();
    if (!/^[a-z0-9-]{2,40}$/.test(key)) return { error: 'Plan code must be 2–40 lowercase letters, digits or dashes (e.g. "professional")' };
    out.key = key;
  }
  if (need('name')) {
    out.name = String(body.name || '').trim();
    if (!out.name) return { error: 'Plan name is required' };
  }
  if (body.description !== undefined) out.description = String(body.description || '').trim();
  for (const k of ['monthlyPrice', 'yearlyPrice']) {
    if (!need(k)) continue;
    const n = Number(body[k]);
    if (!Number.isFinite(n) || n < 0 || n > 10000000) return { error: `${k === 'monthlyPrice' ? 'Monthly' : 'Yearly'} price must be between ₹0 and ₹1,00,00,000` };
    out[k] = Math.round(n);
  }
  for (const k of ['maxVehicles', 'maxUsers']) {
    if (body[k] === undefined) continue;
    if (body[k] === null || body[k] === '') out[k] = null;
    else {
      const n = Number(body[k]);
      if (!Number.isInteger(n) || n < 1) return { error: `${k === 'maxVehicles' ? 'Vehicle' : 'User'} limit must be a whole number, or blank for unlimited` };
      out[k] = n;
    }
  }
  if (body.features !== undefined) {
    out.features = (Array.isArray(body.features) ? body.features : String(body.features).split('\n'))
      .map((f) => String(f).trim())
      .filter(Boolean)
      .slice(0, 30);
  }
  if (body.highlight !== undefined) out.highlight = Boolean(body.highlight);
  if (body.active !== undefined) out.active = Boolean(body.active);
  if (body.sortOrder !== undefined) out.sortOrder = Number(body.sortOrder) || 0;
  return { fields: out };
};

router.get('/plans', async (req, res) => {
  try {
    await ensurePlans();
    const plans = await Plan.find().sort({ sortOrder: 1, monthlyPrice: 1 }).lean();
    const counts = await Subscription.aggregate([{ $match: { plan: { $ne: null } } }, { $group: { _id: '$plan', n: { $sum: 1 } } }]);
    const byPlan = new Map(counts.map((c) => [String(c._id), c.n]));
    res.json({ success: true, plans: plans.map((p) => ({ ...p, subscribers: byPlan.get(String(p._id)) || 0 })) });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to load plans' });
  }
});

router.post('/plans', async (req, res) => {
  try {
    const { fields, error } = buildPlan(req.body);
    if (error) return res.status(400).json({ success: false, error });
    if (await Plan.exists({ key: fields.key })) return res.status(409).json({ success: false, error: `A plan with code "${fields.key}" already exists` });
    const plan = await Plan.create({ ...fields, updatedBy: req.user._id });
    if (plan.highlight) await Plan.updateMany({ _id: { $ne: plan._id } }, { $set: { highlight: false } });
    await audit(req, plan.name, `Plan ${plan.name} created — ₹${plan.monthlyPrice}/month, ₹${plan.yearlyPrice}/year`);
    res.status(201).json({ success: true, plan });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to create plan' });
  }
});

router.put('/plans/:id', async (req, res) => {
  try {
    const before = isId(req.params.id) && (await Plan.findById(req.params.id).lean());
    if (!before) return res.status(404).json({ success: false, error: 'Plan not found' });
    const { fields, error } = buildPlan(req.body, { partial: true });
    if (error) return res.status(400).json({ success: false, error });
    if (fields.key && fields.key !== before.key) {
      if (await Subscription.exists({ plan: before._id })) {
        return res.status(409).json({ success: false, error: 'This plan has subscribers, so its code cannot change' });
      }
      if (await Plan.exists({ key: fields.key })) return res.status(409).json({ success: false, error: `Code "${fields.key}" is taken` });
    }
    const plan = await Plan.findByIdAndUpdate(before._id, { $set: { ...fields, updatedAt: new Date(), updatedBy: req.user._id } }, { new: true });
    // Only one plan carries the "Most Popular" badge.
    if (fields.highlight) await Plan.updateMany({ _id: { $ne: plan._id } }, { $set: { highlight: false } });
    const changes = ['monthlyPrice', 'yearlyPrice', 'maxVehicles', 'maxUsers', 'active']
      .filter((k) => k in fields && fields[k] !== before[k])
      .map((k) => ({ field: k, label: k, from: before[k] ?? null, to: fields[k] ?? null }));
    await audit(req, plan.name, `Plan ${plan.name} updated`, changes);
    res.json({ success: true, plan, note: 'Price and limit changes apply to each subscriber at their next renewal.' });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to update plan' });
  }
});

router.delete('/plans/:id', async (req, res) => {
  try {
    const plan = isId(req.params.id) && (await Plan.findById(req.params.id));
    if (!plan) return res.status(404).json({ success: false, error: 'Plan not found' });
    if ((await Subscription.exists({ plan: plan._id })) || (await SubscriptionPayment.exists({ plan: plan._id }))) {
      return res.status(409).json({ success: false, error: 'This plan has been bought — switch it off (untick Active) instead of deleting it' });
    }
    await plan.deleteOne();
    await audit(req, plan.name, `Plan ${plan.name} deleted`);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to delete plan' });
  }
});

// --- settings ---------------------------------------------------------------

// The settings without the stored (encrypted) Razorpay secrets — those never
// leave the server, not even encrypted.
const publicSettings = (settings) => {
  const { razorpay, ...rest } = settings || {};
  return rest;
};

// What the panel shows about the Razorpay connection: which key, whether each
// secret is set (as a masked hint), test or live, and where it came from.
const razorpayStatus = async () => {
  const cfg = await getRazorpayConfig();
  const stored = (await getBillingSettings()).razorpay || {};
  return {
    configured: cfg.configured,
    source: cfg.source, // panel | env | none
    mode: cfg.mode, // test | live | null
    keyId: cfg.keyId,
    keySecretHint: maskSecret(cfg.keySecret),
    // A secret was saved but cannot be decrypted — the server's
    // JWT_SECRET / SETTINGS_ENCRYPTION_KEY changed since. Re-enter it.
    unreadable: Boolean(stored.keySecretEnc && !cfg.keySecret && cfg.source !== 'env'),
    verifiedAt: stored.verifiedAt || null,
    updatedAt: stored.updatedAt || null
  };
};

router.get('/settings', async (req, res) => {
  res.json({ success: true, settings: publicSettings(await getBillingSettings()), razorpay: await razorpayStatus() });
});

// PUT /api/admin/billing/razorpay { keyId, keySecret? }
// Saves the Razorpay credentials. A new key id or key secret is tested
// against Razorpay before it is stored, so a typo cannot silently break
// every checkout. Leave a secret blank to keep the one already saved.
router.put('/razorpay', async (req, res) => {
  try {
    const body = req.body || {};
    const keyId = String(body.keyId || '').trim();
    const keySecret = String(body.keySecret || '').trim();
    if (!/^rzp_(test|live)_[A-Za-z0-9]+$/.test(keyId)) {
      return res.status(400).json({ success: false, error: 'Key Id looks like rzp_test_… or rzp_live_… (Razorpay Dashboard → Account & Settings → API Keys)' });
    }

    const current = await getRazorpayConfig();
    // Blank secret = keep the saved one, but only if it belongs to the same key.
    const secretToUse = keySecret || (current.keyId === keyId ? current.keySecret : '');
    if (!secretToUse) return res.status(400).json({ success: false, error: 'Enter the Key Secret for this Key Id' });

    try {
      await testCredentials(keyId, secretToUse);
    } catch (error) {
      return res.status(400).json({
        success: false,
        error: error.status === 401 ? 'Razorpay rejected these keys — check the Key Id and Key Secret' : `Could not reach Razorpay to check the keys: ${error.message}`
      });
    }

    const updates = {
      'razorpay.keyId': keyId,
      'razorpay.verifiedAt': new Date(),
      'razorpay.updatedAt': new Date(),
      'razorpay.updatedBy': req.user._id
    };
    if (keySecret || current.source !== 'panel') updates['razorpay.keySecretEnc'] = encryptSecret(secretToUse);

    await getBillingSettings(); // make sure the document exists
    await BillingSetting.updateOne({ singleton: 'billing' }, { $set: updates });
    invalidateRazorpayConfig();

    const status = await razorpayStatus();
    // The secrets themselves are never written to the audit log.
    await audit(req, 'Razorpay', `Razorpay ${status.mode || ''} keys saved (${keyId})`.replace('  ', ' '), [
      { field: 'razorpay.keyId', label: 'Key Id', from: current.keyId || null, to: keyId }
    ]);
    res.json({ success: true, message: `Razorpay connected in ${status.mode} mode`, razorpay: status });
  } catch (error) {
    console.error('[admin-billing] razorpay save failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to save the Razorpay keys' });
  }
});

// POST /api/admin/billing/razorpay/test — re-check the saved keys.
router.post('/razorpay/test', async (req, res) => {
  const cfg = await getRazorpayConfig();
  if (!cfg.configured) return res.status(400).json({ success: false, error: 'No Razorpay keys are saved yet' });
  try {
    await testCredentials(cfg.keyId, cfg.keySecret);
    await BillingSetting.updateOne({ singleton: 'billing' }, { $set: { 'razorpay.verifiedAt': new Date() } });
    invalidateRazorpayConfig();
    res.json({ success: true, message: `Connected to Razorpay (${cfg.mode} mode)`, razorpay: await razorpayStatus() });
  } catch (error) {
    res.status(400).json({ success: false, error: error.status === 401 ? 'Razorpay rejected the saved keys' : `Could not reach Razorpay: ${error.message}` });
  }
});

// DELETE /api/admin/billing/razorpay — forget the keys saved in the panel
// (the server then falls back to .env, if anything is set there).
router.delete('/razorpay', async (req, res) => {
  await BillingSetting.updateOne(
    { singleton: 'billing' },
    { $set: { 'razorpay.keyId': '', 'razorpay.keySecretEnc': '', 'razorpay.webhookSecretEnc': '', 'razorpay.verifiedAt': null, 'razorpay.updatedAt': new Date(), 'razorpay.updatedBy': req.user._id } }
  );
  invalidateRazorpayConfig();
  await audit(req, 'Razorpay', 'Razorpay keys removed from the panel');
  res.json({ success: true, message: 'Razorpay keys removed', razorpay: await razorpayStatus() });
});

router.put('/settings', async (req, res) => {
  try {
    const b = req.body || {};
    const updates = {};
    const bounded = (k, min, max, label) => {
      if (b[k] === undefined) return null;
      const n = Number(b[k]);
      if (!Number.isInteger(n) || n < min || n > max) return `${label} must be a whole number from ${min} to ${max}`;
      updates[k] = n;
      return null;
    };
    const problem = bounded('trialDays', 0, 365, 'Trial days') || bounded('graceDays', 0, 60, 'Grace days');
    if (problem) return res.status(400).json({ success: false, error: problem });
    if (b.enforce !== undefined) updates.enforce = Boolean(b.enforce);
    if (b.reminderDays !== undefined) {
      updates.reminderDays = [...new Set((Array.isArray(b.reminderDays) ? b.reminderDays : String(b.reminderDays).split(','))
        .map((d) => Math.round(Number(String(d).trim())))
        .filter((n) => Number.isFinite(n) && n >= 0 && n <= 60))].sort((x, y) => y - x);
    }
    const before = await getBillingSettings();
    const settings = await BillingSetting.findOneAndUpdate({ singleton: 'billing' }, { $set: { ...updates, updatedAt: new Date(), updatedBy: req.user._id } }, { new: true }).lean();
    // Every account's access depends on these.
    for (const id of (await Subscription.find().select('owner').lean()).map((s) => s.owner)) invalidateAccess(id);
    await audit(
      req,
      'Billing settings',
      'Billing settings updated',
      Object.keys(updates).map((k) => ({ field: k, label: k, from: before[k], to: settings[k] }))
    );
    res.json({ success: true, settings: publicSettings(settings), note: 'A new trial length applies to accounts created from now on; use "Extend trial" for existing ones.' });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to save billing settings' });
  }
});

// --- client subscriptions -------------------------------------------------

router.get('/subscriptions', async (req, res) => {
  try {
    const [owners, settings] = await Promise.all([
      User.find({ account: null, role: { $ne: ROLES.SUPER_ADMIN } }).select('name email company mobile isActive createdAt').sort({ createdAt: -1 }).lean(),
      getBillingSettings()
    ]);
    const rows = [];
    for (const owner of owners) {
      const sub = await getSubscription(owner._id);
      const usage = await usageFor(owner._id);
      rows.push({ owner, usage, subscription: describe(sub, settings) });
    }
    const status = req.query.status;
    res.json({ success: true, subscriptions: status ? rows.filter((r) => r.subscription.status === status) : rows });
  } catch (error) {
    console.error('[admin-billing] subscriptions failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to load subscriptions' });
  }
});

// POST /api/admin/billing/subscriptions/:owner/action
//   { action: 'extend_trial', days }
//   { action: 'grant', plan, cycle, until }   — a period without payment
//                                               (offline payment, pilot, partner)
//   { action: 'cancel' } / { action: 'reactivate' }
router.post('/subscriptions/:owner/action', async (req, res) => {
  try {
    if (!isId(req.params.owner)) return res.status(404).json({ success: false, error: 'Account not found' });
    const owner = await User.findOne({ _id: req.params.owner, account: null }).select('name company').lean();
    if (!owner) return res.status(404).json({ success: false, error: 'Account not found' });
    const sub = await getSubscription(owner._id);
    const b = req.body || {};
    const now = new Date();
    const by = { by: req.user._id, byName: req.user.name || '' };
    let summary = '';

    if (b.action === 'extend_trial') {
      const days = Number(b.days);
      if (!Number.isInteger(days) || days < 1 || days > 365) return res.status(400).json({ success: false, error: 'Days must be 1–365' });
      const from = sub.trialEndsAt && new Date(sub.trialEndsAt) > now ? new Date(sub.trialEndsAt) : now;
      sub.trialEndsAt = new Date(from.getTime() + days * DAY);
      sub.cancelledAt = null;
      summary = `Trial extended by ${days} days to ${sub.trialEndsAt.toLocaleDateString('en-IN')}`;
      sub.history.push({ kind: 'trial_extended', message: summary, ...by });
    } else if (b.action === 'grant') {
      const plan = isId(b.plan) && (await Plan.findById(b.plan).lean());
      if (!plan) return res.status(400).json({ success: false, error: 'Choose a plan' });
      const until = new Date(b.until);
      if (Number.isNaN(until.getTime()) || until <= now) return res.status(400).json({ success: false, error: 'Choose a date in the future' });
      sub.plan = plan._id;
      sub.planSnapshot = { key: plan.key, name: plan.name, maxVehicles: plan.maxVehicles ?? null, maxUsers: plan.maxUsers ?? null };
      sub.cycle = b.cycle === 'yearly' ? 'yearly' : 'monthly';
      sub.currentPeriodStart = now;
      sub.currentPeriodEnd = until;
      sub.cancelledAt = null;
      sub.remindersSent = [];
      summary = `${plan.name} granted until ${until.toLocaleDateString('en-IN')}${b.note ? ` — ${String(b.note).slice(0, 200)}` : ''}`;
      sub.history.push({ kind: 'granted', message: summary, ...by });
    } else if (b.action === 'cancel') {
      sub.cancelledAt = now;
      summary = 'Subscription cancelled — account blocked';
      sub.history.push({ kind: 'cancelled', message: summary, ...by });
    } else if (b.action === 'reactivate') {
      sub.cancelledAt = null;
      summary = 'Subscription reactivated';
      sub.history.push({ kind: 'reactivated', message: summary, ...by });
    } else {
      return res.status(400).json({ success: false, error: 'Unknown action' });
    }

    sub.updatedAt = now;
    await sub.save();
    invalidateAccess(owner._id);
    await recordAudit(req, { entity: 'company', entityId: owner._id, action: 'update', label: owner.company || owner.name, summary: `${owner.company || owner.name}: ${summary}`, account: owner._id });
    res.json({ success: true, subscription: describe(sub, await getBillingSettings()), message: summary });
  } catch (error) {
    console.error('[admin-billing] action failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to update the subscription' });
  }
});

// --- payments ---------------------------------------------------------------

router.get('/payments', async (req, res) => {
  try {
    const filter = {};
    if (['created', 'paid', 'failed'].includes(req.query.status)) filter.status = req.query.status;
    const payments = await SubscriptionPayment.find(filter).sort({ createdAt: -1 }).limit(300).populate('owner', 'name company email').lean();
    const paid = payments.filter((p) => p.status === 'paid');
    res.json({
      success: true,
      payments: payments.map((p) => ({ ...p, amount: p.amountPaise / 100 })),
      totals: { paidCount: paid.length, paidAmount: paid.reduce((s, p) => s + p.amountPaise, 0) / 100 }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to load payments' });
  }
});

export default router;
