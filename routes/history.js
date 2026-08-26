import express from 'express';
import Device from '../models/Device.js';
import Position from '../models/Position.js';
import { protect, requirePermission } from '../middleware/auth.js';
import { detectStops } from '../utils/tripStops.js';
import { describePoints } from '../services/placeLookup.js';

const router = express.Router();

// Device history is scoped to the caller, same as everything else that touches
// position data — a device's movements are exactly the thing another account
// must not be able to read.
const ownedBy = (req) => ({ owner: req.accountId });

// Same guards the trip trail uses: a fix with a huge error radius is a
// cell-tower estimate rather than a satellite lock, and a near-null coordinate
// is a partial lock sitting thousands of km from any real route.
const MAX_ACCURACY_M = 5000;
const isPlausibleFix = (p) => {
  if (!Number.isFinite(p.latitude) || !Number.isFinite(p.longitude)) return false;
  if (Math.abs(p.latitude) < 0.01 && Math.abs(p.longitude) < 0.01) return false;
  if (p.accuracy != null && p.accuracy > MAX_ACCURACY_M) return false;
  return true;
};

// Cap on points drawn for one day. A device reporting every few seconds logs
// tens of thousands over 24h; this keeps the response sane while still tracing
// the day's shape.
const MAX_PATH_POINTS = 3000;

const distanceMeters = (a, b) => {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLng = toRad(b.longitude - a.longitude);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
};

// Sum of point-to-point distance along a run of fixes, in km.
//
// Segments longer than this are dropped: when a tracker goes silent and
// resurfaces elsewhere, the straight line between those two fixes is not a
// distance the vehicle demonstrably drove, and counting it would inflate the
// day's total with a road that was never taken. Excluded rather than estimated,
// so the number stays "distance we actually tracked".
const MAX_SEGMENT_M = 2000;

const pathDistanceKm = (fixes) => {
  let meters = 0;
  for (let i = 1; i < fixes.length; i++) {
    const d = distanceMeters(fixes[i - 1], fixes[i]);
    if (d <= MAX_SEGMENT_M) meters += d;
  }
  return meters / 1000;
};

// Resolve a YYYY-MM-DD day (in the caller's timezone offset) to a UTC range.
// The browser sends its offset so "3 August" means the operator's 3 August, not
// UTC's — without it an IST fleet sees its early-morning movements filed under
// the previous day.
const dayRange = (dateStr, tzOffsetMin = 0) => {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  if (!y || !m || !d) return null;
  // getTimezoneOffset() is minutes *behind* UTC, so adding it converts local
  // midnight to the corresponding UTC instant.
  const startUtc = Date.UTC(y, m - 1, d, 0, 0, 0) + tzOffsetMin * 60000;
  return { from: new Date(startUtc), to: new Date(startUtc + 24 * 60 * 60 * 1000) };
};

// GET /api/history/:deviceId?date=YYYY-MM-DD&tz=-330
//
// One day of a vehicle's movement: the path it drove, where it held and for how
// long, and how far it covered. This is the "what did this truck do on Tuesday"
// view, as opposed to the trip-scoped trail which only covers a planned job.
router.get('/:deviceId', protect, requirePermission('tracking', 'read'), async (req, res) => {
  try {
    const device = await Device.findOne({ _id: req.params.deviceId, ...ownedBy(req) })
      .select('name uniqueId');
    if (!device) return res.status(404).json({ success: false, error: 'Device not found' });

    const tz = Number(req.query.tz);
    const range = dayRange(req.query.date, Number.isFinite(tz) ? tz : 0);
    if (!range) {
      return res.status(400).json({ success: false, error: 'A valid date (YYYY-MM-DD) is required' });
    }

    const raw = await Position.find({
      device: device._id,
      fixTime: { $gte: range.from, $lt: range.to },
      valid: { $ne: false },
      latitude: { $ne: 0 },
      longitude: { $ne: 0 },
    })
      .sort({ fixTime: 1 })
      .select('latitude longitude accuracy speed ignition fixTime -_id')
      .lean();

    const fixes = raw.filter(isPlausibleFix);

    if (!fixes.length) {
      return res.json({
        success: true,
        device: { id: device._id, name: device.name },
        date: req.query.date,
        path: [],
        stops: [],
        summary: { distanceKm: 0, movingMs: 0, idleMs: 0, trackedMs: 0, fixCount: 0, firstFixAt: null, lastFixAt: null },
      });
    }

    // Thin for drawing only — every nth point so the line spans the whole day
    // rather than stopping partway. Stops and distance always use every fix.
    const stride = Math.ceil(fixes.length / MAX_PATH_POINTS) || 1;
    const path = fixes
      .filter((_, i) => i % stride === 0 || i === fixes.length - 1)
      .map((p) => [p.latitude, p.longitude]);

    let stops = [];
    try {
      stops = await describePoints(detectStops(fixes));
    } catch (err) {
      console.error('[history] stop detection failed:', err.message);
    }

    const idleMs = stops.reduce((sum, s) => sum + (s.durationMs || 0), 0);
    const trackedMs = new Date(fixes[fixes.length - 1].fixTime) - new Date(fixes[0].fixTime);

    res.json({
      success: true,
      device: { id: device._id, name: device.name },
      date: req.query.date,
      path,
      stops,
      summary: {
        distanceKm: Math.round(pathDistanceKm(fixes) * 10) / 10,
        // Time between the first and last fix, minus time held. Bounded at zero
        // because a day made entirely of stops can round the other way.
        movingMs: Math.max(0, trackedMs - idleMs),
        idleMs,
        trackedMs,
        fixCount: fixes.length,
        firstFixAt: fixes[0].fixTime,
        lastFixAt: fixes[fixes.length - 1].fixTime,
      },
    });
  } catch (error) {
    console.error('[history] lookup failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to load history' });
  }
});

// GET /api/history/:deviceId/summary?from=YYYY-MM-DD&to=YYYY-MM-DD&tz=-330
//
// Per-day distance across a range, for the "all date-wise km" table. Computed
// with one aggregation-free pass over the range rather than a query per day, so
// a month costs one round trip.
router.get('/:deviceId/summary', protect, requirePermission('tracking', 'read'), async (req, res) => {
  try {
    const device = await Device.findOne({ _id: req.params.deviceId, ...ownedBy(req) }).select('name');
    if (!device) return res.status(404).json({ success: false, error: 'Device not found' });

    const tz = Number(req.query.tz);
    const tzOffset = Number.isFinite(tz) ? tz : 0;
    const start = dayRange(req.query.from, tzOffset);
    const end = dayRange(req.query.to, tzOffset);
    if (!start || !end) {
      return res.status(400).json({ success: false, error: 'Valid from and to dates are required' });
    }

    // A wide range on a fast-reporting device is a lot of documents; cap the
    // span rather than let one request pull a year of fixes into memory.
    const MAX_DAYS = 62;
    const days = Math.round((end.to - start.from) / (24 * 60 * 60 * 1000));
    if (days > MAX_DAYS) {
      return res.status(400).json({ success: false, error: `Range too large — ${MAX_DAYS} days maximum` });
    }

    const raw = await Position.find({
      device: device._id,
      fixTime: { $gte: start.from, $lt: end.to },
      valid: { $ne: false },
      latitude: { $ne: 0 },
      longitude: { $ne: 0 },
    })
      .sort({ fixTime: 1 })
      .select('latitude longitude accuracy speed ignition fixTime -_id')
      .lean();

    // Bucket by the caller's local day, so a fix at 00:30 IST belongs to that
    // day and not to the UTC day before it.
    const buckets = new Map();
    for (const p of raw.filter(isPlausibleFix)) {
      const localMs = new Date(p.fixTime).getTime() - tzOffset * 60000;
      const key = new Date(localMs).toISOString().slice(0, 10);
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(p);
    }

    const rows = [...buckets.entries()]
      .sort(([a], [b]) => (a < b ? 1 : -1)) // newest day first
      .map(([date, dayFixes]) => {
        const stops = detectStops(dayFixes);
        const idleMs = stops.reduce((sum, s) => sum + (s.durationMs || 0), 0);
        const trackedMs =
          new Date(dayFixes[dayFixes.length - 1].fixTime) - new Date(dayFixes[0].fixTime);
        return {
          date,
          distanceKm: Math.round(pathDistanceKm(dayFixes) * 10) / 10,
          stopCount: stops.length,
          idleMs,
          movingMs: Math.max(0, trackedMs - idleMs),
          trackedMs,
          firstFixAt: dayFixes[0].fixTime,
          lastFixAt: dayFixes[dayFixes.length - 1].fixTime,
        };
      });

    res.json({
      success: true,
      device: { id: device._id, name: device.name },
      days: rows,
      totals: {
        distanceKm: Math.round(rows.reduce((s, r) => s + r.distanceKm, 0) * 10) / 10,
        idleMs: rows.reduce((s, r) => s + r.idleMs, 0),
        movingMs: rows.reduce((s, r) => s + r.movingMs, 0),
        activeDays: rows.length,
      },
    });
  } catch (error) {
    console.error('[history] summary failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to load summary' });
  }
});

export default router;
