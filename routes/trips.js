import express from 'express';
import Trip from '../models/Trip.js';
import Device from '../models/Device.js';
import Position from '../models/Position.js';
import TrackToken from '../models/TrackToken.js';
import { protect } from '../middleware/auth.js';
import { sendTripCreatedEmail, sendTripCompletedEmail } from '../services/emailService.js';

const router = express.Router();

// Every trip belongs to the caller; a trip is publicly shareable, so an unscoped
// query would let one account see (and share) another account's journeys.
const ownedBy = (req) => ({ owner: req.user._id });

// Validate a { name, lat, lng } place coming from the frontend's Places search.
const cleanPlace = (place) => {
  if (!place || typeof place !== 'object') return null;
  const name = String(place.name || '').trim();
  const lat = Number(place.lat);
  const lng = Number(place.lng);
  if (!name || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { name, lat, lng };
};

// ---------------------------------------------------------------------------
// Authenticated: fleet owner manages trips
// ---------------------------------------------------------------------------

// GET /api/trips — the caller's trips, newest first, with the device populated so
// the list can show which vehicle each trip is for.
router.get('/', protect, async (req, res) => {
  try {
    const trips = await Trip.find(ownedBy(req))
      .populate('device', 'name uniqueId lastPosition lastSeenAt')
      .sort({ createdAt: -1 });
    res.json({ success: true, trips });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to fetch trips' });
  }
});

// POST /api/trips — create a trip for one of the caller's devices.
// The frontend resolves origin/destination to coordinates (Places search) and
// the road route (OSRM) before calling this, so we just persist what it sends.
router.post('/', protect, async (req, res) => {
  try {
    const { deviceId, note = '', routePolyline, distanceKm, durationMin } = req.body || {};

    // Device must belong to the caller — no planning trips for other fleets.
    const device = await Device.findOne({ _id: deviceId, ...ownedBy(req) });
    if (!device) {
      return res.status(404).json({ success: false, error: 'Device not found' });
    }

    const origin = cleanPlace(req.body.origin);
    const destination = cleanPlace(req.body.destination);
    if (!origin || !destination) {
      return res.status(400).json({
        success: false,
        error: 'Both a valid From and To location are required'
      });
    }

    // routePolyline arrives as [[lat, lng], ...]; keep only well-formed pairs so a
    // malformed client payload can't poison the stored geometry.
    let polyline;
    if (Array.isArray(routePolyline)) {
      polyline = routePolyline
        .filter((p) => Array.isArray(p) && p.length === 2 &&
          Number.isFinite(Number(p[0])) && Number.isFinite(Number(p[1])))
        .map((p) => [Number(p[0]), Number(p[1])]);
      if (polyline.length === 0) polyline = undefined;
    }

    const trip = await Trip.create({
      device: device._id,
      owner: req.user._id,
      origin,
      destination,
      routePolyline: polyline,
      distanceKm: Number.isFinite(Number(distanceKm)) ? Number(distanceKm) : undefined,
      durationMin: Number.isFinite(Number(durationMin)) ? Number(durationMin) : undefined,
      note: String(note).trim()
    });

    const populated = await trip.populate('device', 'name uniqueId lastPosition lastSeenAt');

    // Notify the fleet owner that a trip was created. Fire-and-forget: a mail
    // failure must never fail the request or leave a trip half-created.
    if (req.user?.email) {
      sendTripCreatedEmail(req.user.email, req.user.name, populated, populated.device?.name)
        .catch((err) => console.error('[trips] created email failed:', err.message));
    }

    res.status(201).json({ success: true, trip: populated });
  } catch (error) {
    console.error('[trips] create failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to create trip' });
  }
});

// PATCH /api/trips/:id — update mutable fields (status, note). Kept minimal:
// origin/destination are fixed at creation since the cached route depends on them.
router.patch('/:id', protect, async (req, res) => {
  try {
    const updates = {};
    if (req.body.status !== undefined) {
      const allowed = ['planned', 'active', 'completed', 'cancelled'];
      if (!allowed.includes(req.body.status)) {
        return res.status(400).json({ success: false, error: 'Invalid status' });
      }
      updates.status = req.body.status;
    }
    if (req.body.note !== undefined) updates.note = String(req.body.note).trim();

    // Read the current status first so we only email on an actual transition
    // into 'completed' — not on every PATCH that re-sends the same status.
    const existing = await Trip.findOne({ _id: req.params.id, ...ownedBy(req) }).select('status');
    if (!existing) return res.status(404).json({ success: false, error: 'Trip not found' });

    const trip = await Trip.findOneAndUpdate(
      { _id: req.params.id, ...ownedBy(req) },
      { $set: updates },
      { new: true }
    ).populate('device', 'name uniqueId lastPosition lastSeenAt');

    if (!trip) return res.status(404).json({ success: false, error: 'Trip not found' });

    // Notify the fleet owner when a trip becomes completed. Fire-and-forget so a
    // mail failure never fails the update.
    if (updates.status === 'completed' && existing.status !== 'completed' && req.user?.email) {
      sendTripCompletedEmail(req.user.email, req.user.name, trip, trip.device?.name)
        .catch((err) => console.error('[trips] completed email failed:', err.message));
    }

    res.json({ success: true, trip });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to update trip' });
  }
});

// DELETE /api/trips/:id — remove one of the caller's trips.
router.delete('/:id', protect, async (req, res) => {
  try {
    const trip = await Trip.findOneAndDelete({ _id: req.params.id, ...ownedBy(req) });
    if (!trip) return res.status(404).json({ success: false, error: 'Trip not found' });
    res.json({ success: true, message: 'Trip removed' });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to delete trip' });
  }
});

// ---------------------------------------------------------------------------
// Public: a share token can carry its trip's route so the client map draws
// "From → To" alongside the live vehicle. No JWT — the token is the credential.
// ---------------------------------------------------------------------------

// GET /api/trips/public/:token — the active trip (route + endpoints) for the
// device behind a share token. Same 404 for unknown/revoked/expired as the rest
// of the public API, so probing reveals nothing. Returns { trip: null } when the
// device has no trip, which the map treats as "just show the live vehicle".
router.get('/public/:token', async (req, res) => {
  try {
    const record = await TrackToken.findOne({
      tokenHash: TrackToken.hash(req.params.token)
    });

    if (!record || !record.isUsable()) {
      return res.status(404).json({ success: false, error: 'This tracking link is invalid or has expired' });
    }

    // Most relevant journey for this device: the active one, else the newest.
    const trip = await Trip.findOne({ device: record.device })
      .sort({ status: 1, createdAt: -1 }) // 'active' sorts before 'completed'/'planned'
      .select('origin destination routePolyline distanceKm durationMin status');

    if (!trip) return res.json({ success: true, trip: null });

    res.json({
      success: true,
      trip: {
        origin: trip.origin,
        destination: trip.destination,
        routePolyline: trip.routePolyline || null,
        distanceKm: trip.distanceKm ?? null,
        durationMin: trip.durationMin ?? null,
        status: trip.status
      }
    });
  } catch (error) {
    console.error('[trips] public lookup failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to load trip' });
  }
});

export default router;
