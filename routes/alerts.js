import express from 'express';
import mongoose from 'mongoose';
import Geofence, { GEOFENCE_SHAPES, GEOFENCE_CATEGORIES, GEOFENCE_CATEGORY_LABELS } from '../models/Geofence.js';
import AlertSetting from '../models/AlertSetting.js';
import Notification from '../models/Notification.js';
import Truck from '../models/Truck.js';
import { protect, requirePermission } from '../middleware/auth.js';
import { auditCreate, auditUpdate, auditDelete } from '../utils/audit.js';
import { getAlertSettings, invalidateAlertCache } from '../services/gpsAlerts.js';

// Alerts & Notifications: the GPS alert engine's settings, the geofences it
// watches, and the full alert history behind the bell.
//
// Everything sits on the `tracking` permission resource — alerts are what the
// tracking module observes, and a seat that cannot see the map has no business
// configuring what it watches for.

const router = express.Router();

const ownedBy = (req) => ({ owner: req.accountId });
const isId = (v) => mongoose.Types.ObjectId.isValid(v);

const num = (v) => {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

router.get('/options', protect, (req, res) => {
  res.json({
    success: true,
    shapes: GEOFENCE_SHAPES,
    categories: GEOFENCE_CATEGORIES.map((value) => ({ value, label: GEOFENCE_CATEGORY_LABELS[value] })),
    alertCategories: [
      { value: 'overspeed', label: 'Overspeed' },
      { value: 'idle', label: 'Prolonged idling' },
      { value: 'ignition', label: 'Ignition on/off' },
      { value: 'after_hours', label: 'Unauthorised movement' },
      { value: 'geofence', label: 'Geofence' },
      { value: 'route_deviation', label: 'Route deviation' },
      { value: 'driver_report', label: 'Reported by driver' },
      { value: 'offline', label: 'Device offline' },
      { value: 'compliance', label: 'Document expiry' }
    ]
  });
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

router.get('/settings', protect, requirePermission('tracking', 'read'), async (req, res) => {
  try {
    res.json({ success: true, settings: await getAlertSettings(req.accountId) });
  } catch (error) {
    console.error('[alerts] settings read failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to load alert settings' });
  }
});

router.put('/settings', protect, requirePermission('tracking', 'update'), async (req, res) => {
  try {
    const body = req.body || {};
    const updates = {};

    const bool = (path, v) => {
      if (v !== undefined) updates[path] = Boolean(v);
    };
    const bounded = (path, v, min, max, label) => {
      if (v === undefined) return null;
      const n = num(v);
      if (n === null || n < min || n > max) return `${label} must be between ${min} and ${max}`;
      updates[path] = n;
      return null;
    };

    bool('overspeed.enabled', body.overspeed?.enabled);
    bool('ignition.enabled', body.ignition?.enabled);
    bool('idle.enabled', body.idle?.enabled);
    bool('afterHours.enabled', body.afterHours?.enabled);
    bool('geofence.enabled', body.geofence?.enabled);
    bool('routeDeviation.enabled', body.routeDeviation?.enabled);
    bool('email.enabled', body.email?.enabled);
    if (body.email?.minSeverity !== undefined) {
      if (!['critical', 'warning', 'info'].includes(body.email.minSeverity)) {
        return res.status(400).json({ success: false, error: 'Email severity must be critical, warning or info' });
      }
      updates['email.minSeverity'] = body.email.minSeverity;
    }
    if (body.email?.recipients !== undefined) {
      const list = [...new Set((Array.isArray(body.email.recipients) ? body.email.recipients : String(body.email.recipients).split(','))
        .map((e) => String(e).trim().toLowerCase())
        .filter(Boolean))];
      const bad = list.filter((e) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
      if (bad.length) return res.status(400).json({ success: false, error: `Not an email address: ${bad.join(', ')}` });
      if (list.length > 20) return res.status(400).json({ success: false, error: 'At most 20 alert email recipients' });
      updates['email.recipients'] = list;
    }
    bool('logToTrip', body.logToTrip);
    bool('maintenanceInBell', body.maintenanceInBell);

    if (body.compliance?.reminderDays !== undefined) {
      const days = [...new Set((Array.isArray(body.compliance.reminderDays) ? body.compliance.reminderDays : [])
        .map(num)
        .filter((n) => n !== null && n >= 0 && n <= 365)
        .map(Math.round))].sort((a, b) => b - a);
      if (!days.length) {
        return res.status(400).json({ success: false, error: 'Add at least one reminder day (0 = on the expiry date)' });
      }
      updates['compliance.reminderDays'] = days;
    }

    const problems = [
      bounded('overspeed.limitKmh', body.overspeed?.limitKmh, 10, 200, 'Speed limit'),
      bounded('idle.minutes', body.idle?.minutes, 1, 600, 'Idle minutes'),
      bounded('afterHours.minSpeedKmh', body.afterHours?.minSpeedKmh, 1, 60, 'Minimum speed'),
      bounded('routeDeviation.thresholdM', body.routeDeviation?.thresholdM, 200, 20000, 'Route deviation distance'),
      bounded('routeDeviation.minMinutes', body.routeDeviation?.minMinutes, 0, 120, 'Route deviation minutes')
    ].filter(Boolean);

    for (const key of ['from', 'to']) {
      const v = body.afterHours?.[key];
      if (v === undefined) continue;
      if (!HHMM.test(String(v))) problems.push(`After-hours "${key}" must be a 24-hour time like 22:00`);
      else updates[`afterHours.${key}`] = String(v);
    }

    if (problems.length) return res.status(400).json({ success: false, error: problems.join('; ') });

    const before = await getAlertSettings(req.accountId);
    const settings = await AlertSetting.findOneAndUpdate(
      ownedBy(req),
      { $set: { ...updates, updatedAt: new Date(), updatedBy: req.user._id } },
      { new: true }
    ).lean();

    invalidateAlertCache(req.accountId);
    await auditUpdate(req, {
      entity: 'alert_setting',
      before,
      after: settings,
      fields: updates,
      label: 'GPS alerts'
    });

    res.json({ success: true, message: 'Alert settings saved', settings });
  } catch (error) {
    console.error('[alerts] settings save failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to save alert settings' });
  }
});

// ---------------------------------------------------------------------------
// Geofences
// ---------------------------------------------------------------------------

// Builds a geofence from the request, or returns { error }. Validates the shape
// fully: a fence with no centre or a two-point polygon would silently never
// fire, which is worse than refusing to save it.
const buildFence = async (req, body, { partial = false } = {}) => {
  const out = {};

  if (!partial || body.name !== undefined) {
    const name = String(body.name || '').trim();
    if (!name) return { error: 'A geofence name is required' };
    out.name = name;
  }
  if (body.category !== undefined) {
    if (!GEOFENCE_CATEGORIES.includes(body.category)) return { error: 'Unknown geofence category' };
    out.category = body.category;
  }
  if (body.color !== undefined) out.color = String(body.color || '#2563eb').slice(0, 20);
  if (body.notes !== undefined) out.notes = String(body.notes || '').trim();
  if (body.alertOnEntry !== undefined) out.alertOnEntry = Boolean(body.alertOnEntry);
  if (body.alertOnExit !== undefined) out.alertOnExit = Boolean(body.alertOnExit);
  if (body.active !== undefined) out.active = Boolean(body.active);

  if (body.dwellAlertMinutes !== undefined) {
    const n = num(body.dwellAlertMinutes);
    if (n !== null && (n < 1 || n > 10080)) return { error: 'Stay alert must be between 1 minute and 7 days' };
    out.dwellAlertMinutes = n;
  }

  if (!partial || body.shape !== undefined) {
    const shape = body.shape || 'circle';
    if (!GEOFENCE_SHAPES.includes(shape)) return { error: 'Shape must be circle or polygon' };
    out.shape = shape;

    if (shape === 'circle') {
      const lat = num(body.center?.lat);
      const lng = num(body.center?.lng);
      if (lat === null || lng === null || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
        return { error: 'Pick the centre of the geofence on the map' };
      }
      const radius = num(body.radiusM);
      if (radius === null || radius < 50 || radius > 100000) {
        return { error: 'Radius must be between 50 m and 100 km' };
      }
      out.center = { lat, lng };
      out.radiusM = radius;
      out.polygon = [];
    } else {
      const points = (Array.isArray(body.polygon) ? body.polygon : [])
        .map((p) => ({ lat: num(p?.lat), lng: num(p?.lng) }))
        .filter((p) => p.lat !== null && p.lng !== null && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180);
      if (points.length < 3) return { error: 'A polygon needs at least three points' };
      out.polygon = points;
      out.center = null;
    }
  }

  if (body.vehicles !== undefined) {
    const ids = (Array.isArray(body.vehicles) ? body.vehicles : []).filter(isId);
    // Only the caller's own trucks — an id from another account is dropped
    // rather than stored as a dangling reference.
    const owned = ids.length
      ? await Truck.find({ _id: { $in: ids }, ...ownedBy(req) }).select('_id').lean()
      : [];
    out.vehicles = owned.map((t) => t._id);
  }

  if (body.customer !== undefined) out.customer = isId(body.customer) ? body.customer : null;

  return { fields: out };
};

router.get('/geofences', protect, requirePermission('tracking', 'read'), async (req, res) => {
  try {
    const geofences = await Geofence.find(ownedBy(req))
      .sort({ name: 1 })
      .populate('vehicles', 'number')
      .populate('customer', 'name')
      .lean();
    res.json({ success: true, geofences });
  } catch (error) {
    console.error('[alerts] geofence list failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to load geofences' });
  }
});

router.post('/geofences', protect, requirePermission('tracking', 'create'), async (req, res) => {
  try {
    const { fields, error } = await buildFence(req, req.body || {});
    if (error) return res.status(400).json({ success: false, error });

    const fence = await Geofence.create({ ...fields, owner: req.accountId, createdBy: req.user._id });
    invalidateAlertCache(req.accountId);
    await auditCreate(req, {
      entity: 'geofence',
      doc: fence,
      label: fence.name,
      fields: ['name', 'category', 'shape', 'radiusM', 'alertOnEntry', 'alertOnExit', 'dwellAlertMinutes', 'active']
    });

    res.status(201).json({ success: true, message: `Geofence ${fence.name} created`, geofence: fence });
  } catch (error) {
    if (error.name === 'ValidationError') return res.status(400).json({ success: false, error: error.message });
    console.error('[alerts] geofence create failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to create geofence' });
  }
});

router.put('/geofences/:id', protect, requirePermission('tracking', 'update'), async (req, res) => {
  try {
    if (!isId(req.params.id)) return res.status(404).json({ success: false, error: 'Geofence not found' });
    const before = await Geofence.findOne({ _id: req.params.id, ...ownedBy(req) }).lean();
    if (!before) return res.status(404).json({ success: false, error: 'Geofence not found' });

    const { fields, error } = await buildFence(req, req.body || {}, { partial: true });
    if (error) return res.status(400).json({ success: false, error });

    const fence = await Geofence.findOneAndUpdate(
      { _id: before._id, ...ownedBy(req) },
      { $set: { ...fields, updatedAt: new Date() } },
      { new: true, runValidators: true }
    );
    invalidateAlertCache(req.accountId);
    await auditUpdate(req, { entity: 'geofence', before, after: fence, fields, label: fence.name });

    res.json({ success: true, message: 'Geofence updated', geofence: fence });
  } catch (error) {
    if (error.name === 'ValidationError') return res.status(400).json({ success: false, error: error.message });
    console.error('[alerts] geofence update failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to update geofence' });
  }
});

router.delete('/geofences/:id', protect, requirePermission('tracking', 'delete'), async (req, res) => {
  try {
    if (!isId(req.params.id)) return res.status(404).json({ success: false, error: 'Geofence not found' });
    const fence = await Geofence.findOneAndDelete({ _id: req.params.id, ...ownedBy(req) });
    if (!fence) return res.status(404).json({ success: false, error: 'Geofence not found' });

    invalidateAlertCache(req.accountId);
    await auditDelete(req, {
      entity: 'geofence',
      doc: fence,
      label: fence.name,
      fields: ['name', 'category', 'shape', 'radiusM']
    });
    res.json({ success: true, message: `Geofence ${fence.name} deleted` });
  } catch (error) {
    console.error('[alerts] geofence delete failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to delete geofence' });
  }
});

// ---------------------------------------------------------------------------
// Alert history
// ---------------------------------------------------------------------------

// GET /api/alerts — the account's alerts with filters and paging. The bell
// shows the latest handful; this is the full, searchable record behind it.
router.get('/', protect, requirePermission('tracking', 'read'), async (req, res) => {
  try {
    const { category, severity, status, vehicle, from, to } = req.query;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));

    const filter = { ...ownedBy(req) };
    if (category) {
      // Compliance alerts predate the category field; recognise them by key.
      filter.$or =
        category === 'compliance'
          ? [{ category: 'compliance' }, { dedupeKey: /^(insurance|vehicle-doc|driver-doc):/ }]
          : category === 'offline'
            ? [{ category: 'offline' }, { dedupeKey: /^offline:/ }]
            : [{ category }];
    }
    if (severity) filter.severity = severity;
    if (status === 'open') filter.acknowledgedAt = null;
    if (status === 'acknowledged') filter.acknowledgedAt = { $ne: null };
    if (status === 'unread') filter.read = false;
    if (vehicle) {
      const escaped = String(vehicle).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.vehicle = new RegExp(escaped, 'i');
    }
    if (from || to) {
      filter.createdAt = {};
      if (from) filter.createdAt.$gte = new Date(from);
      if (to) {
        const end = new Date(to);
        end.setHours(23, 59, 59, 999);
        filter.createdAt.$lte = end;
      }
    }

    const [alerts, total, open] = await Promise.all([
      Notification.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      Notification.countDocuments(filter),
      Notification.countDocuments({ ...ownedBy(req), acknowledgedAt: null, type: 'alert' })
    ]);

    res.json({ success: true, alerts, total, page, pages: Math.ceil(total / limit) || 1, open });
  } catch (error) {
    console.error('[alerts] list failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to load alerts' });
  }
});

// POST /api/alerts/:id/acknowledge — someone has dealt with it. Also marks it
// read; acknowledging something you have not seen is not a thing.
router.post('/:id/acknowledge', protect, requirePermission('tracking', 'read'), async (req, res) => {
  try {
    if (!isId(req.params.id)) return res.status(404).json({ success: false, error: 'Alert not found' });
    const alert = await Notification.findOneAndUpdate(
      { _id: req.params.id, ...ownedBy(req) },
      {
        $set: {
          read: true,
          acknowledgedAt: new Date(),
          acknowledgedBy: req.user._id,
          acknowledgedByName: req.user.name || ''
        }
      },
      { new: true }
    );
    if (!alert) return res.status(404).json({ success: false, error: 'Alert not found' });
    res.json({ success: true, alert });
  } catch (error) {
    console.error('[alerts] acknowledge failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to acknowledge alert' });
  }
});

export default router;
