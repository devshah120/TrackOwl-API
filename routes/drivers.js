import express from 'express';
import Driver, { DRIVER_STATUSES } from '../models/Driver.js';
import Truck from '../models/Truck.js';
import DriverDocument from '../models/DriverDocument.js';
import TripOrder from '../models/TripOrder.js';
import { computeDriverAccount } from '../services/tripSettlement.js';
import DriverIncident, { INCIDENT_TYPES, INCIDENT_TYPE_LABELS, INCIDENT_SEVERITIES } from '../models/DriverIncident.js';
import { validateDataUrl } from '../utils/tripOrderFields.js';
import { protect, requirePermission } from '../middleware/auth.js';
import { normaliseDriver } from '../utils/drivers.js';
import { auditCreate, auditUpdate, auditDelete, recordAudit } from '../utils/audit.js';

const router = express.Router();

const ownedBy = (req) => ({ owner: req.accountId });

// Confirms a truck belongs to the caller before a driver is pinned to it, so a
// client cannot attach drivers to someone else's truck by guessing an id.
const resolveTruck = async (req, truckId) => {
  if (!truckId) return null;
  return Truck.findOne({ _id: truckId, ...ownedBy(req) });
};

// Keeps the "one primary per truck" rule when a driver is flagged primary:
// demotes whichever sibling held it before.
const demoteSiblings = async (truckId, ownerId, exceptId) => {
  if (!truckId) return;
  await Driver.updateMany(
    { truck: truckId, owner: ownerId, _id: { $ne: exceptId } },
    { $set: { isPrimary: false } }
  );
};

// GET /api/drivers/options — the driver master vocabulary, so the driver form
// and status filter are populated from the same list the model validates on.
router.get('/options', protect, requirePermission('drivers', 'read'), (req, res) => {
  res.json({ success: true, options: { statuses: DRIVER_STATUSES } });
});

// GET /api/drivers — the caller's drivers. `?truck=<id>` narrows to one truck;
// `?unassigned=1` returns those not on any truck; `?status=` filters the roster.
router.get('/', protect, requirePermission('drivers', 'read'), async (req, res) => {
  try {
    const query = ownedBy(req);
    if (req.query.truck) query.truck = req.query.truck;
    if (req.query.unassigned === '1') query.truck = null;
    if (req.query.status && DRIVER_STATUSES.includes(req.query.status)) {
      query.status = req.query.status;
    }

    const drivers = await Driver.find(query)
      .populate('truck', 'number model')
      .sort({ isPrimary: -1, createdAt: 1 });

    res.json({ success: true, drivers });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to fetch drivers' });
  }
});

// GET /api/drivers/summary — the roster with trip, distance and money totals
// per driver, for the Drivers list's columns (trips, km, pending payment).
// Computed across every non-draft trip, with the same driver account
// arithmetic the trip settlement uses, so the two always agree.
router.get('/summary', protect, requirePermission('drivers', 'read'), async (req, res) => {
  try {
    const trips = await TripOrder.find({ owner: req.accountId, driver: { $ne: null }, status: { $ne: 'draft' } })
      .select('driver driverName status actualKm expenses.category expenses.amount expenses.paidBy driverMoney.kind driverMoney.amount')
      .lean();

    const byDriver = {};
    for (const trip of trips) {
      const key = String(trip.driver);
      const row = (byDriver[key] ||= { trips: 0, completedTrips: 0, km: 0, advances: 0, allowance: 0, pendingBalance: 0 });
      row.trips += 1;
      if (['completed', 'pending_settlement', 'closed'].includes(trip.status)) row.completedTrips += 1;
      row.km += Number(trip.actualKm) || 0;
      const account = computeDriverAccount(trip);
      row.advances += account.advances;
      row.allowance += account.allowance;
      row.pendingBalance += account.balance;
    }
    for (const row of Object.values(byDriver)) {
      row.km = Math.round(row.km);
      row.pendingBalance = Math.round(row.pendingBalance * 100) / 100;
    }

    res.json({ success: true, summary: byDriver });
  } catch (error) {
    console.error('[drivers] summary failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to build the driver summary' });
  }
});

// GET /api/drivers/:id/profile — one driver's complete history: trips,
// distance, allowances, advances, the running balance, and documents.
router.get('/:id/profile', protect, requirePermission('drivers', 'read'), async (req, res) => {
  try {
    const driver = await Driver.findOne({ _id: req.params.id, ...ownedBy(req) }).populate('truck', 'number model').lean();
    if (!driver) return res.status(404).json({ success: false, error: 'Driver not found' });

    const [trips, documents, incidents] = await Promise.all([
      TripOrder.find({ owner: req.accountId, driver: driver._id, status: { $ne: 'draft' } })
        .sort({ tripDate: -1 })
        .select('tripNumber tripDate status vehicleNumber driverName actualKm pickup.city destination.city totals expenses.category expenses.amount expenses.paidBy driverMoney events.eventType events.severity')
        .lean(),
      DriverDocument.find({ owner: req.accountId, driver: driver._id }).select('-attachment').sort({ expiryDate: 1 }).lean(),
      DriverIncident.find({ owner: req.accountId, driver: driver._id }).select('-attachment.dataUrl').sort({ occurredAt: -1 }).populate('truck', 'number').populate('tripOrder', 'tripNumber').lean()
    ]);

    let km = 0;
    let pendingBalance = 0;
    let advances = 0;
    let allowance = 0;
    const tripRows = trips.map((trip) => {
      const account = computeDriverAccount(trip);
      km += Number(trip.actualKm) || 0;
      pendingBalance += account.balance;
      advances += account.advances;
      allowance += account.allowance;
      return {
        _id: trip._id,
        tripNumber: trip.tripNumber,
        tripDate: trip.tripDate,
        status: trip.status,
        vehicleNumber: trip.vehicleNumber,
        route: `${trip.pickup?.city || '—'} → ${trip.destination?.city || '—'}`,
        actualKm: trip.actualKm ?? null,
        allowance: account.allowance,
        advances: account.advances,
        balance: account.balance,
        // Incidents the GPS engine or the office logged on the trip.
        incidents: (trip.events || []).filter((e) => ['overspeed', 'idle', 'route_deviation', 'unexpected_stop'].includes(e.eventType)).length
      };
    });

    const payments = trips
      .flatMap((trip) => (trip.driverMoney || []).map((m) => ({ ...m, tripId: trip._id, tripNumber: trip.tripNumber })))
      .sort((a, b) => new Date(b.paidAt) - new Date(a.paidAt));

    const round = (n) => Math.round(n * 100) / 100;

    // Month by month for the last six months: trips, distance, GPS-detected
    // events and recorded incidents — the driver's performance history.
    const monthKey = (d) => {
      const x = new Date(d);
      return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}`;
    };
    const months = [];
    const now = new Date();
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      months.push({ month: monthKey(d), label: d.toLocaleString('en-IN', { month: 'short', year: '2-digit' }), trips: 0, km: 0, gpsEvents: 0, incidents: 0 });
    }
    const byMonth = new Map(months.map((m) => [m.month, m]));
    for (const t of tripRows) {
      const m = byMonth.get(monthKey(t.tripDate));
      if (m) {
        m.trips += 1;
        m.km += Number(t.actualKm) || 0;
        m.gpsEvents += t.incidents;
      }
    }
    for (const inc of incidents) {
      const m = byMonth.get(monthKey(inc.occurredAt));
      if (m) m.incidents += 1;
    }
    for (const m of months) m.km = Math.round(m.km);
    const toRecover = round(incidents.reduce((s, i) => s + Math.max(0, (i.recoverableAmount || 0) - (i.recoveredAmount || 0)), 0));
    res.json({
      success: true,
      driver,
      totals: {
        trips: trips.length,
        km: Math.round(km),
        allowance: round(allowance),
        advances: round(advances),
        pendingBalance: round(pendingBalance),
        incidents: tripRows.reduce((s, t) => s + t.incidents, 0),
        recordedIncidents: incidents.length,
        openIncidents: incidents.filter((i) => i.status === 'open').length,
        toRecover
      },
      performance: months,
      incidents,
      incidentTypes: INCIDENT_TYPES.map((value) => ({ value, label: INCIDENT_TYPE_LABELS[value] })),
      trips: tripRows,
      payments,
      documents
    });
  } catch (error) {
    console.error('[drivers] profile failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to load the driver profile' });
  }
});

// ---------------------------------------------------------------------------
// Incidents & violations (brief §6)
// ---------------------------------------------------------------------------

const money = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : 0;
};

const buildIncident = (body = {}) => {
  if (!INCIDENT_TYPES.includes(body.type)) return { error: 'Choose what kind of incident this is' };
  const occurredAt = body.occurredAt ? new Date(body.occurredAt) : new Date();
  if (Number.isNaN(occurredAt.getTime())) return { error: 'Invalid date' };
  const fineAmount = money(body.fineAmount);
  const recoverableAmount = money(body.recoverableAmount);
  if (recoverableAmount > fineAmount && fineAmount > 0) return { error: 'The amount to recover from the driver cannot be more than the fine' };
  const fields = {
    type: body.type,
    severity: INCIDENT_SEVERITIES.includes(body.severity) ? body.severity : 'minor',
    occurredAt,
    location: String(body.location || '').trim(),
    description: String(body.description || '').trim(),
    reference: String(body.reference || '').trim(),
    fineAmount,
    recoverableAmount,
    recoveredAmount: Math.min(money(body.recoveredAmount), recoverableAmount),
    status: body.status === 'resolved' ? 'resolved' : 'open',
    resolution: String(body.resolution || '').trim(),
    truck: body.truck || null,
    tripOrder: body.tripOrder || null
  };
  if (body.attachment?.dataUrl) {
    const problem = validateDataUrl(body.attachment.dataUrl, { label: 'document' });
    if (problem) return { error: problem };
    fields.attachment = { dataUrl: String(body.attachment.dataUrl), filename: String(body.attachment.filename || ''), mimeType: String(body.attachment.mimeType || '') };
  }
  return { fields };
};

router.get('/:id/incidents', protect, requirePermission('drivers', 'read'), async (req, res) => {
  try {
    const incidents = await DriverIncident.find({ owner: req.accountId, driver: req.params.id })
      .select('-attachment.dataUrl')
      .sort({ occurredAt: -1 })
      .populate('truck', 'number')
      .populate('tripOrder', 'tripNumber')
      .lean();
    res.json({ success: true, incidents, types: INCIDENT_TYPES.map((value) => ({ value, label: INCIDENT_TYPE_LABELS[value] })) });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to load incidents' });
  }
});

router.post('/:id/incidents', protect, requirePermission('drivers', 'update'), async (req, res) => {
  try {
    const driver = await Driver.findOne({ _id: req.params.id, ...ownedBy(req) }).select('name truck').lean();
    if (!driver) return res.status(404).json({ success: false, error: 'Driver not found' });
    const { fields, error } = buildIncident(req.body);
    if (error) return res.status(400).json({ success: false, error });
    const incident = await DriverIncident.create({ ...fields, truck: fields.truck || driver.truck || null, owner: req.accountId, driver: driver._id, createdBy: req.user._id });
    await recordAudit(req, {
      entity: 'driver',
      entityId: driver._id,
      action: 'update',
      label: driver.name,
      summary: `${INCIDENT_TYPE_LABELS[incident.type]} recorded against ${driver.name}${incident.fineAmount ? ` (fine ₹${incident.fineAmount})` : ''}`,
      changes: [{ field: 'incidents', label: 'Incident', from: null, to: INCIDENT_TYPE_LABELS[incident.type] }]
    });
    res.status(201).json({ success: true, incident });
  } catch (error) {
    if (error.name === 'ValidationError' || error.name === 'CastError') return res.status(400).json({ success: false, error: error.message });
    res.status(500).json({ success: false, error: 'Failed to record the incident' });
  }
});

router.put('/:id/incidents/:incidentId', protect, requirePermission('drivers', 'update'), async (req, res) => {
  try {
    const before = await DriverIncident.findOne({ _id: req.params.incidentId, owner: req.accountId, driver: req.params.id }).lean();
    if (!before) return res.status(404).json({ success: false, error: 'Incident not found' });
    const { fields, error } = buildIncident({ ...before, ...req.body, attachment: req.body.attachment });
    if (error) return res.status(400).json({ success: false, error });
    const incident = await DriverIncident.findOneAndUpdate({ _id: before._id, owner: req.accountId }, { $set: fields }, { new: true }).select('-attachment.dataUrl');
    await recordAudit(req, {
      entity: 'driver',
      entityId: before.driver,
      action: 'update',
      label: INCIDENT_TYPE_LABELS[incident.type],
      summary: `Incident updated: ${INCIDENT_TYPE_LABELS[incident.type]} (${incident.status})`,
      changes: [
        { field: 'incident.status', label: 'Status', from: before.status, to: incident.status },
        { field: 'incident.recoveredAmount', label: 'Recovered', from: before.recoveredAmount, to: incident.recoveredAmount }
      ].filter((c) => c.from !== c.to)
    });
    res.json({ success: true, incident });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to update the incident' });
  }
});

router.get('/:id/incidents/:incidentId/attachment', protect, requirePermission('drivers', 'read'), async (req, res) => {
  const inc = await DriverIncident.findOne({ _id: req.params.incidentId, owner: req.accountId, driver: req.params.id }).select('attachment').lean().catch(() => null);
  if (!inc?.attachment?.dataUrl) return res.status(404).json({ success: false, error: 'No document attached' });
  res.json({ success: true, attachment: inc.attachment });
});

router.delete('/:id/incidents/:incidentId', protect, requirePermission('drivers', 'delete'), async (req, res) => {
  try {
    const inc = await DriverIncident.findOneAndDelete({ _id: req.params.incidentId, owner: req.accountId, driver: req.params.id });
    if (!inc) return res.status(404).json({ success: false, error: 'Incident not found' });
    await recordAudit(req, {
      entity: 'driver',
      entityId: inc.driver,
      action: 'update',
      label: INCIDENT_TYPE_LABELS[inc.type],
      summary: `Incident removed: ${INCIDENT_TYPE_LABELS[inc.type]} of ${inc.occurredAt.toLocaleDateString('en-IN')}`,
      changes: [{ field: 'incidents', label: 'Incident', from: INCIDENT_TYPE_LABELS[inc.type], to: null }]
    });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to remove the incident' });
  }
});

// POST /api/drivers — add one driver, optionally assigned to a truck.
router.post('/', protect, requirePermission('drivers', 'create'), async (req, res) => {
  try {
    const fields = normaliseDriver(req.body || {});
    if (!fields || !fields.name || !fields.mobile) {
      return res.status(400).json({ success: false, error: 'Driver name and mobile are required' });
    }

    const truckId = req.body.truck || null;
    if (truckId && !(await resolveTruck(req, truckId))) {
      return res.status(404).json({ success: false, error: 'Truck not found' });
    }

    // First driver on a truck becomes its primary automatically.
    if (truckId && !fields.isPrimary) {
      const existing = await Driver.countDocuments({ truck: truckId, ...ownedBy(req) });
      if (existing === 0) fields.isPrimary = true;
    }

    const driver = await Driver.create({ ...fields, truck: truckId, owner: req.accountId });
    if (driver.isPrimary) await demoteSiblings(truckId, req.accountId, driver._id);

    await auditCreate(req, { entity: 'driver', doc: driver, label: driver.name });

    res.status(201).json({ success: true, driver });
  } catch (error) {
    if (error.name === 'ValidationError') {
      return res.status(400).json({ success: false, error: error.message });
    }
    console.error('[drivers] create failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to create driver' });
  }
});

// PUT /api/drivers/:id — update one of the caller's drivers.
router.put('/:id', protect, requirePermission('drivers', 'update'), async (req, res) => {
  try {
    const fields = normaliseDriver(req.body || {});
    if (!fields || !fields.name || !fields.mobile) {
      return res.status(400).json({ success: false, error: 'Driver name and mobile are required' });
    }

    // `truck` is only touched when the caller actually sent it, so a plain
    // detail edit does not silently unassign the driver.
    if (req.body.truck !== undefined) {
      const truckId = req.body.truck || null;
      if (truckId && !(await resolveTruck(req, truckId))) {
        return res.status(404).json({ success: false, error: 'Truck not found' });
      }
      fields.truck = truckId;
    }

    const before = await Driver.findOne({ _id: req.params.id, ...ownedBy(req) });
    if (!before) return res.status(404).json({ success: false, error: 'Driver not found' });

    const driver = await Driver.findOneAndUpdate(
      { _id: req.params.id, ...ownedBy(req) },
      { $set: fields },
      { new: true, runValidators: true }
    );
    if (!driver) return res.status(404).json({ success: false, error: 'Driver not found' });

    if (driver.isPrimary) await demoteSiblings(driver.truck, req.accountId, driver._id);

    await auditUpdate(req, { entity: 'driver', before, after: driver, fields, label: driver.name });

    res.json({ success: true, driver });
  } catch (error) {
    if (error.name === 'ValidationError') {
      return res.status(400).json({ success: false, error: error.message });
    }
    res.status(500).json({ success: false, error: 'Failed to update driver' });
  }
});

// DELETE /api/drivers/:id — remove a driver from the roster entirely.
router.delete('/:id', protect, requirePermission('drivers', 'delete'), async (req, res) => {
  try {
    const driver = await Driver.findOneAndDelete({ _id: req.params.id, ...ownedBy(req) });
    if (!driver) return res.status(404).json({ success: false, error: 'Driver not found' });

    // Their paperwork goes with them — a licence expiry for someone no longer
    // on the roster would keep raising alerts nobody can act on.
    await DriverDocument.deleteMany({ driver: driver._id, ...ownedBy(req) });

    // Removing the primary leaves the truck without one; promote the oldest
    // remaining driver so single-driver views keep showing something.
    if (driver.isPrimary && driver.truck) {
      const next = await Driver.findOne({ truck: driver.truck, ...ownedBy(req) }).sort({ createdAt: 1 });
      if (next) {
        next.isPrimary = true;
        await next.save();
      }
    }

    await auditDelete(req, { entity: 'driver', doc: driver, label: driver.name });

    res.json({ success: true, message: 'Driver removed' });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to delete driver' });
  }
});

export default router;
