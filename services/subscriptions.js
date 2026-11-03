import Plan from '../models/Plan.js';
import BillingSetting from '../models/BillingSetting.js';
import Subscription from '../models/Subscription.js';
import SubscriptionPayment from '../models/SubscriptionPayment.js';
import Truck from '../models/Truck.js';
import User from '../models/User.js';
import Notification from '../models/Notification.js';
import { sendAlertDigestEmail } from './emailService.js';
import { getRazorpayConfig, fetchOrderPayments } from './razorpay.js';

// Plans, trials, paid periods and what an account may do because of them.
//
// Billing is prepaid: a payment buys one month or one year, added to the end
// of the current period (renewing the same plan) or starting now with the
// unused value of the old plan converted into extra days (switching plan).
// Nothing here talks to Razorpay — routes/subscription.js does that and calls
// applyPayment() once a payment's signature has been verified.

const DAY = 24 * 60 * 60 * 1000;

// The plans on the pricing page before billing went live. Seeded once, the
// first time plans are read, so the page looks the same on day one; after that
// the Super Admin owns them.
const DEFAULT_PLANS = [
  {
    key: 'starter',
    name: 'Starter',
    description: 'For small fleets',
    monthlyPrice: 999,
    yearlyPrice: 9990,
    maxVehicles: 5,
    features: ['Up to 5 vehicles', 'Basic GPS tracking', 'Monthly reports', 'Email support', 'Basic analytics'],
    sortOrder: 1
  },
  {
    key: 'professional',
    name: 'Professional',
    description: 'For growing businesses',
    monthlyPrice: 4999,
    yearlyPrice: 49990,
    maxVehicles: 50,
    highlight: true,
    features: [
      'Up to 50 vehicles',
      'Real-time GPS tracking',
      'GST invoice automation',
      'Trip history & analytics',
      'Driver management',
      'Customer tracking links',
      'Priority support',
      'Advanced reporting',
      'Mobile app access'
    ],
    sortOrder: 2
  },
  {
    key: 'enterprise',
    name: 'Enterprise',
    description: 'For large operations',
    monthlyPrice: 9999,
    yearlyPrice: 99990,
    maxVehicles: null,
    features: [
      'Unlimited vehicles',
      'Real-time GPS tracking',
      'Full GST automation',
      'Advanced analytics & BI',
      'Multi-user management',
      'Custom integrations',
      'Dedicated support',
      'Custom workflows',
      'On-premise deployment'
    ],
    sortOrder: 3
  }
];

export const ensurePlans = async () => {
  if (await Plan.exists({})) return;
  try {
    await Plan.insertMany(DEFAULT_PLANS, { ordered: false });
  } catch (error) {
    if (error.code !== 11000) throw error;
  }
};

export const getBillingSettings = async () => {
  const existing = await BillingSetting.findOne({ singleton: 'billing' }).lean();
  if (existing) return existing;
  try {
    return (await BillingSetting.create({ singleton: 'billing' })).toObject();
  } catch (error) {
    if (error.code === 11000) return BillingSetting.findOne({ singleton: 'billing' }).lean();
    throw error;
  }
};

// One month or one year on. Clamped to the month's last day, so a period
// starting 31 January ends 28/29 February rather than rolling into March.
export const addCycle = (from, cycle) => {
  const d = new Date(from);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + (cycle === 'yearly' ? 12 : 1));
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, lastDay));
  return d;
};

export const priceFor = (plan, cycle) => (cycle === 'yearly' ? plan.yearlyPrice : plan.monthlyPrice);

// The account's subscription, created with a trial the first time it is
// looked at. That is how existing accounts get their trial when billing goes
// live: from the day they are first seen, not from when they registered, so
// nobody is locked out on deploy.
export const getSubscription = async (owner) => {
  const existing = await Subscription.findOne({ owner });
  if (existing) return existing;
  const settings = await getBillingSettings();
  try {
    return await Subscription.create({
      owner,
      trialEndsAt: new Date(Date.now() + settings.trialDays * DAY),
      history: [{ kind: 'trial_started', message: `${settings.trialDays}-day free trial started` }]
    });
  } catch (error) {
    if (error.code === 11000) return Subscription.findOne({ owner });
    throw error;
  }
};

export const deriveStatus = (sub, settings, now = Date.now()) => {
  if (sub.cancelledAt) return 'cancelled';
  const periodEnd = sub.currentPeriodEnd ? new Date(sub.currentPeriodEnd).getTime() : 0;
  const trialEnd = sub.trialEndsAt ? new Date(sub.trialEndsAt).getTime() : 0;
  if (periodEnd > now) return 'active';
  if (trialEnd > now) return 'trialing';
  const lastEnd = Math.max(periodEnd, trialEnd);
  if (lastEnd && now < lastEnd + (settings.graceDays || 0) * DAY) return 'grace';
  return 'expired';
};

// Everything the app needs to know about an account's plan, in one object.
export const describe = (sub, settings, plan = null) => {
  const status = deriveStatus(sub, settings);
  const endsAt = status === 'trialing' || (status === 'grace' && !sub.currentPeriodEnd) ? sub.trialEndsAt : sub.currentPeriodEnd;
  const graceEndsAt =
    status === 'grace' ? new Date(Math.max(new Date(sub.currentPeriodEnd || 0), new Date(sub.trialEndsAt || 0)).getTime() + settings.graceDays * DAY) : null;
  const limits = status === 'trialing' || !sub.plan
    // A trial runs with the most generous active plan's limits, so the
    // customer can try everything; a paid account gets its own plan's.
    ? { maxVehicles: null, maxUsers: null }
    : { maxVehicles: sub.planSnapshot?.maxVehicles ?? null, maxUsers: sub.planSnapshot?.maxUsers ?? null };
  return {
    status,
    blocked: Boolean(settings.enforce) && ['expired', 'cancelled'].includes(status),
    enforce: Boolean(settings.enforce),
    plan: sub.plan ? { id: String(sub.plan._id || sub.plan), key: sub.planSnapshot?.key, name: sub.planSnapshot?.name } : null,
    planDetails: plan,
    cycle: sub.cycle,
    trialEndsAt: sub.trialEndsAt,
    currentPeriodStart: sub.currentPeriodStart,
    currentPeriodEnd: sub.currentPeriodEnd,
    endsAt,
    graceEndsAt,
    daysLeft: endsAt ? Math.ceil((new Date(endsAt).getTime() - Date.now()) / DAY) : null,
    limits
  };
};

// --- access cache ------------------------------------------------------------
// The middleware asks this on every request; a minute's cache keeps it off the
// database. Anything that changes a subscription calls invalidateAccess.
const cache = new Map();
const CACHE_MS = 60 * 1000;

export const invalidateAccess = (owner) => cache.delete(String(owner));

export const accessFor = async (owner) => {
  const key = String(owner);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const [sub, settings] = await Promise.all([getSubscription(owner), getBillingSettings()]);
  const value = describe(sub, settings);
  cache.set(key, { at: Date.now(), value });
  return value;
};

// --- limits -----------------------------------------------------------------

export const usageFor = async (owner) => {
  const [vehicles, users] = await Promise.all([
    Truck.countDocuments({ owner }),
    User.countDocuments({ $or: [{ _id: owner }, { account: owner }] })
  ]);
  return { vehicles, users };
};

// Would adding one more `kind` (vehicles | users) exceed the plan? Returns an
// error message or null. Not enforced when the master switch is off.
export const checkLimit = async (owner, kind) => {
  const access = await accessFor(owner);
  if (!access.enforce) return null;
  const limit = kind === 'vehicles' ? access.limits.maxVehicles : access.limits.maxUsers;
  if (limit === null || limit === undefined) return null;
  const usage = await usageFor(owner);
  const used = kind === 'vehicles' ? usage.vehicles : usage.users;
  if (used < limit) return null;
  return `Your ${access.plan?.name || 'current'} plan allows ${limit} ${kind === 'vehicles' ? 'vehicle' : 'user'}${limit === 1 ? '' : 's'}. Upgrade under Settings → Plan & Billing to add more.`;
};

// --- payments ---------------------------------------------------------------

/**
 * Mark a verified payment paid and extend the account. Idempotent: the browser
 * callback and the Razorpay webhook may both arrive, and only the first one
 * that flips the payment from `created` to `paid` changes anything.
 */
export const applyPayment = async (orderId, { paymentId, signature = '', method = '' }) => {
  const payment = await SubscriptionPayment.findOneAndUpdate(
    { razorpayOrderId: orderId, status: { $ne: 'paid' } },
    { $set: { status: 'paid', razorpayPaymentId: paymentId, razorpaySignature: signature, method, paidAt: new Date() } },
    { new: true }
  );
  if (!payment) return { alreadyApplied: true, payment: await SubscriptionPayment.findOne({ razorpayOrderId: orderId }).lean() };

  const [sub, plan] = await Promise.all([getSubscription(payment.owner), Plan.findById(payment.plan).lean()]);
  const now = new Date();
  const inPaidPeriod = sub.currentPeriodEnd && new Date(sub.currentPeriodEnd) > now;
  const samePlan = inPaidPeriod && String(sub.plan) === String(payment.plan);

  let start;
  let creditDays = 0;
  if (samePlan) {
    // Renewal: the new period follows on from the current one.
    start = new Date(sub.currentPeriodEnd);
  } else {
    // New plan, or after a lapse: starts now. Unused paid days of the old
    // plan are converted at its daily rate into days of the new one, so an
    // upgrade mid-month loses the customer nothing.
    start = now;
    if (inPaidPeriod && sub.planSnapshot?.key) {
      const oldPlan = await Plan.findById(sub.plan).lean();
      if (oldPlan) {
        const oldCycleDays = sub.cycle === 'yearly' ? 365 : 30;
        const newCycleDays = payment.cycle === 'yearly' ? 365 : 30;
        const remainingDays = (new Date(sub.currentPeriodEnd) - now) / DAY;
        const remainingValue = (priceFor(oldPlan, sub.cycle) / oldCycleDays) * remainingDays;
        const newDaily = priceFor(plan || {}, payment.cycle) / newCycleDays;
        creditDays = newDaily > 0 ? Math.floor(remainingValue / newDaily) : 0;
      }
    }
  }
  const end = new Date(addCycle(start, payment.cycle).getTime() + creditDays * DAY);

  sub.plan = payment.plan;
  sub.planSnapshot = {
    key: plan?.key || '',
    name: plan?.name || payment.planName,
    maxVehicles: plan?.maxVehicles ?? null,
    maxUsers: plan?.maxUsers ?? null
  };
  sub.cycle = payment.cycle;
  sub.currentPeriodStart = samePlan ? sub.currentPeriodStart : start;
  sub.currentPeriodEnd = end;
  sub.cancelledAt = null;
  sub.remindersSent = [];
  sub.history.push({
    kind: 'paid',
    message: `Paid ₹${(payment.amountPaise / 100).toLocaleString('en-IN')} for ${plan?.name || payment.planName} (${payment.cycle})${creditDays ? `, +${creditDays} days credited from the previous plan` : ''}; valid till ${end.toLocaleDateString('en-IN')}`
  });
  sub.updatedAt = now;
  await sub.save();

  payment.periodStart = start;
  payment.periodEnd = end;
  await payment.save();
  invalidateAccess(payment.owner);
  return { alreadyApplied: false, payment: payment.toObject(), subscription: sub };
};

// --- renewal reminders --------------------------------------------------------

/**
 * Run by the scheduler for each account. Raises one reminder per stage
 * (7 / 3 / 1 days by default) before a trial or paid period ends, and one when
 * the account is blocked — in the bell, and by email to the account owner
 * whatever the alert-email settings say, because this is about the account
 * itself, not about the fleet.
 */
export const billingReminders = async (owner) => {
  const [sub, settings] = await Promise.all([getSubscription(owner), getBillingSettings()]);
  const info = describe(sub, settings);
  const stages = settings.reminderDays?.length ? settings.reminderDays : [7, 3, 1];
  const endsAt = info.status === 'grace' ? info.graceEndsAt : info.endsAt;
  if (!endsAt) return;

  let stageKey = null;
  let title = '';
  let message = '';
  let severity = 'warning';
  const what = info.status === 'trialing' ? 'free trial' : `${info.plan?.name || ''} plan`.trim();

  if (['trialing', 'active'].includes(info.status)) {
    const within = stages.filter((d) => info.daysLeft <= d);
    if (!within.length || info.daysLeft < 0) return;
    const stage = Math.min(...within);
    stageKey = `${new Date(endsAt).getTime()}:d${stage}`;
    title = info.status === 'trialing' ? 'Trial ending soon' : 'Plan renewal due';
    message = `Your ${what} ends in ${info.daysLeft} day${info.daysLeft === 1 ? '' : 's'} (${new Date(endsAt).toLocaleDateString('en-IN')}). Renew under Settings → Plan & Billing to avoid interruption.`;
    severity = info.daysLeft <= 1 ? 'critical' : 'warning';
  } else if (info.status === 'grace') {
    stageKey = `${new Date(endsAt).getTime()}:grace`;
    title = 'Plan expired — grace period';
    message = `Your ${what} has ended. TrackOwl will be locked on ${new Date(endsAt).toLocaleDateString('en-IN')} unless you renew.`;
    severity = 'critical';
  } else if (info.status === 'expired' && info.enforce) {
    stageKey = `${new Date(endsAt).getTime()}:expired`;
    title = 'Account locked — plan expired';
    message = 'Your plan has expired and the account is locked. Your data and GPS history are kept. Renew under Settings → Plan & Billing to unlock.';
    severity = 'critical';
  } else {
    return;
  }

  if (sub.remindersSent.includes(stageKey)) return;
  // Claim the stage first so two overlapping runs cannot both send it.
  const claimed = await Subscription.updateOne({ _id: sub._id, remindersSent: { $ne: stageKey } }, { $push: { remindersSent: stageKey } });
  if (!claimed.modifiedCount) return;

  const notification = await Notification.create({
    owner,
    type: 'alert',
    category: 'billing',
    severity,
    title,
    message,
    dedupeKey: `billing:${stageKey}`
  }).catch(() => null);

  const account = await User.findById(owner).select('email company').lean();
  if (account?.email && notification) {
    await sendAlertDigestEmail([account.email], account.company, [notification.toObject()], process.env.APP_URL || '');
  }
};

// --- reconciliation (instead of a webhook) ---------------------------------

/**
 * Checkouts that were started but never confirmed by the browser — the
 * customer paid and closed the tab, or their connection dropped before the
 * success callback reached us. Run by the scheduler every few minutes: for
 * each such order from the last 24 hours, ask Razorpay whether it was paid,
 * and if a payment was captured, apply it exactly as /verify would have.
 *
 * Orders are only looked at once they are 2 minutes old, so a checkout still
 * open in someone's browser is left alone; after 24 hours an unpaid order is
 * given up on (it is still visible to the Super Admin as "Started, not paid").
 */
export const reconcilePendingPayments = async () => {
  const cfg = await getRazorpayConfig();
  if (!cfg.configured) return { checked: 0, applied: 0 };

  const now = Date.now();
  const pending = await SubscriptionPayment.find({
    status: 'created',
    createdAt: { $lte: new Date(now - 2 * 60 * 1000), $gte: new Date(now - 24 * 60 * 60 * 1000) }
  })
    .sort({ createdAt: 1 })
    .limit(50)
    .lean();

  let applied = 0;
  for (const p of pending) {
    try {
      const { items = [] } = await fetchOrderPayments(p.razorpayOrderId);
      const captured = items.find((i) => i.status === 'captured');
      if (captured) {
        const result = await applyPayment(p.razorpayOrderId, { paymentId: captured.id, method: captured.method || '' });
        if (!result.alreadyApplied) {
          applied += 1;
          console.log(`[billing] reconciled order ${p.razorpayOrderId} → payment ${captured.id}`);
        }
      } else {
        const failed = items.filter((i) => i.status === 'failed').pop();
        if (failed?.error_description && !p.failureReason) {
          await SubscriptionPayment.updateOne({ _id: p._id, status: 'created' }, { $set: { failureReason: String(failed.error_description).slice(0, 300) } });
        }
      }
    } catch (error) {
      console.error(`[billing] reconcile ${p.razorpayOrderId} failed:`, error.message);
    }
  }
  return { checked: pending.length, applied };
};
