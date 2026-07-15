import express from 'express';
import crypto from 'crypto';
import Device from '../models/Device.js';
import Position from '../models/Position.js';
import TrackToken from '../models/TrackToken.js';
import { protect } from '../middleware/auth.js';
import * as traccar from '../services/traccarAdmin.js';

const router = express.Router();

const MAX_TTL_MINUTES = 60 * 24 * 7; // a share link may not outlive one week

// What the user types into the Traccar Client app. The phone talks the OsmAnd
// protocol on 5055 — never the web-UI port.
const phoneServerUrl = () =>
  process.env.TRACCAR_PHONE_URL || 'http://103.212.121.139:5055';

// Hardware trackers (e.g. Teltonika FMB920) speak the binary Teltonika protocol
// on 5027. Unlike the phone they take Domain + Port as separate fields, so the
// setup block for them is split rather than a single URL.
const hardwareHost = () => process.env.TRACCAR_HARDWARE_HOST || '103.212.121.139';
const hardwarePort = () => process.env.TRACCAR_HARDWARE_PORT || '5027';

// A hardware unit's identity is its IMEI: 15–17 digits, baked into the device.
const isValidImei = (value) => /^\d{15,17}$/.test(value);

// Short, unambiguous device ids: no vowels (kills accidental words) and no
// 0/O/1/I, since these get typed by hand into a phone.
const generateUniqueId = () =>
  'trk-' + Array.from(crypto.randomBytes(6))
    .map((b) => '23456789abcdefghjkmnpqrstuvwxyz'[b % 30])
    .join('');

// ---------------------------------------------------------------------------
// Authenticated: fleet owner manages devices and share links
// ---------------------------------------------------------------------------

// Devices arriving from Traccar have no owner until a user claims them, so every
// device query is scoped to the caller. Without this, one customer sees another
// customer's trucks — and could mint a public share link for them.
const ownedBy = (req) => ({ owner: req.user._id });

// GET /api/track/devices — only the caller's devices, newest activity first
router.get('/devices', protect, async (req, res) => {
  try {
    const devices = await Device.find(ownedBy(req)).sort({ lastSeenAt: -1 });
    res.json({ success: true, devices });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to fetch devices' });
  }
});

// POST /api/track/devices — register a new vehicle in one step: create it in the
// Traccar gateway (so the phone's packets are accepted) and claim it for the caller.
// Returns the exact settings to type into the Traccar Client app.
router.post('/devices', protect, async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    if (!name) {
      return res.status(400).json({ success: false, error: 'Vehicle name is required' });
    }

    if (!traccar.isConfigured()) {
      return res.status(503).json({
        success: false,
        error: 'Traccar admin credentials are not configured on the server'
      });
    }

    // 'phone' (Traccar Client app, OsmAnd/5055) or 'hardware' (Teltonika/5027).
    const type = req.body.type === 'hardware' ? 'hardware' : 'phone';

    // A hardware unit's uniqueId is its IMEI — fixed in the device, so it's
    // required and validated. A phone id may be supplied (e.g. a number plate)
    // or generated. IMEIs are digits, so lowercasing is safe for both.
    let uniqueId;
    if (type === 'hardware') {
      uniqueId = String(req.body.uniqueId || '').trim();
      if (!isValidImei(uniqueId)) {
        return res.status(400).json({
          success: false,
          error: 'A valid IMEI (15–17 digits) is required for a GPS device'
        });
      }
    } else {
      uniqueId = String(req.body.uniqueId || '').trim().toLowerCase() || generateUniqueId();
    }

    if (await Device.findOne({ uniqueId })) {
      return res.status(409).json({ success: false, error: 'That device ID is already in use' });
    }

    // Register in Traccar first — if this fails there is no point creating our record,
    // since the phone's positions would be rejected at the gateway.
    let traccarDevice;
    try {
      traccarDevice = await traccar.createDevice({ name, uniqueId });
    } catch (err) {
      const clash = err.status === 400;
      return res.status(clash ? 409 : 502).json({
        success: false,
        error: clash
          ? 'That device ID is already registered in the gateway'
          : `Could not reach the Traccar gateway: ${err.message}`
      });
    }

    const device = await Device.create({
      uniqueId,
      name,
      traccarId: traccarDevice.id,
      owner: req.user._id
    });

    res.status(201).json({
      success: true,
      message: `${name} registered`,
      device,
      // Everything the user must enter to point the device at the gateway.
      // Shape differs by type: the phone takes one URL; hardware takes the
      // Domain/Port/Protocol fields shown on the FMB920 config screen.
      setup: type === 'hardware'
        ? {
            type: 'hardware',
            domain: hardwareHost(),
            port: hardwarePort(),
            protocol: 'TCP',
            deviceIdentifier: uniqueId  // the IMEI, for reference
          }
        : {
            type: 'phone',
            serverUrl: phoneServerUrl(),
            deviceIdentifier: uniqueId
          }
    });
  } catch (error) {
    console.error('[track] device registration failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to register device' });
  }
});

// GET /api/track/devices/unclaimed — devices the gateway has seen that nobody owns
// yet. This is how a user discovers the uniqueId of a phone they just switched on.
router.get('/devices/unclaimed', protect, async (req, res) => {
  try {
    const devices = await Device.find({ owner: { $exists: false } })
      .sort({ lastSeenAt: -1 })
      .select('uniqueId name lastSeenAt');
    res.json({ success: true, devices });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to fetch unclaimed devices' });
  }
});

// POST /api/track/devices/claim — take ownership of a device by its uniqueId.
// Claiming is first-come-first-served: an already-owned device cannot be stolen.
router.post('/devices/claim', protect, async (req, res) => {
  try {
    const { uniqueId, name } = req.body;
    if (!uniqueId) {
      return res.status(400).json({ success: false, error: 'uniqueId is required' });
    }

    const device = await Device.findOne({ uniqueId: String(uniqueId).trim() });
    if (!device) {
      return res.status(404).json({
        success: false,
        error: 'No device with that ID has reported yet. Turn the phone on and try again.'
      });
    }

    if (device.owner && !device.owner.equals(req.user._id)) {
      return res.status(409).json({ success: false, error: 'That device is already claimed' });
    }

    device.owner = req.user._id;
    if (name) device.name = String(name).trim();
    await device.save();

    res.json({ success: true, message: `Claimed ${device.name}`, device });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to claim device' });
  }
});

// DELETE /api/track/devices/:id — remove one of the caller's devices everywhere.
router.delete('/devices/:id', protect, async (req, res) => {
  try {
    const device = await Device.findOneAndDelete({ _id: req.params.id, ...ownedBy(req) });
    if (!device) {
      return res.status(404).json({ success: false, error: 'Device not found' });
    }

    // Don't leave orphaned positions or live share links behind.
    await Promise.all([
      Position.deleteMany({ device: device._id }),
      TrackToken.deleteMany({ device: device._id })
    ]);

    // Also drop it from the gateway. Without this the phone keeps reporting and the
    // forward hook simply recreates the device (unowned) on its next fix. Best effort:
    // our records are already gone, so a gateway failure must not fail the request.
    if (device.traccarId && traccar.isConfigured()) {
      try {
        await traccar.deleteDevice(device.traccarId);
      } catch (err) {
        console.warn(`[track] removed ${device.uniqueId} locally but not from Traccar: ${err.message}`);
      }
    }

    res.json({ success: true, message: `Removed ${device.name}` });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to delete device' });
  }
});

// POST /api/track/tokens — issue a short-lived public link for one device
router.post('/tokens', protect, async (req, res) => {
  try {
    const { deviceId, ttlMinutes = 60, label = '' } = req.body;

    // Scoped to the caller: a share link is public, so issuing one for someone
    // else's vehicle would expose their live location.
    const device = await Device.findOne({ _id: deviceId, ...ownedBy(req) });
    if (!device) {
      return res.status(404).json({ success: false, error: 'Device not found' });
    }

    const ttl = Number(ttlMinutes);
    if (!Number.isFinite(ttl) || ttl < 1 || ttl > MAX_TTL_MINUTES) {
      return res.status(400).json({
        success: false,
        error: `ttlMinutes must be between 1 and ${MAX_TTL_MINUTES}`
      });
    }

    const { rawToken, doc } = await TrackToken.issue({
      device: device._id,
      createdBy: req.user._id,
      ttlMinutes: ttl,
      label: String(label).trim()
    });

    const base = process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 5000}`;

    // rawToken is returned here and never again — it is not recoverable.
    res.status(201).json({
      success: true,
      token: rawToken,
      url: `${base}/track/${rawToken}`,
      expiresAt: doc.expiresAt,
      device: { id: device._id, name: device.name }
    });
  } catch (error) {
    console.error('[track] issue token failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to create tracking link' });
  }
});

// GET /api/track/tokens — list this user's links (hash only, never the token)
router.get('/tokens', protect, async (req, res) => {
  try {
    const tokens = await TrackToken.find({ createdBy: req.user._id })
      .populate('device', 'name uniqueId')
      .sort({ createdAt: -1 })
      .select('-tokenHash');
    res.json({ success: true, tokens });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to fetch tracking links' });
  }
});

// DELETE /api/track/tokens/:id — revoke a link before it expires
router.delete('/tokens/:id', protect, async (req, res) => {
  try {
    const token = await TrackToken.findOneAndUpdate(
      { _id: req.params.id, createdBy: req.user._id },
      { $set: { revokedAt: new Date() } },
      { new: true }
    );
    if (!token) {
      return res.status(404).json({ success: false, error: 'Tracking link not found' });
    }
    res.json({ success: true, message: 'Tracking link revoked' });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to revoke tracking link' });
  }
});

// ---------------------------------------------------------------------------
// Public: the client opens /track/<token> and this feeds the map. No JWT.
// ---------------------------------------------------------------------------

// GET /api/track/public/:token — current position + recent trail
router.get('/public/:token', async (req, res) => {
  try {
    const record = await TrackToken.findOne({
      tokenHash: TrackToken.hash(req.params.token)
    }).populate('device');

    // Same response for unknown, revoked and expired: don't leak which it was.
    if (!record || !record.isUsable() || !record.device) {
      return res.status(404).json({ success: false, error: 'This tracking link is invalid or has expired' });
    }

    // Fire-and-forget view accounting; must not delay the response.
    TrackToken.updateOne(
      { _id: record._id },
      { $inc: { viewCount: 1 }, $set: { lastViewedAt: new Date() } }
    ).catch(() => {});

    const trail = await Position.find({ device: record.device._id })
      .sort({ fixTime: -1 })
      .limit(50)
      .select('latitude longitude speed course ignition fixTime -_id');

    const device = record.device;

    // Deliberately narrow: the public sees the vehicle, not the fleet account.
    res.json({
      success: true,
      device: {
        name: device.name,
        status: device.status,
        lastSeenAt: device.lastSeenAt
      },
      position: device.lastPosition?.latitude ? device.lastPosition : null,
      trail: trail.reverse(),
      expiresAt: record.expiresAt
    });
  } catch (error) {
    console.error('[track] public lookup failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to load tracking data' });
  }
});

export default router;
