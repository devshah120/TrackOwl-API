import express from 'express';
import Device from '../models/Device.js';
import Position from '../models/Position.js';
import TrackToken from '../models/TrackToken.js';
import { protect } from '../middleware/auth.js';

const router = express.Router();

const MAX_TTL_MINUTES = 60 * 24 * 7; // a share link may not outlive one week

// ---------------------------------------------------------------------------
// Authenticated: fleet owner manages devices and share links
// ---------------------------------------------------------------------------

// GET /api/track/devices — devices seen by the gateway, newest activity first
router.get('/devices', protect, async (req, res) => {
  try {
    const devices = await Device.find().sort({ lastSeenAt: -1 });
    res.json({ success: true, devices });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to fetch devices' });
  }
});

// DELETE /api/track/devices/:id — remove a device and everything hanging off it.
// Note this only clears our records; if the device is still registered in Traccar
// and still reporting, the forward hook will simply recreate it on the next fix.
router.delete('/devices/:id', protect, async (req, res) => {
  try {
    const device = await Device.findByIdAndDelete(req.params.id);
    if (!device) {
      return res.status(404).json({ success: false, error: 'Device not found' });
    }

    // Don't leave orphaned positions or live share links behind.
    await Promise.all([
      Position.deleteMany({ device: device._id }),
      TrackToken.deleteMany({ device: device._id })
    ]);

    res.json({ success: true, message: `Removed ${device.name}` });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to delete device' });
  }
});

// POST /api/track/tokens — issue a short-lived public link for one device
router.post('/tokens', protect, async (req, res) => {
  try {
    const { deviceId, ttlMinutes = 60, label = '' } = req.body;

    const device = await Device.findById(deviceId);
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
