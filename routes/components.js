import express from 'express';
import Tyre from '../models/Tyre.js';
import Battery from '../models/Battery.js';
import Truck from '../models/Truck.js';
import { settingsFor } from '../models/MaintenanceSetting.js';
import { protect, requirePermission } from '../middleware/auth.js';
import { auditCreate, auditUpdate, auditDelete } from '../utils/audit.js';
import {
  TYRE_STATUSES,
  ON_VEHICLE_TYRE_STATUSES,
  BATTERY_STATUSES,
  TYRE_POSITIONS,
  daysUntil
} from '../utils/maintenance.js';
import {
  buildTyreFields,
  buildFitment,
  buildRemoval,
  buildRetread,
  buildBatteryFields,
  buildBatteryInstall,
  buildBatteryCheck,
  objectId
} from '../utils/maintenanceFields.js';
import { fitTyre, removeTyre, retreadTyre, recomputeTyre } from '../services/tyreTracking.js';

// M3-M06 to M3-M09 — the tyre and battery masters.
//
// Split from routes/maintenance.js because these are asset registers, not job
// cards: a tyre is fitted, rotated, retreaded and scrapped over years, and the
// endpoints that move it through that life have nothing in common with the CRUD
// on a service record. Both files sit behind the same `maintenance` permission
// resource — a seat that can book a service can fit a tyre.

const router = express.Router();

const ownedBy = (req) => ({ owner: req.accountId });

const tyreLabel = (doc) =>
  `Tyre ${doc?.tyreNumber || '?'}${doc?.vehicleNumber ? ` on ${doc.vehicleNumber}` : ''}`;

const batteryLabel = (doc) =>
  `Battery ${doc?.serialNumber || '?'}${doc?.vehicleNumber ? ` on ${doc.vehicleNumber}` : ''}`;

// The fields the audit trail tracks. The computed life figures — running
// kilometres, cost per km — are deliberately absent: they move every time the
// vehicle's odometer does, and logging them would fill the trail with rows
// reporting that a truck was driven.
const TYRE_AUDIT_FIELDS = [
  'tyreNumber',
  'brand',
  'model',
  'size',
  'serialNumber',
  'purchaseDate',
  'price',
  'warrantyMonths',
  'ratedKm',
  'status',
  'vehicleNumber',
  'position',
  'treadDepthMm',
  'scrapReason',
  'salvageValue',
  'notes'
];

const BATTERY_AUDIT_FIELDS = [
  'serialNumber',
  'brand',
  'model',
  'voltage',
  'capacityAh',
  'purchaseDate',
  'cost',
  'warrantyMonths',
  'warrantyExpiry',
  'status',
  'vehicleNumber',
  'position',
  'installedAt',
  'health',
  'expectedReplacementDate',
  'removalReason',
  'notes'
];

const TRUCK_POPULATE = { path: 'truck', select: 'number model vehicleType odometer status' };

const searchClause = (raw, fields) => {
  const search = String(raw || '').trim();
  if (!search) return null;
  const safe = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rx = new RegExp(safe, 'i');
  return { $or: fields.map((field) => ({ [field]: rx })) };
};

const readPaging = (req) => ({
  page: Math.max(1, Number(req.query.page) || 1),
  limit: Math.min(200, Math.max(1, Number(req.query.limit) || 25))
});

// A duplicate key on either master means the fleet already has that number, and
// the message should say so rather than leaking a Mongo error.
const duplicateMessage = (error, what, value) =>
  error?.code === 11000 ? `${what} ${value} already exists in this fleet` : null;

// ---------------------------------------------------------------------------
// M3-M06 / M3-M07 / M3-M08 — Tyres
// ---------------------------------------------------------------------------

// GET /api/components/tyres — the tyre register.
router.get('/tyres', protect, requirePermission('maintenance', 'read'), async (req, res) => {
  try {
    const query = ownedBy(req);

    const truck = objectId(req.query.truck);
    if (truck) query.truck = truck;

    if (TYRE_STATUSES.includes(req.query.status)) query.status = req.query.status;
    if (req.query.position) query.position = String(req.query.position).trim();
    if (req.query.brand) query.brand = String(req.query.brand).trim();

    // The replacement queue: fitted tyres at or below the account's minimum
    // tread. Resolved here rather than in the browser so the threshold comes
    // from one place.
    if (req.query.dueForReplacement === 'true') {
      const settings = await settingsFor(req.accountId);
      query.status = { $in: ON_VEHICLE_TYRE_STATUSES };
      query.treadDepthMm = { $ne: null, $lte: settings.tyreMinTreadMm };
    }

    const search = searchClause(req.query.search, [
      'tyreNumber',
      'serialNumber',
      'brand',
      'model',
      'size',
      'vehicleNumber',
      'position'
    ]);
    if (search) Object.assign(query, search);

    const SORTABLE = {
      tyreNumber: 'tyreNumber',
      runningKm: 'runningKm',
      costPerKm: 'costPerKm',
      treadDepthMm: 'treadDepthMm',
      purchaseDate: 'purchaseDate',
      createdAt: 'createdAt'
    };
    const sortField = SORTABLE[req.query.sortBy] || 'createdAt';
    const sortDir = req.query.sortDir === 'asc' ? 1 : -1;

    const { page, limit } = readPaging(req);

    const [tyres, total] = await Promise.all([
      Tyre.find(query)
        // The histories are excluded from the list: a tyre with twenty
        // fitments is rows of data no table cell shows. The detail endpoint
        // returns them.
        .select('-fitments -retreads')
        .populate(TRUCK_POPULATE)
        .sort({ [sortField]: sortDir, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Tyre.countDocuments(query)
    ]);

    res.json({
      success: true,
      tyres,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) || 1 }
    });
  } catch (error) {
    console.error('[maintenance] tyre list failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to fetch tyres' });
  }
});

// M3-M07 — the vehicle's current tyre layout: what is fitted where.
//
// Returned as a position-keyed map plus the loose list, so the UI can draw an
// axle diagram without deciding for itself which tyre is at which corner.
router.get('/tyres/layout/:truckId', protect, requirePermission('maintenance', 'read'), async (req, res) => {
  try {
    const truck = objectId(req.params.truckId);
    if (!truck) return res.status(400).json({ success: false, error: 'Invalid vehicle' });

    const [vehicle, tyres, settings] = await Promise.all([
      Truck.findOne({ _id: truck, owner: req.accountId }).select('number odometer status').lean(),
      Tyre.find({ owner: req.accountId, truck, status: { $in: ON_VEHICLE_TYRE_STATUSES } })
        .select('-fitments -retreads')
        .lean(),
      settingsFor(req.accountId)
    ]);

    if (!vehicle) return res.status(404).json({ success: false, error: 'Vehicle not found' });

    const byPosition = {};
    for (const tyre of tyres) {
      byPosition[tyre.position || 'Unassigned'] = {
        ...tyre,
        // Whether this one needs replacing, decided here so every screen that
        // renders the layout agrees.
        dueForReplacement:
          tyre.treadDepthMm !== null && tyre.treadDepthMm <= settings.tyreMinTreadMm
      };
    }

    res.json({
      success: true,
      vehicle,
      tyres,
      byPosition,
      // The standard positions, so a vehicle with empty corners still renders a
      // full diagram rather than only the corners that happen to be filled.
      positions: TYRE_POSITIONS,
      minTreadMm: settings.tyreMinTreadMm
    });
  } catch (error) {
    console.error('[maintenance] tyre layout failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to load the tyre layout' });
  }
});

// One tyre in full, fitment and retread history included.
router.get('/tyres/:id', protect, requirePermission('maintenance', 'read'), async (req, res) => {
  try {
    const tyre = await Tyre.findOne({ _id: req.params.id, ...ownedBy(req) })
      .populate(TRUCK_POPULATE)
      .lean();

    if (!tyre) return res.status(404).json({ success: false, error: 'Tyre not found' });

    res.json({ success: true, tyre });
  } catch (error) {
    console.error('[maintenance] tyre fetch failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to fetch the tyre' });
  }
});

// POST /api/components/tyres — add a tyre to the master.
router.post('/tyres', protect, requirePermission('maintenance', 'create'), async (req, res) => {
  try {
    const { fields, errors } = buildTyreFields(req.body, { partial: false });
    if (errors.length) return res.status(400).json({ success: false, error: errors[0], errors });

    const tyre = new Tyre({
      ...fields,
      // A new tyre goes into stock. It reaches a vehicle through /fit, which is
      // what opens the stint its distance is measured over — letting a create
      // set a vehicle directly would produce a fitted tyre with no stint and
      // therefore no life figure, ever.
      status: 'In Stock',
      owner: req.accountId,
      createdBy: req.user._id
    });

    await tyre.save();

    auditCreate(req, {
      entity: 'tyre',
      doc: tyre,
      label: tyreLabel(tyre),
      fields: TYRE_AUDIT_FIELDS
    });

    res.status(201).json({ success: true, tyre: tyre.toObject() });
  } catch (error) {
    const duplicate = duplicateMessage(error, 'Tyre', req.body?.tyreNumber);
    if (duplicate) return res.status(400).json({ success: false, error: duplicate });
    if (error.name === 'ValidationError') {
      const first = Object.values(error.errors)[0];
      return res.status(400).json({ success: false, error: first?.message || 'Invalid tyre' });
    }
    console.error('[maintenance] tyre create failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to save the tyre' });
  }
});

// PUT /api/components/tyres/:id — correct a tyre's details.
router.put('/tyres/:id', protect, requirePermission('maintenance', 'update'), async (req, res) => {
  try {
    const tyre = await Tyre.findOne({ _id: req.params.id, ...ownedBy(req) });
    if (!tyre) return res.status(404).json({ success: false, error: 'Tyre not found' });

    const before = tyre.toObject();

    const { fields, errors } = buildTyreFields(req.body, { partial: true });
    if (errors.length) return res.status(400).json({ success: false, error: errors[0], errors });

    // Status is only settable here for the transitions that do not imply a
    // fitment. Fitting, removing and retreading go through their own endpoints,
    // which open and close the stints the life figure is measured over — a
    // status flipped to Fitted here would claim the tyre is on a vehicle with
    // no record of which one or from what reading.
    if (fields.status && fields.status !== tyre.status) {
      if (ON_VEHICLE_TYRE_STATUSES.includes(fields.status)) {
        return res.status(400).json({
          success: false,
          error: 'Use the fit endpoint to put a tyre on a vehicle, so its distance can be measured'
        });
      }
      if (tyre.truck && ['Scrapped', 'Sold', 'In Stock'].includes(fields.status)) {
        return res.status(400).json({
          success: false,
          error: 'Remove the tyre from the vehicle before changing its status'
        });
      }
    }

    tyre.set(fields);

    // The price or a retread may have moved, so the per-km figure is rebuilt
    // rather than left describing the old cost.
    await recomputeTyre(tyre);

    auditUpdate(req, {
      entity: 'tyre',
      before,
      after: tyre,
      fields: TYRE_AUDIT_FIELDS,
      label: tyreLabel(tyre)
    });

    res.json({ success: true, tyre: tyre.toObject() });
  } catch (error) {
    const duplicate = duplicateMessage(error, 'Tyre', req.body?.tyreNumber);
    if (duplicate) return res.status(400).json({ success: false, error: duplicate });
    if (error.name === 'ValidationError') {
      const first = Object.values(error.errors)[0];
      return res.status(400).json({ success: false, error: first?.message || 'Invalid tyre' });
    }
    console.error('[maintenance] tyre update failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to update the tyre' });
  }
});

// Fit a tyre to a vehicle at a position (M3-M07).
router.post('/tyres/:id/fit', protect, requirePermission('maintenance', 'update'), async (req, res) => {
  try {
    const tyre = await Tyre.findOne({ _id: req.params.id, ...ownedBy(req) });
    if (!tyre) return res.status(404).json({ success: false, error: 'Tyre not found' });

    if (['Scrapped', 'Sold'].includes(tyre.status)) {
      return res.status(400).json({ success: false, error: `That tyre has been ${tyre.status.toLowerCase()} and cannot be fitted` });
    }

    const { fitment, errors } = buildFitment(req.body);
    if (errors.length) return res.status(400).json({ success: false, error: errors[0], errors });

    const before = tyre.toObject();

    const { tyre: fitted, error } = await fitTyre({
      accountId: req.accountId,
      tyre,
      ...fitment
    });
    if (error) return res.status(400).json({ success: false, error });

    auditUpdate(req, {
      entity: 'tyre',
      before,
      after: fitted,
      fields: TYRE_AUDIT_FIELDS,
      label: tyreLabel(fitted),
      summary: `${tyreLabel(fitted)} fitted at ${fitted.position} (${fitment.odometer} km)`
    });

    res.json({ success: true, tyre: fitted.toObject() });
  } catch (error) {
    console.error('[maintenance] tyre fit failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to fit the tyre' });
  }
});

// Take a tyre off, closing its stint and banking the distance.
router.post('/tyres/:id/remove', protect, requirePermission('maintenance', 'update'), async (req, res) => {
  try {
    const tyre = await Tyre.findOne({ _id: req.params.id, ...ownedBy(req) });
    if (!tyre) return res.status(404).json({ success: false, error: 'Tyre not found' });

    const { removal, errors } = buildRemoval(req.body);
    if (errors.length) return res.status(400).json({ success: false, error: errors[0], errors });

    const before = tyre.toObject();
    const cameOff = tyre.vehicleNumber;

    const { tyre: removed, error } = await removeTyre({ tyre, ...removal });
    if (error) return res.status(400).json({ success: false, error });

    auditUpdate(req, {
      entity: 'tyre',
      before,
      after: removed,
      fields: TYRE_AUDIT_FIELDS,
      label: tyreLabel(removed),
      summary: `Tyre ${removed.tyreNumber} removed from ${cameOff || 'vehicle'} at ${removal.odometer} km — ${removed.runningKm} km run`
    });

    res.json({ success: true, tyre: removed.toObject() });
  } catch (error) {
    console.error('[maintenance] tyre removal failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to remove the tyre' });
  }
});

// Record a retread.
router.post('/tyres/:id/retread', protect, requirePermission('maintenance', 'update'), async (req, res) => {
  try {
    const tyre = await Tyre.findOne({ _id: req.params.id, ...ownedBy(req) });
    if (!tyre) return res.status(404).json({ success: false, error: 'Tyre not found' });

    const { retread, errors } = buildRetread(req.body);
    if (errors.length) return res.status(400).json({ success: false, error: errors[0], errors });

    const before = tyre.toObject();

    const { tyre: retreaded, error } = await retreadTyre({ tyre, ...retread });
    if (error) return res.status(400).json({ success: false, error });

    auditUpdate(req, {
      entity: 'tyre',
      before,
      after: retreaded,
      fields: TYRE_AUDIT_FIELDS,
      label: tyreLabel(retreaded),
      summary: `Tyre ${retreaded.tyreNumber} retreaded at ${retread.cost ? `₹${retread.cost}` : 'no cost recorded'}`
    });

    res.json({ success: true, tyre: retreaded.toObject() });
  } catch (error) {
    console.error('[maintenance] tyre retread failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to record the retread' });
  }
});

// DELETE /api/components/tyres/:id
router.delete('/tyres/:id', protect, requirePermission('maintenance', 'delete'), async (req, res) => {
  try {
    const tyre = await Tyre.findOne({ _id: req.params.id, ...ownedBy(req) });
    if (!tyre) return res.status(404).json({ success: false, error: 'Tyre not found' });

    // A fitted tyre is on a vehicle right now: deleting it would leave the
    // layout claiming a position is filled by a record that no longer exists.
    // Scrapping is what retires a tyre; deleting is for one entered by mistake.
    if (tyre.truck) {
      return res.status(400).json({
        success: false,
        error: 'Remove the tyre from the vehicle before deleting it'
      });
    }

    const label = tyreLabel(tyre);
    const snapshot = tyre.toObject();

    await tyre.deleteOne();

    auditDelete(req, { entity: 'tyre', doc: snapshot, label, fields: TYRE_AUDIT_FIELDS });

    res.json({ success: true, message: 'Tyre deleted' });
  } catch (error) {
    console.error('[maintenance] tyre delete failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to delete the tyre' });
  }
});

// ---------------------------------------------------------------------------
// M3-M09 — Batteries
// ---------------------------------------------------------------------------

router.get('/batteries', protect, requirePermission('maintenance', 'read'), async (req, res) => {
  try {
    const query = ownedBy(req);

    const truck = objectId(req.query.truck);
    if (truck) query.truck = truck;

    if (BATTERY_STATUSES.includes(req.query.status)) query.status = req.query.status;
    if (req.query.brand) query.brand = String(req.query.brand).trim();
    if (req.query.health) query.health = String(req.query.health).trim();

    // In-warranty only — the filter that turns a failing battery into a claim
    // rather than a purchase.
    if (req.query.inWarranty === 'true') {
      query.warrantyExpiry = { $ne: null, $gte: new Date() };
    }

    if (req.query.dueForReplacement === 'true') {
      const settings = await settingsFor(req.accountId);
      const horizon = new Date();
      horizon.setDate(horizon.getDate() + settings.serviceDueDays);
      query.status = 'Fitted';
      query.$or = [
        { health: { $in: ['Weak', 'Dead'] } },
        { expectedReplacementDate: { $ne: null, $lte: horizon } }
      ];
    }

    const search = searchClause(req.query.search, [
      'serialNumber',
      'brand',
      'model',
      'vehicleNumber',
      'position'
    ]);
    if (search) {
      // Combined rather than assigned: the due-for-replacement filter above may
      // already own $or, and overwriting it would silently drop it.
      query.$and = [...(query.$and || []), search];
      if (query.$or && search.$or) {
        query.$and.push({ $or: query.$or });
        delete query.$or;
      }
    }

    const SORTABLE = {
      serialNumber: 'serialNumber',
      purchaseDate: 'purchaseDate',
      warrantyExpiry: 'warrantyExpiry',
      lastCheckedAt: 'lastCheckedAt',
      createdAt: 'createdAt'
    };
    const sortField = SORTABLE[req.query.sortBy] || 'createdAt';
    const sortDir = req.query.sortDir === 'asc' ? 1 : -1;

    const { page, limit } = readPaging(req);

    const [batteries, total] = await Promise.all([
      Battery.find(query)
        .select('-checks')
        .populate(TRUCK_POPULATE)
        .sort({ [sortField]: sortDir, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Battery.countDocuments(query)
    ]);

    const settings = await settingsFor(req.accountId);

    res.json({
      success: true,
      // The warranty countdown is computed here rather than in the browser, so
      // the list, the reminders and the dashboard all agree on what "expiring
      // soon" means.
      batteries: batteries.map((b) => ({
        ...b,
        warrantyDaysLeft: daysUntil(b.warrantyExpiry),
        warrantyClosing:
          b.warrantyExpiry !== null &&
          (daysUntil(b.warrantyExpiry) ?? -1) >= 0 &&
          (daysUntil(b.warrantyExpiry) ?? Infinity) <= settings.warrantyWarnDays
      })),
      pagination: { page, limit, total, pages: Math.ceil(total / limit) || 1 }
    });
  } catch (error) {
    console.error('[maintenance] battery list failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to fetch batteries' });
  }
});

router.get('/batteries/:id', protect, requirePermission('maintenance', 'read'), async (req, res) => {
  try {
    const battery = await Battery.findOne({ _id: req.params.id, ...ownedBy(req) })
      .populate(TRUCK_POPULATE)
      .populate({ path: 'replacedBy', select: 'serialNumber brand installedAt' })
      .lean();

    if (!battery) return res.status(404).json({ success: false, error: 'Battery not found' });

    res.json({
      success: true,
      battery: { ...battery, warrantyDaysLeft: daysUntil(battery.warrantyExpiry) }
    });
  } catch (error) {
    console.error('[maintenance] battery fetch failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to fetch the battery' });
  }
});

router.post('/batteries', protect, requirePermission('maintenance', 'create'), async (req, res) => {
  try {
    const { fields, errors } = buildBatteryFields(req.body, { partial: false });
    if (errors.length) return res.status(400).json({ success: false, error: errors[0], errors });

    const battery = new Battery({
      ...fields,
      // Into stock, for the same reason a tyre is: it reaches a vehicle through
      // /install, which stamps the reading its life is measured from.
      status: 'In Stock',
      owner: req.accountId,
      createdBy: req.user._id
    });

    await battery.save();

    auditCreate(req, {
      entity: 'battery',
      doc: battery,
      label: batteryLabel(battery),
      fields: BATTERY_AUDIT_FIELDS
    });

    res.status(201).json({ success: true, battery: battery.toObject() });
  } catch (error) {
    const duplicate = duplicateMessage(error, 'Battery serial', req.body?.serialNumber);
    if (duplicate) return res.status(400).json({ success: false, error: duplicate });
    if (error.name === 'ValidationError') {
      const first = Object.values(error.errors)[0];
      return res.status(400).json({ success: false, error: first?.message || 'Invalid battery' });
    }
    console.error('[maintenance] battery create failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to save the battery' });
  }
});

router.put('/batteries/:id', protect, requirePermission('maintenance', 'update'), async (req, res) => {
  try {
    const battery = await Battery.findOne({ _id: req.params.id, ...ownedBy(req) });
    if (!battery) return res.status(404).json({ success: false, error: 'Battery not found' });

    const before = battery.toObject();

    const { fields, errors } = buildBatteryFields(req.body, { partial: true });
    if (errors.length) return res.status(400).json({ success: false, error: errors[0], errors });

    // Fitting goes through /install, for the same reason a tyre's does.
    if (fields.status === 'Fitted' && battery.status !== 'Fitted') {
      return res.status(400).json({
        success: false,
        error: 'Use the install endpoint to fit a battery to a vehicle'
      });
    }

    battery.set(fields);
    await battery.save();

    auditUpdate(req, {
      entity: 'battery',
      before,
      after: battery,
      fields: BATTERY_AUDIT_FIELDS,
      label: batteryLabel(battery)
    });

    res.json({ success: true, battery: battery.toObject() });
  } catch (error) {
    const duplicate = duplicateMessage(error, 'Battery serial', req.body?.serialNumber);
    if (duplicate) return res.status(400).json({ success: false, error: duplicate });
    if (error.name === 'ValidationError') {
      const first = Object.values(error.errors)[0];
      return res.status(400).json({ success: false, error: first?.message || 'Invalid battery' });
    }
    console.error('[maintenance] battery update failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to update the battery' });
  }
});

// Fit a battery to a vehicle.
router.post('/batteries/:id/install', protect, requirePermission('maintenance', 'update'), async (req, res) => {
  try {
    const battery = await Battery.findOne({ _id: req.params.id, ...ownedBy(req) });
    if (!battery) return res.status(404).json({ success: false, error: 'Battery not found' });

    if (battery.status === 'Fitted') {
      return res.status(400).json({
        success: false,
        error: `That battery is already fitted to ${battery.vehicleNumber || 'a vehicle'}. Remove it first.`
      });
    }
    if (battery.status === 'Scrapped') {
      return res.status(400).json({ success: false, error: 'That battery has been scrapped and cannot be fitted' });
    }

    const { install, errors } = buildBatteryInstall(req.body);
    if (errors.length) return res.status(400).json({ success: false, error: errors[0], errors });

    const vehicle = await Truck.findOne({ _id: install.truck, owner: req.accountId })
      .select('number')
      .lean();
    if (!vehicle) return res.status(400).json({ success: false, error: 'That vehicle could not be found' });

    const before = battery.toObject();

    // The battery this one replaces, if it is taking a named position that is
    // already occupied. Linked both ways so a vehicle's battery history reads
    // as a chain — see `replacedBy` on the model.
    let replaced = null;
    if (install.position) {
      replaced = await Battery.findOne({
        owner: req.accountId,
        truck: install.truck,
        position: install.position,
        status: 'Fitted',
        _id: { $ne: battery._id }
      });
    }

    battery.set({
      truck: install.truck,
      vehicleNumber: vehicle.number || '',
      position: install.position,
      installedAt: install.installedAt,
      installedOdometer: install.odometer,
      status: 'Fitted',
      removedAt: null,
      removalReason: ''
    });

    // Expected replacement follows the account's battery life, unless somebody
    // has set a date by hand.
    if (!battery.expectedReplacementDate && battery.purchaseDate) {
      const settings = await settingsFor(req.accountId);
      const expected = new Date(battery.purchaseDate);
      expected.setMonth(expected.getMonth() + settings.batteryLifeMonths);
      battery.expectedReplacementDate = expected;
    }

    await battery.save();

    if (replaced) {
      replaced.set({
        status: 'Removed',
        truck: null,
        vehicleNumber: '',
        position: '',
        removedAt: install.installedAt,
        removalReason: `Replaced by ${battery.serialNumber}`,
        replacedBy: battery._id
      });
      await replaced.save();
    }

    auditUpdate(req, {
      entity: 'battery',
      before,
      after: battery,
      fields: BATTERY_AUDIT_FIELDS,
      label: batteryLabel(battery),
      summary: `${batteryLabel(battery)} installed${replaced ? `, replacing ${replaced.serialNumber}` : ''}`
    });

    res.json({
      success: true,
      battery: battery.toObject(),
      replaced: replaced ? replaced.toObject() : null
    });
  } catch (error) {
    console.error('[maintenance] battery install failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to install the battery' });
  }
});

// Take a battery off.
router.post('/batteries/:id/remove', protect, requirePermission('maintenance', 'update'), async (req, res) => {
  try {
    const battery = await Battery.findOne({ _id: req.params.id, ...ownedBy(req) });
    if (!battery) return res.status(404).json({ success: false, error: 'Battery not found' });

    if (battery.status !== 'Fitted') {
      return res.status(400).json({ success: false, error: 'That battery is not currently fitted' });
    }

    const before = battery.toObject();
    const cameOff = battery.vehicleNumber;

    // Where it goes next. A battery still under warranty that has failed is a
    // claim, which is why that is one of the statuses on offer rather than
    // just scrap.
    const status = ['Removed', 'Scrapped', 'Warranty Claim'].includes(req.body?.status)
      ? req.body.status
      : 'Removed';

    battery.set({
      status,
      truck: null,
      vehicleNumber: '',
      position: '',
      removedAt: new Date(),
      removalReason: String(req.body?.reason ?? '').trim()
    });

    await battery.save();

    auditUpdate(req, {
      entity: 'battery',
      before,
      after: battery,
      fields: BATTERY_AUDIT_FIELDS,
      label: batteryLabel(battery),
      summary: `Battery ${battery.serialNumber} removed from ${cameOff || 'vehicle'} — ${status}`
    });

    res.json({ success: true, battery: battery.toObject() });
  } catch (error) {
    console.error('[maintenance] battery removal failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to remove the battery' });
  }
});

// Record a voltage/health check (M3-M09).
router.post('/batteries/:id/check', protect, requirePermission('maintenance', 'update'), async (req, res) => {
  try {
    const battery = await Battery.findOne({ _id: req.params.id, ...ownedBy(req) });
    if (!battery) return res.status(404).json({ success: false, error: 'Battery not found' });

    const { check, errors } = buildBatteryCheck(req.body);
    if (errors.length) return res.status(400).json({ success: false, error: errors[0], errors });

    const before = battery.toObject();

    battery.checks.push(check);

    // The denormalised "current condition", so the list can show and sort on
    // health without unwinding the history. Only moved forward: a check
    // back-dated behind the latest one is recorded but does not overwrite a
    // newer reading with an older one.
    if (!battery.lastCheckedAt || check.date >= battery.lastCheckedAt) {
      battery.lastCheckedAt = check.date;
      if (check.voltage !== null) battery.lastVoltage = check.voltage;
      if (check.health) battery.health = check.health;
    }

    await battery.save();

    auditUpdate(req, {
      entity: 'battery',
      before,
      after: battery,
      fields: BATTERY_AUDIT_FIELDS,
      label: batteryLabel(battery),
      summary: `Battery ${battery.serialNumber} checked${check.voltage !== null ? ` at ${check.voltage}V` : ''}${check.health ? ` — ${check.health}` : ''}`
    });

    res.json({ success: true, battery: battery.toObject() });
  } catch (error) {
    console.error('[maintenance] battery check failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to record the check' });
  }
});

router.delete('/batteries/:id', protect, requirePermission('maintenance', 'delete'), async (req, res) => {
  try {
    const battery = await Battery.findOne({ _id: req.params.id, ...ownedBy(req) });
    if (!battery) return res.status(404).json({ success: false, error: 'Battery not found' });

    if (battery.status === 'Fitted') {
      return res.status(400).json({
        success: false,
        error: 'Remove the battery from the vehicle before deleting it'
      });
    }

    const label = batteryLabel(battery);
    const snapshot = battery.toObject();

    await battery.deleteOne();

    auditDelete(req, { entity: 'battery', doc: snapshot, label, fields: BATTERY_AUDIT_FIELDS });

    res.json({ success: true, message: 'Battery deleted' });
  } catch (error) {
    console.error('[maintenance] battery delete failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to delete the battery' });
  }
});

export default router;
