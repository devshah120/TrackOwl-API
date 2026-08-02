// Turns stop coordinates into street addresses for the trip stop list.
//
// The Trip Routes screen re-fetches an active trip's trail every 5 seconds, and
// a long trip can hold a dozen stops. Geocoding each one per poll would be
// thousands of billable Google calls for a handful of distinct places, so
// lookups are cached and rounded — a parked vehicle's stop centroid shifts by a
// metre or two between polls, which must not read as a new place to look up.

const KEY = () => process.env.GOOGLE_MAPS_API_KEY || '';

// ~11 m of latitude. Fine enough to keep two genuinely different stops apart,
// coarse enough that the same stop lands on the same cache key every poll even
// as late fixes nudge its centroid.
const CACHE_PRECISION = 4;

// Addresses do not change. The only reason to expire at all is to stop a
// long-lived process from growing without bound; a day is far longer than any
// trip, so a running trip never re-pays for a lookup it has already made.
const TTL_MS = 24 * 60 * 60 * 1000;

// Bounds the map for a server that has been up for weeks. Well above the number
// of distinct stops any one fleet accumulates in a day.
const MAX_ENTRIES = 5000;

const cache = new Map();

const cacheKey = (lat, lng) =>
  `${lat.toFixed(CACHE_PRECISION)},${lng.toFixed(CACHE_PRECISION)}`;

// Plain coordinates, used whenever an address is unavailable. A stop with a
// readable duration and a pin on the map is still useful without a street name,
// so a geocoding failure must never drop the stop itself.
const asCoords = (lat, lng) => `${lat.toFixed(5)}, ${lng.toFixed(5)}`;

const readCache = (key) => {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > TTL_MS) {
    cache.delete(key);
    return null;
  }
  return hit.name;
};

const writeCache = (key, name) => {
  // Map preserves insertion order, so the first key is the oldest — evicting it
  // keeps the cache bounded without tracking access times.
  if (cache.size >= MAX_ENTRIES) {
    cache.delete(cache.keys().next().value);
  }
  cache.set(key, { name, at: Date.now() });
};

const reverseGeocode = async (lat, lng) => {
  const key = KEY();
  if (!key) return asCoords(lat, lng);

  try {
    const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
    url.search = new URLSearchParams({
      latlng: `${lat},${lng}`,
      language: 'en',
      key,
    }).toString();

    const response = await fetch(url);
    const data = await response.json();
    return data.results?.[0]?.formatted_address || asCoords(lat, lng);
  } catch (error) {
    console.error('[placeLookup] reverse geocode failed:', error.message);
    return asCoords(lat, lng);
  }
};

/**
 * Attach a human-readable `address` to each { lat, lng } point.
 *
 * Uncached points are looked up together rather than one after another, so a
 * trip with ten new stops costs one round trip's latency instead of ten.
 */
export const describePoints = async (points = []) => {
  const results = await Promise.all(
    points.map(async (p) => {
      const key = cacheKey(p.lat, p.lng);
      const cached = readCache(key);
      if (cached) return { ...p, address: cached };

      const name = await reverseGeocode(p.lat, p.lng);
      writeCache(key, name);
      return { ...p, address: name };
    })
  );
  return results;
};
