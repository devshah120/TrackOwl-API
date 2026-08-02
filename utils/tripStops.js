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
// began. It has to clear GPS jitter, which wanders a parked vehicle by tens of
// metres, without swallowing genuine crawling in traffic.
//
// 100 m rather than a tighter figure because the units here run a ~75 m distance
// filter — they transmit once the vehicle has moved that far, so consecutive
// fixes from a standing vehicle routinely sit 75-80 m apart. A 60 m radius fell
// just under that and split every stationary run into unusable fragments.
const STILL_RADIUS_M = 100;

// Below this the tracker is reporting a stationary vehicle, whatever the noise
// in successive coordinates says. Kept above zero because GPS rarely reports a
// clean 0 km/h — it hovers in the low single digits while parked.
const STILL_SPEED_KMH = 3;

// A stop has to last this long to be worth a dispatcher's attention. Much below
// a minute is a traffic light or a junction, and marking those would bury the
// real stops under dozens of pins.
//
// Held at one minute rather than lower because gap-derived stops have their
// drive-out time deducted before this test, which trims a minute or so off each
// one — a higher floor was rejecting genuine one-to-two minute halts after that
// deduction rather than because they were too short to matter.
const MIN_STOP_MS = 60 * 1000;

// Many trackers transmit only when the vehicle has moved, to ration data. On
// those, a long halt records NO stationary fixes at all — it appears purely as a
// gap in time between two ordinary moving fixes. Detecting stops only from
// clustered fixes would miss every stop such a device ever makes, so a silent
// gap this long between consecutive fixes is itself treated as a stop.
//
// Sized against the FMB920s in this fleet, which report roughly every 10-15
// seconds while driving. Against that cadence a full minute of silence is
// already dozens of skipped reports, so it is well outside normal behaviour —
// and in practice these one-to-three minute gaps are exactly the deliveries and
// checkpost halts that operators care about. A higher floor (the 4 and 10
// minute values tried earlier) silently swallowed all of them.
//
// This is safe to keep low only because MAX_GAP_IMPLIED_KMH below independently
// checks that the vehicle did not actually travel during the silence: a brief
// gap taken mid-drive implies road speed and is rejected on that basis, not on
// its duration.
const MIN_GAP_STOP_MS = 60 * 1000;

// Whether a silence means "parked" cannot be judged by how far apart its two
// fixes are. A distance-filtered unit stays quiet while parked and only
// transmits once the vehicle is moving again, so the fix ending a gap is
// routinely hundreds of metres down the road — the vehicle really did sit still,
// it just wasn't reporting while it did.
//
// What distinguishes a stop from driving through a coverage blackspot is the
// speed the distance implies. Covering 800 m in two hours is a vehicle that
// parked and left near the end; covering 60 km is a vehicle that drove the whole
// time. Below this implied average the silence has to be mostly standing still,
// since no journey averages walking pace over a sustained period.
//
// Deliberately low: an implied average this small cannot be produced by real
// driving, so what it admits is overwhelmingly genuine halts.
const MAX_GAP_IMPLIED_KMH = 5;

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
        // Straight-line distance understates road distance, so this implied
        // speed is a lower bound — which is the safe direction: it can only
        // make a genuine drive look slower, never make a stop look like one.
        const impliedKmh = (moved / 1000) / (gapMs / 3600000);

        if (impliedKmh <= MAX_GAP_IMPLIED_KMH) {
          // Close any open cluster first so the two never double-count the
          // same period, then record the silence itself as the stop.
          flush();

          // The vehicle sat where it was last seen, not where it resurfaced —
          // it was already driving again by the time the second fix arrived.
          // Anchoring the pin to `prev` puts it at the place it actually
          // waited, which is what the address in the list has to name.
          //
          // The time spent driving the `moved` distance is not standing-still
          // time, so it is taken off the reported duration. Without this a
          // 2-hour gap that included a 10-minute drive out would be billed as
          // 2 hours parked. Road speed here is a conservative 25 km/h: a low
          // estimate deducts less, keeping the stop duration on the honest side
          // rather than inflating it.
          const drivingMs = Math.min((moved / 1000) / 25 * 3600000, gapMs);
          const stationaryMs = gapMs - drivingMs;

          if (stationaryMs >= MIN_STOP_MS) {
            stops.push({
              lat: prev.latitude,
              lng: prev.longitude,
              startedAt: prev.fixTime,
              endedAt: new Date(new Date(prev.fixTime).getTime() + stationaryMs),
              durationMs: stationaryMs,
              fixCount: 2,
              // Tells the UI this stop is bounded by a reporting gap rather
              // than observed throughout, so it can be labelled honestly.
              inferred: true,
              // When the vehicle was actually next seen. `endedAt` above is
              // pulled earlier by the drive-out deduction, so merging against
              // it would treat two visits either side of a long drive as
              // adjacent. Merging needs the real moment contact resumed.
              seenAgainAt: fix.fixTime,
            });
          }
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
  return mergeAdjacent(stops);
};

// One halt can surface as several stops in a row: a unit with a distance filter
// re-reports every ~75 m, so a vehicle inching forward in a queue or shuffling
// within a yard produces a string of short gaps a hundred metres apart rather
// than one continuous run. Presented raw that reads as three separate visits to
// the same street, and it splits one long wait into fragments that each look
// trivial.
//
// Two stops are the same halt when they are close in space AND effectively
// continuous in time. Both must hold: nearby stops hours apart are genuinely
// separate visits, and consecutive stops far apart are a real drive between two
// waits.
const MERGE_RADIUS_M = 150;
const MERGE_GAP_MS = 5 * 60 * 1000;

const mergeAdjacent = (stops) => {
  if (stops.length < 2) return stops;

  const merged = [stops[0]];
  for (let i = 1; i < stops.length; i++) {
    const cur = stops[i];
    const last = merged[merged.length - 1];
    const apart = distanceMeters(last.lat, last.lng, cur.lat, cur.lng);
    // Measured from when the vehicle was genuinely seen again, not from the
    // deduction-adjusted `endedAt` — otherwise a long drive between two visits
    // to the same yard collapses into a single stop.
    const lastSeen = last.seenAgainAt || last.endedAt;
    const between = new Date(cur.startedAt) - new Date(lastSeen);

    if (apart <= MERGE_RADIUS_M && between <= MERGE_GAP_MS) {
      // Span the pair end to end. The time between them was spent creeping
      // around the same spot, so it belongs to the halt rather than falling
      // through the cracks between two reported stops.
      last.endedAt = cur.endedAt;
      last.durationMs = new Date(cur.endedAt) - new Date(last.startedAt);
      last.fixCount += cur.fixCount;
      last.seenAgainAt = cur.seenAgainAt || cur.endedAt;
      // Stays inferred only if neither part was directly observed.
      last.inferred = last.inferred && cur.inferred;
    } else {
      merged.push(cur);
    }
  }
  return merged;
};

export const STOP_TUNING = {
  STILL_RADIUS_M,
  STILL_SPEED_KMH,
  MIN_STOP_MS,
  MIN_GAP_STOP_MS,
  MAX_GAP_IMPLIED_KMH,
};
