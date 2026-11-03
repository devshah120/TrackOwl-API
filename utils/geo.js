// Small geometry helpers shared by GPS ingestion, the alert engine and the
// geofence screens. Kept dependency-free: everything here is a few lines of
// trigonometry on WGS84 coordinates, accurate to well under a metre at the
// distances a fleet cares about.

const EARTH_RADIUS_M = 6371000;
const toRad = (d) => (d * Math.PI) / 180;

// Metres between two points (haversine).
export const distanceMeters = (aLat, aLng, bLat, bLng) => {
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(s));
};

// Is the point inside a circular fence? Inclusive of the boundary, so a vehicle
// parked exactly on the line counts as inside rather than flickering.
export const insideCircle = (lat, lng, center, radiusM) =>
  distanceMeters(lat, lng, center.lat, center.lng) <= radiusM;

// Is the point inside a polygon of { lat, lng } vertices? Ray casting, which is
// exact for the small, non-self-intersecting shapes a yard or warehouse fence is
// drawn as. Treats lng as x and lat as y — fine away from the antimeridian,
// which no Indian fleet crosses.
export const insidePolygon = (lat, lng, vertices = []) => {
  if (vertices.length < 3) return false;
  let inside = false;
  for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
    const xi = vertices[i].lng;
    const yi = vertices[i].lat;
    const xj = vertices[j].lng;
    const yj = vertices[j].lat;
    const crosses = yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (crosses) inside = !inside;
  }
  return inside;
};

// A coordinate pair a tracker could genuinely have produced. (0, 0) is the
// classic "no fix yet" value many modules send before they lock on — it is a
// point in the Gulf of Guinea, not a vehicle.
export const isPlausibleCoordinate = (lat, lng) =>
  Number.isFinite(lat) &&
  Number.isFinite(lng) &&
  lat >= -90 &&
  lat <= 90 &&
  lng >= -180 &&
  lng <= 180 &&
  !(Math.abs(lat) < 1e-6 && Math.abs(lng) < 1e-6);

// Shortest distance in metres from a point to a route drawn as [lat, lng]
// pairs (the OSRM geometry stored on Trip.routePolyline). Each segment is
// flattened with an equirectangular projection around the point — accurate to
// a few metres over the few-kilometre scale a deviation is judged at, and cheap
// enough to run over a several-thousand-point route on every GPS fix.
export const distanceToPolylineMeters = (lat, lng, points = []) => {
  if (!Array.isArray(points) || points.length === 0) return Infinity;
  const R = 6371000;
  const cosLat = Math.cos(toRad(lat));
  const project = (p) => ({ x: toRad(p[1] - lng) * cosLat * R, y: toRad(p[0] - lat) * R });

  if (points.length === 1) {
    const a = project(points[0]);
    return Math.hypot(a.x, a.y);
  }

  let best = Infinity;
  let prev = project(points[0]);
  for (let i = 1; i < points.length; i++) {
    const next = project(points[i]);
    const dx = next.x - prev.x;
    const dy = next.y - prev.y;
    const len2 = dx * dx + dy * dy;
    // Projection of the origin (the vehicle) onto the segment, clamped to it.
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(prev.x * dx + prev.y * dy) / len2));
    const d = Math.hypot(prev.x + t * dx, prev.y + t * dy);
    if (d < best) best = d;
    prev = next;
  }
  return best;
};
