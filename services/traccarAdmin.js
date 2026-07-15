// Thin client for Traccar's REST API, so TrackOwl can register a device in the
// gateway on the user's behalf. Traccar rejects positions from devices it does not
// know ("Unknown device"), so a device must exist here before a phone can report.
//
// Requires TRACCAR_URL, TRACCAR_ADMIN_USER and TRACCAR_ADMIN_PASSWORD in .env.

const baseUrl = () => (process.env.TRACCAR_URL || 'http://localhost:8082').replace(/\/$/, '');

const authHeader = () => {
  const user = process.env.TRACCAR_ADMIN_USER;
  const pass = process.env.TRACCAR_ADMIN_PASSWORD;
  if (!user || !pass) {
    throw new Error('Traccar admin credentials are not configured on the server');
  }
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
};

export const isConfigured = () =>
  Boolean(process.env.TRACCAR_ADMIN_USER && process.env.TRACCAR_ADMIN_PASSWORD);

const request = async (path, options = {}) => {
  const res = await fetch(`${baseUrl()}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: authHeader(),
      ...options.headers
    },
    signal: AbortSignal.timeout(10000)
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    const err = new Error(`Traccar ${res.status}: ${detail.slice(0, 200) || res.statusText}`);
    err.status = res.status;
    throw err;
  }

  return res.status === 204 ? null : res.json();
};

export const listDevices = () => request('/api/devices');

// Fetch the single device with this uniqueId, or null if the gateway has none.
// Traccar filters server-side when given a uniqueId query param, so this stays
// cheap even with a large fleet.
export const findDeviceByUniqueId = async (uniqueId) => {
  const matches = await request(`/api/devices?uniqueId=${encodeURIComponent(uniqueId)}`);
  return Array.isArray(matches) && matches.length ? matches[0] : null;
};

// Traccar returns 400 with a constraint message if uniqueId is taken.
export const createDevice = ({ name, uniqueId }) =>
  request('/api/devices', {
    method: 'POST',
    body: JSON.stringify({ name, uniqueId })
  });

export const deleteDevice = (traccarId) =>
  request(`/api/devices/${traccarId}`, { method: 'DELETE' });
