import Device from '../models/Device.js';
import Truck from '../models/Truck.js';
import Geofence from '../models/Geofence.js';
import AlertSetting from '../models/AlertSetting.js';
import Notification from '../models/Notification.js';
import TripOrder from '../models/TripOrder.js';
import Trip from '../models/Trip.js';
import { ACTIVE_STATUSES } from '../utils/tripOrders.js';
import { distanceMeters, insidePolygon, distanceToPolylineMeters } from '../utils/geo.js';

// The GPS alert engine. Called by the Traccar forwarder for every fix that is
// valid *and* newer than the device's current position, so it only ever sees
// the vehicle moving forward in time — an out-of-order packet replayed after a
// reconnect cannot re-raise an alert that already fired.
//
// What it detects:
//   overspeed     speed crosses the account's limit (edge-triggered)
//   ignition      ignition switches on or off (off by default)
//   idle          engine on, standing still, for longer than N minutes
//   after_hours   moving inside the account's "fleet should be parked" window
//   geofence      entry, exit and dwell for every fence that applies
//   route         off the planned road route of the active trip, and back on
//
// State that spans fixes (when idling began, which fences the vehicle is
// inside) lives on Device.alertState, so it survives a server restart and a
// device reconnect does not look like a fresh entry into every fence.
//
// It must never fail ingestion. Every error is caught and logged; a fix that
// could not be evaluated is still stored.

const CACHE_MS = 60 * 1000;
const settingsCache = new Map(); // owner -> { at, value }
const fenceCache = new Map(); // owner -> { at, value }
const plateCache = new Map(); // truckId -> { at, value }
const routeCache = new Map(); // truckId -> { at, value: { tripId, tripNumber, polyline } | null }

const cached = async (cache, key, load) => {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = await load();
  cache.set(key, { at: Date.now(), value });
  return value;
};

// Called by the settings and geofence routes after a write, so a change takes
// effect on the next fix rather than up to a minute later.
export const invalidateAlertCache = (owner) => {
  settingsCache.delete(String(owner));
  fenceCache.delete(String(owner));
};

export const getAlertSettings = async (owner) => {
  const existing = await AlertSetting.findOne({ owner }).lean();
  if (existing) return existing;
  try {
    return (await AlertSetting.create({ owner })).toObject();
  } catch (error) {
    // Two fixes racing to create the first row: the loser reads the winner's.
    if (error.code === 11000) return AlertSetting.findOne({ owner }).lean();
    throw error;
  }
};

const loadSettings = (owner) => cached(settingsCache, String(owner), () => getAlertSettings(owner));

const loadFences = (owner) =>
  cached(fenceCache, String(owner), () => Geofence.find({ owner, active: true }).lean());

const loadPlate = (truckId) =>
  cached(plateCache, String(truckId), async () => {
    const truck = await Truck.findById(truckId).select('number').lean();
    return truck?.number || '';
  });

// The planned road line for the vehicle's live trip, if it has one: the
// TripOrder that is on the road, through its linked GPS route record.
const loadActiveRoute = (owner, truckId) =>
  cached(routeCache, String(truckId), async () => {
    const trip = await TripOrder.findOne({ owner, truck: truckId, status: { $in: ACTIVE_STATUSES }, route: { $ne: null } })
      .select('tripNumber route')
      .lean();
    if (!trip) return null;
    const route = await Trip.findOne({ _id: trip.route, owner }).select('routePolyline').lean();
    const polyline = Array.isArray(route?.routePolyline) ? route.routePolyline : [];
    return polyline.length >= 2 ? { tripId: String(trip._id), tripNumber: trip.tripNumber, polyline } : null;
  });

// Minutes since local midnight in the account's time zone.
const localMinutes = (date, timeZone) => {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    }).formatToParts(date);
    const h = Number(parts.find((p) => p.type === 'hour')?.value);
    const m = Number(parts.find((p) => p.type === 'minute')?.value);
    return h * 60 + m;
  } catch {
    return date.getUTCHours() * 60 + date.getUTCMinutes();
  }
};

const parseHHMM = (s) => {
  const [h, m] = String(s || '').split(':').map(Number);
  return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null;
};

// Is `minutes` inside [from, to)? A window that wraps midnight (22:00 → 05:00)
// is the usual curfew and is handled.
const inWindow = (minutes, from, to) => {
  if (from === null || to === null || from === to) return false;
  return from < to ? minutes >= from && minutes < to : minutes >= from || minutes < to;
};

// Circles get a little hysteresis on the way out: GPS scatter around the edge
// would otherwise have a vehicle parked on the boundary enter and exit every
// few seconds. Polygons are drawn by hand around a site and get none.
const fenceContains = (fence, lat, lng, wasInside) => {
  if (fence.shape === 'polygon') return insidePolygon(lat, lng, fence.polygon);
  if (!fence.center) return false;
  const d = distanceMeters(lat, lng, fence.center.lat, fence.center.lng);
  const margin = wasInside ? Math.max(30, fence.radiusM * 0.1) : 0;
  return d <= fence.radiusM + margin;
};

const appliesTo = (fence, truckId) =>
  !fence.vehicles?.length || (truckId && fence.vehicles.some((v) => String(v) === String(truckId)));

const minutesBetween = (a, b) => Math.round((new Date(b).getTime() - new Date(a).getTime()) / 60000);

const raise = (owner, doc) =>
  Notification.findOneAndUpdate(
    { owner, dedupeKey: doc.dedupeKey },
    { $setOnInsert: { owner, createdAt: new Date(), read: false, type: 'alert', ...doc } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  ).catch((error) => {
    if (error.code !== 11000) console.error('[gps-alerts] notification failed:', error.message);
  });

// Puts the alert on the vehicle's live trip, if it has one, so the trip's own
// timeline shows it in context.
const logToTrip = (owner, truckId, event) =>
  TripOrder.updateOne(
    { owner, truck: truckId, status: { $in: ACTIVE_STATUSES } },
    { $push: { events: { ...event, source: 'system' } } }
  ).catch((error) => console.error('[gps-alerts] trip event failed:', error.message));

/**
 * @param {object} device   the Device document (lean or hydrated)
 * @param {object} fix      { latitude, longitude, speed, ignition, fixTime }
 * @param {object|null} previous  the device's previous current position
 */
export const evaluateFix = async (device, fix, previous) => {
  try {
    if (!device?.owner) return; // unclaimed hardware belongs to nobody yet

    const owner = device.owner;
    const settings = await loadSettings(owner);
    const truckId = device.vehicle || null;
    const subject = (truckId && (await loadPlate(truckId))) || device.name || device.uniqueId;
    const at = fix.fixTime;
    const where = { lat: fix.latitude, lng: fix.longitude };
    const deviceKey = String(device._id);

    const state = { inside: {}, dwellAlerted: {}, ...(device.alertState || {}) };
    const firstEvaluation = !state.initialisedAt;
    const jobs = [];

    const alert = (doc, tripEvent) => {
      jobs.push(raise(owner, { vehicle: subject, ...where, ...doc }));
      if (tripEvent && settings.logToTrip && truckId) {
        jobs.push(logToTrip(owner, truckId, { ...tripEvent, occurredAt: at, ...where }));
      }
    };

    // --- Overspeed ----------------------------------------------------------
    // Edge-triggered: one alert when the limit is crossed, not one per fix for
    // the whole stretch above it. The 10-minute bucket in the key is a second
    // guard against a speed hovering right on the limit.
    const limit = settings.overspeed?.limitKmh ?? 80;
    if (settings.overspeed?.enabled && fix.speed > limit && !(previous && previous.speed > limit)) {
      const speed = Math.round(fix.speed);
      alert(
        {
          severity: 'warning',
          category: 'overspeed',
          title: 'Overspeed',
          message: `${subject} was doing ${speed} km/h (limit ${limit} km/h)`,
          dedupeKey: `overspeed:${deviceKey}:${Math.floor(at.getTime() / 600000)}`
        },
        { eventType: 'overspeed', severity: 'warning', message: `Overspeed: ${speed} km/h against a ${limit} km/h limit` }
      );
    }

    // --- Ignition -----------------------------------------------------------
    if (settings.ignition?.enabled && previous && Boolean(previous.ignition) !== Boolean(fix.ignition)) {
      alert({
        severity: 'info',
        category: 'ignition',
        title: fix.ignition ? 'Ignition On' : 'Ignition Off',
        message: `${subject} ignition switched ${fix.ignition ? 'on' : 'off'}`,
        dedupeKey: `ignition:${deviceKey}:${at.getTime()}`
      });
    }

    // --- Idling -------------------------------------------------------------
    const idleNow = fix.ignition && fix.speed < 3;
    if (idleNow) {
      if (!state.idleSince) {
        state.idleSince = at;
        state.idleAlerted = false;
      } else if (
        settings.idle?.enabled &&
        !state.idleAlerted &&
        minutesBetween(state.idleSince, at) >= (settings.idle?.minutes ?? 20)
      ) {
        const mins = minutesBetween(state.idleSince, at);
        state.idleAlerted = true;
        alert(
          {
            severity: 'warning',
            category: 'idle',
            title: 'Prolonged Idling',
            message: `${subject} has been idling with the engine on for ${mins} min`,
            dedupeKey: `idle:${deviceKey}:${new Date(state.idleSince).getTime()}`
          },
          { eventType: 'idle', severity: 'warning', message: `Idling with engine on for ${mins} min` }
        );
      }
    } else {
      state.idleSince = null;
      state.idleAlerted = false;
    }

    // --- After-hours movement ----------------------------------------------
    const ah = settings.afterHours || {};
    if (ah.enabled && fix.speed >= (ah.minSpeedKmh ?? 10)) {
      const minutes = localMinutes(at, settings.timezone || 'Asia/Kolkata');
      if (inWindow(minutes, parseHHMM(ah.from), parseHHMM(ah.to))) {
        alert({
          severity: 'critical',
          category: 'after_hours',
          title: 'Unauthorised Movement',
          message: `${subject} is moving at ${Math.round(fix.speed)} km/h outside permitted hours (${ah.from}–${ah.to})`,
          // One per vehicle per three hours: the point is "it is out", not a
          // running commentary on the drive.
          dedupeKey: `afterhours:${deviceKey}:${Math.floor(at.getTime() / (3 * 3600000))}`
        });
      }
    }

    // --- Route deviation -----------------------------------------------------
    // Off the planned line by more than the threshold for long enough raises
    // one alert; coming back within 70% of the threshold closes it (the gap
    // stops a vehicle running along the edge from flapping).
    const rd = settings.routeDeviation || {};
    if (rd.enabled !== false && truckId) {
      const active = await loadActiveRoute(owner, truckId);
      if (!active) {
        state.offRoute = null;
      } else {
        const threshold = rd.thresholdM ?? 1000;
        const off = distanceToPolylineMeters(fix.latitude, fix.longitude, active.polyline);
        const current = state.offRoute && state.offRoute.tripId === active.tripId ? state.offRoute : null;

        if (off > threshold) {
          const since = current?.since || at;
          const mins = minutesBetween(since, at);
          const next = { tripId: active.tripId, since, alerted: current?.alerted || false, maxM: Math.max(current?.maxM || 0, Math.round(off)) };
          if (!next.alerted && mins >= (rd.minMinutes ?? 3)) {
            next.alerted = true;
            const km = (off / 1000).toFixed(1);
            alert(
              {
                severity: 'warning',
                category: 'route_deviation',
                title: 'Route Deviation',
                message: `${subject} is ${km} km off the planned route of trip ${active.tripNumber}`,
                dedupeKey: `route-off:${deviceKey}:${active.tripId}:${new Date(since).getTime()}`
              },
              { eventType: 'route_deviation', severity: 'warning', message: `Left the planned route — ${km} km off` }
            );
          }
          state.offRoute = next;
        } else if (current && off < threshold * 0.7) {
          if (current.alerted) {
            const mins = minutesBetween(current.since, at);
            alert(
              {
                severity: 'info',
                category: 'route_deviation',
                title: 'Back on Route',
                message: `${subject} is back on the planned route of trip ${active.tripNumber} after ${mins} min (up to ${(current.maxM / 1000).toFixed(1)} km off)`,
                dedupeKey: `route-on:${deviceKey}:${active.tripId}:${at.getTime()}`
              },
              { eventType: 'route_deviation', severity: 'info', message: `Back on the planned route after ${mins} min` }
            );
          }
          state.offRoute = null;
        }
      }
    }

    // --- Geofences ----------------------------------------------------------
    const fences = settings.geofence?.enabled ? await loadFences(owner) : [];
    const seen = new Set();
    for (const fence of fences) {
      if (!appliesTo(fence, truckId)) continue;
      const id = String(fence._id);
      seen.add(id);
      const since = state.inside[id];
      const inside = fenceContains(fence, fix.latitude, fix.longitude, Boolean(since));

      if (inside && !since) {
        state.inside[id] = at;
        delete state.dwellAlerted[id];
        // The first fix after this feature (or a new fence) goes live only
        // records where the vehicle is — it did not "enter" anything.
        if (!firstEvaluation && fence.alertOnEntry) {
          alert(
            {
              severity: fence.category === 'restricted' ? 'critical' : 'info',
              category: 'geofence',
              title: `Entered ${fence.name}`,
              message: `${subject} entered ${fence.name}`,
              dedupeKey: `geofence-in:${deviceKey}:${id}:${at.getTime()}`
            },
            { eventType: 'geofence', severity: 'info', message: `Entered geofence ${fence.name}` }
          );
        }
      } else if (!inside && since) {
        const mins = minutesBetween(since, at);
        delete state.inside[id];
        delete state.dwellAlerted[id];
        if (fence.alertOnExit) {
          alert(
            {
              severity: 'info',
              category: 'geofence',
              title: `Left ${fence.name}`,
              message: `${subject} left ${fence.name} after ${mins} min inside`,
              dedupeKey: `geofence-out:${deviceKey}:${id}:${at.getTime()}`
            },
            { eventType: 'geofence', severity: 'info', message: `Left geofence ${fence.name} after ${mins} min` }
          );
        }
      } else if (inside && since && fence.dwellAlertMinutes && !state.dwellAlerted[id]) {
        const mins = minutesBetween(since, at);
        if (mins >= fence.dwellAlertMinutes) {
          state.dwellAlerted[id] = true;
          alert(
            {
              severity: 'warning',
              category: 'geofence',
              title: `Long stay at ${fence.name}`,
              message: `${subject} has been inside ${fence.name} for ${mins} min`,
              dedupeKey: `geofence-dwell:${deviceKey}:${id}:${new Date(since).getTime()}`
            },
            { eventType: 'geofence', severity: 'warning', message: `Inside ${fence.name} for ${mins} min` }
          );
        }
      }
    }
    // Forget fences that were deleted, deactivated or unassigned, so their
    // state does not linger and fire a phantom "left" if they come back.
    for (const id of Object.keys(state.inside)) {
      if (!seen.has(id)) {
        delete state.inside[id];
        delete state.dwellAlerted[id];
      }
    }

    state.initialisedAt = state.initialisedAt || new Date();
    jobs.push(Device.updateOne({ _id: device._id }, { $set: { alertState: state } }));
    await Promise.all(jobs);
  } catch (error) {
    console.error('[gps-alerts] evaluation failed:', error.message);
  }
};
