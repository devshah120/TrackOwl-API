import express from 'express';
import Trip from '../models/Trip.js';
import Device from '../models/Device.js';
import Position from '../models/Position.js';
import TrackToken from '../models/TrackToken.js';
import { protect } from '../middleware/auth.js';
import { sendTripCreatedEmail, sendTripCompletedEmail } from '../services/emailService.js';
import { detectStops } from '../utils/tripStops.js';
import { describePoints } from '../services/placeLookup.js';

const router = express.Router();

// Upper bound on GPS fixes returned for one trip's actual-path trail. A device
// reporting every few seconds over a long haul can accumulate thousands; 2000
// points still draws a smooth line without bloating the response.
const MAX_TRAIL_POINTS = 2000;

// A fix reported with an error radius this large is noise, not a location — it
// is typically a cell-tower or wifi estimate rather than a real satellite lock,
// and plotting it puts a spike in the trail.
const MAX_ACCURACY_M = 5000;

// Rejects fixes that would visibly corrupt the drawn trail. The `[0, 0]` case is
// already excluded by the query; this additionally drops near-null coordinates
// (a partial lock lands a fraction of a degree off Null Island, still thousands
// of km from any real route) and low-confidence fixes.
const isPlausibleFix = (p) => {
  if (!Number.isFinite(p.latitude) || !Number.isFinite(p.longitude)) return false;
  if (Math.abs(p.latitude) < 0.01 && Math.abs(p.longitude) < 0.01) return false;
  if (p.accuracy != null && p.accuracy > MAX_ACCURACY_M) return false;
  return true;
};

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
    const {
      deviceId,
      note = '',
      routePolyline: reqPolyline,
      distanceKm: reqDistanceKm,
      durationMin: reqDurationMin,
      route,
    } = req.body || {};

    const rawPolyline = reqPolyline || route?.polyline;
    const distanceKm = reqDistanceKm ?? route?.distanceKm;
    const durationMin = reqDurationMin ?? route?.durationMin;

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
    if (Array.isArray(rawPolyline)) {
      polyline = rawPolyline
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
    const existing = await Trip.findOne({ _id: req.params.id, ...ownedBy(req) }).select('status device');
    if (!existing) return res.status(404).json({ success: false, error: 'Trip not found' });

    // Prevent starting a trip when another trip on the same device is already
    // active — two concurrent trips on one vehicle would produce overlapping
    // GPS trails, which is exactly the problem this feature solves.
    if (updates.status === 'active' && existing.status !== 'active') {
      const conflict = await Trip.findOne({
        device: existing.device,
        status: 'active',
        _id: { $ne: existing._id },
        ...ownedBy(req),
      }).select('_id');
      if (conflict) {
        return res.status(409).json({
          success: false,
          error: 'Another trip on this device is already active. Complete or cancel it first.',
        });
      }
      updates.startedAt = new Date();
    }

    // Stamp the arrival time on the transition into 'completed' — it bounds the
    // trip's actual-path trail. Only on the transition, so a repeat PATCH of the
    // same status can't push the boundary forward and swallow a later journey.
    if (updates.status === 'completed' && existing.status !== 'completed') {
      updates.completedAt = new Date();
    }

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

// GET /api/trips/:id/trail — the path the vehicle actually drove for this trip,
// as opposed to the planned `routePolyline`. Built from the stored GPS fixes for
// the trip's device, windowed to the trip's own lifetime: from when the trip was
// created until it completed (or now, if it is still running). Without that
// window we'd draw every fix the device ever sent, including other journeys.
//
// Returns oldest-first [[lat, lng], ...] so the map can draw it as one line.
router.get('/:id/trail', protect, async (req, res) => {
  try {
    const trip = await Trip.findOne({ _id: req.params.id, ...ownedBy(req) })
      .select('device startedAt completedAt status');
    if (!trip) return res.status(404).json({ success: false, error: 'Trip not found' });

    // The trail window opens at startedAt — the moment the user clicked "Start
    // Trip" — and nowhere else. A trip without it has not been started, so it
    // has driven nothing yet, whatever its device is doing: the vehicle may be
    // on another job or deadheading to the pickup, and none of that mileage
    // belongs to this trip. Report an empty trail rather than guessing a start.
    if (!trip.startedAt) {
      return res.json({ success: true, trail: [], stops: [], startedAt: null, endedAt: null });
    }

    // Ends at completedAt (when they clicked "End Trip") — or now if the trip
    // is still running.
    const window = { $gte: trip.startedAt };
    if (trip.status === 'completed' && trip.completedAt) window.$lte = trip.completedAt;

    // Oldest-first is the draw order. The cap protects the response on a long
    // journey — a fast-reporting device can log thousands of fixes.
    //
    // Only fixes the tracker itself flagged valid are drawn. A GPS module that
    // hasn't locked yet reports [0, 0], and a single such point stretches the
    // trail from the real route out into the Atlantic — which also drags the
    // map's auto-framing out with it.
    // No `.limit()` here: a limit takes the FIRST n fixes, which on a long trip
    // silently ends the trail partway through the journey — a 5-hour trip from
    // a 5-second tracker would be cut off before its third hour, hiding both
    // the rest of the route and every stop in it. Stops are what explain a long
    // trip, so they must be detected over the whole journey. The response is
    // thinned for drawing further down instead.
    const fixes = await Position.find({
      device: trip.device,
      fixTime: window,
      valid: { $ne: false },
      latitude: { $ne: 0 },
      longitude: { $ne: 0 },
    })
      .sort({ fixTime: 1 })
      .select('latitude longitude accuracy speed fixTime -_id')
      .lean();

    // Same filtered fixes feed both outputs, so a point drawn on the trail and
    // a point counted towards a stop can never disagree.
    const usable = fixes.filter(isPlausibleFix);

    // Thin the drawn line to keep the response small, taking every nth fix so
    // the shape spans the whole trip rather than stopping partway. Stops are
    // detected from the full set below, never from this thinned copy — dropping
    // fixes inside a stop would shorten the very durations we are reporting.
    const stride = Math.ceil(usable.length / MAX_TRAIL_POINTS) || 1;
    const trail = usable
      .filter((_, i) => i % stride === 0 || i === usable.length - 1)
      .map((p) => [p.latitude, p.longitude]);

    // Where the vehicle stood still, and for how long — the reason a planned
    // 11-minute run can take five hours. Addresses are resolved server-side so
    // every client of this endpoint gets them without its own geocoding.
    let stops = [];
    try {
      stops = await describePoints(detectStops(usable));
    } catch (err) {
      // A stop list is an enrichment; losing it must not cost the caller the
      // trail, which is the endpoint's primary job.
      console.error('[trips] stop detection failed:', err.message);
    }

    // Why a trip shows no stops is otherwise invisible from the client: too few
    // fixes, a tracker that reports road speed while parked, and a genuinely
    // non-stop drive all look identical once the list comes back empty.
    const speeds = usable.map((p) => p.speed).filter((s) => Number.isFinite(s));
    const diagnostics = {
      fixCount: usable.length,
      returnedPoints: trail.length,
      medianGapSec: usable.length > 1
        ? Math.round(
            (new Date(usable[usable.length - 1].fixTime) - new Date(usable[0].fixTime)) /
              1000 / (usable.length - 1)
          )
        : null,
      slowFixCount: speeds.filter((s) => s <= 3).length,
      hasSpeedField: speeds.length > 0,
    };

    res.json({
      success: true,
      trail,
      stops,
      diagnostics,
      startedAt: usable[0]?.fixTime || null,
      endedAt: usable[usable.length - 1]?.fixTime || null,
    });
  } catch (error) {
    console.error('[trips] trail lookup failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to load trip trail' });
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
