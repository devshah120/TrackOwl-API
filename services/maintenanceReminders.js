import ServiceRecord from '../models/ServiceRecord.js';
import RepairRequest from '../models/RepairRequest.js';
import Tyre from '../models/Tyre.js';
import Battery from '../models/Battery.js';
import Truck from '../models/Truck.js';
import { settingsFor } from '../models/MaintenanceSetting.js';
import {
  assessDue,
  daysUntil,
  ACTIVE_REPAIR_STATUSES,
  OPEN_REPAIR_STATUSES,
  ON_VEHICLE_TYRE_STATUSES,
  SERVICE_TYPE_LABELS
} from '../utils/maintenance.js';

// M3-M10 — what is due, overdue, or about to be.
//
// Reminders are computed on read rather than stored. A service due at 55,000 km
// becomes overdue the moment the vehicle crosses that reading, with nothing
// happening to the service record itself — so a stored "is overdue" flag would
// be wrong between the crossing and whatever job next rewrote it. Computing on
// read costs a handful of indexed queries and is always right.
//
// The four sources are deliberately assembled separately and merged at the end.
// A service, a tyre and a battery fall due for entirely different reasons, and
// a single clever query over all of them would be unreadable and no faster.

// The most recent service per vehicle and service type — the row that says when
// that particular clock next runs out.
//
// A vehicle has as many service clocks as it has service types it has had done:
// its oil change is due on a different schedule from its brake inspection, and
// collapsing them to one "last serviced" date would hide whichever falls due
// first.
const currentServiceRows = async (accountId, { truck = null } = {}) => {
  const match = { owner: accountId, supersededAt: null };
  if (truck) match.truck = truck;

  return ServiceRecord.find(match)
    .select('truck vehicleNumber serviceType servicedAt odometer nextServiceDate nextServiceKm workshop')
    .populate({ path: 'truck', select: 'number odometer status' })
    .sort({ servicedAt: -1 })
    .lean();
};

// Service reminders: every current service row that has a next-due clock on it,
// judged against today and against the vehicle's odometer as it reads now.
export const serviceReminders = async (accountId, { settings, truck = null } = {}) => {
  const config = settings || (await settingsFor(accountId));
  const rows = await currentServiceRows(accountId, { truck });

  const out = [];

  for (const row of rows) {
    // A record with neither clock set scheduled nothing, and is not a reminder.
    if (!row.nextServiceDate && !row.nextServiceKm) continue;

    const due = assessDue({
      dueDate: row.nextServiceDate,
      dueKm: row.nextServiceKm,
      currentOdometer: row.truck?.odometer ?? null,
      warnDays: config.serviceDueDays,
      warnKm: config.serviceDueKm
    });

    if (due.status === 'ok' || due.status === 'unknown') continue;

    // An overdue service past the grace period has been abandoned rather than
    // forgotten — the vehicle was almost certainly serviced without the record
    // being made. It stays on the record; it just stops occupying the tile.
    if (due.status === 'overdue' && due.days !== null && due.days < -config.overdueGraceDays) {
      continue;
    }

    out.push({
      kind: 'service',
      status: due.status,
      by: due.by,
      days: due.days,
      km: due.km,
      truck: row.truck?._id || row.truck,
      vehicleNumber: row.vehicleNumber || row.truck?.number || '',
      serviceType: row.serviceType,
      label: `${SERVICE_TYPE_LABELS[row.serviceType] || row.serviceType} — ${row.vehicleNumber || row.truck?.number || 'vehicle'}`,
      dueDate: row.nextServiceDate,
      dueKm: row.nextServiceKm,
      currentOdometer: row.truck?.odometer ?? null,
      lastServicedAt: row.servicedAt,
      lastOdometer: row.odometer,
      workshop: row.workshop?.name || '',
      sourceId: row._id
    });
  }

  return out;
};

// Tyre reminders: fitted tyres worn to or past the account's minimum tread.
//
// Only fitted tyres are reported. A worn tyre sitting in the store is not a
// reminder — nobody has to act on it today — and listing it would bury the ones
// actually on the road.
export const tyreReminders = async (accountId, { settings, truck = null } = {}) => {
  const config = settings || (await settingsFor(accountId));

  const match = {
    owner: accountId,
    status: { $in: ON_VEHICLE_TYRE_STATUSES },
    treadDepthMm: { $ne: null, $lte: config.tyreMinTreadMm }
  };
  if (truck) match.truck = truck;

  const rows = await Tyre.find(match)
    .select('tyreNumber brand size truck vehicleNumber position treadDepthMm treadCheckedAt runningKm costPerKm ratedKm')
    .sort({ treadDepthMm: 1 })
    .lean();

  return rows.map((row) => ({
    kind: 'tyre',
    // At or below the legal minimum the tyre is not "due", it is illegal to
    // run — so it is reported as overdue rather than upcoming.
    status: row.treadDepthMm <= 1.6 ? 'overdue' : 'due',
    by: 'tread',
    days: null,
    km: null,
    truck: row.truck,
    vehicleNumber: row.vehicleNumber,
    label: `Tyre ${row.tyreNumber} at ${row.position || 'position unknown'} — ${row.treadDepthMm}mm tread`,
    tyreNumber: row.tyreNumber,
    position: row.position,
    treadDepthMm: row.treadDepthMm,
    treadCheckedAt: row.treadCheckedAt,
    runningKm: row.runningKm,
    costPerKm: row.costPerKm,
    sourceId: row._id
  }));
};

// Battery reminders: fitted batteries that are old, failing, or whose warranty
// is about to lapse.
//
// The warranty case is the one worth surfacing early. A battery that dies
// inside its warranty is a claim; the same battery dying a week after it
// expires is a purchase, and the difference is only actionable if somebody
// knew the date was coming.
export const batteryReminders = async (accountId, { settings, truck = null } = {}) => {
  const config = settings || (await settingsFor(accountId));

  const match = { owner: accountId, status: 'Fitted' };
  if (truck) match.truck = truck;

  const rows = await Battery.find(match)
    .select('serialNumber brand truck vehicleNumber position purchaseDate installedAt warrantyExpiry expectedReplacementDate health lastVoltage lastCheckedAt cost')
    .lean();

  const out = [];
  const now = new Date();

  for (const row of rows) {
    // A battery the tester called Weak or Dead needs replacing whatever its age
    // says — the reading is evidence and the age is only an estimate.
    if (row.health === 'Dead' || row.health === 'Weak') {
      out.push({
        kind: 'battery',
        status: row.health === 'Dead' ? 'overdue' : 'due',
        by: 'health',
        days: null,
        km: null,
        truck: row.truck,
        vehicleNumber: row.vehicleNumber,
        label: `Battery ${row.serialNumber} — tested ${row.health.toLowerCase()}`,
        serialNumber: row.serialNumber,
        position: row.position,
        health: row.health,
        lastVoltage: row.lastVoltage,
        lastCheckedAt: row.lastCheckedAt,
        warrantyExpiry: row.warrantyExpiry,
        sourceId: row._id
      });
      continue;
    }

    // Age. The explicit replacement date wins where one was set; otherwise the
    // account's expected life is measured from the purchase.
    let dueDate = row.expectedReplacementDate || null;
    if (!dueDate && row.purchaseDate) {
      dueDate = new Date(row.purchaseDate);
      dueDate.setMonth(dueDate.getMonth() + config.batteryLifeMonths);
    }

    const ageDue = assessDue({
      dueDate,
      warnDays: config.serviceDueDays,
      now
    });

    // Warranty, judged on its own window: it is a different question from
    // whether the battery is worn out, and it has a different deadline.
    const warrantyDays = daysUntil(row.warrantyExpiry, now);
    const warrantyClosing =
      warrantyDays !== null && warrantyDays >= 0 && warrantyDays <= config.warrantyWarnDays;

    if (ageDue.status === 'overdue' || ageDue.status === 'due') {
      out.push({
        kind: 'battery',
        status: ageDue.status,
        by: 'age',
        days: ageDue.days,
        km: null,
        truck: row.truck,
        vehicleNumber: row.vehicleNumber,
        label: `Battery ${row.serialNumber} — ${ageDue.status === 'overdue' ? 'past' : 'nearing'} expected life`,
        serialNumber: row.serialNumber,
        position: row.position,
        health: row.health,
        dueDate,
        warrantyExpiry: row.warrantyExpiry,
        sourceId: row._id
      });
    } else if (warrantyClosing) {
      out.push({
        kind: 'battery',
        status: 'due',
        by: 'warranty',
        days: warrantyDays,
        km: null,
        truck: row.truck,
        vehicleNumber: row.vehicleNumber,
        label: `Battery ${row.serialNumber} — warranty ends in ${warrantyDays} ${warrantyDays === 1 ? 'day' : 'days'}`,
        serialNumber: row.serialNumber,
        position: row.position,
        health: row.health,
        warrantyExpiry: row.warrantyExpiry,
        sourceId: row._id
      });
    }
  }

  return out;
};

// Everything due, in one list, worst first.
//
// Sorted by urgency rather than by kind: whoever reads this needs to know what
// to deal with first, and an overdue brake service and an illegal tyre are the
// same job — get the vehicle in — regardless of which collection they came
// from.
export const allReminders = async (accountId, { truck = null } = {}) => {
  const settings = await settingsFor(accountId);

  const [services, tyres, batteries] = await Promise.all([
    serviceReminders(accountId, { settings, truck }),
    tyreReminders(accountId, { settings, truck }),
    batteryReminders(accountId, { settings, truck })
  ]);

  const rank = { overdue: 0, due: 1 };
  const items = [...services, ...tyres, ...batteries].sort((a, b) => {
    const byStatus = (rank[a.status] ?? 9) - (rank[b.status] ?? 9);
    if (byStatus !== 0) return byStatus;
    // Within a status, the nearest deadline first. Items with no day count —
    // a tyre judged on tread — sort after those that have one, since "how
    // urgent" is not answerable for them.
    const ad = a.days ?? Number.POSITIVE_INFINITY;
    const bd = b.days ?? Number.POSITIVE_INFINITY;
    return ad - bd;
  });

  return {
    items,
    counts: {
      total: items.length,
      overdue: items.filter((i) => i.status === 'overdue').length,
      due: items.filter((i) => i.status === 'due').length,
      service: services.length,
      tyre: tyres.length,
      battery: batteries.length
    },
    settings
  };
};

// M3-M01 — the maintenance dashboard.
//
// Upcoming and overdue service, vehicles under repair, maintenance cost, and
// tyre/battery status. Assembled from the reminders above plus a cost roll-up,
// in one call so the screen makes one request rather than six.
export const dashboard = async (accountId, { from = null, to = null } = {}) => {
  const settings = await settingsFor(accountId);

  // The cost window. Defaults to the last twelve months rather than all time:
  // "maintenance cost" on a dashboard means recent spend, and a figure
  // accumulated since the fleet was founded only ever grows.
  const costFrom = from || (() => {
    const d = new Date();
    d.setMonth(d.getMonth() - 12);
    return d;
  })();
  const costTo = to || new Date();

  const [reminders, repairRows, serviceCost, repairCost, tyreStats, batteryStats, fleetSize] =
    await Promise.all([
      allReminders(accountId),

      // Open repairs, with enough on each to render the board.
      RepairRequest.find({ owner: accountId, status: { $in: OPEN_REPAIR_STATUSES } })
        .select('requestNumber truck vehicleNumber issue status priority reportedAt estimatedCost totalCost')
        .populate({ path: 'truck', select: 'number status' })
        .sort({ priority: -1, reportedAt: 1 })
        .limit(50)
        .lean(),

      ServiceRecord.aggregate([
        { $match: { owner: accountId, servicedAt: { $gte: costFrom, $lte: costTo } } },
        { $group: { _id: null, total: { $sum: '$totalCost' }, count: { $sum: 1 } } }
      ]),

      // Only completed repairs are counted as spend. An open job's estimate is
      // not money that has left the account, and mixing the two would make the
      // cost figure move every time somebody typed a quote.
      RepairRequest.aggregate([
        {
          $match: {
            owner: accountId,
            status: 'Completed',
            completedAt: { $gte: costFrom, $lte: costTo }
          }
        },
        {
          $group: {
            _id: null,
            total: { $sum: '$totalCost' },
            count: { $sum: 1 },
            downtime: { $sum: '$downtimeHours' }
          }
        }
      ]),

      Tyre.aggregate([
        { $match: { owner: accountId } },
        { $group: { _id: '$status', count: { $sum: 1 }, value: { $sum: '$price' } } }
      ]),

      Battery.aggregate([
        { $match: { owner: accountId } },
        { $group: { _id: '$status', count: { $sum: 1 }, value: { $sum: '$cost' } } }
      ]),

      Truck.countDocuments({ owner: accountId, status: { $ne: 'Inactive' } })
    ]);

  const byStatus = (rows) =>
    rows.reduce((acc, row) => {
      acc[row._id] = { count: row.count, value: Math.round(row.value || 0) };
      return acc;
    }, {});

  // Vehicles under repair, counted as distinct vehicles rather than as jobs:
  // one truck with three open faults is one truck off the road, and the fleet
  // availability figure has to say so.
  const groundedVehicles = new Set(
    repairRows
      .filter((r) => ACTIVE_REPAIR_STATUSES.includes(r.status))
      .map((r) => String(r.truck?._id || r.truck))
  );

  const services = serviceCost[0] || { total: 0, count: 0 };
  const repairs = repairCost[0] || { total: 0, count: 0, downtime: 0 };

  return {
    period: { from: costFrom, to: costTo },
    settings,

    reminders: {
      counts: reminders.counts,
      // The dashboard shows the worst of them; the reminders screen has the
      // rest. Capped here rather than in the browser so the payload stays
      // small on a fleet with hundreds outstanding.
      items: reminders.items.slice(0, 12)
    },

    repairs: {
      open: repairRows.length,
      active: repairRows.filter((r) => ACTIVE_REPAIR_STATUSES.includes(r.status)).length,
      groundedVehicles: groundedVehicles.size,
      fleetSize,
      items: repairRows.slice(0, 12)
    },

    cost: {
      services: Math.round(services.total || 0),
      serviceCount: services.count || 0,
      repairs: Math.round(repairs.total || 0),
      repairCount: repairs.count || 0,
      total: Math.round((services.total || 0) + (repairs.total || 0)),
      downtimeHours: Math.round(repairs.downtime || 0)
    },

    tyres: byStatus(tyreStats),
    batteries: byStatus(batteryStats)
  };
};
