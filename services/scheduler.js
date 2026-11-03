import User from '../models/User.js';
import Notification from '../models/Notification.js';
import { ROLES } from '../utils/permissions.js';
import { synthesizeNotifications } from './notificationSynth.js';
import { billingReminders, reconcilePendingPayments } from './subscriptions.js';
import { getAlertSettings } from './gpsAlerts.js';
import { sendAlertDigestEmail } from './emailService.js';
import { emitEvent } from './webhooks.js';

// The background jobs. Started once from server.js after the database
// connects.
//
//   every 10 min   scan every active account for condition alerts — expiring
//                  documents, devices gone offline, maintenance due — so they
//                  appear (and are emailed) even when nobody has the app open
//   every 1 min    deliver new alerts: one email digest per account to its
//                  configured recipients, and an `alert.created` webhook each
//
// Each job skips a tick while its previous run is still going, so a slow
// database never stacks runs on top of each other. Runs are per process: on a
// single API instance that is exact; with several, run the scheduler on one
// (SCHEDULER_DISABLED=true on the others).

const SCAN_EVERY_MS = 10 * 60 * 1000;
const DELIVER_EVERY_MS = 60 * 1000;
// Only alerts this recent are delivered. Stops the first run after deploy
// emailing every historical notification, and stops a long outage turning into
// a flood of stale alerts when the server comes back.
const DELIVERY_WINDOW_MS = 2 * 60 * 60 * 1000;
const RANK = { info: 0, warning: 1, critical: 2 };
const MAX_PER_DIGEST = 25;

// Last run of each job, for /api/health.
const status = {
  started: false,
  disabled: false,
  scan: { lastFinishedAt: null, lastError: null, accounts: 0 },
  delivery: { lastFinishedAt: null, lastError: null, delivered: 0 },
  reconcile: { lastFinishedAt: null, lastError: null, checked: 0, applied: 0 }
};

export const schedulerStatus = () => {
  // Stale = enabled but delivery (every minute) has not finished in 5 min, or
  // the scan (every 10 min) not in 30 — the jobs are stuck or dead.
  const ago = (d) => (d ? Date.now() - new Date(d).getTime() : Infinity);
  const stale =
    status.started &&
    !status.disabled &&
    process.uptime() > 15 * 60 &&
    (ago(status.delivery.lastFinishedAt) > 5 * 60 * 1000 || ago(status.scan.lastFinishedAt) > 30 * 60 * 1000);
  return { ...status, stale };
};

const accountIds = async () => {
  // An account is its owner seat: a user with no `account` of its own.
  const owners = await User.find({ account: null, isActive: true, role: { $ne: ROLES.SUPER_ADMIN } }).select('_id company').lean();
  return owners;
};

let scanning = false;
export const runScan = async () => {
  if (scanning) return;
  scanning = true;
  try {
    const owners = await accountIds();
    let failed = null;
    for (const owner of owners) {
      try {
        await synthesizeNotifications(owner._id);
        await billingReminders(owner._id);
      } catch (error) {
        failed = error.message;
        console.error(`[scheduler] scan failed for ${owner._id}:`, error.message);
      }
    }
    status.scan = { lastFinishedAt: new Date(), lastError: failed, accounts: owners.length };
  } catch (error) {
    status.scan = { ...status.scan, lastFinishedAt: new Date(), lastError: error.message };
    console.error('[scheduler] scan failed:', error.message);
  } finally {
    scanning = false;
  }
};

// Razorpay checkouts the browser never confirmed (no webhook is configured,
// so this is how a customer who paid and closed the tab still gets the plan).
let reconciling = false;
export const runReconcile = async () => {
  if (reconciling) return;
  reconciling = true;
  try {
    const result = await reconcilePendingPayments();
    status.reconcile = { lastFinishedAt: new Date(), lastError: null, ...result };
  } catch (error) {
    status.reconcile = { lastFinishedAt: new Date(), lastError: error.message };
    console.error('[scheduler] payment reconcile failed:', error.message);
  } finally {
    reconciling = false;
  }
};

let delivering = false;
export const runDelivery = async () => {
  if (delivering) return;
  delivering = true;
  try {
    const since = new Date(Date.now() - DELIVERY_WINDOW_MS);
    const pending = await Notification.find({ deliveredAt: null, createdAt: { $gte: since } })
      .sort({ createdAt: 1 })
      .limit(1000)
      .lean();
    if (!pending.length) {
      status.delivery = { lastFinishedAt: new Date(), lastError: null, delivered: 0 };
      return;
    }

    const byOwner = new Map();
    for (const n of pending) {
      const key = String(n.owner);
      if (!byOwner.has(key)) byOwner.set(key, []);
      byOwner.get(key).push(n);
    }

    const owners = await User.find({ _id: { $in: [...byOwner.keys()] } }).select('company').lean();
    const companyOf = new Map(owners.map((o) => [String(o._id), o.company]));

    for (const [owner, list] of byOwner) {
      // Mark first: a crash mid-send must not resend the whole batch next
      // minute. Losing one digest is better than mailing it twice a minute.
      await Notification.updateMany({ _id: { $in: list.map((n) => n._id) } }, { $set: { deliveredAt: new Date() } });

      for (const n of list) {
        emitEvent(owner, 'alert.created', {
          id: String(n._id),
          category: n.category || '',
          severity: n.severity || 'info',
          title: n.title,
          message: n.message,
          vehicle: n.vehicle || '',
          lat: n.lat ?? null,
          lng: n.lng ?? null,
          createdAt: n.createdAt
        });
      }

      try {
        const settings = await getAlertSettings(owner);
        const mail = settings.email || {};
        if (!mail.enabled || !mail.recipients?.length) continue;
        const floor = RANK[mail.minSeverity] ?? 2;
        const eligible = list.filter((n) => (RANK[n.severity] ?? 0) >= floor).slice(-MAX_PER_DIGEST);
        if (eligible.length) {
          await sendAlertDigestEmail(mail.recipients, companyOf.get(owner), eligible, process.env.APP_URL || '');
        }
      } catch (error) {
        console.error(`[scheduler] email failed for ${owner}:`, error.message);
      }
    }
    status.delivery = { lastFinishedAt: new Date(), lastError: null, delivered: pending.length };
  } catch (error) {
    status.delivery = { ...status.delivery, lastFinishedAt: new Date(), lastError: error.message };
    console.error('[scheduler] delivery failed:', error.message);
  } finally {
    delivering = false;
  }
};

export const startScheduler = () => {
  if (process.env.SCHEDULER_DISABLED === 'true') {
    console.log('• Scheduler disabled on this instance (SCHEDULER_DISABLED=true)');
    status.disabled = true;
    return;
  }
  // First scan shortly after start, not at once, so a restart does not add a
  // full sweep to the boot.
  setTimeout(runScan, 60 * 1000).unref();
  setInterval(runScan, SCAN_EVERY_MS).unref();
  setInterval(runDelivery, DELIVER_EVERY_MS).unref();
  setInterval(runReconcile, 3 * 60 * 1000).unref();
  status.started = true;
  console.log('✓ Scheduler started (alert scan every 10 min, delivery every 1 min, payment check every 3 min)');
};
