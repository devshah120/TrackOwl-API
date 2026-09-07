import express from 'express';
import FuelEntry from '../models/FuelEntry.js';
import FuelSetting, { settingsFor } from '../models/FuelSetting.js';
import Truck from '../models/Truck.js';
import Driver from '../models/Driver.js';
import TripOrder from '../models/TripOrder.js';
import { protect, requirePermission } from '../middleware/auth.js';
import { auditCreate, auditUpdate, auditDelete } from '../utils/audit.js';
import {
  FUEL_TYPES,
  FUEL_TYPE_LABELS,
  FUEL_UNITS,
  PAYMENT_MODES,
  FILL_TYPES,
  FILL_TYPE_LABELS,
  BASELINE_MODES,
  BASELINE_MODE_LABELS,
  FLAG_REASONS,
  FLAG_REASON_LABELS,
  DEFAULT_SETTINGS,
  PROPULSION_FUEL_TYPES,
  unitFor
} from '../utils/fuel.js';
import { buildEntryFields, buildSettingsFields, objectId } from '../utils/fuelFields.js';
import { analyseEntry, recomputeChain } from '../services/fuelEfficiency.js';
import { syncToTrip, detachFromTrip } from '../services/fuelTripSync.js';
import * as reports from '../services/fuelReports.js';

const router = express.Router();

// Every fuel entry belongs to the caller's account, applied to the query itself
// rather than filtered after the read — the same rule as every other business
// record here.
const ownedBy = (req) => ({ owner: req.accountId });

// How an entry names itself in the audit trail: the way an operator would say
// it out loud.
const entryLabel = (entry) =>
  `${entry?.vehicleNumber || 'Vehicle'} — ${entry?.quantity ?? '?'} ${entry?.unit || 'L'} ${
    entry?.fuelType || ''
  }`.trim();

// The fields the audit trail tracks. The efficiency block and the flags are
// deliberately absent: they are computed, so logging them would fill the trail
// with rows reporting that the system recalculated something after a
// back-dated entry moved the chain.
const AUDIT_FIELDS = [
  'vehicleNumber',
  'driverName',
  'filledAt',
  'fuelType',
  'quantity',
  'rate',
  'amount',
  'fillType',
  'odometer',
  'paymentMode',
  'billNumber',
  'station.name',
  'station.city',
  'trip',
  'remarks'
];

const POPULATE = [
  { path: 'truck', select: 'number model vehicleType fuelType odometer status' },
  { path: 'driver', select: 'name mobile licenseNumber status' },
  { path: 'trip', select: 'tripNumber status tripDate actualKm pickup.city destination.city' }
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

// The filter set shared by the list and every report, read from the query
// string in one place so a filter cannot mean one thing on the register and
// another on the report built from it.
const readFilters = (req) => ({
  accountId: req.accountId,
  from: parseDate(req.query.from),
  to: parseDate(req.query.to, { endOfDay: true }),
  truck: objectId(req.query.truck),
  driver: objectId(req.query.driver),
  trip: objectId(req.query.trip),
  fuelType: FUEL_TYPES.includes(req.query.fuelType) ? req.query.fuelType : null,
  station: req.query.station ? String(req.query.station).trim() : null,
  flaggedOnly: req.query.flagged === 'true'
});

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

// Everything the fuel forms render their dropdowns from, served from the same
// module the model validates against so the UI can never offer a value the API
// would reject.
router.get('/options', protect, (req, res) => {
  res.json({
    success: true,
    fuelTypes: FUEL_TYPES.map((v) => ({ value: v, label: FUEL_TYPE_LABELS[v], unit: FUEL_UNITS[v] })),
    fuelUnits: FUEL_UNITS,
    propulsionFuelTypes: PROPULSION_FUEL_TYPES,
    paymentModes: PAYMENT_MODES,
    fillTypes: FILL_TYPES.map((v) => ({ value: v, label: FILL_TYPE_LABELS[v] })),
    baselineModes: BASELINE_MODES.map((v) => ({ value: v, label: BASELINE_MODE_LABELS[v] })),
    flagReasons: FLAG_REASONS.map((v) => ({ value: v, label: FLAG_REASON_LABELS[v] })),
    defaultSettings: DEFAULT_SETTINGS
  });
});

// The distinct station names this account has used, for the entry form's
// autocomplete. Typing a station that already exists should be one keystroke,
// not a re-spelling that fragments the station-wise report.
router.get('/stations', protect, requirePermission('fuel', 'read'), async (req, res) => {
  try {
    const search = String(req.query.search || '').trim();
    const match = { owner: req.accountId, 'station.name': { $nin: ['', null] } };

    if (search) {
      const safe = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      match['station.name'] = { $nin: ['', null], $regex: new RegExp(safe, 'i') };
    }

    const rows = await FuelEntry.aggregate([
      { $match: match },
      {
        $group: {
          _id: '$station.name',
          city: { $last: '$station.city' },
          state: { $last: '$station.state' },
          code: { $last: '$station.code' },
          lastUsed: { $max: '$filledAt' },
          uses: { $sum: 1 }
        }
      },
      // Most-used first: the pumps a fleet actually uses should be the ones at
      // the top of the suggestion list.
      { $sort: { uses: -1, lastUsed: -1 } },
      { $limit: 50 }
    ]);

    res.json({
      success: true,
      stations: rows.map((r) => ({
        name: r._id,
        city: r.city || '',
        state: r.state || '',
        code: r.code || '',
        uses: r.uses,
        lastUsed: r.lastUsed
      }))
    });
  } catch (error) {
    console.error('[fuel] station list failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to load fuel stations' });
  }
});

// The last filling for a vehicle, so the entry form can show the previous
// odometer reading while the operator types the new one. Catching a
// transposed digit at the keyboard is worth far more than flagging it later.
router.get('/last-entry/:truckId', protect, requirePermission('fuel', 'read'), async (req, res) => {
  try {
    const truck = objectId(req.params.truckId);
    if (!truck) return res.status(400).json({ success: false, error: 'Invalid vehicle' });

    const [entry, vehicle] = await Promise.all([
      FuelEntry.findOne({ owner: req.accountId, truck })
        .sort({ filledAt: -1, _id: -1 })
        .select('filledAt odometer quantity rate amount fuelType fillType station efficiency')
        .lean(),
      Truck.findOne({ _id: truck, owner: req.accountId }).select('number odometer fuelType').lean()
    ]);

    res.json({
      success: true,
      lastEntry: entry || null,
      // The vehicle master's own odometer, which may be ahead of the last
      // filling if trips have been closed since. The form offers the higher of
      // the two as the starting suggestion.
      vehicleOdometer: vehicle?.odometer ?? null,
      vehicleFuelType: vehicle?.fuelType || null
    });
  } catch (error) {
    console.error('[fuel] last entry lookup failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to load the previous filling' });
  }
});

// ---------------------------------------------------------------------------
// Settings — M3-F06's configurable thresholds
// ---------------------------------------------------------------------------

router.get('/settings', protect, requirePermission('fuel', 'read'), async (req, res) => {
  try {
    const settings = await settingsFor(req.accountId);
    // `isDefault` lets the settings screen say whether these are the shipped
    // values or something the account has chosen, without the UI having to
    // compare against a copy of the defaults it keeps itself.
    const stored = await FuelSetting.exists({ owner: req.accountId });
    res.json({ success: true, settings, isDefault: !stored, defaults: DEFAULT_SETTINGS });
  } catch (error) {
    console.error('[fuel] settings read failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to load fuel settings' });
  }
});

router.put('/settings', protect, requirePermission('fuel', 'manage'), async (req, res) => {
  try {
    const { fields, errors } = buildSettingsFields(req.body);
    if (errors.length) return res.status(400).json({ success: false, error: errors[0], errors });

    const before = await FuelSetting.findOne({ owner: req.accountId });

    const after = await FuelSetting.findOneAndUpdate(
      { owner: req.accountId },
      { $set: { ...fields, updatedBy: req.user._id, updatedAt: new Date() }, $setOnInsert: { owner: req.accountId } },
      { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true }
    );

    auditUpdate(req, {
      entity: 'fuel_setting',
      before: before || {},
      after,
      fields: Object.keys(fields),
      label: 'Fuel outlier thresholds'
    });

    // Changing the thresholds does not re-judge history here. Re-flagging every
    // entry an account has ever recorded could touch tens of thousands of rows
    // inside one request, and the reports read the stored flags. The recompute
    // endpoint below does it deliberately, per vehicle, when the office asks.
    res.json({
      success: true,
      settings: await settingsFor(req.accountId),
      message: 'Thresholds saved. Existing entries keep their current flags until you recompute.'
    });
  } catch (error) {
    if (error.name === 'ValidationError') {
      const first = Object.values(error.errors)[0];
      return res.status(400).json({ success: false, error: first?.message || 'Invalid settings' });
    }
    console.error('[fuel] settings save failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to save fuel settings' });
  }
});

// ---------------------------------------------------------------------------
// Reports — M3-F07
// ---------------------------------------------------------------------------

// The stat strip above the register: bought, spent, burnt, and what needs
// looking at.
router.get('/summary', protect, requirePermission('fuel', 'read'), async (req, res) => {
  try {
    res.json({ success: true, ...(await reports.summary(readFilters(req))) });
  } catch (error) {
    console.error('[fuel] summary failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to build the fuel summary' });
  }
});

// One endpoint per grouping rather than a `groupBy` parameter, so each can
// return the fields its own grouping needs — a vehicle row carries a model, a
// station row carries a city — without a union type nobody can read.
const REPORTS = {
  vehicle: reports.byVehicle,
  driver: reports.byDriver,
  station: reports.byStation,
  trip: reports.byTrip
};

router.get('/reports/:groupBy', protect, requirePermission('fuel', 'read'), async (req, res) => {
  try {
    const build = REPORTS[req.params.groupBy];
    if (!build) {
      return res.status(400).json({
        success: false,
        error: `Unknown report. Available: ${Object.keys(REPORTS).join(', ')}, period`
      });
    }

    res.json({ success: true, groupBy: req.params.groupBy, rows: await build(readFilters(req)) });
  } catch (error) {
    console.error(`[fuel] ${req.params.groupBy} report failed:`, error.message);
    res.status(500).json({ success: false, error: 'Failed to build that fuel report' });
  }
});

// Over time, bucketed by day, month or year.
router.get('/trend', protect, requirePermission('fuel', 'read'), async (req, res) => {
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
    console.error('[fuel] trend failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to build the fuel trend' });
  }
});

// The fleet efficiency ranking behind M3-F06's fleet comparison.
router.get('/efficiency', protect, requirePermission('fuel', 'read'), async (req, res) => {
  try {
    res.json({ success: true, ...(await reports.efficiencyRanking(readFilters(req))) });
  } catch (error) {
    console.error('[fuel] efficiency ranking failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to build the efficiency ranking' });
  }
});

// ---------------------------------------------------------------------------
// The register
// ---------------------------------------------------------------------------

// GET /api/fuel — the fuel entry list, filtered, sorted and paginated on the
// server. A fleet records a filling per vehicle every few days, so this grows
// without limit and none of it is done in the browser.
router.get('/', protect, requirePermission('fuel', 'read'), async (req, res) => {
  try {
    const filters = readFilters(req);
    const query = ownedBy(req);

    if (filters.truck) query.truck = filters.truck;
    if (filters.driver) query.driver = filters.driver;
    if (filters.trip) query.trip = filters.trip;
    if (filters.fuelType) query.fuelType = filters.fuelType;
    if (filters.station) query['station.name'] = filters.station;
    if (filters.flaggedOnly) query.isFlagged = true;

    // Outstanding flags only — flagged and not yet reviewed. The working queue
    // for whoever investigates them.
    if (req.query.unreviewed === 'true') {
      query.isFlagged = true;
      query.reviewedAt = null;
    }

    if (filters.from || filters.to) {
      query.filledAt = {};
      if (filters.from) query.filledAt.$gte = filters.from;
      if (filters.to) query.filledAt.$lte = filters.to;
    }

    const search = String(req.query.search || '').trim();
    if (search) {
      const safe = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const rx = new RegExp(safe, 'i');
      query.$or = [
        { vehicleNumber: rx },
        { driverName: rx },
        { 'station.name': rx },
        { 'station.city': rx },
        { billNumber: rx },
        { remarks: rx }
      ];
    }

    // Sorting is restricted to an allow-list: a sort key taken straight from
    // the query string would let a caller sort on any path in the document.
    const SORTABLE = {
      filledAt: 'filledAt',
      amount: 'amount',
      quantity: 'quantity',
      odometer: 'odometer',
      rate: 'rate',
      kmPerUnit: 'efficiency.kmPerUnit',
      costPerKm: 'efficiency.costPerKm'
    };
    const sortField = SORTABLE[req.query.sortBy] || 'filledAt';
    const sortDir = req.query.sortDir === 'asc' ? 1 : -1;

    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 25));

    const [entries, total] = await Promise.all([
      FuelEntry.find(query)
        // The receipt image is excluded from the list: a page of 25 entries
        // each carrying a photographed bill is megabytes of base64 that no
        // table row displays. The detail endpoint returns it.
        .select('-receipt.dataUrl')
        .populate(POPULATE)
        .sort({ [sortField]: sortDir, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      FuelEntry.countDocuments(query)
    ]);

    res.json({
      success: true,
      entries,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) || 1 }
    });
  } catch (error) {
    console.error('[fuel] list failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to fetch fuel entries' });
  }
});

// One entry in full, receipt included.
router.get('/:id', protect, requirePermission('fuel', 'read'), async (req, res) => {
  try {
    const entry = await FuelEntry.findOne({ _id: req.params.id, ...ownedBy(req) })
      .populate(POPULATE)
      .lean();

    if (!entry) return res.status(404).json({ success: false, error: 'Fuel entry not found' });

    res.json({ success: true, entry });
  } catch (error) {
    console.error('[fuel] fetch failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to fetch the fuel entry' });
  }
});

// Resolves and validates the vehicle, driver and trip a payload points at, and
// returns the denormalised names to store with them.
//
// All three are checked against the caller's own account: an id from a request
// body is not evidence that the caller may use it.
const resolveReferences = async ({ accountId, fields, existing = null }) => {
  const errors = [];
  const resolved = {};

  const truckId = fields.truck || existing?.truck;
  if (truckId) {
    const truck = await Truck.findOne({ _id: truckId, owner: accountId }).select('number').lean();
    if (!truck) errors.push('That vehicle could not be found');
    else if (fields.truck) resolved.vehicleNumber = truck.number || '';
  }

  if (Object.prototype.hasOwnProperty.call(fields, 'driver')) {
    if (fields.driver) {
      const driver = await Driver.findOne({ _id: fields.driver, owner: accountId }).select('name').lean();
      if (!driver) errors.push('That driver could not be found');
      else resolved.driverName = driver.name || '';
    } else {
      // Cleared: the stored name goes with it, or the entry would show a driver
      // it is no longer linked to.
      resolved.driverName = '';
    }
  }

  if (Object.prototype.hasOwnProperty.call(fields, 'trip') && fields.trip) {
    const trip = await TripOrder.findOne({ _id: fields.trip, owner: accountId })
      .select('tripNumber')
      .lean();
    if (!trip) errors.push('That trip could not be found');
  }

  return { resolved, errors };
};

// POST /api/fuel — record a filling.
router.post('/', protect, requirePermission('fuel', 'create'), async (req, res) => {
  try {
    const { fields, errors } = buildEntryFields(req.body, { partial: false });
    if (errors.length) return res.status(400).json({ success: false, error: errors[0], errors });

    const { resolved, errors: refErrors } = await resolveReferences({
      accountId: req.accountId,
      fields
    });
    if (refErrors.length) return res.status(400).json({ success: false, error: refErrors[0] });

    const entry = new FuelEntry({
      ...fields,
      ...resolved,
      owner: req.accountId,
      createdBy: req.user._id
    });

    // Measure and judge before the first save, so an entry is never briefly
    // stored without the figures the list is about to render.
    const { efficiency, flags } = await analyseEntry({ accountId: req.accountId, entry });
    entry.efficiency = efficiency;
    entry.flags = flags;

    await entry.save();

    // Project the cost onto the trip, if one was named. A failure here is
    // reported as a warning and never fails the entry — recording the bill is
    // what the user asked for.
    const sync = await syncToTrip({ accountId: req.accountId, entry });
    if (sync.expenseId) {
      entry.tripExpenseId = sync.expenseId;
      await entry.save();
    }

    // A back-dated filling changes the measurement of every entry after it, so
    // the rest of that vehicle's chain is re-measured. Awaited rather than left
    // running: the client re-reads the list straight after this returns, and it
    // should not see half-updated figures.
    await recomputeChain({
      accountId: req.accountId,
      truck: entry.truck,
      since: entry.filledAt
    });

    // The vehicle master's odometer follows the highest reading seen, so the
    // fleet screen does not show a stale figure after a filling. Guarded
    // against going backwards, matching how routes/trucks.js treats it.
    if (Number.isFinite(entry.odometer) && entry.odometer !== null) {
      await Truck.updateOne(
        { _id: entry.truck, owner: req.accountId, odometer: { $lt: entry.odometer } },
        { $set: { odometer: entry.odometer } }
      );
    }

    auditCreate(req, {
      entity: 'fuel_entry',
      doc: entry,
      label: entryLabel(entry),
      fields: AUDIT_FIELDS
    });

    const saved = await FuelEntry.findById(entry._id).populate(POPULATE).lean();

    res.status(201).json({
      success: true,
      entry: saved,
      // Surfaced rather than silently swallowed: if the cost did not reach the
      // trip, the person who typed it is the one who can fix it.
      warning: sync.warning || null
    });
  } catch (error) {
    if (error.name === 'ValidationError') {
      const first = Object.values(error.errors)[0];
      return res.status(400).json({ success: false, error: first?.message || 'Invalid fuel entry' });
    }
    console.error('[fuel] create failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to save the fuel entry' });
  }
});

// PUT /api/fuel/:id — correct a filling.
router.put('/:id', protect, requirePermission('fuel', 'update'), async (req, res) => {
  try {
    const entry = await FuelEntry.findOne({ _id: req.params.id, ...ownedBy(req) });
    if (!entry) return res.status(404).json({ success: false, error: 'Fuel entry not found' });

    const before = entry.toObject();

    const { fields, errors } = buildEntryFields(req.body, { partial: true });
    if (errors.length) return res.status(400).json({ success: false, error: errors[0], errors });

    const { resolved, errors: refErrors } = await resolveReferences({
      accountId: req.accountId,
      fields,
      existing: entry
    });
    if (refErrors.length) return res.status(400).json({ success: false, error: refErrors[0] });

    // Where the entry was before this edit, so the trip sync knows which line to
    // detach when it moves between trips.
    const previousTripId = entry.trip;
    const previousExpenseId = entry.tripExpenseId;
    // The earlier of the old and new dates: moving a filling backwards
    // invalidates measurements from the *old* position onwards too.
    const earliestAffected =
      fields.filledAt && fields.filledAt < entry.filledAt ? fields.filledAt : entry.filledAt;
    const previousTruck = entry.truck;

    entry.set({ ...fields, ...resolved });

    const { efficiency, flags } = await analyseEntry({
      accountId: req.accountId,
      entry,
      excludeId: entry._id
    });
    entry.efficiency = efficiency;
    entry.flags = flags;
    // A correction is a new set of facts, so an earlier review no longer
    // applies — the flags above were just recomputed against the new values.
    entry.reviewedAt = null;
    entry.reviewedBy = null;
    entry.reviewNote = '';

    await entry.save();

    const sync = await syncToTrip({
      accountId: req.accountId,
      entry,
      previousTripId,
      previousExpenseId
    });
    entry.tripExpenseId = sync.expenseId;
    await entry.save();

    // Re-measure both chains when the entry moved between vehicles: the one it
    // left has a gap where it was, and the one it joined has a new anchor.
    await recomputeChain({ accountId: req.accountId, truck: entry.truck, since: earliestAffected });
    if (String(previousTruck) !== String(entry.truck)) {
      await recomputeChain({ accountId: req.accountId, truck: previousTruck, since: earliestAffected });
    }

    auditUpdate(req, {
      entity: 'fuel_entry',
      before,
      after: entry,
      fields: AUDIT_FIELDS,
      label: entryLabel(entry)
    });

    const saved = await FuelEntry.findById(entry._id).populate(POPULATE).lean();

    res.json({ success: true, entry: saved, warning: sync.warning || null });
  } catch (error) {
    if (error.name === 'ValidationError') {
      const first = Object.values(error.errors)[0];
      return res.status(400).json({ success: false, error: first?.message || 'Invalid fuel entry' });
    }
    console.error('[fuel] update failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to update the fuel entry' });
  }
});

// Dismiss a flag after looking into it (M3-F06). The flags stay on the record —
// they were genuinely raised — but the entry stops counting as outstanding.
router.post('/:id/review', protect, requirePermission('fuel', 'update'), async (req, res) => {
  try {
    const entry = await FuelEntry.findOne({ _id: req.params.id, ...ownedBy(req) });
    if (!entry) return res.status(404).json({ success: false, error: 'Fuel entry not found' });

    if (!entry.isFlagged) {
      return res.status(400).json({ success: false, error: 'That entry has no flags to review' });
    }

    entry.reviewedAt = new Date();
    entry.reviewedBy = req.user._id;
    entry.reviewNote = String(req.body?.note ?? '').trim();
    await entry.save();

    auditUpdate(req, {
      entity: 'fuel_entry',
      before: {},
      after: entry,
      fields: [],
      label: entryLabel(entry),
      summary: `Reviewed fuel flags on ${entryLabel(entry)}${entry.reviewNote ? ` — ${entry.reviewNote}` : ''}`
    });

    res.json({ success: true, entry: await FuelEntry.findById(entry._id).populate(POPULATE).lean() });
  } catch (error) {
    console.error('[fuel] review failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to record the review' });
  }
});

// Re-measure and re-judge a vehicle's whole chain against the current
// thresholds. Deliberately explicit, and per vehicle: this is what makes a
// change to the settings apply to history, without a settings save quietly
// rewriting tens of thousands of rows.
router.post('/recompute', protect, requirePermission('fuel', 'manage'), async (req, res) => {
  try {
    const truck = objectId(req.body?.truck);
    if (!truck) {
      return res.status(400).json({ success: false, error: 'Select the vehicle to recompute' });
    }

    const vehicle = await Truck.findOne({ _id: truck, owner: req.accountId }).select('number').lean();
    if (!vehicle) return res.status(404).json({ success: false, error: 'Vehicle not found' });

    const { updated } = await recomputeChain({ accountId: req.accountId, truck });

    res.json({
      success: true,
      updated,
      message: `Recomputed ${updated} fuel ${updated === 1 ? 'entry' : 'entries'} for ${vehicle.number}`
    });
  } catch (error) {
    console.error('[fuel] recompute failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to recompute that vehicle' });
  }
});

// DELETE /api/fuel/:id
router.delete('/:id', protect, requirePermission('fuel', 'delete'), async (req, res) => {
  try {
    const entry = await FuelEntry.findOne({ _id: req.params.id, ...ownedBy(req) });
    if (!entry) return res.status(404).json({ success: false, error: 'Fuel entry not found' });

    const { truck, filledAt, trip, tripExpenseId } = entry;
    const label = entryLabel(entry);
    const snapshot = entry.toObject();

    // Take the cost off the trip before the entry goes: otherwise the expense
    // line survives with nothing left that owns it, and no way to identify it
    // as ours later.
    await detachFromTrip({ accountId: req.accountId, tripId: trip, expenseId: tripExpenseId });

    await entry.deleteOne();

    // The chain now has a hole in it, so everything after the removed entry is
    // measured against a new anchor.
    await recomputeChain({ accountId: req.accountId, truck, since: filledAt });

    auditDelete(req, {
      entity: 'fuel_entry',
      doc: snapshot,
      label,
      fields: AUDIT_FIELDS
    });

    res.json({ success: true, message: 'Fuel entry deleted' });
  } catch (error) {
    console.error('[fuel] delete failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to delete the fuel entry' });
  }
});

export default router;
