import express from 'express';
import mongoose from 'mongoose';
import ServiceRecord from '../models/ServiceRecord.js';
import RepairRequest from '../models/RepairRequest.js';
import MaintenanceSetting, { settingsFor } from '../models/MaintenanceSetting.js';
import Truck from '../models/Truck.js';
import Driver from '../models/Driver.js';
import { protect, requirePermission } from '../middleware/auth.js';
import { auditCreate, auditUpdate, auditDelete } from '../utils/audit.js';
import {
  SERVICE_TYPES,
  SERVICE_TYPE_LABELS,
  SERVICE_INTERVALS,
  REPAIR_STATUSES,
  REPAIR_STATUS_LABELS,
  REPAIR_TRANSITIONS,
  REPAIR_PRIORITIES,
  REPAIR_PRIORITY_LABELS,
  ACTIVE_REPAIR_STATUSES,
  OPEN_REPAIR_STATUSES,
  TYRE_POSITIONS,
  TYRE_STATUSES,
  TYRE_STATUS_LABELS,
  BATTERY_STATUSES,
  BATTERY_STATUS_LABELS,
  BATTERY_HEALTH,
  BATTERY_VOLTAGES,
  PAYMENT_MODES,
  WORKSHOP_TYPES,
  DEFAULT_SETTINGS,
  suggestNextService
} from '../utils/maintenance.js';
import {
  buildServiceFields,
  buildRepairFields,
  buildStatusChange,
  buildSettingsFields,
  objectId
} from '../utils/maintenanceFields.js';
import { createWithRequestNumber, previewRequestNumber } from '../services/maintenanceNumber.js';
import { allReminders, dashboard } from '../services/maintenanceReminders.js';
import * as reports from '../services/maintenanceReports.js';

const router = express.Router();

// Every maintenance record belongs to the caller's account, applied to the
// query itself rather than filtered after the read — the same rule as every
// other business record here.
const ownedBy = (req) => ({ owner: req.accountId });

// How a record names itself in the audit trail: the way an operator would say
// it out loud.
const serviceLabel = (doc) =>
  `${doc?.vehicleNumber || 'Vehicle'} — ${SERVICE_TYPE_LABELS[doc?.serviceType] || doc?.serviceType || 'service'}`;

const repairLabel = (doc) =>
  `${doc?.requestNumber || 'Repair'} — ${doc?.vehicleNumber || 'Vehicle'}`;

// The fields the audit trail tracks. The derived totals are included because a
// changed total is exactly what a reader of the trail wants to see, but the
// workflow stamps are not: they are written by the status endpoint, which
// records the transition itself in a form that reads better than a diff.
const SERVICE_AUDIT_FIELDS = [
  'vehicleNumber',
  'serviceType',
  'servicedAt',
  'odometer',
  'workshop.name',
  'workshop.type',
  'labourCost',
  'partsTotal',
  'taxAmount',
  'discount',
  'totalCost',
  'paymentMode',
  'invoiceNumber',
  'nextServiceDate',
  'nextServiceKm',
  'notes'
];

const REPAIR_AUDIT_FIELDS = [
  'requestNumber',
  'vehicleNumber',
  'issue',
  'reportedByName',
  'reportedAt',
  'odometer',
  'priority',
  'workshop.name',
  'estimatedCost',
  'labourCost',
  'partsTotal',
  'taxAmount',
  'discount',
  'totalCost',
  'paymentMode',
  'invoiceNumber',
  'diagnosis',
  'workDone',
  'notes'
];

const SERVICE_POPULATE = [
  { path: 'truck', select: 'number model vehicleType odometer status' },
  { path: 'repair', select: 'requestNumber issue status' }
];

const REPAIR_POPULATE = [
  { path: 'truck', select: 'number model vehicleType odometer status' },
  { path: 'reportedBy', select: 'name mobile licenseNumber status' }
];

// Parses a date filter, returning null for anything unusable rather than an
// Invalid Date that would silently match nothing.
const parseDate = (raw, { endOfDay = false } = {}) => {
  if (!raw) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  if (endOfDay) d.setHours(23, 59, 59, 999);
  return d;
};

// The filter set shared by the lists and every report, read from the query
// string in one place so a filter cannot mean one thing on a register and
// another on the report built from it.
const readFilters = (req) => ({
  accountId: req.accountId,
  from: parseDate(req.query.from),
  to: parseDate(req.query.to, { endOfDay: true }),
  truck: objectId(req.query.truck),
  serviceType: SERVICE_TYPES.includes(req.query.serviceType) ? req.query.serviceType : null,
  workshop: req.query.workshop ? String(req.query.workshop).trim() : null,
  status: req.query.status || null
});

// A case-insensitive search over a set of fields, with the user's input escaped
// so a stray bracket cannot become a pattern.
const searchClause = (raw, fields) => {
  const search = String(raw || '').trim();
  if (!search) return null;
  const safe = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rx = new RegExp(safe, 'i');
  return { $or: fields.map((field) => ({ [field]: rx })) };
};

// Pagination, capped so a caller cannot ask for the whole collection at once.
const readPaging = (req) => ({
  page: Math.max(1, Number(req.query.page) || 1),
  limit: Math.min(200, Math.max(1, Number(req.query.limit) || 25))
});

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

// Everything the maintenance forms render their dropdowns from, served from the
// same module the models validate against so the UI can never offer a value the
// API would reject.
router.get('/options', protect, (req, res) => {
  res.json({
    success: true,
    serviceTypes: SERVICE_TYPES.map((v) => ({
      value: v,
      label: SERVICE_TYPE_LABELS[v],
      interval: SERVICE_INTERVALS[v]
    })),
    serviceIntervals: SERVICE_INTERVALS,
    repairStatuses: REPAIR_STATUSES.map((v) => ({
      value: v,
      label: REPAIR_STATUS_LABELS[v],
      // The UI renders its status buttons from this rather than hardcoding the
      // workflow, so the two can never disagree about what is allowed next.
      next: REPAIR_TRANSITIONS[v] || []
    })),
    repairTransitions: REPAIR_TRANSITIONS,
    activeRepairStatuses: ACTIVE_REPAIR_STATUSES,
    openRepairStatuses: OPEN_REPAIR_STATUSES,
    repairPriorities: REPAIR_PRIORITIES.map((v) => ({ value: v, label: REPAIR_PRIORITY_LABELS[v] })),
    tyrePositions: TYRE_POSITIONS,
    tyreStatuses: TYRE_STATUSES.map((v) => ({ value: v, label: TYRE_STATUS_LABELS[v] })),
    batteryStatuses: BATTERY_STATUSES.map((v) => ({ value: v, label: BATTERY_STATUS_LABELS[v] })),
    batteryHealth: BATTERY_HEALTH,
    batteryVoltages: BATTERY_VOLTAGES,
    paymentModes: PAYMENT_MODES,
    workshopTypes: WORKSHOP_TYPES,
    defaultSettings: DEFAULT_SETTINGS
  });
});

// The distinct workshop names this account has used, for the job card's
// autocomplete. Typing a workshop that already exists should be one keystroke,
// not a re-spelling that fragments the vendor report.
router.get('/workshops', protect, requirePermission('maintenance', 'read'), async (req, res) => {
  try {
    const search = String(req.query.search || '').trim();
    const match = { owner: req.accountId, 'workshop.name': { $nin: ['', null] } };

    if (search) {
      const safe = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      match['workshop.name'] = { $nin: ['', null], $regex: new RegExp(safe, 'i') };
    }

    const group = {
      $group: {
        _id: '$workshop.name',
        type: { $last: '$workshop.type' },
        city: { $last: '$workshop.city' },
        contact: { $last: '$workshop.contact' },
        uses: { $sum: 1 }
      }
    };

    // Both collections, because a garage used for a repair is the same garage
    // when it does a service — offering only half the list would send the user
    // to retype a name that already exists.
    const [fromServices, fromRepairs] = await Promise.all([
      ServiceRecord.aggregate([{ $match: match }, group]),
      RepairRequest.aggregate([{ $match: match }, group])
    ]);

    const merged = new Map();
    for (const row of [...fromServices, ...fromRepairs]) {
      const existing = merged.get(row._id);
      if (existing) {
        existing.uses += row.uses;
        existing.type = existing.type || row.type;
        existing.city = existing.city || row.city;
        existing.contact = existing.contact || row.contact;
      } else {
        merged.set(row._id, {
          name: row._id,
          type: row.type || '',
          city: row.city || '',
          contact: row.contact || '',
          uses: row.uses
        });
      }
    }

    res.json({
      success: true,
      // Most-used first: the garages a fleet actually uses should be at the top
      // of the suggestion list.
      workshops: [...merged.values()].sort((a, b) => b.uses - a.uses).slice(0, 50)
    });
  } catch (error) {
    console.error('[maintenance] workshop list failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to load workshops' });
  }
});

// What the form should suggest for "next service", given a type and a reading.
// Offered at the keyboard so the office is not looking up an oil change
// interval on every job card; nothing is applied without the user accepting it.
router.get('/next-service-suggestion', protect, requirePermission('maintenance', 'read'), (req, res) => {
  const serviceType = SERVICE_TYPES.includes(req.query.serviceType) ? req.query.serviceType : 'General';
  const servicedAt = parseDate(req.query.servicedAt) || new Date();
  const odometer = req.query.odometer === undefined ? null : Number(req.query.odometer);

  res.json({
    success: true,
    serviceType,
    ...suggestNextService({ serviceType, servicedAt, odometer })
  });
});

// The last service of each type for a vehicle, so the form can show what was
// last done and when. Catching "this was serviced three weeks ago" at the
// keyboard is worth more than finding the duplicate later.
router.get('/vehicle/:truckId/history', protect, requirePermission('maintenance', 'read'), async (req, res) => {
  try {
    const truck = objectId(req.params.truckId);
    if (!truck) return res.status(400).json({ success: false, error: 'Invalid vehicle' });

    const [vehicle, services, repairs] = await Promise.all([
      Truck.findOne({ _id: truck, owner: req.accountId }).select('number odometer status').lean(),
      ServiceRecord.find({ owner: req.accountId, truck })
        .select('serviceType servicedAt odometer totalCost nextServiceDate nextServiceKm workshop.name')
        .sort({ servicedAt: -1 })
        .limit(50)
        .lean(),
      RepairRequest.find({ owner: req.accountId, truck })
        .select('requestNumber issue status priority reportedAt completedAt totalCost')
        .sort({ reportedAt: -1 })
        .limit(50)
        .lean()
    ]);

    if (!vehicle) return res.status(404).json({ success: false, error: 'Vehicle not found' });

    // The newest service per type — the row each reminder clock hangs off.
    const lastByType = {};
    for (const row of services) {
      if (!lastByType[row.serviceType]) lastByType[row.serviceType] = row;
    }

    res.json({
      success: true,
      vehicle,
      services,
      repairs,
      lastByType,
      openRepairs: repairs.filter((r) => OPEN_REPAIR_STATUSES.includes(r.status)).length
    });
  } catch (error) {
    console.error('[maintenance] vehicle history failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to load the vehicle history' });
  }
});

// ---------------------------------------------------------------------------
// M3-M01 — the dashboard, and M3-M10 — the reminders
// ---------------------------------------------------------------------------

router.get('/dashboard', protect, requirePermission('maintenance', 'read'), async (req, res) => {
  try {
    const filters = readFilters(req);
    res.json({
      success: true,
      ...(await dashboard(req.accountId, { from: filters.from, to: filters.to }))
    });
  } catch (error) {
    console.error('[maintenance] dashboard failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to build the maintenance dashboard' });
  }
});

router.get('/reminders', protect, requirePermission('maintenance', 'read'), async (req, res) => {
  try {
    const truck = objectId(req.query.truck);
    const { items, counts, settings } = await allReminders(req.accountId, { truck });

    // The list is filterable by kind and by status so the screen can offer
    // "overdue only" and "tyres only" without a second endpoint.
    const kind = ['service', 'tyre', 'battery'].includes(req.query.kind) ? req.query.kind : null;
    const status = ['overdue', 'due'].includes(req.query.status) ? req.query.status : null;

    const filtered = items.filter(
      (item) => (!kind || item.kind === kind) && (!status || item.status === status)
    );

    res.json({ success: true, reminders: filtered, counts, settings });
  } catch (error) {
    console.error('[maintenance] reminders failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to load the service reminders' });
  }
});

// ---------------------------------------------------------------------------
// M3-M11 — Reports
// ---------------------------------------------------------------------------

router.get('/summary', protect, requirePermission('maintenance', 'read'), async (req, res) => {
  try {
    res.json({ success: true, ...(await reports.summary(readFilters(req))) });
  } catch (error) {
    console.error('[maintenance] summary failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to build the maintenance summary' });
  }
});

// One endpoint per grouping rather than a `groupBy` parameter, so each can
// return the fields its own grouping needs — a vehicle row carries a model, a
// tyre row carries a tread depth — without a union type nobody can read.
const REPORTS = {
  vehicle: reports.byVehicle,
  service: reports.byServiceType,
  vendor: reports.byVendor,
  part: reports.byPart,
  tyre: reports.tyreReport,
  battery: reports.batteryReport,
  repair: reports.repairReport
};

router.get('/reports/:groupBy', protect, requirePermission('maintenance', 'read'), async (req, res) => {
  try {
    const build = REPORTS[req.params.groupBy];
    if (!build) {
      return res.status(400).json({
        success: false,
        error: `Unknown report. Available: ${Object.keys(REPORTS).join(', ')}, trend`
      });
    }

    res.json({ success: true, groupBy: req.params.groupBy, rows: await build(readFilters(req)) });
  } catch (error) {
    console.error(`[maintenance] ${req.params.groupBy} report failed:`, error.message);
    res.status(500).json({ success: false, error: 'Failed to build that maintenance report' });
  }
});

// Over time, bucketed by day, month or year.
router.get('/trend', protect, requirePermission('maintenance', 'read'), async (req, res) => {
  try {
    const granularity = ['day', 'month', 'year'].includes(req.query.granularity)
      ? req.query.granularity
      : 'month';
    res.json({
      success: true,
      granularity,
      rows: await reports.byPeriod(readFilters(req), granularity)
    });
  } catch (error) {
    console.error('[maintenance] trend failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to build the maintenance trend' });
  }
});

// ---------------------------------------------------------------------------
// Settings — M3-M10's configurable thresholds
// ---------------------------------------------------------------------------

router.get('/settings', protect, requirePermission('maintenance', 'read'), async (req, res) => {
  try {
    const settings = await settingsFor(req.accountId);
    // `isDefault` lets the settings screen say whether these are the shipped
    // values or something the account has chosen, without the UI having to
    // compare against a copy of the defaults it keeps itself.
    const stored = await MaintenanceSetting.exists({ owner: req.accountId });
    res.json({ success: true, settings, isDefault: !stored, defaults: DEFAULT_SETTINGS });
  } catch (error) {
    console.error('[maintenance] settings read failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to load maintenance settings' });
  }
});

router.put('/settings', protect, requirePermission('maintenance', 'manage'), async (req, res) => {
  try {
    const { fields, errors } = buildSettingsFields(req.body);
    if (errors.length) return res.status(400).json({ success: false, error: errors[0], errors });

    const before = await MaintenanceSetting.findOne({ owner: req.accountId });

    const after = await MaintenanceSetting.findOneAndUpdate(
      { owner: req.accountId },
      {
        $set: { ...fields, updatedBy: req.user._id, updatedAt: new Date() },
        $setOnInsert: { owner: req.accountId }
      },
      { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true }
    );

    auditUpdate(req, {
      entity: 'maintenance_setting',
      before: before || {},
      after,
      fields: Object.keys(fields),
      label: 'Maintenance reminder thresholds'
    });

    // Unlike the fuel thresholds, these need no recompute: reminders are
    // computed on read (see services/maintenanceReminders.js), so a changed
    // window applies to everything the moment it is saved.
    res.json({
      success: true,
      settings: await settingsFor(req.accountId),
      message: 'Reminder thresholds saved.'
    });
  } catch (error) {
    if (error.name === 'ValidationError') {
      const first = Object.values(error.errors)[0];
      return res.status(400).json({ success: false, error: first?.message || 'Invalid settings' });
    }
    console.error('[maintenance] settings save failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to save maintenance settings' });
  }
});

// ---------------------------------------------------------------------------
// M3-M02 — Service records
// ---------------------------------------------------------------------------

// Resolves and validates the vehicle a payload points at, and returns the
// denormalised number to store with it.
//
// Checked against the caller's own account: an id from a request body is not
// evidence that the caller may use it.
const resolveVehicle = async ({ accountId, truckId }) => {
  if (!truckId) return { resolved: {}, errors: [] };
  const truck = await Truck.findOne({ _id: truckId, owner: accountId }).select('number odometer').lean();
  if (!truck) return { resolved: {}, errors: ['That vehicle could not be found'] };
  return { resolved: { vehicleNumber: truck.number || '' }, truck, errors: [] };
};

// The vehicle master's odometer follows the highest reading seen, so the fleet
// screen does not show a stale figure after a workshop visit. Guarded against
// going backwards, matching how routes/trucks.js and routes/fuel.js treat it.
//
// Tyres fitted to the vehicle are re-measured against the new reading, since
// their running distance is read from exactly this number.
const advanceOdometer = async ({ accountId, truck, odometer }) => {
  if (!Number.isFinite(odometer) || odometer === null) return;

  await Truck.updateOne(
    { _id: truck, owner: accountId, odometer: { $lt: odometer } },
    { $set: { odometer } }
  );

  const { recomputeForTruck } = await import('../services/tyreTracking.js');
  await recomputeForTruck({ accountId, truck, odometer });
};

// Marks earlier services of the same type on the same vehicle as superseded, so
// the reminder query only ever looks at the newest one per clock.
//
// Run after every write rather than only on create, because an edit that
// changes a record's date or type moves which one is current.
const restampSupersession = async ({ accountId, truck, serviceType }) => {
  const rows = await ServiceRecord.find({ owner: accountId, truck, serviceType })
    .select('_id servicedAt')
    .sort({ servicedAt: -1, _id: -1 })
    .lean();

  if (!rows.length) return;

  const [current, ...older] = rows;

  await Promise.all([
    ServiceRecord.updateOne({ _id: current._id }, { $set: { supersededAt: null } }),
    older.length
      ? ServiceRecord.updateMany(
          { _id: { $in: older.map((r) => r._id) }, supersededAt: null },
          { $set: { supersededAt: new Date() } }
        )
      : Promise.resolve()
  ]);
};

// GET /api/maintenance/services — the service register, filtered, sorted and
// paginated on the server. A fleet services a vehicle every few weeks, so this
// grows without limit and none of it is done in the browser.
router.get('/services', protect, requirePermission('maintenance', 'read'), async (req, res) => {
  try {
    const filters = readFilters(req);
    const query = ownedBy(req);

    if (filters.truck) query.truck = filters.truck;
    if (filters.serviceType) query.serviceType = filters.serviceType;
    if (filters.workshop) query['workshop.name'] = filters.workshop;

    if (filters.from || filters.to) {
      query.servicedAt = {};
      if (filters.from) query.servicedAt.$gte = filters.from;
      if (filters.to) query.servicedAt.$lte = filters.to;
    }

    const search = searchClause(req.query.search, [
      'vehicleNumber',
      'workshop.name',
      'workshop.city',
      'invoiceNumber',
      'notes'
    ]);
    if (search) Object.assign(query, search);

    // Sorting is restricted to an allow-list: a sort key taken straight from
    // the query string would let a caller sort on any path in the document.
    const SORTABLE = {
      servicedAt: 'servicedAt',
      totalCost: 'totalCost',
      odometer: 'odometer',
      nextServiceDate: 'nextServiceDate'
    };
    const sortField = SORTABLE[req.query.sortBy] || 'servicedAt';
    const sortDir = req.query.sortDir === 'asc' ? 1 : -1;

    const { page, limit } = readPaging(req);

    const [records, total] = await Promise.all([
      ServiceRecord.find(query)
        // The invoice image is excluded from the list: a page of 25 records
        // each carrying a photographed bill is megabytes of base64 that no
        // table row displays. The detail endpoint returns it.
        .select('-invoice.dataUrl')
        .populate(SERVICE_POPULATE)
        .sort({ [sortField]: sortDir, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      ServiceRecord.countDocuments(query)
    ]);

    res.json({
      success: true,
      records,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) || 1 }
    });
  } catch (error) {
    console.error('[maintenance] service list failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to fetch service records' });
  }
});

// One service record in full, invoice included.
router.get('/services/:id', protect, requirePermission('maintenance', 'read'), async (req, res) => {
  try {
    const record = await ServiceRecord.findOne({ _id: req.params.id, ...ownedBy(req) })
      .populate(SERVICE_POPULATE)
      .lean();

    if (!record) return res.status(404).json({ success: false, error: 'Service record not found' });

    res.json({ success: true, record });
  } catch (error) {
    console.error('[maintenance] service fetch failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to fetch the service record' });
  }
});

// POST /api/maintenance/services — record a service visit.
router.post('/services', protect, requirePermission('maintenance', 'create'), async (req, res) => {
  try {
    const { fields, errors } = buildServiceFields(req.body, { partial: false });
    if (errors.length) return res.status(400).json({ success: false, error: errors[0], errors });

    const { resolved, errors: refErrors } = await resolveVehicle({
      accountId: req.accountId,
      truckId: fields.truck
    });
    if (refErrors.length) return res.status(400).json({ success: false, error: refErrors[0] });

    const record = new ServiceRecord({
      ...fields,
      ...resolved,
      owner: req.accountId,
      createdBy: req.user._id
    });

    await record.save();

    await restampSupersession({
      accountId: req.accountId,
      truck: record.truck,
      serviceType: record.serviceType
    });

    await advanceOdometer({
      accountId: req.accountId,
      truck: record.truck,
      odometer: record.odometer
    });

    auditCreate(req, {
      entity: 'service_record',
      doc: record,
      label: serviceLabel(record),
      fields: SERVICE_AUDIT_FIELDS
    });

    const saved = await ServiceRecord.findById(record._id).populate(SERVICE_POPULATE).lean();

    res.status(201).json({ success: true, record: saved });
  } catch (error) {
    if (error.name === 'ValidationError') {
      const first = Object.values(error.errors)[0];
      return res.status(400).json({ success: false, error: first?.message || 'Invalid service record' });
    }
    console.error('[maintenance] service create failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to save the service record' });
  }
});

// PUT /api/maintenance/services/:id — correct a service record.
router.put('/services/:id', protect, requirePermission('maintenance', 'update'), async (req, res) => {
  try {
    const record = await ServiceRecord.findOne({ _id: req.params.id, ...ownedBy(req) });
    if (!record) return res.status(404).json({ success: false, error: 'Service record not found' });

    const before = record.toObject();

    const { fields, errors } = buildServiceFields(req.body, { partial: true, existing: before });
    if (errors.length) return res.status(400).json({ success: false, error: errors[0], errors });

    if (fields.truck) {
      const { resolved, errors: refErrors } = await resolveVehicle({
        accountId: req.accountId,
        truckId: fields.truck
      });
      if (refErrors.length) return res.status(400).json({ success: false, error: refErrors[0] });
      Object.assign(fields, resolved);
    }

    const previousTruck = record.truck;
    const previousType = record.serviceType;

    record.set(fields);
    await record.save();

    // Both clocks are restamped when the record moved between vehicles or
    // types: the one it left has a new newest record, and the one it joined
    // does too.
    await restampSupersession({
      accountId: req.accountId,
      truck: record.truck,
      serviceType: record.serviceType
    });
    if (String(previousTruck) !== String(record.truck) || previousType !== record.serviceType) {
      await restampSupersession({
        accountId: req.accountId,
        truck: previousTruck,
        serviceType: previousType
      });
    }

    await advanceOdometer({
      accountId: req.accountId,
      truck: record.truck,
      odometer: record.odometer
    });

    auditUpdate(req, {
      entity: 'service_record',
      before,
      after: record,
      fields: SERVICE_AUDIT_FIELDS,
      label: serviceLabel(record)
    });

    const saved = await ServiceRecord.findById(record._id).populate(SERVICE_POPULATE).lean();

    res.json({ success: true, record: saved });
  } catch (error) {
    if (error.name === 'ValidationError') {
      const first = Object.values(error.errors)[0];
      return res.status(400).json({ success: false, error: first?.message || 'Invalid service record' });
    }
    console.error('[maintenance] service update failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to update the service record' });
  }
});

// DELETE /api/maintenance/services/:id
router.delete('/services/:id', protect, requirePermission('maintenance', 'delete'), async (req, res) => {
  try {
    const record = await ServiceRecord.findOne({ _id: req.params.id, ...ownedBy(req) });
    if (!record) return res.status(404).json({ success: false, error: 'Service record not found' });

    const { truck, serviceType } = record;
    const label = serviceLabel(record);
    const snapshot = record.toObject();

    await record.deleteOne();

    // The newest record for this clock has changed, so the reminder has to be
    // re-pointed at whatever is now the latest.
    await restampSupersession({ accountId: req.accountId, truck, serviceType });

    auditDelete(req, {
      entity: 'service_record',
      doc: snapshot,
      label,
      fields: SERVICE_AUDIT_FIELDS
    });

    res.json({ success: true, message: 'Service record deleted' });
  } catch (error) {
    console.error('[maintenance] service delete failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to delete the service record' });
  }
});

// ---------------------------------------------------------------------------
// M3-M04 / M3-M05 — Repair requests
// ---------------------------------------------------------------------------

// The number the next request would take, for the create form to show before
// anything is saved.
router.get('/repairs/next-number', protect, requirePermission('maintenance', 'create'), async (req, res) => {
  try {
    res.json({ success: true, requestNumber: await previewRequestNumber(req.accountId) });
  } catch (error) {
    console.error('[maintenance] repair number preview failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to preview the request number' });
  }
});

// GET /api/maintenance/repairs — the repair register.
router.get('/repairs', protect, requirePermission('maintenance', 'read'), async (req, res) => {
  try {
    const filters = readFilters(req);
    const query = ownedBy(req);

    if (filters.truck) query.truck = filters.truck;
    if (filters.workshop) query['workshop.name'] = filters.workshop;

    if (REPAIR_STATUSES.includes(req.query.status)) {
      query.status = req.query.status;
    } else if (req.query.open === 'true') {
      // The working queue: everything not yet finished.
      query.status = { $in: OPEN_REPAIR_STATUSES };
    }

    if (REPAIR_PRIORITIES.includes(req.query.priority)) query.priority = req.query.priority;

    if (filters.from || filters.to) {
      query.reportedAt = {};
      if (filters.from) query.reportedAt.$gte = filters.from;
      if (filters.to) query.reportedAt.$lte = filters.to;
    }

    const search = searchClause(req.query.search, [
      'requestNumber',
      'vehicleNumber',
      'issue',
      'reportedByName',
      'workshop.name',
      'diagnosis',
      'workDone'
    ]);
    if (search) Object.assign(query, search);

    const SORTABLE = {
      reportedAt: 'reportedAt',
      completedAt: 'completedAt',
      totalCost: 'totalCost',
      priority: 'priority',
      status: 'status'
    };
    const sortField = SORTABLE[req.query.sortBy] || 'reportedAt';
    const sortDir = req.query.sortDir === 'asc' ? 1 : -1;

    const { page, limit } = readPaging(req);

    const [requests, total] = await Promise.all([
      RepairRequest.find(query)
        .select('-invoice.dataUrl')
        .populate(REPAIR_POPULATE)
        .sort({ [sortField]: sortDir, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      RepairRequest.countDocuments(query)
    ]);

    res.json({
      success: true,
      requests,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) || 1 }
    });
  } catch (error) {
    console.error('[maintenance] repair list failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to fetch repair requests' });
  }
});

router.get('/repairs/:id', protect, requirePermission('maintenance', 'read'), async (req, res) => {
  try {
    const request = await RepairRequest.findOne({ _id: req.params.id, ...ownedBy(req) })
      .populate(REPAIR_POPULATE)
      .lean();

    if (!request) return res.status(404).json({ success: false, error: 'Repair request not found' });

    res.json({ success: true, request });
  } catch (error) {
    console.error('[maintenance] repair fetch failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to fetch the repair request' });
  }
});

// POST /api/maintenance/repairs — raise a repair request.
router.post('/repairs', protect, requirePermission('maintenance', 'create'), async (req, res) => {
  try {
    const { fields, errors } = buildRepairFields(req.body, { partial: false });
    if (errors.length) return res.status(400).json({ success: false, error: errors[0], errors });

    const { resolved, errors: refErrors } = await resolveVehicle({
      accountId: req.accountId,
      truckId: fields.truck
    });
    if (refErrors.length) return res.status(400).json({ success: false, error: refErrors[0] });

    // The driver who reported it, when one was named.
    if (fields.reportedBy) {
      const driver = await Driver.findOne({ _id: fields.reportedBy, owner: req.accountId })
        .select('name')
        .lean();
      if (!driver) return res.status(400).json({ success: false, error: 'That driver could not be found' });
      resolved.reportedByName = driver.name || '';
    }

    const saved = await createWithRequestNumber(req.accountId, async (requestNumber) => {
      const request = new RepairRequest({
        ...fields,
        ...resolved,
        requestNumber,
        owner: req.accountId,
        raisedBy: req.user._id,
        createdBy: req.user._id,
        // The workflow starts here, and the first history entry is the report
        // itself — so a job's timeline is complete from its first moment
        // rather than starting at whatever the first transition was.
        status: 'Reported',
        history: [
          {
            status: 'Reported',
            at: fields.reportedAt || new Date(),
            by: req.user._id,
            byName: req.user.name || '',
            note: 'Fault reported'
          }
        ]
      });

      await request.save();
      return request;
    });

    await advanceOdometer({
      accountId: req.accountId,
      truck: saved.truck,
      odometer: saved.odometer
    });

    auditCreate(req, {
      entity: 'repair_request',
      doc: saved,
      label: repairLabel(saved),
      fields: REPAIR_AUDIT_FIELDS
    });

    const populated = await RepairRequest.findById(saved._id).populate(REPAIR_POPULATE).lean();

    res.status(201).json({ success: true, request: populated });
  } catch (error) {
    if (error.name === 'ValidationError') {
      const first = Object.values(error.errors)[0];
      return res.status(400).json({ success: false, error: first?.message || 'Invalid repair request' });
    }
    console.error('[maintenance] repair create failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to raise the repair request' });
  }
});

// PUT /api/maintenance/repairs/:id — edit a repair request.
//
// The status is not editable here: it moves through /status below, which checks
// the transition and stamps the milestones the downtime report measures.
router.put('/repairs/:id', protect, requirePermission('maintenance', 'update'), async (req, res) => {
  try {
    const request = await RepairRequest.findOne({ _id: req.params.id, ...ownedBy(req) });
    if (!request) return res.status(404).json({ success: false, error: 'Repair request not found' });

    const before = request.toObject();

    const { fields, errors } = buildRepairFields(req.body, { partial: true, existing: before });
    if (errors.length) return res.status(400).json({ success: false, error: errors[0], errors });

    if (fields.truck) {
      const { resolved, errors: refErrors } = await resolveVehicle({
        accountId: req.accountId,
        truckId: fields.truck
      });
      if (refErrors.length) return res.status(400).json({ success: false, error: refErrors[0] });
      Object.assign(fields, resolved);
    }

    if (Object.prototype.hasOwnProperty.call(fields, 'reportedBy')) {
      if (fields.reportedBy) {
        const driver = await Driver.findOne({ _id: fields.reportedBy, owner: req.accountId })
          .select('name')
          .lean();
        if (!driver) return res.status(400).json({ success: false, error: 'That driver could not be found' });
        fields.reportedByName = driver.name || '';
      } else {
        // Cleared: the stored name goes with it, or the request would show a
        // reporter it is no longer linked to.
        fields.reportedByName = '';
      }
    }

    request.set(fields);
    await request.save();

    await advanceOdometer({
      accountId: req.accountId,
      truck: request.truck,
      odometer: request.odometer
    });

    auditUpdate(req, {
      entity: 'repair_request',
      before,
      after: request,
      fields: REPAIR_AUDIT_FIELDS,
      label: repairLabel(request)
    });

    const saved = await RepairRequest.findById(request._id).populate(REPAIR_POPULATE).lean();

    res.json({ success: true, request: saved });
  } catch (error) {
    if (error.name === 'ValidationError') {
      const first = Object.values(error.errors)[0];
      return res.status(400).json({ success: false, error: first?.message || 'Invalid repair request' });
    }
    console.error('[maintenance] repair update failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to update the repair request' });
  }
});

// M3-M05 — move a repair through its workflow.
//
// The only way the status changes. Every transition is checked against
// REPAIR_TRANSITIONS, appended to the history, and stamped onto whichever
// milestone it crosses — so the downtime figure and the timeline can never
// disagree with the status the record is showing.
router.post('/repairs/:id/status', protect, requirePermission('maintenance', 'update'), async (req, res) => {
  try {
    const request = await RepairRequest.findOne({ _id: req.params.id, ...ownedBy(req) });
    if (!request) return res.status(404).json({ success: false, error: 'Repair request not found' });

    const { status, note, errors } = buildStatusChange(req.body);
    if (errors.length) return res.status(400).json({ success: false, error: errors[0] });

    const allowed = REPAIR_TRANSITIONS[request.status] || [];
    if (!allowed.includes(status)) {
      return res.status(400).json({
        success: false,
        error: allowed.length
          ? `A ${REPAIR_STATUS_LABELS[request.status]?.toLowerCase() || request.status} repair can only move to: ${allowed.join(', ')}`
          : `This repair is ${REPAIR_STATUS_LABELS[request.status]?.toLowerCase() || request.status} and cannot be moved again`
      });
    }

    const previous = request.status;
    const now = new Date();

    request.status = status;
    request.history.push({
      status,
      at: now,
      by: req.user._id,
      byName: req.user.name || '',
      note
    });

    // The milestones. Only stamped the first time each is crossed: a job that
    // bounces between In Repair and Waiting Parts started once, and overwriting
    // `startedAt` on the second pass would erase the wait from the downtime.
    if (status === 'Approved' && !request.approvedAt) {
      request.approvedAt = now;
      request.approvedBy = req.user._id;
    }
    if ((status === 'In Repair' || status === 'Waiting Parts') && !request.startedAt) {
      request.startedAt = now;
    }

    if (status === 'Completed') {
      request.completedAt = now;
      // Measured from approval rather than from the report — see the note on
      // the field in models/RepairRequest.js. A job completed without ever
      // being approved (small enough to just do) falls back to when work
      // started, and reports no downtime at all if neither was stamped.
      const from = request.approvedAt || request.startedAt;
      request.downtimeHours = from
        ? Math.round(((now - from) / (1000 * 60 * 60)) * 10) / 10
        : null;
    }

    await request.save();

    // The vehicle's own status follows the workshop. A vehicle with work in
    // progress is off the road, and the fleet screen has to say so without
    // anyone remembering to set it by hand.
    //
    // Only 'Maintenance' is ever set or cleared here: a vehicle that was
    // Inactive or In Transit for its own reasons is left alone, because this
    // module does not own those states.
    const stillGrounded = await RepairRequest.exists({
      owner: req.accountId,
      truck: request.truck,
      status: { $in: ACTIVE_REPAIR_STATUSES }
    });

    if (stillGrounded) {
      await Truck.updateOne(
        { _id: request.truck, owner: req.accountId, status: { $nin: ['Maintenance', 'Inactive'] } },
        { $set: { status: 'Maintenance' } }
      );
    } else {
      await Truck.updateOne(
        { _id: request.truck, owner: req.accountId, status: 'Maintenance' },
        { $set: { status: 'Idle' } }
      );
    }

    auditUpdate(req, {
      entity: 'repair_request',
      before: {},
      after: request,
      fields: [],
      label: repairLabel(request),
      summary: `${repairLabel(request)}: ${previous} → ${status}${note ? ` — ${note}` : ''}`
    });

    const saved = await RepairRequest.findById(request._id).populate(REPAIR_POPULATE).lean();

    res.json({ success: true, request: saved });
  } catch (error) {
    console.error('[maintenance] repair status change failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to update the repair status' });
  }
});

// DELETE /api/maintenance/repairs/:id
router.delete('/repairs/:id', protect, requirePermission('maintenance', 'delete'), async (req, res) => {
  try {
    const request = await RepairRequest.findOne({ _id: req.params.id, ...ownedBy(req) });
    if (!request) return res.status(404).json({ success: false, error: 'Repair request not found' });

    const { truck } = request;
    const label = repairLabel(request);
    const snapshot = request.toObject();

    await request.deleteOne();

    // Deleting the last open job on a vehicle releases it, exactly as
    // completing one would — otherwise a truck stays marked under repair for a
    // job that no longer exists.
    const stillGrounded = await RepairRequest.exists({
      owner: req.accountId,
      truck,
      status: { $in: ACTIVE_REPAIR_STATUSES }
    });
    if (!stillGrounded) {
      await Truck.updateOne(
        { _id: truck, owner: req.accountId, status: 'Maintenance' },
        { $set: { status: 'Idle' } }
      );
    }

    auditDelete(req, {
      entity: 'repair_request',
      doc: snapshot,
      label,
      fields: REPAIR_AUDIT_FIELDS
    });

    res.json({ success: true, message: 'Repair request deleted' });
  } catch (error) {
    console.error('[maintenance] repair delete failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to delete the repair request' });
  }
});

export default router;
