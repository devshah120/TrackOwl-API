import express from 'express';
import Truck, { VEHICLE_TYPES, FUEL_TYPES, BODY_TYPES, VEHICLE_STATUSES } from '../models/Truck.js';
import Driver from '../models/Driver.js';
import VehicleDocument from '../models/VehicleDocument.js';
import DriverDocument from '../models/DriverDocument.js';
import Notification from '../models/Notification.js';
import Device from '../models/Device.js';
import Trip from '../models/Trip.js';
import { protect, requirePermission } from '../middleware/auth.js';
import { hasPermission } from '../utils/permissions.js';
import { readDriverList, syncTruckDrivers, attachDrivers } from '../utils/drivers.js';
import { auditCreate, auditUpdate, auditDelete } from '../utils/audit.js';

const router = express.Router();

const ownedBy = (req) => ({ owner: req.accountId });

// Builds a Truck-shaped update object from the flat AddNewTruck form payload,
// only including fields that were actually sent. Drivers are not part of this —
// they are their own collection now and are synced separately.
// An empty string from a cleared number input means "no value", which is not
// the same as 0 — `null` clears the field without tripping the min validators.
const numberOrNull = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const buildTruckFields = (body) => {
  const fields = {};
  if (body.number !== undefined) fields.number = String(body.number).trim();
  if (body.model !== undefined) fields.model = String(body.model).trim();
  if (body.registrationDate !== undefined) fields.registrationDate = body.registrationDate || undefined;
  if (body.insuranceExpiry !== undefined) fields.insuranceExpiry = body.insuranceExpiry || undefined;
  if (body.status !== undefined) fields.status = body.status;
  if (body.currentRoute !== undefined) fields.currentRoute = String(body.currentRoute).trim();

  // Vehicle master. Each field is optional on the wire; only what was sent is
  // written, so a partial form save never blanks the rest of the record.
  if (body.vehicleType !== undefined) fields.vehicleType = body.vehicleType;
  if (body.make !== undefined) fields.make = String(body.make).trim();
  if (body.manufactureYear !== undefined) fields.manufactureYear = numberOrNull(body.manufactureYear);
  if (body.fuelType !== undefined) fields.fuelType = body.fuelType;
  if (body.odometer !== undefined) fields.odometer = numberOrNull(body.odometer) ?? 0;

  // Capacity and purchase are nested, so they are set with dotted paths: a
  // whole-subdocument $set would wipe the siblings the form didn't send.
  if (body.capacity !== undefined) {
    const c = body.capacity || {};
    if (c.weightKg !== undefined) fields['capacity.weightKg'] = numberOrNull(c.weightKg);
    if (c.volumeM3 !== undefined) fields['capacity.volumeM3'] = numberOrNull(c.volumeM3);
    if (c.bodyType !== undefined) fields['capacity.bodyType'] = c.bodyType;
  }
  if (body.purchase !== undefined) {
    const pu = body.purchase || {};
    if (pu.date !== undefined) fields['purchase.date'] = pu.date || undefined;
    if (pu.price !== undefined) fields['purchase.price'] = numberOrNull(pu.price);
    if (pu.vendor !== undefined) fields['purchase.vendor'] = String(pu.vendor).trim();
    if (pu.financedBy !== undefined) fields['purchase.financedBy'] = String(pu.financedBy).trim();
  }

  return fields;
};

// The raw driver rows as sent, kept alongside the normalised list so
// syncTruckDrivers can match each row back to its existing _id.
const rawDriverRows = (body) =>
  Array.isArray(body?.drivers) ? body.drivers : body?.driver ? [body.driver] : [];

// GET /api/trucks/options — the vehicle master vocabularies, so the form's
// dropdowns are driven by the same lists the model validates against instead
// of a copy that can drift out of sync.
router.get('/options', protect, requirePermission('trucks', 'read'), (req, res) => {
  res.json({
    success: true,
    options: {
      vehicleTypes: VEHICLE_TYPES,
      fuelTypes: FUEL_TYPES,
      bodyTypes: BODY_TYPES,
      statuses: VEHICLE_STATUSES
    }
  });
});

// The window after which a device that has stopped reporting counts as
// offline. Matches Device.status's own virtual and the notification
// synthesizer, so the dashboard tile, the map badge and the bell cannot
// disagree about which vehicles are live.
const OFFLINE_AFTER_MS = 2 * 60 * 1000;

// GET /api/trucks/fleet-summary — the headline fleet numbers for the dashboard
// strip: how many vehicles exist, how many are reporting, how many trips are
// running, how many vehicles are off the road, and how many alerts are open.
//
// Computed server-side rather than in the browser because the pieces live in
// four collections and the client would otherwise need four round trips (and
// the tracking/trips grants to make them) just to render five numbers. The
// counts a caller cannot see degrade to zero rather than failing the request —
// an Accountant has no tracking grant, and the tile should read 0 online, not
// blank the whole dashboard.
router.get('/fleet-summary', protect, requirePermission('trucks', 'read'), async (req, res) => {
  try {
    const owner = req.accountId;
    const canSeeTracking = hasPermission(req.user.role, 'tracking', 'read');
    const canSeeTrips = hasPermission(req.user.role, 'trips', 'read');

    const [trucks, devices, activeTrips, alerts] = await Promise.all([
      Truck.find({ owner }).select('status device'),
      // Only units actually fitted to a vehicle count towards online/offline. A
      // box still in stock or already retired has no vehicle to report for, and
      // counting it would inflate the offline number with hardware that was
      // never on the road in the first place.
      canSeeTracking
        ? Device.find({
            owner,
            vehicle: { $ne: null },
            lifecycleStatus: { $nin: ['In Stock', 'Retired'] }
          }).select('lastSeenAt lastPosition.speed')
        : [],
      canSeeTrips ? Trip.countDocuments({ owner, status: 'active' }) : 0,
      Notification.countDocuments({ owner, type: 'alert', read: false })
    ]);

    // Seeded from the model's status list so a newly added status shows up as a
    // zero bucket instead of going missing until a truck first uses it.
    const byStatus = trucks.reduce(
      (acc, t) => {
        acc[t.status] = (acc[t.status] || 0) + 1;
        return acc;
      },
      Object.fromEntries(VEHICLE_STATUSES.map((s) => [s, 0]))
    );

    const now = Date.now();
    const telemetry = devices.reduce(
      (acc, d) => {
        const staleMs = d.lastSeenAt ? now - new Date(d.lastSeenAt).getTime() : Infinity;
        if (staleMs > OFFLINE_AFTER_MS) acc.offline += 1;
        else if ((d.lastPosition?.speed || 0) > 3) acc.moving += 1;
        else acc.idle += 1;
        return acc;
      },
      { moving: 0, idle: 0, offline: 0 }
    );

    // "Online" is any fitted device still reporting, whether it is rolling or
    // parked with the engine off — the question the tile answers is whether we
    // still have contact with the vehicle, not whether it is moving.
    const online = telemetry.moving + telemetry.idle;

    res.json({
      success: true,
      summary: {
        totalVehicles: trucks.length,
        // Vehicles with no tracker fitted are neither online nor offline; they
        // are reported separately so a paperwork-only truck is not counted as a
        // dead device. Derived from the truck's own `device` link rather than
        // by subtracting the device count, which would go wrong the moment a
        // unit is fitted to a vehicle another seat cannot see.
        online,
        offline: telemetry.offline,
        untracked: trucks.filter((t) => !t.device).length,
        moving: telemetry.moving,
        idle: telemetry.idle,
        activeTrips,
        maintenance: byStatus.Maintenance || 0,
        alerts,
        byStatus
      }
    });
  } catch (error) {
    console.error('[trucks] fleet summary failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to load fleet summary' });
  }
});

// GET /api/trucks — the caller's trucks, newest first, each with its drivers.
router.get('/', protect, requirePermission('trucks', 'read'), async (req, res) => {
  try {
    // The fitted GPS unit comes back with the truck so callers can offer
    // tracking without a second round-trip to /track/devices.
    const trucks = await Truck.find(ownedBy(req))
      .populate('device', 'name uniqueId lastPosition lastSeenAt')
      .sort({ createdAt: -1 });
    res.json({ success: true, trucks: await attachDrivers(trucks, req.accountId) });
  } catch (error) {
    console.error('[trucks] list failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to fetch trucks' });
  }
});

// POST /api/trucks — create a truck and its drivers for the caller.
router.post('/', protect, requirePermission('trucks', 'create'), async (req, res) => {
  try {
    const body = req.body || {};
    const fields = buildTruckFields(body);
    if (!fields.number || !fields.model) {
      return res.status(400).json({ success: false, error: 'Truck number and model are required' });
    }

    const drivers = readDriverList(body);
    const truck = await Truck.create({ ...fields, owner: req.accountId });

    try {
      await syncTruckDrivers(truck._id, req.accountId, drivers, rawDriverRows(body));
    } catch (err) {
      // A truck with no valid drivers is worse than no truck at all here — the
      // form submitted both together, so roll back rather than leave a stray.
      await Truck.deleteOne({ _id: truck._id });
      await Driver.deleteMany({ truck: truck._id });
      if (err.name === 'ValidationError') {
        return res.status(400).json({ success: false, error: err.message });
      }
      throw err;
    }

    const saved = await attachDrivers(truck, req.accountId);
    const names = (saved.drivers || []).map((d) => d.name).filter(Boolean);

    Notification.create({
      owner: req.accountId,
      type: 'event',
      title: 'Truck Added',
      message: `Truck ${truck.number} added to fleet${names.length ? ` with driver${names.length > 1 ? 's' : ''} ${names.join(', ')}` : ''}`,
      vehicle: truck.number
    }).catch((err) => console.error('[trucks] notification failed:', err.message));

    await auditCreate(req, { entity: 'truck', doc: truck, label: truck.number });

    res.status(201).json({ success: true, truck: saved });
  } catch (error) {
    console.error('[trucks] create failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to create truck' });
  }
});

// PUT /api/trucks/:id — full update of one of the caller's trucks, drivers included.
router.put('/:id', protect, requirePermission('trucks', 'update'), async (req, res) => {
  try {
    const body = req.body || {};
    const fields = buildTruckFields(body);

    // Read once, before the write: this is both the odometer guard's reference
    // point and the "old value" side of the audit diff.
    const before = await Truck.findOne({ _id: req.params.id, ...ownedBy(req) });
    if (!before) return res.status(404).json({ success: false, error: 'Truck not found' });

    // An odometer only ever climbs. A lower reading is a typo far more often
    // than a genuine correction, and silently accepting it would understate
    // every distance derived from it, so it is rejected rather than clamped.
    if (fields.odometer !== undefined && fields.odometer < (before.odometer || 0)) {
      return res.status(400).json({
        success: false,
        error: `Odometer cannot go backwards (current reading is ${before.odometer} km)`
      });
    }

    const truck = await Truck.findOneAndUpdate(
      { _id: req.params.id, ...ownedBy(req) },
      { $set: fields },
      { new: true, runValidators: true }
    );
    if (!truck) return res.status(404).json({ success: false, error: 'Truck not found' });

    await syncTruckDrivers(truck._id, req.accountId, readDriverList(body), rawDriverRows(body));

    await auditUpdate(req, {
      entity: 'truck',
      before,
      after: truck,
      fields,
      label: truck.number
    });

    res.json({ success: true, truck: await attachDrivers(truck, req.accountId) });
  } catch (error) {
    if (error.name === 'ValidationError') {
      return res.status(400).json({ success: false, error: error.message });
    }
    console.error('[trucks] update failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to update truck' });
  }
});

// DELETE /api/trucks/:id — remove one of the caller's trucks and its drivers.
router.delete('/:id', protect, requirePermission('trucks', 'delete'), async (req, res) => {
  try {
    const truck = await Truck.findOneAndDelete({ _id: req.params.id, ...ownedBy(req) });
    if (!truck) return res.status(404).json({ success: false, error: 'Truck not found' });

    // The drivers go with the truck, so their paperwork has to be collected
    // before they are deleted — afterwards there is nothing left to look them
    // up by.
    const driverIds = (await Driver.find({ truck: truck._id, ...ownedBy(req) }).select('_id'))
      .map((d) => d._id);

    await Driver.deleteMany({ truck: truck._id, ...ownedBy(req) });
    // The vehicle's own paperwork goes with it — an RC or permit for a truck
    // that no longer exists is only noise in the expiry alerts.
    await VehicleDocument.deleteMany({ truck: truck._id, ...ownedBy(req) });
    if (driverIds.length) {
      await DriverDocument.deleteMany({ driver: { $in: driverIds }, ...ownedBy(req) });
    }

    // Logged after the cascade so the entry reflects what the delete actually
    // took with it, and notes the collateral — the drivers and paperwork that
    // went too are not otherwise recoverable from the trail.
    await auditDelete(req, {
      entity: 'truck',
      doc: truck,
      label: truck.number,
      summary: `Truck ${truck.number} deleted${driverIds.length ? ` along with ${driverIds.length} driver${driverIds.length > 1 ? 's' : ''} and their documents` : ''}`
    });

    res.json({ success: true, message: 'Truck removed' });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to delete truck' });
  }
});

export default router;
