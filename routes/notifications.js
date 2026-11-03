import express from 'express';
import Notification from '../models/Notification.js';
import { protect } from '../middleware/auth.js';
import { hasPermission } from '../utils/permissions.js';
import { synthesizeNotifications } from '../services/notificationSynth.js';

const router = express.Router();

const ownedBy = (req) => ({ owner: req.accountId });

// The bell polls every 30 s per open tab; the full scan is not needed that
// often now the scheduler runs it. At most once a minute per account here.
const lastSynth = new Map();
const SYNTH_EVERY_MS = 60 * 1000;

const maybeSynthesize = async (req) => {
  const key = String(req.accountId);
  if (Date.now() - (lastSynth.get(key) || 0) < SYNTH_EVERY_MS) return;
  lastSynth.set(key, Date.now());
  await synthesizeNotifications(req.accountId);
};

// GET /api/notifications — the caller's notifications, newest first. Runs the
// lazy synthesizer first so expiry/offline alerts are always up to date.
router.get('/', protect, async (req, res) => {
  try {
    await maybeSynthesize(req);
    // Maintenance reminders are account-wide rows; a seat that cannot see
    // maintenance does not get them in its bell.
    const filter = ownedBy(req);
    // ...nor does an account whose plan does not include maintenance.
    const maintenanceInPlan = !req.subscription || req.subscription.modules?.includes('maintenance');
    if (!hasPermission(req.user.role, 'maintenance', 'read') || !maintenanceInPlan) filter.category = { $ne: 'maintenance' };
    const notifications = await Notification.find(filter).sort({ createdAt: -1 }).limit(50);
    res.json({ success: true, notifications });
  } catch (error) {
    console.error('[notifications] fetch failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to fetch notifications' });
  }
});

// POST /api/notifications/:id/read — mark one as read.
router.post('/:id/read', protect, async (req, res) => {
  try {
    const notification = await Notification.findOneAndUpdate(
      { _id: req.params.id, ...ownedBy(req) },
      { $set: { read: true } },
      { new: true }
    );
    if (!notification) return res.status(404).json({ success: false, error: 'Notification not found' });
    res.json({ success: true, notification });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to mark notification as read' });
  }
});

// POST /api/notifications/read-all — mark every unread notification as read.
router.post('/read-all', protect, async (req, res) => {
  try {
    await Notification.updateMany({ ...ownedBy(req), read: false }, { $set: { read: true } });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to mark notifications as read' });
  }
});

export default router;
