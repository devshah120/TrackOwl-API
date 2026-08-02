// Detects where a vehicle stood still during a trip.
//
// The GPS trail alone answers "which roads did it take"; it cannot answer "why
// did an 11-minute run take five hours". That difference is almost entirely
// time parked — at a loading bay, a dhaba, a checkpost — and the tracker keeps
// reporting from the same spot throughout, so a stop shows up in the data as a
// long run of consecutive fixes that never leave a small circle.
//
// This groups those runs into stops. It works off the same fixes the trail is
// drawn from, so the two can never disagree about where the vehicle was.

// A vehicle is "still" while its fixes stay inside this radius of where the run
// began. It has to clear consumer-GPS jitter, which wanders a parked vehicle by
// tens of metres, without swallowing genuine crawling in traffic. 60 m does
// that: wider than the jitter, narrower than a city block.
const STILL_RADIUS_M = 60;

// Below this the tracker is reporting a stationary vehicle, whatever the noise
// in successive coordinates says. Kept above zero because GPS rarely reports a
// clean 0 km/h — it hovers in the low single digits while parked.
const STILL_SPEED_KMH = 3;

// A run has to last this long to be worth a dispatcher's attention. Under two
// minutes is a traffic light or a junction, and marking those would bury the
// real stops under dozens of pins.
const MIN_STOP_MS = 2 * 60 * 1000;

// Many trackers transmit only when the vehicle has moved, to ration data. On
// those, a long halt records NO stationary fixes at all — it appears purely as a
// gap in time between two ordinary moving fixes. Detecting stops only from
// clustered fixes would miss every stop such a device ever makes, so a silent
// gap this long between consecutive fixes is itself treated as a stop.
//
// Sized for the Teltonika FMB920 in this fleet. Its stock profile sends on a
// 3-5 minute heartbeat while parked and far more often while driving, so any
// silence past ~4 minutes is already outside normal reporting. Kept above
// MIN_STOP_MS because a gap is weaker evidence than a cluster — it can also mean
// lost signal — but low enough to catch the shorter halts (a delivery, a
// checkpost) that a 10-minute floor would swallow.
const MIN_GAP_STOP_MS = 4 * 60 * 1000;

// A gap only means "parked" if the vehicle was in the same place either side of
// it. If it reappears far away it was driving through a coverage blackspot, not
// standing still, and marking that as a stop would be plainly wrong. This is
// generous compared with STILL_RADIUS_M because the two fixes bounding a gap are
// independent readings taken far apart in time.
const GAP_MOVE_TOLERANCE_M = 250;

// Metres between two fixes (haversine).
const distanceMeters = (aLat, aLng, bLat, bLng) => {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
};

// Mean of a run's coordinates. A parked vehicle's fixes scatter around the true
// position, so the average sits closer to it than any single fix — including
// closer than the first fix, which is just wherever the noise happened to be
// when the vehicle stopped.
const centroid = (fixes) => {
  let lat = 0;
  let lng = 0;
  for (const f of fixes) {
    lat += f.latitude;
    lng += f.longitude;
  }
  return { lat: lat / fixes.length, lng: lng / fixes.length };
};

/**
 * Group a trip's GPS fixes into stops.
 *
 * @param fixes  oldest-first fixes, each { latitude, longitude, speed, fixTime }
 * @returns [{ lat, lng, startedAt, endedAt, durationMs, fixCount }, ...] in
 *          travel order. Coordinates are the run's centroid; the caller turns
 *          them into an address.
 */
export const detectStops = (fixes = []) => {
  const stops = [];
  if (fixes.length < 2) return stops;

  // The run of fixes currently believed to be one stop. Empty between stops.
  let run = [];

  // Close off the open run, keeping it only if the vehicle sat long enough.
  // Duration is measured between the run's first and last fix — the honest
  // bound on what we observed. It slightly under-reports (the vehicle stopped
  // some seconds before its first stationary fix and left some seconds after
  // its last), which is the right direction to err in a billing dispute.
  const flush = () => {
    if (run.length >= 2) {
      const startedAt = run[0].fixTime;
      const endedAt = run[run.length - 1].fixTime;
      const durationMs = new Date(endedAt) - new Date(startedAt);
      if (durationMs >= MIN_STOP_MS) {
        const { lat, lng } = centroid(run);
        stops.push({ lat, lng, startedAt, endedAt, durationMs, fixCount: run.length });
      }
    }
    run = [];
  };

  for (let i = 0; i < fixes.length; i++) {
    const fix = fixes[i];

    // A long silence between two fixes taken in roughly the same place is a
    // stop that the tracker simply did not report from — the case a
    // cluster-only detector is blind to. Checked before anything else so it is
    // caught whatever the two fixes claim about speed: a distance-filtered unit
    // often reports its last pre-halt fix at road speed and its first post-halt
    // fix at road speed too, with hours of standing still in between.
    const prev = i > 0 ? fixes[i - 1] : null;
    if (prev) {
      const gapMs = new Date(fix.fixTime) - new Date(prev.fixTime);
      if (gapMs >= MIN_GAP_STOP_MS) {
        const moved = distanceMeters(
          prev.latitude, prev.longitude, fix.latitude, fix.longitude
        );
        if (moved <= GAP_MOVE_TOLERANCE_M) {
          // Close any open cluster first so the two never double-count the
          // same period, then record the silence itself as the stop.
          flush();
          stops.push({
            lat: prev.latitude,
            lng: prev.longitude,
            startedAt: prev.fixTime,
            endedAt: fix.fixTime,
            durationMs: gapMs,
            fixCount: 2,
            // Tells the UI this stop is bounded by a reporting gap rather than
            // observed throughout, so it can be labelled honestly.
            inferred: true,
          });
          continue;
        }
      }
    }

    // A fix reporting real road speed ends any run outright — no need to check
    // the radius, the vehicle is demonstrably moving.
    //
    // Ignition overrides that: a hardwired unit like the FMB920 reports the
    // engine state directly, and engine-off is proof of a stop no matter what
    // speed the GPS chip claims. Trusting speed alone would drop real halts
    // whenever a stationary vehicle's noisy fix reads a few km/h.
    const engineOff = fix.ignition === false;
    const moving = !engineOff && Number.isFinite(fix.speed) && fix.speed > STILL_SPEED_KMH;
    if (moving) {
      flush();
      continue;
    }

    if (run.length === 0) {
      run = [fix];
      continue;
    }

    // Measure from the run's anchor rather than the previous fix. Comparing
    // neighbours would let a vehicle creep out of the area one small step at a
    // time — a slow crawl through a jam would read as one long stop.
    const anchor = run[0];
    const drift = distanceMeters(anchor.latitude, anchor.longitude, fix.latitude, fix.longitude);

    if (drift <= STILL_RADIUS_M) {
      run.push(fix);
    } else {
      // Left the circle: close the old run and let this fix anchor a new one,
      // so a vehicle that shuffles forward and parks again is two stops rather
      // than one stop plus a dropped fix.
      flush();
      run = [fix];
    }
  }

  flush();
  return stops;
};

export const STOP_TUNING = {
  STILL_RADIUS_M,
  STILL_SPEED_KMH,
  MIN_STOP_MS,
  MIN_GAP_STOP_MS,
  GAP_MOVE_TOLERANCE_M,
};
