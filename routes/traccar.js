import express from 'express';
import crypto from 'crypto';
import Device from '../models/Device.js';
import Position from '../models/Position.js';

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

    // Traccar always knows the device; uniqueId is our join key.
    const uniqueId = device?.uniqueId || String(position.deviceId);
    if (!uniqueId) {
      return res.status(400).json({ success: false, error: 'Missing device uniqueId' });
    }

    const attributes = position.attributes || {};
    const ignition = asBool(attributes.ignition);
    const fixTime = parseTime(position.fixTime ?? position.deviceTime);

    // Auto-register on first sighting so a new phone just works.
    const trackedDevice = await Device.findOneAndUpdate(
      { uniqueId },
      {
        $set: {
          traccarId: position.deviceId ?? device?.id,
          lastSeenAt: new Date(),
          lastPosition: {
            latitude: position.latitude,
            longitude: position.longitude,
            speed: (position.speed || 0) * KNOTS_TO_KMH,
            course: position.course || 0,
            ignition,
            fixTime
          }
        },
        $setOnInsert: {
          uniqueId,
          name: device?.name || `Device ${uniqueId}`
        }
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    await Position.create({
      device: trackedDevice._id,
      deviceUniqueId: uniqueId,
      latitude: position.latitude,
      longitude: position.longitude,
      speed: (position.speed || 0) * KNOTS_TO_KMH,
      course: position.course || 0,
      altitude: position.altitude,
      accuracy: position.accuracy,
      ignition,
      battery: attributes.batteryLevel ?? attributes.battery,
      motion: asBool(attributes.motion),
      valid: position.valid !== false,
      protocol: position.protocol,
      fixTime,
      serverTime: new Date(),
      attributes
    });

    console.log(
      `[traccar] ${uniqueId} @ ${position.latitude.toFixed(5)},${position.longitude.toFixed(5)} ` +
      `speed=${((position.speed || 0) * KNOTS_TO_KMH).toFixed(1)}km/h ignition=${ignition}`
    );

    // Traccar only needs a 2xx; a non-2xx makes it retry.
    res.status(200).json({ success: true });
  } catch (error) {
    console.error('[traccar] forward failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to store position' });
  }
});

export default router;
