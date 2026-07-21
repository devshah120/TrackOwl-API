import express from 'express';
import { protect } from '../middleware/auth.js';

const router = express.Router();

// Google Maps proxy.
//
// These endpoints exist so the Google API key never reaches the browser. The
// frontend used to call Nominatim/OSRM directly, which was fine because those
// are keyless; a Google key in the JS bundle can be scraped and billed against
// us, so every Google web-service call goes through here instead.
//
// All routes are behind `protect` for the same reason: an open proxy is just a
// slower way of leaking the key's quota to anyone who finds the URL.
const KEY = () => process.env.GOOGLE_MAPS_API_KEY || '';

// Google returns 200 with a status string in the body; only OK and
// ZERO_RESULTS are non-errors. Everything else (REQUEST_DENIED,
// OVER_QUERY_LIMIT, INVALID_REQUEST) means the call did not do what we asked.
const isFailure = (status) => status !== 'OK' && status !== 'ZERO_RESULTS';

// Fail loudly and identically everywhere rather than silently returning empty
// results, which would look to the user like "no such place".
const guardKey = (res) => {
  if (KEY()) return true;
  res.status(503).json({ success: false, error: 'Maps service is not configured' });
  return false;
};

// India bias for autocomplete/geocoding, matching the old Nominatim
// countrycodes=in. Drop these to search worldwide.
const REGION = 'in';

// GET /api/geo/places?q=... — place autocomplete.
// Uses the Places Text Search API, which (unlike Autocomplete) returns
// coordinates in the same response, so one call gives us { name, lat, lng }
// and we avoid a second billed Place Details request per keystroke.
router.get('/places', protect, async (req, res) => {
  if (!guardKey(res)) return;
  const q = String(req.query.q || '').trim();
  if (q.length < 3) return res.json({ success: true, places: [] });

  try {
    const url = new URL('https://maps.googleapis.com/maps/api/place/textsearch/json');
    url.search = new URLSearchParams({
      query: q,
      region: REGION,
      language: 'en',
      key: KEY(),
    }).toString();

    const response = await fetch(url);
    const data = await response.json();
    if (isFailure(data.status)) {
      console.error('Places search failed:', data.status, data.error_message || '');
      return res.status(502).json({ success: false, error: 'Place search failed' });
    }

    const places = (data.results || []).slice(0, 6).map((r) => ({
      // formatted_address alone often omits the POI name ("Odhav Lake"), so
      // prefix it when it isn't already the start of the address.
      name:
        r.name && !r.formatted_address?.startsWith(r.name)
          ? `${r.name}, ${r.formatted_address}`
          : r.formatted_address || r.name,
      lat: r.geometry.location.lat,
      lng: r.geometry.location.lng,
    }));
    res.json({ success: true, places });
  } catch (error) {
    console.error('Places search error:', error.message);
    res.status(502).json({ success: false, error: 'Place search failed' });
  }
});

// GET /api/geo/reverse?lat=..&lng=.. — coordinates to a street address.
// Backs the "Use my location" button: the browser supplies a raw GPS fix and
// this turns it into something a dispatcher can read.
router.get('/reverse', protect, async (req, res) => {
  if (!guardKey(res)) return;
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return res.status(400).json({ success: false, error: 'lat and lng are required' });
  }

  try {
    const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
    url.search = new URLSearchParams({
      latlng: `${lat},${lng}`,
      language: 'en',
      key: KEY(),
    }).toString();

    const response = await fetch(url);
    const data = await response.json();
    if (isFailure(data.status)) {
      console.error('Reverse geocode failed:', data.status, data.error_message || '');
      return res.status(502).json({ success: false, error: 'Reverse geocode failed' });
    }

    // No address (mid-ocean, or a gap in Google's data) is not an error — the
    // GPS fix is still usable, so fall back to the plain coordinates.
    const name =
      data.results?.[0]?.formatted_address || `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
    res.json({ success: true, place: { name, lat, lng } });
  } catch (error) {
    console.error('Reverse geocode error:', error.message);
    res.status(502).json({ success: false, error: 'Reverse geocode failed' });
  }
});

// Road route via the Routes API (the current product). Returns our
// { polyline, distanceKm, durationMin } shape, or null if it is unavailable so
// the caller can try the legacy endpoint.
const routeViaRoutesApi = async (from, to) => {
  const response = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': KEY(),
      // Routes API requires an explicit field mask; asking only for what we use
      // keeps the response in the cheaper billing tier.
      'X-Goog-FieldMask': 'routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline',
    },
    body: JSON.stringify({
      origin: { location: { latLng: { latitude: from.lat, longitude: from.lng } } },
      destination: { location: { latLng: { latitude: to.lat, longitude: to.lng } } },
      travelMode: 'DRIVE',
      polylineQuality: 'HIGH_QUALITY',
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    console.error('Routes API failed:', response.status, body.slice(0, 200));
    return null;
  }

  const data = await response.json();
  const route = data.routes?.[0];
  if (!route) return null;

  return {
    polyline: decodePolyline(route.polyline.encodedPolyline),
    distanceKm: Math.round((route.distanceMeters / 1000) * 10) / 10,
    // Routes API returns duration as a string of seconds, e.g. "1263s".
    durationMin: Math.round(parseInt(route.duration, 10) / 60),
  };
};

// Same thing via the legacy Directions API, for projects that have Directions
// enabled but not Routes.
const routeViaDirectionsApi = async (from, to) => {
  const url = new URL('https://maps.googleapis.com/maps/api/directions/json');
  url.search = new URLSearchParams({
    origin: `${from.lat},${from.lng}`,
    destination: `${to.lat},${to.lng}`,
    mode: 'driving',
    region: REGION,
    key: KEY(),
  }).toString();

  const data = await (await fetch(url)).json();
  if (isFailure(data.status)) {
    console.error('Directions failed:', data.status, data.error_message || '');
    return null;
  }

  const route = data.routes?.[0];
  if (!route) return null;

  // Directions reports distance/duration per leg, so sum them.
  const totals = route.legs.reduce(
    (acc, leg) => ({
      distance: acc.distance + (leg.distance?.value || 0),
      duration: acc.duration + (leg.duration?.value || 0),
    }),
    { distance: 0, duration: 0 }
  );

  return {
    polyline: decodePolyline(route.overview_polyline.points),
    distanceKm: Math.round((totals.distance / 1000) * 10) / 10,
    durationMin: Math.round(totals.duration / 60),
  };
};

// GET /api/geo/route?fromLat=..&fromLng=..&toLat=..&toLng=..
// Returns the same shape the frontend used to build from OSRM, so the map and
// the Trip model did not have to change.
//
// Google is mid-migration from Directions to Routes, and a given Cloud project
// may have either one enabled. We try Routes first and fall back, so whichever
// the project has switched on is the one that gets used.
router.get('/route', protect, async (req, res) => {
  if (!guardKey(res)) return;
  const from = { lat: Number(req.query.fromLat), lng: Number(req.query.fromLng) };
  const to = { lat: Number(req.query.toLat), lng: Number(req.query.toLng) };
  if (![from.lat, from.lng, to.lat, to.lng].every(Number.isFinite)) {
    return res.status(400).json({ success: false, error: 'from/to coordinates are required' });
  }

  try {
    const route = (await routeViaRoutesApi(from, to)) || (await routeViaDirectionsApi(from, to));
    if (!route) {
      return res.status(502).json({ success: false, error: 'Routing failed' });
    }
    res.json({ success: true, route });
  } catch (error) {
    console.error('Routing error:', error.message);
    res.status(502).json({ success: false, error: 'Routing failed' });
  }
});

// Google returns the route geometry as an encoded polyline string. Decode it
// here so the frontend keeps receiving a plain [[lat, lng], ...] array and
// needs no decoding library of its own.
// Format: https://developers.google.com/maps/documentation/utilities/polylinealgorithm
function decodePolyline(encoded) {
  const points = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  while (index < encoded.length) {
    // Each coordinate is a zig-zag encoded delta from the previous one, split
    // into 5-bit chunks with a continuation bit set on all but the last.
    for (const axis of ['lat', 'lng']) {
      let result = 0;
      let shift = 0;
      let byte;
      do {
        byte = encoded.charCodeAt(index++) - 63;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20);

      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (axis === 'lat') lat += delta;
      else lng += delta;
    }
    points.push([lat / 1e5, lng / 1e5]);
  }
  return points;
}

export default router;
