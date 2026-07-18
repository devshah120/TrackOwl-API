// Shared device-registration logic: register a vehicle in the Traccar gateway
// and create the local Device record for a given owner. Used by both
// routes/track.js (owner = the calling client) and routes/admin.js
// (owner = a client chosen by superadmin), so the gateway call, orphan-reuse
// handling, and setup-block shaping only live in one place.
import crypto from 'crypto';
import Device from '../models/Device.js';
import * as traccar from './traccarAdmin.js';

// What the user types into the Traccar Client app. The phone talks the OsmAnd
// protocol on 5055 — never the web-UI port.
export const phoneServerUrl = () =>
  process.env.TRACCAR_PHONE_URL || 'http://103.212.121.139:5055';

// Hardware trackers (e.g. Teltonika FMB920) speak the binary Teltonika protocol
// on 5027. Unlike the phone they take Domain + Port as separate fields, so the
// setup block for them is split rather than a single URL.
export const hardwareHost = () => process.env.TRACCAR_HARDWARE_HOST || '103.212.121.139';
export const hardwarePort = () => process.env.TRACCAR_HARDWARE_PORT || '5027';

// A hardware unit's identity is its IMEI: 15–17 digits, baked into the device.
export const isValidImei = (value) => /^\d{15,17}$/.test(value);

// Short, unambiguous device ids: no vowels (kills accidental words) and no
// 0/O/1/I, since these get typed by hand into a phone.
export const generateUniqueId = () =>
  'trk-' + Array.from(crypto.randomBytes(6))
    .map((b) => '23456789abcdefghjkmnpqrstuvwxyz'[b % 30])
    .join('');

// Registers { name, type, uniqueId } in the Traccar gateway and creates the
// local Device owned by `ownerId`. Returns { device, setup } on success, or
// throws an Error with a `status` (HTTP code) and `error` (client message)
// for the caller to relay.
export const registerDevice = async ({ name, type, uniqueId: requestedUniqueId, ownerId }) => {
  const trimmedName = String(name || '').trim();
  if (!trimmedName) {
    const err = new Error('Vehicle name is required');
    err.status = 400;
    throw err;
  }

  if (!traccar.isConfigured()) {
    const err = new Error('Traccar admin credentials are not configured on the server');
    err.status = 503;
    throw err;
  }

  const deviceType = type === 'hardware' ? 'hardware' : 'phone';

  let uniqueId;
  if (deviceType === 'hardware') {
    uniqueId = String(requestedUniqueId || '').trim();
    if (!isValidImei(uniqueId)) {
      const err = new Error('A valid IMEI (15–17 digits) is required for a GPS device');
      err.status = 400;
      throw err;
    }
  } else {
    uniqueId = String(requestedUniqueId || '').trim().toLowerCase() || generateUniqueId();
  }

  if (await Device.findOne({ uniqueId })) {
    const err = new Error('That device ID is already in use');
    err.status = 409;
    throw err;
  }

  // Register in Traccar first — if this fails there is no point creating our record,
  // since the device's positions would be rejected at the gateway.
  //
  // If Traccar reports the uniqueId is taken (400) despite Mongo having no record
  // of it, it's an orphan left behind by a failed/partial registration. Reuse
  // that device instead of dead-ending — otherwise the IMEI becomes permanently
  // unregisterable through the UI.
  let traccarDevice;
  try {
    traccarDevice = await traccar.createDevice({ name: trimmedName, uniqueId });
  } catch (err) {
    if (err.status === 400) {
      try {
        traccarDevice = await traccar.findDeviceByUniqueId(uniqueId);
      } catch { /* fall through to the error below */ }
      if (!traccarDevice) {
        const notFound = new Error('That device ID is already registered in the gateway');
        notFound.status = 409;
        throw notFound;
      }
      console.warn(`[track] reusing orphaned gateway device ${uniqueId} (traccarId=${traccarDevice.id})`);
    } else {
      const gatewayErr = new Error(`Could not reach the Traccar gateway: ${err.message}`);
      gatewayErr.status = 502;
      throw gatewayErr;
    }
  }

  const device = await Device.create({
    uniqueId,
    name: trimmedName,
    traccarId: traccarDevice.id,
    owner: ownerId
  });

  return {
    device,
    // Everything the user must enter to point the device at the gateway.
    // Shape differs by type: the phone takes one URL; hardware takes the
    // Domain/Port/Protocol fields shown on the FMB920 config screen.
    setup: deviceType === 'hardware'
      ? {
          type: 'hardware',
          domain: hardwareHost(),
          port: hardwarePort(),
          protocol: 'TCP',
          deviceIdentifier: uniqueId
        }
      : {
          type: 'phone',
          serverUrl: phoneServerUrl(),
          deviceIdentifier: uniqueId
        }
  };
};
