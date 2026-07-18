import express from 'express';
import Device from '../models/Device.js';
import Position from '../models/Position.js';
import TrackToken from '../models/TrackToken.js';
import { protect } from '../middleware/auth.js';
import * as traccar from '../services/traccarAdmin.js';
import { registerDevice } from '../services/deviceRegistration.js';

const router = express.Router();

const MAX_TTL_MINUTES = 60 * 24 * 7; // a share link may not outlive one week

// ---------------------------------------------------------------------------
// Authenticated: fleet owner manages devices and share links
// ---------------------------------------------------------------------------

// Devices arriving from Traccar have no owner until a user claims them, so every
// device *mutation* (delete, share) stays scoped to the caller. Without this, one
// customer could delete or mint a public share link for another customer's truck.
const ownedBy = (req) => ({ owner: req.user._id });

// GET /api/track/devices — the caller's own devices plus any still-unclaimed ones.
//
// Devices added straight in the Traccar admin portal (or a phone switched on
// before it was registered through the app) land in Mongo via the forward hook
// with no owner. Listing those alongside the caller's own devices means such a
// device shows up in the frontend as soon as it reports its first position —
// "auto-adopt", no separate claim step. Newest activity first.
//
// NOTE: mutating a device (delete / share link) still requires ownership, so an
// unclaimed device is visible-but-read-only until adopted. In a multi-tenant
// deployment every account would see every unclaimed device here; that is the
// deliberate trade for zero-touch adoption on a single-account install.
router.get('/devices', protect, async (req, res) => {
  try {
    // Adopt every currently-unclaimed device to the caller, so it stops being an
    // orphan and becomes fully usable (shareable, deletable) — not just visible.
    // First caller to list wins; already-owned devices are untouched.
    await Device.updateMany(
      { owner: { $exists: false } },
      { $set: { owner: req.user._id } }
    );

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
    const { device, setup } = await registerDevice({
      name: req.body.name,
      type: req.body.type,
      uniqueId: req.body.uniqueId,
      ownerId: req.user._id
    });

    res.status(201).json({
      success: true,
      message: `${device.name} registered`,
      device,
      setup
    });
  } catch (error) {
    if (error.status) {
      return res.status(error.status).json({ success: false, error: error.message });
    }
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
