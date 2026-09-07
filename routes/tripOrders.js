import express from 'express';
import TripOrder from '../models/TripOrder.js';
import Customer from '../models/Customer.js';
import Truck from '../models/Truck.js';
import Driver from '../models/Driver.js';
import Trip from '../models/Trip.js';
import { protect, requirePermission } from '../middleware/auth.js';
import { hasPermission } from '../utils/permissions.js';
import { auditCreate, auditUpdate, auditDelete, recordAudit } from '../utils/audit.js';
import {
  TRIP_TYPES,
  TRIP_TYPE_LABELS,
  TRIP_STATUSES,
  TRIP_STATUS_LABELS,
  STATUS_TRANSITIONS,
  TERMINAL_STATUSES,
  ACTIVE_STATUSES,
  LEGACY_TRIP_STATUS,
  STOP_TYPES,
  STOP_TYPE_LABELS,
  STOP_STATUSES,
  STOP_STATUS_LABELS,
  CARGO_UNITS,
  REVENUE_CATEGORIES,
  REVENUE_CATEGORY_LABELS,
  EXPENSE_CATEGORIES,
  EXPENSE_CATEGORY_LABELS,
  PAYMENT_MODES,
  EVENT_TYPES,
  EVENT_TYPE_LABELS,
  EVENT_SEVERITIES,
  TRIP_DOCUMENT_TYPES,
  TRIP_DOCUMENT_TYPE_LABELS,
  CREW_ROLES,
  CREW_ROLE_LABELS,
  CHECKLIST_ITEMS,
  MANDATORY_CHECKLIST_KEYS,
  canTransition
} from '../utils/tripOrders.js';
import {
  buildTripFields,
  buildChecklist,
  cleanStop,
  cleanCargo,
  cleanRevenueLine,
  cleanExpenseLine,
  cleanCrewMember,
  cleanDocument,
  cleanPod,
  cleanReading,
  validateDataUrl,
  objectId,
  MAX_SIGNATURE_CHARS
} from '../utils/tripOrderFields.js';
import { applyTotals, computeProfitability, computeVariance } from '../services/tripFinance.js';
import {
  validateVehicleAssignment,
  validateDriverAssignment,
  validateCapacity
} from '../services/tripAssignment.js';
import { createWithTripNumber, previewTripNumber } from '../services/tripNumber.js';

const router = express.Router();

// Every trip belongs to the caller's account, like every other business record
// here. Applied to the query itself rather than filtered after the read.
const ownedBy = (req) => ({ owner: req.accountId });

// How a trip names itself in the audit trail. The number is the office's own
// reference, so a log line reads the way a person would say it out loud.
const tripLabel = (trip) =>
  trip?.tripNumber || `${trip?.pickup?.city || 'Unknown'} → ${trip?.destination?.city || 'Unknown'}`;

// Fields the list and detail views populate. Kept in one place so a change to
// what a trip shows about its vehicle does not have to be made in six handlers.
const POPULATE = [
  { path: 'customer', select: 'name legalName code gstin paymentTerms creditLimit gstRate billingAddress contacts status' },
  { path: 'truck', select: 'number model vehicleType status capacity odometer fuelType device' },
  { path: 'driver', select: 'name mobile licenseNumber licenseExpiry status' },
  { path: 'crew.employee', select: 'name mobile licenseNumber' }
];

// Loads one of the caller's trips, or null. Every sub-resource handler starts
// here, so ownership is enforced in exactly one place.
const findTrip = (req) => TripOrder.findOne({ _id: req.params.id, ...ownedBy(req) });

// Refuses a change to a trip that has already finished. A completed or
// cancelled trip is a record of what happened; correcting it is an override,
// not an edit, and the two should not look the same in the audit trail.
const guardTerminal = (trip, res) => {
  if (TERMINAL_STATUSES.includes(trip.status)) {
    res.status(409).json({
      success: false,
      error: `This trip is ${TRIP_STATUS_LABELS[trip.status].toLowerCase()} and can no longer be changed`
    });
    return true;
  }
  return false;
};

// Records a status change on the trip's own history and, when it is worth
// seeing on the timeline, as an event. The two are different things: the
// history is the audit of the state machine, the event list is the operational
// narrative.
const pushStatusChange = (trip, { from, to, req, reason = '', lat = null, lng = null }) => {
  trip.statusHistory.push({
    from,
    to,
    at: new Date(),
    by: req.user?._id || null,
    byName: req.user?.name || '',
    reason,
    lat,
    lng
  });

  trip.events.push({
    eventType: 'status_change',
    severity: to === 'cancelled' || to === 'on_hold' ? 'warning' : 'info',
    message: from
      ? `Status changed from ${TRIP_STATUS_LABELS[from]} to ${TRIP_STATUS_LABELS[to]}${reason ? ` — ${reason}` : ''}`
      : `Trip created as ${TRIP_STATUS_LABELS[to]}`,
    occurredAt: new Date(),
    lat,
    lng,
    source: 'system',
    createdBy: req.user?._id || null
  });
};

// Mirrors the operational status onto the linked GPS Trip record, which still
// speaks the older four-value vocabulary that the map trail and the public
// tracking page read.
//
// Deliberately one-way and best-effort: Trip.js is not modified by this module,
// and a failure to mirror must never fail the status change the operator asked
// for. The trip's own status is the source of truth either way.
const mirrorToRoute = async (trip) => {
  if (!trip.route) return;

  const legacy = LEGACY_TRIP_STATUS[trip.status];
  if (!legacy) return;

  const updates = { status: legacy };
  // startedAt bounds the GPS trail, so it has to be stamped when the vehicle
  // actually goes out — the trail query returns nothing without it.
  if (legacy === 'active' && trip.start?.at) updates.startedAt = trip.start.at;
  if (legacy === 'completed' && trip.end?.at) updates.completedAt = trip.end.at;

  try {
    await Trip.updateOne({ _id: trip.route, owner: trip.owner }, { $set: updates });
  } catch (error) {
    console.error('[trip-orders] route mirror failed:', error.message);
  }
};

// Keeps the vehicle and driver masters in step with what the trip is doing, so
// the fleet screens do not have to derive it. Best-effort for the same reason
// as the route mirror.
const syncResourceStatus = async (trip, { releasing = false } = {}) => {
  try {
    if (trip.truck) {
      const onTrip = ACTIVE_STATUSES.includes(trip.status);
      // Only ever moves between 'In Transit' and 'Idle', and never touches a
      // vehicle the workshop has taken off the road — a trip ending must not
      // quietly mark a truck in Maintenance as available.
      const truck = await Truck.findOne({ _id: trip.truck, owner: trip.owner }).select('status');
      if (truck && !['Maintenance', 'Inactive'].includes(truck.status)) {
        const next = releasing || !onTrip ? 'Idle' : 'In Transit';
        if (truck.status !== next) {
          await Truck.updateOne({ _id: trip.truck }, { $set: { status: next } });
        }
      }
    }

    if (trip.driver) {
      const onTrip = ACTIVE_STATUSES.includes(trip.status);
      const driver = await Driver.findOne({ _id: trip.driver, owner: trip.owner }).select('status');
      // Same restraint: a driver on Leave stays on Leave.
      if (driver && !['Leave', 'Inactive', 'Off Duty'].includes(driver.status)) {
        const next = releasing || !onTrip ? 'Available' : 'On Trip';
        if (driver.status !== next) {
          await Driver.updateOne({ _id: trip.driver }, { $set: { status: next } });
        }
      }
    }
  } catch (error) {
    console.error('[trip-orders] resource status sync failed:', error.message);
  }
};

// May this seat push an assignment past a blocker? `trips:manage` is the
// write-plus-destroy grant, so it is the closest thing the existing matrix has
// to "senior enough to take responsibility for an exception". Read through
// hasPermission rather than by naming roles, so a Super Admin editing the
// matrix changes who can override without a code change.
const canOverride = (req) => hasPermission(req.user?.role, 'trips', 'manage');

// Expense lines without their receipt images. A trip with twenty fuel bills
// carries megabytes of base64 that no list view renders; `hasReceipt` says one
// exists and the receipt endpoint fetches it on demand.
const stripReceipts = (expenses = []) =>
  expenses.map((e) => {
    const line = e.toObject ? e.toObject() : { ...e };
    const receipt = line.receipt || {};
    return {
      ...line,
      hasReceipt: Boolean(receipt.dataUrl),
      receipt: { filename: receipt.filename || '', mimeType: receipt.mimeType || '' }
    };
  });

// The same for attached documents: metadata in the list, the file itself only
// when someone opens it.
const listDocuments = (documents = []) =>
  documents.map((d) => {
    const doc = d.toObject ? d.toObject() : { ...d };
    delete doc.dataUrl;
    return { ...doc, hasFile: true };
  });

// A POD without its stored images. Same reasoning as stripReceipts: the
// signature and the photo are only needed when the POD is actually opened.
const stripPodMedia = (pod) => {
  if (!pod) return pod;
  const out = pod.toObject ? pod.toObject() : { ...pod };
  const hasSignature = Boolean(out.signature);
  const hasPhoto = Boolean(out.photo);
  delete out.signature;
  delete out.photo;
  return { ...out, hasSignature, hasPhoto };
};

// Renumbers stops from their array position, so `sequence` is always dense and
// in travel order however the client reordered them.
const resequence = (stops) => {
  stops.forEach((stop, i) => {
    stop.sequence = i + 1;
  });
  return stops;
};

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

// Everything the trip forms render their dropdowns from. Served from the same
// module the model validates against, so the UI can never offer a value the
// API would reject.
router.get('/options', protect, (req, res) => {
  res.json({
    success: true,
    tripTypes: TRIP_TYPES.map((v) => ({ value: v, label: TRIP_TYPE_LABELS[v] })),
    statuses: TRIP_STATUSES.map((v) => ({ value: v, label: TRIP_STATUS_LABELS[v] })),
    statusTransitions: STATUS_TRANSITIONS,
    terminalStatuses: TERMINAL_STATUSES,
    activeStatuses: ACTIVE_STATUSES,
    stopTypes: STOP_TYPES.map((v) => ({ value: v, label: STOP_TYPE_LABELS[v] })),
    stopStatuses: STOP_STATUSES.map((v) => ({ value: v, label: STOP_STATUS_LABELS[v] })),
    cargoUnits: CARGO_UNITS,
    revenueCategories: REVENUE_CATEGORIES.map((v) => ({ value: v, label: REVENUE_CATEGORY_LABELS[v] })),
    expenseCategories: EXPENSE_CATEGORIES.map((v) => ({ value: v, label: EXPENSE_CATEGORY_LABELS[v] })),
    paymentModes: PAYMENT_MODES,
    eventTypes: EVENT_TYPES.map((v) => ({ value: v, label: EVENT_TYPE_LABELS[v] })),
    eventSeverities: EVENT_SEVERITIES,
    documentTypes: TRIP_DOCUMENT_TYPES.map((v) => ({ value: v, label: TRIP_DOCUMENT_TYPE_LABELS[v] })),
    crewRoles: CREW_ROLES.map((v) => ({ value: v, label: CREW_ROLE_LABELS[v] })),
    checklistItems: CHECKLIST_ITEMS
  });
});

// The number the next trip would take. A preview only — the number is actually
// allocated at save time, so two people on the form at once still get distinct
// numbers.
router.get('/next-number', protect, requirePermission('trips', 'create'), async (req, res) => {
  try {
    res.json({ success: true, tripNumber: await previewTripNumber(req.accountId) });
  } catch (error) {
    console.error('[trip-orders] number preview failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to generate a trip number' });
  }
});

// ---------------------------------------------------------------------------
// List and summary
// ---------------------------------------------------------------------------

// GET /api/trip-orders — the trip list, filtered, sorted and paginated on the
// server. The list is the module's busiest screen and a fleet accumulates
// thousands of trips, so none of this is done in the browser.
router.get('/', protect, requirePermission('trips', 'read'), async (req, res) => {
  try {
    const query = ownedBy(req);

    // Multi-select filters arrive comma-separated. Unknown values are dropped
    // rather than 400ing — a stale bookmark should narrow oddly, not break.
    const list = (raw, allowed) =>
      String(raw || '')
        .split(',')
        .map((v) => v.trim())
        .filter((v) => allowed.includes(v));

    const statuses = list(req.query.status, TRIP_STATUSES);
    if (statuses.length) query.status = { $in: statuses };

    const types = list(req.query.tripType, TRIP_TYPES);
    if (types.length) query.tripType = { $in: types };

    if (objectId(req.query.customer)) query.customer = objectId(req.query.customer);
    if (objectId(req.query.truck)) query.truck = objectId(req.query.truck);
    if (objectId(req.query.driver)) query.driver = objectId(req.query.driver);

    // Date range over tripDate. `to` is pushed to the end of its day so a
    // same-day from/to returns that day's trips rather than nothing.
    const from = req.query.from ? new Date(req.query.from) : null;
    const to = req.query.to ? new Date(req.query.to) : null;
    if ((from && !Number.isNaN(from.getTime())) || (to && !Number.isNaN(to.getTime()))) {
      query.tripDate = {};
      if (from && !Number.isNaN(from.getTime())) query.tripDate.$gte = from;
      if (to && !Number.isNaN(to.getTime())) {
        to.setHours(23, 59, 59, 999);
        query.tripDate.$lte = to;
      }
    }

    const search = String(req.query.search || '').trim();
    if (search) {
      const safe = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const rx = new RegExp(safe, 'i');
      query.$or = [
        { tripNumber: rx },
        { vehicleNumber: rx },
        { driverName: rx },
        { 'pickup.city': rx },
        { 'destination.city': rx },
        { 'consignment.lrNumber': rx },
        { 'consignment.ewayBill': rx },
        { 'customerReferences.po': rx }
      ];
    }

    // Sorting is restricted to an allow-list: a sort key straight from the
    // query string would let a caller sort on any indexed or unindexed path.
    const SORTABLE = {
      tripDate: 'tripDate',
      tripNumber: 'tripNumber',
      status: 'status',
      revenue: 'totals.revenue',
      expenses: 'totals.expenses',
      profit: 'totals.profit',
      actualKm: 'actualKm',
      plannedKm: 'plannedKm'
    };
    const sortField = SORTABLE[req.query.sortBy] || 'tripDate';
    const sortDir = req.query.sortDir === 'asc' ? 1 : -1;

    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25));

    const [trips, total] = await Promise.all([
      TripOrder.find(query)
        // The heavy arrays are excluded from the list: a trip's events,
        // documents and POD images run to megabytes, and none of it is shown
        // in a table row. The detail endpoint returns them.
        .select('-events -documents -statusHistory -pod -checklist -expenses.receipt')
        .populate(POPULATE)
        .sort({ [sortField]: sortDir, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      TripOrder.countDocuments(query)
    ]);

    res.json({
      success: true,
      trips,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) || 1 }
    });
  } catch (error) {
    console.error('[trip-orders] list failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to fetch trips' });
  }
});

// GET /api/trip-orders/summary — the counts and money totals behind the list's
// stat strip, aggregated in the database rather than by loading every trip.
router.get('/summary', protect, requirePermission('trips', 'read'), async (req, res) => {
  try {
    const match = ownedBy(req);

    const [byStatus, money] = await Promise.all([
      TripOrder.aggregate([
        { $match: match },
        { $group: { _id: '$status', count: { $sum: 1 } } }
      ]),
      TripOrder.aggregate([
        { $match: match },
        {
          $group: {
            _id: null,
            revenue: { $sum: '$totals.revenue' },
            expenses: { $sum: '$totals.expenses' },
            profit: { $sum: '$totals.profit' },
            trips: { $sum: 1 }
          }
        }
      ])
    ]);

    const counts = Object.fromEntries(byStatus.map((r) => [r._id, r.count]));
    const totals = money[0] || { revenue: 0, expenses: 0, profit: 0, trips: 0 };

    res.json({
      success: true,
      counts,
      active: ACTIVE_STATUSES.reduce((sum, s) => sum + (counts[s] || 0), 0),
      totals: {
        trips: totals.trips,
        revenue: Math.round((totals.revenue || 0) * 100) / 100,
        expenses: Math.round((totals.expenses || 0) * 100) / 100,
        profit: Math.round((totals.profit || 0) * 100) / 100
      }
    });
  } catch (error) {
    console.error('[trip-orders] summary failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to load trip summary' });
  }
});

// ---------------------------------------------------------------------------
// Create, read, update, delete
// ---------------------------------------------------------------------------

// POST /api/trip-orders — create a trip.
//
// A trip starts as a draft with only what the operator has so far. Vehicle,
// driver, cargo and money all have their own endpoints with their own
// validation, so they are not accepted here — but a create payload carrying
// them is handled by the wizard calling those endpoints in turn, which keeps
// every assignment check in exactly one place.
router.post('/', protect, requirePermission('trips', 'create'), async (req, res) => {
  try {
    const fields = buildTripFields(req.body);

    // A customer is optional on a draft (an enquiry with no party yet is real),
    // but if one is named it must exist in this account and be usable.
    if (fields.customer) {
      const customer = await Customer.findOne({ _id: fields.customer, owner: req.accountId })
        .select('name status');
      if (!customer) {
        return res.status(404).json({ success: false, error: 'Customer not found' });
      }
      if (customer.status === 'Blacklisted') {
        return res.status(409).json({
          success: false,
          error: `${customer.name} is blacklisted and cannot be booked`
        });
      }
    }

    const status = TRIP_STATUSES.includes(req.body.status) && req.body.status !== 'draft'
      ? req.body.status
      : 'draft';

    // Only the two statuses a trip can legitimately be born in. Anything
    // further along implies a vehicle, a driver and a dispatch that have not
    // happened yet, and would leave the state machine with no history.
    if (!['draft', 'planned'].includes(status)) {
      return res.status(400).json({
        success: false,
        error: 'A new trip can only start as Draft or Planned'
      });
    }

    const trip = await createWithTripNumber(req.accountId, async (tripNumber) => {
      const doc = new TripOrder({
        ...fields,
        tripNumber,
        status,
        owner: req.accountId,
        createdBy: req.user?._id || null,
        checklist: buildChecklist([], [], req.user?._id || null)
      });
      pushStatusChange(doc, { from: '', to: status, req });
      applyTotals(doc);
      return doc.save();
    });

    await trip.populate(POPULATE);

    await auditCreate(req, {
      entity: 'trip_order',
      doc: trip,
      label: tripLabel(trip),
      fields: ['tripNumber', 'tripDate', 'tripType', 'status', 'customer', 'pickup', 'destination', 'plannedKm']
    });

    res.status(201).json({ success: true, trip });
  } catch (error) {
    console.error('[trip-orders] create failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to create trip' });
  }
});

// GET /api/trip-orders/:id — one trip in full, with the computed money and
// distance blocks the detail page renders. Both are computed here rather than
// in the browser.
router.get('/:id', protect, requirePermission('trips', 'read'), async (req, res) => {
  try {
    const trip = await findTrip(req).populate(POPULATE).lean();
    if (!trip) return res.status(404).json({ success: false, error: 'Trip not found' });

    // The stored images are stripped from the detail payload: a trip with a
    // POD photo, a signature and a dozen fuel receipts runs to several
    // megabytes, none of which the page shows until someone opens it. Each has
    // its own endpoint, and the flags here tell the UI what is there to open.
    const lean = {
      ...trip,
      expenses: stripReceipts(trip.expenses),
      documents: listDocuments(trip.documents),
      pod: stripPodMedia(trip.pod),
      stops: (trip.stops || []).map((s) => ({ ...s, pod: stripPodMedia(s.pod) }))
    };

    res.json({
      success: true,
      trip: lean,
      profitability: computeProfitability(trip),
      variance: computeVariance(trip),
      // Signature and photo live behind their own endpoints; these say whether
      // there is anything to fetch.
      podMedia: {
        hasSignature: Boolean(trip.pod?.signature),
        hasPhoto: Boolean(trip.pod?.photo)
      },
      // What this trip may do next, so the detail page's action buttons match
      // the server's rules instead of re-implementing them.
      allowedTransitions: trip.status === 'on_hold'
        ? [trip.heldFrom || 'planned', 'cancelled']
        : [...(STATUS_TRANSITIONS[trip.status] || []),
           ...(TERMINAL_STATUSES.includes(trip.status) ? [] : ['on_hold', 'cancelled'])]
    });
  } catch (error) {
    console.error('[trip-orders] fetch failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to fetch trip' });
  }
});

// PATCH /api/trip-orders/:id — edit the trip's own fields. Assignment, stops,
// cargo, money and status each have their own endpoint.
router.patch('/:id', protect, requirePermission('trips', 'update'), async (req, res) => {
  try {
    const existing = await findTrip(req);
    if (!existing) return res.status(404).json({ success: false, error: 'Trip not found' });
    if (guardTerminal(existing, res)) return;

    const fields = buildTripFields(req.body);

    if (fields.customer) {
      const customer = await Customer.findOne({ _id: fields.customer, owner: req.accountId })
        .select('name status');
      if (!customer) return res.status(404).json({ success: false, error: 'Customer not found' });
      if (customer.status === 'Blacklisted') {
        return res.status(409).json({
          success: false,
          error: `${customer.name} is blacklisted and cannot be booked`
        });
      }
    }

    const before = existing.toObject();
    const trip = await TripOrder.findOneAndUpdate(
      { _id: req.params.id, ...ownedBy(req) },
      { $set: { ...fields, updatedAt: new Date() } },
      { new: true, runValidators: true }
    ).populate(POPULATE);

    await auditUpdate(req, {
      entity: 'trip_order',
      before,
      after: trip,
      fields,
      label: tripLabel(trip)
    });

    res.json({ success: true, trip });
  } catch (error) {
    console.error('[trip-orders] update failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to update trip' });
  }
});

// DELETE /api/trip-orders/:id — only ever a draft.
//
// A trip that has been dispatched is a record of something that happened in the
// real world: a vehicle went out, money was spent, a customer was served.
// Deleting it would erase that. Those are cancelled instead, which keeps the
// history and the reason.
router.delete('/:id', protect, requirePermission('trips', 'delete'), async (req, res) => {
  try {
    const trip = await findTrip(req);
    if (!trip) return res.status(404).json({ success: false, error: 'Trip not found' });

    if (trip.status !== 'draft') {
      return res.status(409).json({
        success: false,
        error: 'Only a draft trip can be deleted. Cancel this trip instead so its history is kept.'
      });
    }

    await TripOrder.deleteOne({ _id: trip._id, ...ownedBy(req) });

    await auditDelete(req, {
      entity: 'trip_order',
      doc: trip,
      label: tripLabel(trip),
      fields: ['tripNumber', 'tripDate', 'tripType', 'status', 'customer', 'pickup', 'destination']
    });

    res.json({ success: true, message: 'Trip removed' });
  } catch (error) {
    console.error('[trip-orders] delete failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to delete trip' });
  }
});

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

// POST /api/trip-orders/:id/status — move the trip through its lifecycle.
//
// This is the only way a trip's status changes. Every transition is checked
// against the state machine, recorded in the trip's own history, mirrored onto
// the GPS route record and reflected on the vehicle and driver masters.
router.post('/:id/status', protect, requirePermission('trips', 'update'), async (req, res) => {
  try {
    const trip = await findTrip(req);
    if (!trip) return res.status(404).json({ success: false, error: 'Trip not found' });

    const to = String(req.body.status || '');
    const from = trip.status;

    const refusal = canTransition(from, to, { resumeTo: trip.heldFrom });
    if (refusal) return res.status(409).json({ success: false, error: refusal });

    if (from === to) {
      return res.json({ success: true, trip: await trip.populate(POPULATE) });
    }

    // Dispatch is the gate the checklist exists for. Checked here rather than
    // only on the dispatch endpoint so the status cannot be walked past it.
    if (to === 'dispatched') {
      const ticked = new Set(trip.checklist.filter((i) => i.checked).map((i) => i.key));
      const missing = MANDATORY_CHECKLIST_KEYS.filter((k) => !ticked.has(k));
      if (missing.length) {
        return res.status(409).json({
          success: false,
          error: 'The dispatch checklist is not complete',
          missingChecklistItems: missing
        });
      }
      if (!trip.truck || !trip.driver) {
        return res.status(409).json({
          success: false,
          error: 'A trip needs both a vehicle and a driver before it can be dispatched'
        });
      }
      trip.dispatchedAt = new Date();
      trip.dispatchedBy = req.user?._id || null;
    }

    // Moving beyond planning requires the trip to actually be assigned.
    if (to === 'assigned' && (!trip.truck || !trip.driver)) {
      return res.status(409).json({
        success: false,
        error: 'Assign a vehicle and a driver before marking this trip Assigned'
      });
    }

    trip.heldFrom = to === 'on_hold' ? from : null;
    trip.status = to;

    pushStatusChange(trip, {
      from,
      to,
      req,
      reason: String(req.body.reason || '').trim(),
      lat: Number.isFinite(Number(req.body.lat)) ? Number(req.body.lat) : null,
      lng: Number.isFinite(Number(req.body.lng)) ? Number(req.body.lng) : null
    });

    await trip.save();

    await mirrorToRoute(trip);
    // A terminal status hands the vehicle and driver back to the pool.
    await syncResourceStatus(trip, { releasing: TERMINAL_STATUSES.includes(to) });

    await recordAudit(req, {
      entity: 'trip_order',
      entityId: trip._id,
      action: 'update',
      label: tripLabel(trip),
      summary: `Trip ${trip.tripNumber} moved from ${TRIP_STATUS_LABELS[from]} to ${TRIP_STATUS_LABELS[to]}`,
      changes: [
        { field: 'status', label: 'Status', from: TRIP_STATUS_LABELS[from], to: TRIP_STATUS_LABELS[to] }
      ]
    });

    res.json({ success: true, trip: await trip.populate(POPULATE) });
  } catch (error) {
    console.error('[trip-orders] status change failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to change trip status' });
  }
});


// ---------------------------------------------------------------------------
// Assignment — vehicle, driver, crew
// ---------------------------------------------------------------------------

// GET /api/trip-orders/:id/assignment-options — everything the assignment panel
// needs to let an operator choose well: the fleet and roster, each already
// marked with the trip currently holding it, so the UI can say why a vehicle is
// unavailable rather than silently omitting it.
router.get('/:id/assignment-options', protect, requirePermission('trips', 'read'), async (req, res) => {
  try {
    const trip = await findTrip(req).select('cargo truck driver status').lean();
    if (!trip) return res.status(404).json({ success: false, error: 'Trip not found' });

    const [trucks, drivers] = await Promise.all([
      Truck.find({ owner: req.accountId, status: { $ne: 'Inactive' } })
        .select('number model vehicleType status capacity odometer fuelType device')
        .sort({ number: 1 })
        .lean(),
      Driver.find({ owner: req.accountId, status: { $ne: 'Inactive' } })
        .select('name mobile licenseNumber licenseExpiry status truck isPrimary')
        .sort({ name: 1 })
        .lean()
    ]);

    // Which vehicles and drivers are already out, in one query rather than one
    // per row — a fleet of 200 would otherwise mean 400 round trips to render a
    // dropdown.
    const busy = await TripOrder.find({
      owner: req.accountId,
      status: { $in: ACTIVE_STATUSES },
      _id: { $ne: trip._id }
    })
      .select('tripNumber truck driver')
      .lean();

    const busyTrucks = new Map(busy.filter((t) => t.truck).map((t) => [String(t.truck), t.tripNumber]));
    const busyDrivers = new Map(busy.filter((t) => t.driver).map((t) => [String(t.driver), t.tripNumber]));

    res.json({
      success: true,
      trucks: trucks.map((t) => ({ ...t, busyOnTrip: busyTrucks.get(String(t._id)) || null })),
      drivers: drivers.map((d) => ({ ...d, busyOnTrip: busyDrivers.get(String(d._id)) || null }))
    });
  } catch (error) {
    console.error('[trip-orders] assignment options failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to load assignment options' });
  }
});

// GET /api/trip-orders/:id/vehicle-check/:truckId — the verdict for one vehicle
// without committing to it, so the operator sees the blockers and warnings
// before pressing Assign.
router.get('/:id/vehicle-check/:truckId', protect, requirePermission('trips', 'read'), async (req, res) => {
  try {
    const trip = await findTrip(req).select('cargo').lean();
    if (!trip) return res.status(404).json({ success: false, error: 'Trip not found' });

    const result = await validateVehicleAssignment(req.params.truckId, {
      accountId: req.accountId,
      cargo: trip.cargo || [],
      excludeTripId: trip._id
    });

    res.json({ success: true, ...result });
  } catch (error) {
    console.error('[trip-orders] vehicle check failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to check the vehicle' });
  }
});

// GET /api/trip-orders/:id/driver-check/:driverId — the same for a driver.
router.get('/:id/driver-check/:driverId', protect, requirePermission('trips', 'read'), async (req, res) => {
  try {
    const trip = await findTrip(req).select('_id').lean();
    if (!trip) return res.status(404).json({ success: false, error: 'Trip not found' });

    const result = await validateDriverAssignment(req.params.driverId, {
      accountId: req.accountId,
      excludeTripId: trip._id
    });

    res.json({ success: true, ...result });
  } catch (error) {
    console.error('[trip-orders] driver check failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to check the driver' });
  }
});

// POST /api/trip-orders/:id/assign-vehicle
//
// `allowOverride` lets a seat holding trips:manage push past a blocker. A
// dispatcher with a load to move and a PUC that lapsed yesterday sometimes has
// to, and the alternative is that they stop using the system and move the truck
// anyway. The override is refused for anyone else, recorded as a warning event
// on the trip, and audited with the reasons that were bypassed.
router.post('/:id/assign-vehicle', protect, requirePermission('trips', 'update'), async (req, res) => {
  try {
    const trip = await findTrip(req);
    if (!trip) return res.status(404).json({ success: false, error: 'Trip not found' });
    if (guardTerminal(trip, res)) return;

    const truckId = objectId(req.body.truck);
    if (!truckId) return res.status(400).json({ success: false, error: 'A vehicle is required' });

    const check = await validateVehicleAssignment(truckId, {
      accountId: req.accountId,
      cargo: trip.cargo || [],
      excludeTripId: trip._id
    });

    if (!check.detail) return res.status(404).json({ success: false, error: 'Vehicle not found' });

    const wantsOverride = Boolean(req.body.allowOverride);
    const mayOverride = canOverride(req);

    if (!check.ok && !(wantsOverride && mayOverride)) {
      return res.status(409).json({
        success: false,
        error: check.blockers[0],
        blockers: check.blockers,
        warnings: check.warnings,
        // Tells the UI whether to offer an override button at all.
        canOverride: mayOverride
      });
    }

    const previous = trip.vehicleNumber || null;
    trip.truck = truckId;
    trip.vehicleNumber = check.detail.truck.number || '';

    // The starting odometer defaults to what the vehicle master already knows,
    // so the driver corrects a number rather than hunting for one.
    if (trip.start?.odometer == null && Number.isFinite(check.detail.truck.odometer)) {
      trip.start.odometer = check.detail.truck.odometer;
    }

    if (!check.ok && wantsOverride && mayOverride) {
      trip.events.push({
        eventType: 'manual',
        severity: 'warning',
        message: `Vehicle assigned by override — ${check.blockers.join('; ')}`,
        occurredAt: new Date(),
        source: 'manual',
        createdBy: req.user?._id || null
      });
    }

    await trip.save();
    await syncResourceStatus(trip);

    await recordAudit(req, {
      entity: 'trip_order',
      entityId: trip._id,
      action: 'update',
      label: tripLabel(trip),
      summary: !check.ok
        ? `Vehicle ${trip.vehicleNumber} assigned to trip ${trip.tripNumber} by override (${check.blockers.join('; ')})`
        : `Vehicle ${trip.vehicleNumber} assigned to trip ${trip.tripNumber}`,
      changes: [{ field: 'truck', label: 'Vehicle', from: previous, to: trip.vehicleNumber }]
    });

    res.json({
      success: true,
      trip: await trip.populate(POPULATE),
      warnings: check.warnings,
      overridden: !check.ok
    });
  } catch (error) {
    console.error('[trip-orders] assign vehicle failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to assign the vehicle' });
  }
});

// POST /api/trip-orders/:id/assign-driver
router.post('/:id/assign-driver', protect, requirePermission('trips', 'update'), async (req, res) => {
  try {
    const trip = await findTrip(req);
    if (!trip) return res.status(404).json({ success: false, error: 'Trip not found' });
    if (guardTerminal(trip, res)) return;

    const driverId = objectId(req.body.driver);
    if (!driverId) return res.status(400).json({ success: false, error: 'A driver is required' });

    const check = await validateDriverAssignment(driverId, {
      accountId: req.accountId,
      excludeTripId: trip._id
    });

    if (!check.detail) return res.status(404).json({ success: false, error: 'Driver not found' });

    const wantsOverride = Boolean(req.body.allowOverride);
    const mayOverride = canOverride(req);

    if (!check.ok && !(wantsOverride && mayOverride)) {
      return res.status(409).json({
        success: false,
        error: check.blockers[0],
        blockers: check.blockers,
        warnings: check.warnings,
        canOverride: mayOverride
      });
    }

    const previous = trip.driverName || null;
    trip.driver = driverId;
    trip.driverName = check.detail.driver.name || '';

    if (!check.ok && wantsOverride && mayOverride) {
      trip.events.push({
        eventType: 'manual',
        severity: 'warning',
        message: `Driver assigned by override — ${check.blockers.join('; ')}`,
        occurredAt: new Date(),
        source: 'manual',
        createdBy: req.user?._id || null
      });
    }

    await trip.save();
    await syncResourceStatus(trip);

    await recordAudit(req, {
      entity: 'trip_order',
      entityId: trip._id,
      action: 'update',
      label: tripLabel(trip),
      summary: !check.ok
        ? `Driver ${trip.driverName} assigned to trip ${trip.tripNumber} by override (${check.blockers.join('; ')})`
        : `Driver ${trip.driverName} assigned to trip ${trip.tripNumber}`,
      changes: [{ field: 'driver', label: 'Driver', from: previous, to: trip.driverName }]
    });

    res.json({
      success: true,
      trip: await trip.populate(POPULATE),
      warnings: check.warnings,
      overridden: !check.ok
    });
  } catch (error) {
    console.error('[trip-orders] assign driver failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to assign the driver' });
  }
});

// PUT /api/trip-orders/:id/crew — replaces the crew list. Crew are the
// secondary people on board, so the list is short and replacing it wholesale is
// simpler and less error-prone than diffing individual rows.
router.put('/:id/crew', protect, requirePermission('trips', 'update'), async (req, res) => {
  try {
    const trip = await findTrip(req);
    if (!trip) return res.status(404).json({ success: false, error: 'Trip not found' });
    if (guardTerminal(trip, res)) return;

    const incoming = Array.isArray(req.body.crew) ? req.body.crew : [];
    const crew = incoming.map(cleanCrewMember).filter((c) => c.employee || c.name);

    // Any crew member drawn from the roster must belong to this account.
    const referenced = crew.map((c) => c.employee).filter(Boolean);
    if (referenced.length) {
      const found = await Driver.countDocuments({ _id: { $in: referenced }, owner: req.accountId });
      if (found !== referenced.length) {
        return res.status(404).json({ success: false, error: 'One of the crew members was not found' });
      }
    }

    const before = trip.crew.length;
    trip.crew = crew;
    await trip.save();

    await recordAudit(req, {
      entity: 'trip_order',
      entityId: trip._id,
      action: 'update',
      label: tripLabel(trip),
      summary: `Crew updated on trip ${trip.tripNumber} (${before} → ${crew.length})`,
      changes: [{ field: 'crew', label: 'Crew', from: before, to: crew.length }]
    });

    res.json({ success: true, trip: await trip.populate(POPULATE) });
  } catch (error) {
    console.error('[trip-orders] crew update failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to update the crew' });
  }
});

// ---------------------------------------------------------------------------
// Stops
// ---------------------------------------------------------------------------

// PUT /api/trip-orders/:id/stops — replace the whole list, in travel order.
// This is also how reordering is saved: the client sends the stops in their new
// order and the server renumbers them, so `sequence` can never disagree with
// the array.
//
// Stops that already exist keep their progress. Without this, dragging a stop
// in the planner would silently discard the arrival time and POD already
// captured against it.
router.put('/:id/stops', protect, requirePermission('trips', 'update'), async (req, res) => {
  try {
    const trip = await findTrip(req);
    if (!trip) return res.status(404).json({ success: false, error: 'Trip not found' });
    if (guardTerminal(trip, res)) return;

    const incoming = Array.isArray(req.body.stops) ? req.body.stops : [];
    const existing = new Map(trip.stops.map((s) => [String(s._id), s]));

    const stops = incoming.map((raw, i) => {
      const cleaned = cleanStop(raw, i);
      const prior = raw?._id ? existing.get(String(raw._id)) : null;
      if (!prior) return cleaned;

      // Keep what actually happened at this stop; take only the planning
      // fields from the payload.
      return {
        ...prior.toObject(),
        ...cleaned,
        _id: prior._id,
        arrivedAt: prior.arrivedAt,
        departedAt: prior.departedAt,
        status: prior.status,
        pod: prior.pod
      };
    });

    const before = trip.stops.length;
    trip.stops = resequence(stops);
    await trip.save();

    await recordAudit(req, {
      entity: 'trip_order',
      entityId: trip._id,
      action: 'update',
      label: tripLabel(trip),
      summary: `Stops updated on trip ${trip.tripNumber} (${before} → ${trip.stops.length})`,
      changes: [{ field: 'stops', label: 'Stops', from: before, to: trip.stops.length }]
    });

    res.json({ success: true, stops: trip.stops });
  } catch (error) {
    console.error('[trip-orders] stops update failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to update the stops' });
  }
});

// POST /api/trip-orders/:id/stops — append one stop.
router.post('/:id/stops', protect, requirePermission('trips', 'update'), async (req, res) => {
  try {
    const trip = await findTrip(req);
    if (!trip) return res.status(404).json({ success: false, error: 'Trip not found' });
    if (guardTerminal(trip, res)) return;

    trip.stops.push(cleanStop(req.body, trip.stops.length));
    resequence(trip.stops);
    await trip.save();

    await recordAudit(req, {
      entity: 'trip_order',
      entityId: trip._id,
      action: 'update',
      label: tripLabel(trip),
      summary: `Stop added to trip ${trip.tripNumber}`,
      changes: [{ field: 'stops', label: 'Stops', from: trip.stops.length - 1, to: trip.stops.length }]
    });

    res.status(201).json({ success: true, stops: trip.stops });
  } catch (error) {
    console.error('[trip-orders] stop add failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to add the stop' });
  }
});

// PATCH /api/trip-orders/:id/stops/:stopId — edit one stop, or move it on:
// `action` of 'arrive', 'depart', 'complete' or 'skip' stamps the times the
// operator would otherwise have to type.
router.patch('/:id/stops/:stopId', protect, requirePermission('trips', 'update'), async (req, res) => {
  try {
    const trip = await findTrip(req);
    if (!trip) return res.status(404).json({ success: false, error: 'Trip not found' });
    if (guardTerminal(trip, res)) return;

    const stop = trip.stops.id(req.params.stopId);
    if (!stop) return res.status(404).json({ success: false, error: 'Stop not found' });

    const action = String(req.body.action || '').trim();
    const now = new Date();
    const before = stop.status;

    if (action === 'arrive') {
      stop.arrivedAt = now;
      stop.status = 'arrived';
    } else if (action === 'depart') {
      stop.departedAt = now;
      // Departing a stop that was reached completes it: the vehicle has done
      // what it came for and moved on.
      if (stop.status === 'arrived') stop.status = 'completed';
    } else if (action === 'complete') {
      stop.status = 'completed';
      if (!stop.arrivedAt) stop.arrivedAt = now;
      if (!stop.departedAt) stop.departedAt = now;
    } else if (action === 'skip') {
      stop.status = 'skipped';
    } else {
      // A plain edit of the stop's planning fields.
      const cleaned = cleanStop(req.body, stop.sequence - 1);
      stop.stopType = cleaned.stopType;
      stop.location = cleaned.location;
      stop.eta = cleaned.eta;
      stop.loadingQuantity = cleaned.loadingQuantity;
      stop.unloadingQuantity = cleaned.unloadingQuantity;
      stop.notes = cleaned.notes;
      if (STOP_STATUSES.includes(req.body.status)) stop.status = req.body.status;
    }

    await trip.save();

    if (before !== stop.status) {
      await recordAudit(req, {
        entity: 'trip_order',
        entityId: trip._id,
        action: 'update',
        label: tripLabel(trip),
        summary: `Stop ${stop.sequence} on trip ${trip.tripNumber} is now ${STOP_STATUS_LABELS[stop.status]}`,
        changes: [
          {
            field: 'stops',
            label: `Stop ${stop.sequence}`,
            from: STOP_STATUS_LABELS[before],
            to: STOP_STATUS_LABELS[stop.status]
          }
        ]
      });
    }

    res.json({ success: true, stop, stops: trip.stops });
  } catch (error) {
    console.error('[trip-orders] stop update failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to update the stop' });
  }
});

// PUT /api/trip-orders/:id/stops/:stopId/pod — proof of delivery for one drop.
router.put('/:id/stops/:stopId/pod', protect, requirePermission('trips', 'update'), async (req, res) => {
  try {
    const trip = await findTrip(req);
    if (!trip) return res.status(404).json({ success: false, error: 'Trip not found' });

    const stop = trip.stops.id(req.params.stopId);
    if (!stop) return res.status(404).json({ success: false, error: 'Stop not found' });

    const pod = cleanPod(req.body, req.user?._id || null);

    const signatureError = validateDataUrl(pod.signature, {
      max: MAX_SIGNATURE_CHARS,
      label: 'signature'
    });
    if (signatureError) return res.status(400).json({ success: false, error: signatureError });

    const photoError = validateDataUrl(pod.photo, { label: 'photo' });
    if (photoError) return res.status(400).json({ success: false, error: photoError });

    stop.pod = pod;
    // Capturing a POD is what completes a drop; making the operator then also
    // tick "complete" would be a second click for something already proven.
    if (stop.status !== 'skipped') stop.status = 'completed';
    if (!stop.arrivedAt) stop.arrivedAt = pod.arrivedAt || new Date();

    await trip.save();

    await recordAudit(req, {
      entity: 'trip_order',
      entityId: trip._id,
      action: 'update',
      label: tripLabel(trip),
      summary: `POD captured at stop ${stop.sequence} on trip ${trip.tripNumber}`,
      changes: [
        { field: 'pod', label: `Stop ${stop.sequence} POD`, from: null, to: pod.receiverName || 'Captured' }
      ]
    });

    res.json({ success: true, stop });
  } catch (error) {
    console.error('[trip-orders] stop POD failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to save the proof of delivery' });
  }
});

// DELETE /api/trip-orders/:id/stops/:stopId
//
// A stop the vehicle has already reached is not deleted — that happened, and
// erasing it would leave the trip's timeline lying about the route. It is
// marked skipped instead, which the client is told explicitly.
router.delete('/:id/stops/:stopId', protect, requirePermission('trips', 'update'), async (req, res) => {
  try {
    const trip = await findTrip(req);
    if (!trip) return res.status(404).json({ success: false, error: 'Trip not found' });
    if (guardTerminal(trip, res)) return;

    const stop = trip.stops.id(req.params.stopId);
    if (!stop) return res.status(404).json({ success: false, error: 'Stop not found' });

    const visited = stop.status !== 'pending';

    if (visited) {
      stop.status = 'skipped';
    } else {
      stop.deleteOne();
      resequence(trip.stops);
    }

    await trip.save();

    await recordAudit(req, {
      entity: 'trip_order',
      entityId: trip._id,
      action: 'update',
      label: tripLabel(trip),
      summary: visited
        ? `Stop marked skipped on trip ${trip.tripNumber} (it had already been reached)`
        : `Stop removed from trip ${trip.tripNumber}`,
      changes: [{ field: 'stops', label: 'Stops', from: null, to: trip.stops.length }]
    });

    res.json({
      success: true,
      stops: trip.stops,
      skipped: visited,
      message: visited
        ? 'This stop had already been reached, so it was marked skipped rather than removed'
        : 'Stop removed'
    });
  } catch (error) {
    console.error('[trip-orders] stop delete failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to remove the stop' });
  }
});

// ---------------------------------------------------------------------------
// Cargo
// ---------------------------------------------------------------------------

// PUT /api/trip-orders/:id/cargo — replace the cargo list and report how the
// totals sit against the assigned vehicle.
//
// Exceeding capacity does not fail the save here: the load is a fact being
// recorded, and the operator may be entering it before choosing a bigger
// vehicle. It is the *assignment* that blocks on capacity, which is the point
// at which an overloaded vehicle would actually be dispatched.
router.put('/:id/cargo', protect, requirePermission('trips', 'update'), async (req, res) => {
  try {
    const trip = await findTrip(req);
    if (!trip) return res.status(404).json({ success: false, error: 'Trip not found' });
    if (guardTerminal(trip, res)) return;

    const incoming = Array.isArray(req.body.cargo) ? req.body.cargo : [];
    const before = trip.cargo.length;
    trip.cargo = incoming.map(cleanCargo);
    await trip.save();

    // Compare against the assigned vehicle, when there is one.
    let capacityCheck = null;
    if (trip.truck) {
      const truck = await Truck.findOne({ _id: trip.truck, owner: req.accountId }).select('capacity number').lean();
      if (truck) capacityCheck = validateCapacity(trip.cargo, truck.capacity || {});
    }

    await recordAudit(req, {
      entity: 'trip_order',
      entityId: trip._id,
      action: 'update',
      label: tripLabel(trip),
      summary: `Cargo updated on trip ${trip.tripNumber} (${before} → ${trip.cargo.length} item${trip.cargo.length === 1 ? '' : 's'})`,
      changes: [{ field: 'cargo', label: 'Cargo', from: before, to: trip.cargo.length }]
    });

    res.json({ success: true, cargo: trip.cargo, capacityCheck });
  } catch (error) {
    console.error('[trip-orders] cargo update failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to update the cargo' });
  }
});

// ---------------------------------------------------------------------------
// Revenue and expenses
// ---------------------------------------------------------------------------

// Every one of these recomputes the stored totals through applyTotals before
// saving, so `totals.profit` can never drift from the lines it is the sum of.
// The frontend displays these numbers and computes none of its own.

// POST /api/trip-orders/:id/revenue — add a billable line.
router.post('/:id/revenue', protect, requirePermission('trips', 'update'), async (req, res) => {
  try {
    const trip = await findTrip(req);
    if (!trip) return res.status(404).json({ success: false, error: 'Trip not found' });
    if (guardTerminal(trip, res)) return;

    const line = cleanRevenueLine(req.body, req.user?._id || null);
    if (!line) {
      return res.status(400).json({
        success: false,
        error: 'A revenue line needs a valid category and a non-negative amount'
      });
    }

    trip.revenue.push(line);
    applyTotals(trip);
    await trip.save();

    await recordAudit(req, {
      entity: 'trip_order',
      entityId: trip._id,
      action: 'update',
      label: tripLabel(trip),
      summary: `${REVENUE_CATEGORY_LABELS[line.category]} of ₹${line.amount.toLocaleString('en-IN')} added to trip ${trip.tripNumber}`,
      changes: [{ field: 'totals.revenue', label: 'Total Revenue', from: null, to: trip.totals.revenue }]
    });

    res.status(201).json({ success: true, revenue: trip.revenue, totals: trip.totals });
  } catch (error) {
    console.error('[trip-orders] revenue add failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to add the revenue line' });
  }
});

// PUT /api/trip-orders/:id/revenue/:lineId — edit one line.
router.put('/:id/revenue/:lineId', protect, requirePermission('trips', 'update'), async (req, res) => {
  try {
    const trip = await findTrip(req);
    if (!trip) return res.status(404).json({ success: false, error: 'Trip not found' });
    if (guardTerminal(trip, res)) return;

    const line = trip.revenue.id(req.params.lineId);
    if (!line) return res.status(404).json({ success: false, error: 'Revenue line not found' });

    const cleaned = cleanRevenueLine(req.body, req.user?._id || null);
    if (!cleaned) {
      return res.status(400).json({
        success: false,
        error: 'A revenue line needs a valid category and a non-negative amount'
      });
    }

    const previous = line.amount;
    line.category = cleaned.category;
    line.description = cleaned.description;
    line.amount = cleaned.amount;

    applyTotals(trip);
    await trip.save();

    await recordAudit(req, {
      entity: 'trip_order',
      entityId: trip._id,
      action: 'update',
      label: tripLabel(trip),
      summary: `Revenue line edited on trip ${trip.tripNumber}`,
      changes: [
        { field: 'amount', label: REVENUE_CATEGORY_LABELS[line.category], from: previous, to: line.amount },
        { field: 'totals.revenue', label: 'Total Revenue', from: null, to: trip.totals.revenue }
      ]
    });

    res.json({ success: true, revenue: trip.revenue, totals: trip.totals });
  } catch (error) {
    console.error('[trip-orders] revenue update failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to update the revenue line' });
  }
});

// DELETE /api/trip-orders/:id/revenue/:lineId
router.delete('/:id/revenue/:lineId', protect, requirePermission('trips', 'update'), async (req, res) => {
  try {
    const trip = await findTrip(req);
    if (!trip) return res.status(404).json({ success: false, error: 'Trip not found' });
    if (guardTerminal(trip, res)) return;

    const line = trip.revenue.id(req.params.lineId);
    if (!line) return res.status(404).json({ success: false, error: 'Revenue line not found' });

    const removed = { category: line.category, amount: line.amount };
    line.deleteOne();
    applyTotals(trip);
    await trip.save();

    await recordAudit(req, {
      entity: 'trip_order',
      entityId: trip._id,
      action: 'update',
      label: tripLabel(trip),
      summary: `${REVENUE_CATEGORY_LABELS[removed.category]} of ₹${removed.amount.toLocaleString('en-IN')} removed from trip ${trip.tripNumber}`,
      changes: [{ field: 'totals.revenue', label: 'Total Revenue', from: null, to: trip.totals.revenue }]
    });

    res.json({ success: true, revenue: trip.revenue, totals: trip.totals });
  } catch (error) {
    console.error('[trip-orders] revenue delete failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to remove the revenue line' });
  }
});

// POST /api/trip-orders/:id/expenses — add a cost line, optionally with a
// scanned receipt.
router.post('/:id/expenses', protect, requirePermission('trips', 'update'), async (req, res) => {
  try {
    const trip = await findTrip(req);
    if (!trip) return res.status(404).json({ success: false, error: 'Trip not found' });
    if (guardTerminal(trip, res)) return;

    const line = cleanExpenseLine(req.body, req.user?._id || null);
    if (!line) {
      return res.status(400).json({
        success: false,
        error: 'An expense needs a valid category and a non-negative amount'
      });
    }

    const receiptError = validateDataUrl(line.receipt.dataUrl, { label: 'receipt' });
    if (receiptError) return res.status(400).json({ success: false, error: receiptError });

    trip.expenses.push(line);
    applyTotals(trip);
    await trip.save();

    await recordAudit(req, {
      entity: 'trip_order',
      entityId: trip._id,
      action: 'update',
      label: tripLabel(trip),
      summary: `${EXPENSE_CATEGORY_LABELS[line.category]} of ₹${line.amount.toLocaleString('en-IN')} added to trip ${trip.tripNumber}`,
      changes: [{ field: 'totals.expenses', label: 'Total Expenses', from: null, to: trip.totals.expenses }]
    });

    res.status(201).json({ success: true, expenses: stripReceipts(trip.expenses), totals: trip.totals });
  } catch (error) {
    console.error('[trip-orders] expense add failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to add the expense' });
  }
});

// PUT /api/trip-orders/:id/expenses/:lineId
router.put('/:id/expenses/:lineId', protect, requirePermission('trips', 'update'), async (req, res) => {
  try {
    const trip = await findTrip(req);
    if (!trip) return res.status(404).json({ success: false, error: 'Trip not found' });
    if (guardTerminal(trip, res)) return;

    const line = trip.expenses.id(req.params.lineId);
    if (!line) return res.status(404).json({ success: false, error: 'Expense not found' });

    const cleaned = cleanExpenseLine(req.body, req.user?._id || null);
    if (!cleaned) {
      return res.status(400).json({
        success: false,
        error: 'An expense needs a valid category and a non-negative amount'
      });
    }

    const receiptError = validateDataUrl(cleaned.receipt.dataUrl, { label: 'receipt' });
    if (receiptError) return res.status(400).json({ success: false, error: receiptError });

    const previous = line.amount;
    line.category = cleaned.category;
    line.description = cleaned.description;
    line.amount = cleaned.amount;
    line.spentAt = cleaned.spentAt;
    line.paidBy = cleaned.paidBy;
    line.paymentMode = cleaned.paymentMode;
    line.vendor = cleaned.vendor;
    line.litres = cleaned.litres;
    line.odometer = cleaned.odometer;
    // An absent receipt in the payload leaves the stored one alone — editing an
    // amount should not silently drop the scan that backs it.
    if (req.body.receipt !== undefined) line.receipt = cleaned.receipt;

    applyTotals(trip);
    await trip.save();

    await recordAudit(req, {
      entity: 'trip_order',
      entityId: trip._id,
      action: 'update',
      label: tripLabel(trip),
      summary: `Expense edited on trip ${trip.tripNumber}`,
      changes: [
        { field: 'amount', label: EXPENSE_CATEGORY_LABELS[line.category], from: previous, to: line.amount },
        { field: 'totals.expenses', label: 'Total Expenses', from: null, to: trip.totals.expenses }
      ]
    });

    res.json({ success: true, expenses: stripReceipts(trip.expenses), totals: trip.totals });
  } catch (error) {
    console.error('[trip-orders] expense update failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to update the expense' });
  }
});

// DELETE /api/trip-orders/:id/expenses/:lineId
router.delete('/:id/expenses/:lineId', protect, requirePermission('trips', 'update'), async (req, res) => {
  try {
    const trip = await findTrip(req);
    if (!trip) return res.status(404).json({ success: false, error: 'Trip not found' });
    if (guardTerminal(trip, res)) return;

    const line = trip.expenses.id(req.params.lineId);
    if (!line) return res.status(404).json({ success: false, error: 'Expense not found' });

    const removed = { category: line.category, amount: line.amount };
    line.deleteOne();
    applyTotals(trip);
    await trip.save();

    await recordAudit(req, {
      entity: 'trip_order',
      entityId: trip._id,
      action: 'update',
      label: tripLabel(trip),
      summary: `${EXPENSE_CATEGORY_LABELS[removed.category]} of ₹${removed.amount.toLocaleString('en-IN')} removed from trip ${trip.tripNumber}`,
      changes: [{ field: 'totals.expenses', label: 'Total Expenses', from: null, to: trip.totals.expenses }]
    });

    res.json({ success: true, expenses: stripReceipts(trip.expenses), totals: trip.totals });
  } catch (error) {
    console.error('[trip-orders] expense delete failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to remove the expense' });
  }
});

// GET /api/trip-orders/:id/expenses/:lineId/receipt — the stored scan, fetched
// only when someone actually opens it. Same pattern as the ledger's receipts:
// list responses carry the filename, not the megabytes.
router.get('/:id/expenses/:lineId/receipt', protect, requirePermission('trips', 'read'), async (req, res) => {
  try {
    const trip = await findTrip(req).select('expenses');
    if (!trip) return res.status(404).json({ success: false, error: 'Trip not found' });

    const line = trip.expenses.id(req.params.lineId);
    if (!line?.receipt?.dataUrl) {
      return res.status(404).json({ success: false, error: 'No receipt on this expense' });
    }

    res.json({ success: true, receipt: line.receipt });
  } catch (error) {
    console.error('[trip-orders] receipt fetch failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to load the receipt' });
  }
});

// GET /api/trip-orders/:id/profitability — the money block on its own, for the
// profitability tab and for reports.
router.get('/:id/profitability', protect, requirePermission('trips', 'read'), async (req, res) => {
  try {
    const trip = await findTrip(req).lean();
    if (!trip) return res.status(404).json({ success: false, error: 'Trip not found' });

    res.json({
      success: true,
      profitability: computeProfitability(trip),
      variance: computeVariance(trip)
    });
  } catch (error) {
    console.error('[trip-orders] profitability failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to compute profitability' });
  }
});

// ---------------------------------------------------------------------------
// Dispatch checklist, start and end
// ---------------------------------------------------------------------------

// PUT /api/trip-orders/:id/checklist — save the pre-departure checks and report
// what is still outstanding, so the UI can enable Dispatch without guessing.
router.put('/:id/checklist', protect, requirePermission('trips', 'update'), async (req, res) => {
  try {
    const trip = await findTrip(req);
    if (!trip) return res.status(404).json({ success: false, error: 'Trip not found' });
    if (guardTerminal(trip, res)) return;

    trip.checklist = buildChecklist(req.body.checklist, trip.checklist, req.user?._id || null);
    await trip.save();

    const ticked = new Set(trip.checklist.filter((i) => i.checked).map((i) => i.key));
    const missing = MANDATORY_CHECKLIST_KEYS.filter((k) => !ticked.has(k));

    await recordAudit(req, {
      entity: 'trip_order',
      entityId: trip._id,
      action: 'update',
      label: tripLabel(trip),
      summary: `Dispatch checklist updated on trip ${trip.tripNumber} (${ticked.size} of ${trip.checklist.length} checked)`,
      changes: [{ field: 'checklist', label: 'Dispatch Checklist', from: null, to: `${ticked.size} checked` }]
    });

    res.json({
      success: true,
      checklist: trip.checklist,
      missingMandatory: missing,
      readyToDispatch: missing.length === 0 && Boolean(trip.truck) && Boolean(trip.driver)
    });
  } catch (error) {
    console.error('[trip-orders] checklist update failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to update the checklist' });
  }
});

// POST /api/trip-orders/:id/start — the vehicle leaves.
//
// Captures the starting odometer and fuel, moves the trip to In Transit, and
// stamps the linked GPS record so its trail starts from this moment rather than
// from whatever the tracker was doing beforehand.
router.post('/:id/start', protect, requirePermission('trips', 'update'), async (req, res) => {
  try {
    const trip = await findTrip(req);
    if (!trip) return res.status(404).json({ success: false, error: 'Trip not found' });
    if (guardTerminal(trip, res)) return;

    if (!trip.truck || !trip.driver) {
      return res.status(409).json({
        success: false,
        error: 'A trip needs both a vehicle and a driver before it can start'
      });
    }

    const reading = cleanReading(req.body, req.user?._id || null);
    if (reading.odometer === null) {
      return res.status(400).json({ success: false, error: 'A starting odometer reading is required' });
    }

    const from = trip.status;
    trip.start = reading;

    // Starting from Ready goes through Dispatched, which is where the checklist
    // is enforced; from Dispatched it simply moves to In Transit. Either way the
    // trip cannot skip the checklist.
    if (from === 'ready') {
      const ticked = new Set(trip.checklist.filter((i) => i.checked).map((i) => i.key));
      const missing = MANDATORY_CHECKLIST_KEYS.filter((k) => !ticked.has(k));
      if (missing.length) {
        return res.status(409).json({
          success: false,
          error: 'The dispatch checklist is not complete',
          missingChecklistItems: missing
        });
      }
      trip.dispatchedAt = trip.dispatchedAt || new Date();
      trip.dispatchedBy = trip.dispatchedBy || req.user?._id || null;
      pushStatusChange(trip, { from, to: 'dispatched', req, lat: reading.lat, lng: reading.lng });
      trip.status = 'dispatched';
    }

    const refusal = canTransition(trip.status, 'in_transit');
    if (refusal) return res.status(409).json({ success: false, error: refusal });

    pushStatusChange(trip, {
      from: trip.status,
      to: 'in_transit',
      req,
      reason: 'Trip started',
      lat: reading.lat,
      lng: reading.lng
    });
    trip.status = 'in_transit';

    applyTotals(trip);
    await trip.save();
    await mirrorToRoute(trip);
    await syncResourceStatus(trip);

    await recordAudit(req, {
      entity: 'trip_order',
      entityId: trip._id,
      action: 'update',
      label: tripLabel(trip),
      summary: `Trip ${trip.tripNumber} started at ${reading.odometer} km`,
      changes: [
        { field: 'start.odometer', label: 'Starting Odometer', from: null, to: reading.odometer },
        { field: 'status', label: 'Status', from: TRIP_STATUS_LABELS[from], to: 'In Transit' }
      ]
    });

    res.json({ success: true, trip: await trip.populate(POPULATE) });
  } catch (error) {
    console.error('[trip-orders] start failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to start the trip' });
  }
});

// POST /api/trip-orders/:id/end — the vehicle arrives.
//
// The final odometer must not be below the starting one: that is either a typo
// or a reading from a different vehicle, and accepting it would produce a
// negative distance that then divides into every per-km figure on the trip.
router.post('/:id/end', protect, requirePermission('trips', 'update'), async (req, res) => {
  try {
    const trip = await findTrip(req);
    if (!trip) return res.status(404).json({ success: false, error: 'Trip not found' });
    if (guardTerminal(trip, res)) return;

    if (!trip.start?.at || trip.start?.odometer == null) {
      return res.status(409).json({
        success: false,
        error: 'This trip has not been started, so it cannot be ended'
      });
    }

    const reading = cleanReading(req.body, req.user?._id || null);
    if (reading.odometer === null) {
      return res.status(400).json({ success: false, error: 'A final odometer reading is required' });
    }

    if (reading.odometer < trip.start.odometer) {
      return res.status(400).json({
        success: false,
        error: `The final odometer (${reading.odometer} km) cannot be lower than the starting reading (${trip.start.odometer} km)`
      });
    }

    const from = trip.status;
    const refusal = canTransition(from, 'delivered');
    if (refusal) {
      return res.status(409).json({
        success: false,
        error: `${refusal}. Move the trip to Unloading before ending it.`
      });
    }

    trip.end = reading;
    pushStatusChange(trip, {
      from,
      to: 'delivered',
      req,
      reason: 'Trip ended',
      lat: reading.lat,
      lng: reading.lng
    });
    trip.status = 'delivered';

    // Recomputes actualKm and actualMinutes from the two readings.
    applyTotals(trip);
    await trip.save();
    await mirrorToRoute(trip);

    // The vehicle's own odometer moves forward to what the trip finished on, so
    // the master reflects reality without a separate edit. Never backwards: a
    // later trip may already have pushed it further.
    try {
      await Truck.updateOne(
        { _id: trip.truck, owner: req.accountId, odometer: { $lt: reading.odometer } },
        { $set: { odometer: reading.odometer } }
      );
    } catch (err) {
      console.error('[trip-orders] odometer sync failed:', err.message);
    }

    await recordAudit(req, {
      entity: 'trip_order',
      entityId: trip._id,
      action: 'update',
      label: tripLabel(trip),
      summary: `Trip ${trip.tripNumber} ended at ${reading.odometer} km (${trip.actualKm} km driven)`,
      changes: [
        { field: 'end.odometer', label: 'Final Odometer', from: null, to: reading.odometer },
        { field: 'actualKm', label: 'Actual KM', from: null, to: trip.actualKm },
        { field: 'status', label: 'Status', from: TRIP_STATUS_LABELS[from], to: 'Delivered' }
      ]
    });

    res.json({
      success: true,
      trip: await trip.populate(POPULATE),
      profitability: computeProfitability(trip.toObject()),
      variance: computeVariance(trip.toObject())
    });
  } catch (error) {
    console.error('[trip-orders] end failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to end the trip' });
  }
});

// ---------------------------------------------------------------------------
// Proof of delivery, documents, events
// ---------------------------------------------------------------------------

// PUT /api/trip-orders/:id/pod — the trip-level proof of delivery.
router.put('/:id/pod', protect, requirePermission('trips', 'update'), async (req, res) => {
  try {
    const trip = await findTrip(req);
    if (!trip) return res.status(404).json({ success: false, error: 'Trip not found' });

    const pod = cleanPod(req.body, req.user?._id || null);

    const signatureError = validateDataUrl(pod.signature, {
      max: MAX_SIGNATURE_CHARS,
      label: 'signature'
    });
    if (signatureError) return res.status(400).json({ success: false, error: signatureError });

    const photoError = validateDataUrl(pod.photo, { label: 'photo' });
    if (photoError) return res.status(400).json({ success: false, error: photoError });

    // A shortage or damage larger than what was carried is a data-entry error,
    // and it would misstate what the customer is owed.
    const totalQuantity = trip.cargo.reduce((sum, c) => sum + (Number(c.quantity) || 0), 0);
    if (totalQuantity > 0 && pod.deliveredQuantity !== null && pod.deliveredQuantity > totalQuantity) {
      return res.status(400).json({
        success: false,
        error: `The delivered quantity (${pod.deliveredQuantity}) is more than the cargo loaded (${totalQuantity})`
      });
    }

    trip.pod = pod;
    await trip.save();

    await recordAudit(req, {
      entity: 'trip_order',
      entityId: trip._id,
      action: 'update',
      label: tripLabel(trip),
      summary: `POD captured on trip ${trip.tripNumber}${pod.receiverName ? ` by ${pod.receiverName}` : ''}`,
      changes: [
        { field: 'pod', label: 'Proof of Delivery', from: null, to: pod.receiverName || 'Captured' },
        ...(pod.shortage ? [{ field: 'shortage', label: 'Shortage', from: null, to: pod.shortage }] : []),
        ...(pod.damage ? [{ field: 'damage', label: 'Damage', from: null, to: pod.damage }] : [])
      ]
    });

    res.json({ success: true, pod: trip.pod });
  } catch (error) {
    console.error('[trip-orders] POD failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to save the proof of delivery' });
  }
});

// GET /api/trip-orders/:id/pod/media — the signature and photo behind the
// trip-level POD, fetched only when the POD is opened. `stopId` in the query
// returns one stop's POD media instead.
router.get('/:id/pod/media', protect, requirePermission('trips', 'read'), async (req, res) => {
  try {
    const trip = await findTrip(req).select('pod stops');
    if (!trip) return res.status(404).json({ success: false, error: 'Trip not found' });

    const source = req.query.stopId ? trip.stops.id(req.query.stopId)?.pod : trip.pod;
    if (!source) return res.status(404).json({ success: false, error: 'No proof of delivery found' });

    res.json({
      success: true,
      signature: source.signature || '',
      photo: source.photo || ''
    });
  } catch (error) {
    console.error('[trip-orders] POD media failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to load the proof of delivery' });
  }
});

// POST /api/trip-orders/:id/documents — attach a file to the trip.
router.post('/:id/documents', protect, requirePermission('trips', 'update'), async (req, res) => {
  try {
    const trip = await findTrip(req);
    if (!trip) return res.status(404).json({ success: false, error: 'Trip not found' });

    const doc = cleanDocument(req.body, req.user?._id || null);
    if (!doc) return res.status(400).json({ success: false, error: 'A file is required' });

    const fileError = validateDataUrl(doc.dataUrl, { label: 'document' });
    if (fileError) return res.status(400).json({ success: false, error: fileError });

    trip.documents.push(doc);
    await trip.save();

    await recordAudit(req, {
      entity: 'trip_order',
      entityId: trip._id,
      action: 'update',
      label: tripLabel(trip),
      summary: `${TRIP_DOCUMENT_TYPE_LABELS[doc.docType]} attached to trip ${trip.tripNumber}`,
      changes: [{ field: 'file', label: 'Attached File', from: null, to: doc.filename || doc.title }]
    });

    res.status(201).json({ success: true, documents: listDocuments(trip.documents) });
  } catch (error) {
    console.error('[trip-orders] document upload failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to attach the document' });
  }
});

// GET /api/trip-orders/:id/documents — the file list, without the files. Same
// pattern as the vehicle and driver documents.
router.get('/:id/documents', protect, requirePermission('trips', 'read'), async (req, res) => {
  try {
    const trip = await findTrip(req).select('documents');
    if (!trip) return res.status(404).json({ success: false, error: 'Trip not found' });
    res.json({ success: true, documents: listDocuments(trip.documents) });
  } catch (error) {
    console.error('[trip-orders] document list failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to load the documents' });
  }
});

// GET /api/trip-orders/:id/documents/:docId — one file, when it is opened.
router.get('/:id/documents/:docId', protect, requirePermission('trips', 'read'), async (req, res) => {
  try {
    const trip = await findTrip(req).select('documents');
    if (!trip) return res.status(404).json({ success: false, error: 'Trip not found' });

    const doc = trip.documents.id(req.params.docId);
    if (!doc) return res.status(404).json({ success: false, error: 'Document not found' });

    res.json({ success: true, document: doc });
  } catch (error) {
    console.error('[trip-orders] document fetch failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to load the document' });
  }
});

// DELETE /api/trip-orders/:id/documents/:docId
router.delete('/:id/documents/:docId', protect, requirePermission('trips', 'update'), async (req, res) => {
  try {
    const trip = await findTrip(req);
    if (!trip) return res.status(404).json({ success: false, error: 'Trip not found' });

    const doc = trip.documents.id(req.params.docId);
    if (!doc) return res.status(404).json({ success: false, error: 'Document not found' });

    const removed = doc.filename || doc.title || TRIP_DOCUMENT_TYPE_LABELS[doc.docType];
    doc.deleteOne();
    await trip.save();

    await recordAudit(req, {
      entity: 'trip_order',
      entityId: trip._id,
      action: 'update',
      label: tripLabel(trip),
      summary: `Document removed from trip ${trip.tripNumber}`,
      changes: [{ field: 'file', label: 'Attached File', from: removed, to: null }]
    });

    res.json({ success: true, documents: listDocuments(trip.documents) });
  } catch (error) {
    console.error('[trip-orders] document delete failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to remove the document' });
  }
});

// POST /api/trip-orders/:id/events — record something by hand. System events
// are written by the handlers above; this is the operator noting a breakdown, a
// police check, a customer call.
router.post('/:id/events', protect, requirePermission('trips', 'update'), async (req, res) => {
  try {
    const trip = await findTrip(req);
    if (!trip) return res.status(404).json({ success: false, error: 'Trip not found' });

    const eventType = EVENT_TYPES.includes(req.body.eventType) ? req.body.eventType : 'manual';
    const severity = EVENT_SEVERITIES.includes(req.body.severity) ? req.body.severity : 'info';
    const message = String(req.body.message || '').trim();

    if (!message) return res.status(400).json({ success: false, error: 'An event needs a description' });

    const lat = Number(req.body.lat);
    const lng = Number(req.body.lng);

    trip.events.push({
      eventType,
      severity,
      message,
      occurredAt: req.body.occurredAt ? new Date(req.body.occurredAt) : new Date(),
      lat: Number.isFinite(lat) ? lat : null,
      lng: Number.isFinite(lng) ? lng : null,
      // Always 'manual' regardless of what the client claims: a hand-typed note
      // must never be presentable as a system observation.
      source: 'manual',
      createdBy: req.user?._id || null
    });

    await trip.save();

    res.status(201).json({ success: true, events: trip.events });
  } catch (error) {
    console.error('[trip-orders] event add failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to record the event' });
  }
});

// GET /api/trip-orders/:id/timeline — everything that happened on this trip, in
// one ordered list: status changes, events, stop arrivals and the POD. The
// detail page's Activity tab renders this directly rather than merging four
// arrays in the browser.
router.get('/:id/timeline', protect, requirePermission('trips', 'read'), async (req, res) => {
  try {
    const trip = await findTrip(req)
      .select('tripNumber statusHistory events stops pod start end dispatchedAt')
      .lean();
    if (!trip) return res.status(404).json({ success: false, error: 'Trip not found' });

    const entries = [];

    for (const h of trip.statusHistory || []) {
      entries.push({
        kind: 'status',
        at: h.at,
        title: h.from
          ? `${TRIP_STATUS_LABELS[h.from]} → ${TRIP_STATUS_LABELS[h.to]}`
          : `Trip created as ${TRIP_STATUS_LABELS[h.to]}`,
        detail: h.reason || '',
        by: h.byName || '',
        lat: h.lat,
        lng: h.lng
      });
    }

    for (const e of trip.events || []) {
      // Status-change events are already represented by the history above;
      // including both would show every transition twice.
      if (e.eventType === 'status_change') continue;
      entries.push({
        kind: 'event',
        at: e.occurredAt,
        title: EVENT_TYPE_LABELS[e.eventType] || e.eventType,
        detail: e.message,
        severity: e.severity,
        source: e.source,
        lat: e.lat,
        lng: e.lng
      });
    }

    for (const s of trip.stops || []) {
      if (s.arrivedAt) {
        entries.push({
          kind: 'stop',
          at: s.arrivedAt,
          title: `Arrived at stop ${s.sequence}${s.location?.name ? ` — ${s.location.name}` : ''}`,
          detail: STOP_TYPE_LABELS[s.stopType] || ''
        });
      }
      if (s.departedAt) {
        entries.push({
          kind: 'stop',
          at: s.departedAt,
          title: `Departed stop ${s.sequence}${s.location?.name ? ` — ${s.location.name}` : ''}`,
          detail: ''
        });
      }
    }

    if (trip.pod?.capturedAt) {
      entries.push({
        kind: 'pod',
        at: trip.pod.capturedAt,
        title: 'Proof of delivery captured',
        detail: trip.pod.receiverName ? `Received by ${trip.pod.receiverName}` : ''
      });
    }

    entries.sort((a, b) => new Date(a.at) - new Date(b.at));

    res.json({ success: true, timeline: entries });
  } catch (error) {
    console.error('[trip-orders] timeline failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to load the timeline' });
  }
});

// GET /api/trip-orders/:id/tracking — where the vehicle is and how it is doing
// against the plan.
//
// When the trip has no linked GPS record, or its vehicle has no tracker, this
// says so explicitly rather than returning an empty position that the UI would
// have to guess the meaning of. Nothing here is ever synthesised: no invented
// ETA, no interpolated position.
router.get('/:id/tracking', protect, requirePermission('trips', 'read'), async (req, res) => {
  try {
    const trip = await findTrip(req)
      .select('route truck status destinationExpectedAt plannedKm actualKm plannedMinutes actualMinutes start end')
      .populate('truck', 'number device')
      .lean();
    if (!trip) return res.status(404).json({ success: false, error: 'Trip not found' });

    if (!trip.truck?.device) {
      return res.json({
        success: true,
        available: false,
        reason: trip.truck
          ? 'No GPS device is fitted to this vehicle'
          : 'No vehicle is assigned to this trip',
        variance: computeVariance(trip)
      });
    }

    if (!trip.route) {
      return res.json({
        success: true,
        available: false,
        reason: 'No route is being tracked for this trip',
        deviceId: trip.truck.device,
        variance: computeVariance(trip)
      });
    }

    // The trail itself is served by the existing /api/trips/:id/trail endpoint,
    // which already handles windowing, thinning and stop detection. Pointing at
    // it rather than duplicating it keeps one implementation of that logic.
    res.json({
      success: true,
      available: true,
      routeId: trip.route,
      deviceId: trip.truck.device,
      trailEndpoint: `/api/trips/${trip.route}/trail`,
      variance: computeVariance(trip),
      // The planned arrival, stated as what it is. A real ETA needs a live
      // routing call against the current position, which this deployment does
      // not have — reporting the plan as though it were a prediction would be
      // inventing information.
      eta: {
        plannedArrival: trip.destinationExpectedAt || null,
        estimatedArrival: null,
        source: 'planned',
        note: 'Live ETA requires a tracking integration that is not configured'
      }
    });
  } catch (error) {
    console.error('[trip-orders] tracking failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to load tracking' });
  }
});

export default router;
