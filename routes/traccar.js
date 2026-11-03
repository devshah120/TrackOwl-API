import express from 'express';
import crypto from 'crypto';
import Device from '../models/Device.js';
import Position from '../models/Position.js';
import { isValidImei } from '../services/deviceRegistration.js';
import { assessFix } from '../services/positionQuality.js';
import { evaluateFix } from '../services/gpsAlerts.js';

const router = express.Router();

const KNOTS_TO_KMH = 1.852;

// Traccar's forward.header is a plain shared secret. Compare in constant time so
// the endpoint can't be probed byte-by-byte with timing.
const secretMatches = (provided) => {
  const expected = process.env.TRACCAR_FORWARD_SECRET;
  if (!expected || !provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
};

// Traccar has sent fixTime as epoch millis in some versions and ISO-8601 in
// others; accept either and fall back to arrival time.
const parseTime = (value) => {
  if (value === undefined || value === null) return new Date();
  const date = typeof value === 'number' ? new Date(value) : new Date(String(value));
  return Number.isNaN(date.getTime()) ? new Date() : date;
};

// Attributes arrive as strings from some protocols ("true"/"1").
const asBool = (value) => value === true || value === 'true' || value === 1 || value === '1';

/**
 * POST /api/traccar/forward
 * Called by Traccar itself (forward.enable=true, forward.type=json).
 * Body: { position: {...}, device: {...} }
 *
 * Every packet is answered 200 once it has been dealt with — including the
 * ones that are discarded as duplicates or kept only as history. Traccar
 * retries anything else, and a retried duplicate is exactly what this guards
 * against.
 *
 * What happens to a packet:
 *   duplicate     same device, fix time and coordinates as a stored fix
 *                 (a reconnect replaying its buffer) — dropped.
 *   rejected      fails services/positionQuality.js — stored with
 *                 valid:false, so trails and replays skip it, and never
 *                 becomes the live position.
 *   out of order  valid but older than the live position (buffered data
 *                 arriving after newer data) — stored as history only.
 *   current       valid and newest — becomes the live position and is run
 *                 through the alert engine.
 */
router.post('/forward', async (req, res) => {
  if (!secretMatches(req.get('X-Traccar-Secret'))) {
    return res.status(401).json({ success: false, error: 'Invalid forwarding secret' });
  }

  try {
    const { position, device } = req.body || {};

    if (!position || typeof position.latitude !== 'number' || typeof position.longitude !== 'number') {
      return res.status(400).json({ success: false, error: 'Missing position coordinates' });
    }

    const uniqueId = device?.uniqueId || String(position.deviceId);
    if (!uniqueId) {
      return res.status(400).json({ success: false, error: 'Missing device uniqueId' });
    }

    const attributes = position.attributes || {};
    const ignition = asBool(attributes.ignition);
    const fixTime = parseTime(position.fixTime ?? position.deviceTime);
    const speed = (position.speed || 0) * KNOTS_TO_KMH;

    // The device has communicated, whatever the packet turns out to be worth —
    // lastSeenAt is "when did it last talk to us", which is what the offline
    // alert and the "last communication" column need.
    //
    // new:false returns the device as it was before this packet, so its
    // lastPosition is the previous live fix. A brand-new unit returns null.
    const before = await Device.findOneAndUpdate(
      { uniqueId },
      {
        $set: {
          traccarId: position.deviceId ?? device?.id,
          lastSeenAt: new Date(),
          ...(position.protocol ? { reportedProtocol: String(position.protocol).toLowerCase() } : {})
        },
        $setOnInsert: {
          uniqueId,
          name: device?.name || `Device ${uniqueId}`,
          deviceType: isValidImei(uniqueId) ? 'hardware' : 'phone'
        }
      },
      { upsert: true, new: false, setDefaultsOnInsert: true }
    );
    const trackedDevice = before || (await Device.findOne({ uniqueId }));

    const duplicate = await Position.exists({
      device: trackedDevice._id,
      fixTime,
      latitude: position.latitude,
      longitude: position.longitude
    });
    if (duplicate) {
      await Device.updateOne({ _id: trackedDevice._id }, { $inc: { 'ingestStats.duplicates': 1 } });
      return res.status(200).json({ success: true, duplicate: true });
    }

    // The quality check compares against the nearest earlier good fix, not the
    // live one, so an out-of-order packet is judged against its own neighbour.
    const previousGood = await Position.findOne({
      device: trackedDevice._id,
      valid: { $ne: false },
      fixTime: { $lt: fixTime }
    })
      .sort({ fixTime: -1 })
      .select('latitude longitude fixTime')
      .lean();

    const verdict = assessFix(
      { latitude: position.latitude, longitude: position.longitude, fixTime, valid: position.valid !== false },
      previousGood
    );

    await Position.create({
      device: trackedDevice._id,
      deviceUniqueId: uniqueId,
      latitude: position.latitude,
      longitude: position.longitude,
      speed,
      course: position.course || 0,
      altitude: position.altitude,
      accuracy: position.accuracy,
      ignition,
      battery: attributes.batteryLevel ?? attributes.battery,
      motion: asBool(attributes.motion),
      valid: verdict.valid,
      protocol: position.protocol,
      fixTime,
      serverTime: new Date(),
      attributes: verdict.valid ? attributes : { ...attributes, rejectReason: verdict.reason }
    });

    if (!verdict.valid) {
      await Device.updateOne(
        { _id: trackedDevice._id },
        {
          $inc: { 'ingestStats.rejected': 1 },
          $set: { 'ingestStats.lastRejectReason': verdict.reason, 'ingestStats.lastRejectAt': new Date() }
        }
      );
      console.warn(`[traccar] ${uniqueId} fix rejected (${verdict.reason})`);
      return res.status(200).json({ success: true, accepted: false, reason: verdict.reason });
    }

    const live = {
      latitude: position.latitude,
      longitude: position.longitude,
      speed,
      course: position.course || 0,
      ignition,
      fixTime
    };

    // Only a fix newer than the live one may replace it. The filter repeats the
    // comparison so two packets racing each other cannot leave the older one in
    // place.
    const promoted = await Device.updateOne(
      {
        _id: trackedDevice._id,
        $or: [{ 'lastPosition.fixTime': { $exists: false } }, { 'lastPosition.fixTime': null }, { 'lastPosition.fixTime': { $lt: fixTime } }]
      },
      { $set: { lastPosition: live }, $inc: { 'ingestStats.accepted': 1 } }
    );

    if (promoted.modifiedCount === 0) {
      await Device.updateOne({ _id: trackedDevice._id }, { $inc: { 'ingestStats.outOfOrder': 1 } });
      return res.status(200).json({ success: true, accepted: true, current: false });
    }

    // Not awaited: alerts are a side effect and must not hold Traccar's
    // connection open. evaluateFix catches its own errors.
    evaluateFix(trackedDevice, live, before?.lastPosition?.fixTime ? before.lastPosition : null);

    console.log(
      `[traccar] ${uniqueId} @ ${position.latitude.toFixed(5)},${position.longitude.toFixed(5)} ` +
      `speed=${speed.toFixed(1)}km/h ignition=${ignition}`
    );

    res.status(200).json({ success: true, accepted: true, current: true });
  } catch (error) {
    console.error('[traccar] forward failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to store position' });
  }
});

export default router;
