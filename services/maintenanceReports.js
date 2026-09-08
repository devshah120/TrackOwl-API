import mongoose from 'mongoose';
import ServiceRecord from '../models/ServiceRecord.js';
import RepairRequest from '../models/RepairRequest.js';
import Tyre from '../models/Tyre.js';
import Battery from '../models/Battery.js';
import { roundTo, computeCostPerKm } from '../utils/maintenance.js';

// M3-M11 — the maintenance reports: vehicle, service, repair, parts, tyres,
// battery, cost and vendor.
//
// Every one of these is a database aggregation rather than a load-and-reduce in
// Node, for the reason services/fuelReports.js gives: a fleet accumulates these
// rows steadily, and pulling a year of them into the API process to sum would
// get slower exactly as the reports became worth reading.
//
// The union problem
// -----------------
// Maintenance spend lives in two collections. A brake pad fitted during a
// scheduled service and one fitted during a breakdown repair are the same
// purchase from the fleet's point of view, and a parts report that only saw one
// of them would be wrong in a way nobody would notice.
//
// So the money reports run the same aggregation over both collections and merge
// the results by key. That is done here, in one place, rather than left to each
// caller — the alternative is six screens each merging slightly differently.

const oid = (v) => new mongoose.Types.ObjectId(v);

// The match stage for service records.
const serviceMatch = ({ accountId, from, to, truck, serviceType, workshop }) => {
  const match = { owner: oid(accountId) };

  if (from || to) {
    match.servicedAt = {};
    if (from) match.servicedAt.$gte = from;
    if (to) match.servicedAt.$lte = to;
  }

  if (truck) match.truck = oid(truck);
  if (serviceType) match.serviceType = serviceType;
  if (workshop) match['workshop.name'] = workshop;

  return match;
};

// The match stage for repair requests.
//
// Dated on completion rather than on report, because these are cost reports and
// the cost is only real once the job is done. A repair reported in March and
// finished in April is April's spend — which is also how the invoice will be
// dated.
const repairMatch = ({ accountId, from, to, truck, workshop, status }) => {
  const match = { owner: oid(accountId), status: status || 'Completed' };

  if (from || to) {
    match.completedAt = {};
    if (from) match.completedAt.$gte = from;
    if (to) match.completedAt.$lte = to;
  }

  if (truck) match.truck = oid(truck);
  if (workshop) match['workshop.name'] = workshop;

  return match;
};

// The accumulators shared by every money grouping, so a vehicle report and a
// vendor report cannot end up computing "total spend" differently.
const COST_ACCUMULATORS = {
  jobs: { $sum: 1 },
  partsTotal: { $sum: '$partsTotal' },
  labourCost: { $sum: '$labourCost' },
  taxAmount: { $sum: '$taxAmount' },
  discount: { $sum: '$discount' },
  totalCost: { $sum: '$totalCost' }
};

// An empty bucket, so a merge can add into a key it has not seen before without
// checking whether every field exists.
const emptyBucket = () => ({
  services: 0,
  repairs: 0,
  jobs: 0,
  partsTotal: 0,
  labourCost: 0,
  taxAmount: 0,
  discount: 0,
  totalCost: 0,
  downtimeHours: 0
});

// Folds one aggregation's rows into a keyed accumulator. `kind` says which
// collection they came from, so the row can report the split as well as the
// total — "we spent 4 lakh, three-quarters of it on unplanned repairs" is a
// more useful sentence than the total alone.
const foldInto = (target, rows, kind, { keyOf = (r) => String(r._id), metaOf = () => ({}) } = {}) => {
  for (const row of rows) {
    const key = keyOf(row);
    // A group whose key is null — a job with no vendor named — is skipped
    // rather than bucketed under "null", which would render as a blank row
    // nobody can act on. The account-level totals still include it.
    if (key === 'null' || key === 'undefined' || key === '') continue;

    const bucket = target.get(key) || { key, ...emptyBucket(), ...metaOf(row) };

    bucket[kind === 'service' ? 'services' : 'repairs'] += row.jobs || 0;
    bucket.jobs += row.jobs || 0;
    bucket.partsTotal += row.partsTotal || 0;
    bucket.labourCost += row.labourCost || 0;
    bucket.taxAmount += row.taxAmount || 0;
    bucket.discount += row.discount || 0;
    bucket.totalCost += row.totalCost || 0;
    bucket.downtimeHours += row.downtime || 0;

    // Metadata from whichever collection had it. A vehicle's number can come
    // from either, and the first one to supply a non-empty value wins.
    for (const [field, value] of Object.entries(metaOf(row))) {
      if (!bucket[field] && value) bucket[field] = value;
    }

    target.set(key, bucket);
  }
};

// Rounds a merged bucket's money once, at the end.
const finishBucket = (bucket) => ({
  ...bucket,
  partsTotal: roundTo(bucket.partsTotal),
  labourCost: roundTo(bucket.labourCost),
  taxAmount: roundTo(bucket.taxAmount),
  discount: roundTo(bucket.discount),
  totalCost: roundTo(bucket.totalCost),
  downtimeHours: roundTo(bucket.downtimeHours)
});

const sortByCost = (rows) => rows.sort((a, b) => b.totalCost - a.totalCost);

// --------------------------------------------------------------------------
// The account-level summary
// --------------------------------------------------------------------------

// The stat strip above the maintenance screens: what was spent, on what, and
// how much of it was unplanned.
export const summary = async (filters) => {
  const [services, repairs, openRepairs] = await Promise.all([
    ServiceRecord.aggregate([
      { $match: serviceMatch(filters) },
      { $group: { _id: null, ...COST_ACCUMULATORS } }
    ]),
    RepairRequest.aggregate([
      { $match: repairMatch(filters) },
      { $group: { _id: null, ...COST_ACCUMULATORS, downtime: { $sum: '$downtimeHours' } } }
    ]),
    RepairRequest.countDocuments({
      owner: oid(filters.accountId),
      status: { $nin: ['Completed', 'Cancelled'] }
    })
  ]);

  const s = services[0] || {};
  const r = repairs[0] || {};

  const serviceCost = roundTo(s.totalCost || 0);
  const repairCost = roundTo(r.totalCost || 0);
  const total = roundTo((s.totalCost || 0) + (r.totalCost || 0));

  return {
    totals: {
      services: s.jobs || 0,
      repairs: r.jobs || 0,
      openRepairs,
      serviceCost,
      repairCost,
      total,
      partsTotal: roundTo((s.partsTotal || 0) + (r.partsTotal || 0)),
      labourCost: roundTo((s.labourCost || 0) + (r.labourCost || 0)),
      downtimeHours: roundTo(r.downtime || 0),
      // What share of the spend was unplanned. The single most telling number
      // on the page: a fleet whose repair spend dwarfs its service spend is
      // one that is not servicing enough.
      unplannedShare: total > 0 ? roundTo((repairCost / total) * 100, 1) : null
    }
  };
};

// --------------------------------------------------------------------------
// Grouped cost reports
// --------------------------------------------------------------------------

// By vehicle. The report that answers "which truck is eating the money", and
// the one that carries a cost per kilometre where the odometer allows it.
export const byVehicle = async (filters) => {
  const [services, repairs, trucks] = await Promise.all([
    ServiceRecord.aggregate([
      { $match: serviceMatch(filters) },
      {
        $group: {
          _id: '$truck',
          ...COST_ACCUMULATORS,
          vehicleNumber: { $last: '$vehicleNumber' },
          lastServicedAt: { $max: '$servicedAt' },
          maxOdometer: { $max: '$odometer' },
          minOdometer: { $min: '$odometer' }
        }
      }
    ]),
    RepairRequest.aggregate([
      { $match: repairMatch(filters) },
      {
        $group: {
          _id: '$truck',
          ...COST_ACCUMULATORS,
          downtime: { $sum: '$downtimeHours' },
          vehicleNumber: { $last: '$vehicleNumber' },
          lastRepairedAt: { $max: '$completedAt' }
        }
      }
    ]),
    mongoose
      .model('Truck')
      .find({ owner: oid(filters.accountId) })
      .select('number model vehicleType odometer status')
      .lean()
  ]);

  const merged = new Map();

  foldInto(merged, services, 'service', {
    metaOf: (r) => ({
      vehicleNumber: r.vehicleNumber || '',
      lastServicedAt: r.lastServicedAt || null
    })
  });
  foldInto(merged, repairs, 'repair', {
    metaOf: (r) => ({
      vehicleNumber: r.vehicleNumber || '',
      lastRepairedAt: r.lastRepairedAt || null
    })
  });

  const byId = new Map(trucks.map((t) => [String(t._id), t]));

  return sortByCost(
    [...merged.values()].map((bucket) => {
      const truck = byId.get(bucket.key);
      const finished = finishBucket(bucket);

      // Cost per kilometre needs a distance the vehicle actually covered in the
      // window. The service records' own odometer spread is the only distance
      // this report knows about — a vehicle serviced once has none, and
      // reports null rather than dividing by a guess.
      const spread =
        Number.isFinite(bucket.maxOdometer) && Number.isFinite(bucket.minOdometer)
          ? bucket.maxOdometer - bucket.minOdometer
          : null;

      return {
        ...finished,
        truck: bucket.key,
        vehicleNumber: finished.vehicleNumber || truck?.number || '',
        model: truck?.model || '',
        vehicleType: truck?.vehicleType || '',
        status: truck?.status || '',
        odometer: truck?.odometer ?? null,
        distanceKm: spread && spread > 0 ? roundTo(spread, 0) : null,
        costPerKm: computeCostPerKm(finished.totalCost, spread)
      };
    })
  );
};

// By service type (M3-M03). What the fleet spends on oil changes versus
// brakes versus engines.
export const byServiceType = async (filters) => {
  const rows = await ServiceRecord.aggregate([
    { $match: serviceMatch(filters) },
    {
      $group: {
        _id: '$serviceType',
        ...COST_ACCUMULATORS,
        vehicles: { $addToSet: '$truck' },
        lastAt: { $max: '$servicedAt' }
      }
    },
    { $sort: { totalCost: -1 } }
  ]);

  return rows.map((row) => ({
    key: row._id,
    serviceType: row._id,
    jobs: row.jobs,
    vehicles: (row.vehicles || []).length,
    partsTotal: roundTo(row.partsTotal),
    labourCost: roundTo(row.labourCost),
    totalCost: roundTo(row.totalCost),
    // What one job of this type typically costs — the figure that makes a
    // quote checkable.
    avgCost: row.jobs > 0 ? roundTo(row.totalCost / row.jobs) : null,
    lastAt: row.lastAt
  }));
};

// By vendor / workshop. Who the fleet is paying, and — via the estimate
// variance on the repair side — who quotes low and bills high.
export const byVendor = async (filters) => {
  const [services, repairs] = await Promise.all([
    ServiceRecord.aggregate([
      { $match: serviceMatch(filters) },
      {
        $group: {
          _id: '$workshop.name',
          ...COST_ACCUMULATORS,
          type: { $last: '$workshop.type' },
          city: { $last: '$workshop.city' },
          lastAt: { $max: '$servicedAt' }
        }
      }
    ]),
    RepairRequest.aggregate([
      { $match: repairMatch(filters) },
      {
        $group: {
          _id: '$workshop.name',
          ...COST_ACCUMULATORS,
          downtime: { $sum: '$downtimeHours' },
          type: { $last: '$workshop.type' },
          city: { $last: '$workshop.city' },
          lastAt: { $max: '$completedAt' },
          // Only jobs that carried an estimate can be compared against one.
          estimated: {
            $sum: { $cond: [{ $gt: ['$estimatedCost', 0] }, '$estimatedCost', 0] }
          },
          estimatedActual: {
            $sum: { $cond: [{ $gt: ['$estimatedCost', 0] }, '$totalCost', 0] }
          }
        }
      }
    ])
  ]);

  const merged = new Map();
  foldInto(merged, services, 'service', {
    metaOf: (r) => ({ type: r.type || '', city: r.city || '', lastAt: r.lastAt || null })
  });
  foldInto(merged, repairs, 'repair', {
    metaOf: (r) => ({ type: r.type || '', city: r.city || '', lastAt: r.lastAt || null })
  });

  // The estimate comparison only exists on the repair side, so it is folded in
  // separately rather than forced into the shared accumulator.
  for (const row of repairs) {
    const key = String(row._id);
    const bucket = merged.get(key);
    if (!bucket || !row.estimated) continue;
    bucket.estimated = roundTo(row.estimated);
    bucket.estimatedActual = roundTo(row.estimatedActual);
    bucket.estimateVariancePct = roundTo(
      ((row.estimatedActual - row.estimated) / row.estimated) * 100,
      1
    );
  }

  return sortByCost([...merged.values()].map(finishBucket)).map((row) => ({
    ...row,
    vendor: row.key
  }));
};

// By part (M3-M11's "parts"). Unwinds the line items from both collections, so
// "what do we spend on brake pads" has one answer.
export const byPart = async (filters) => {
  const pipeline = (match, dateField) => [
    { $match: match },
    { $unwind: '$parts' },
    {
      $group: {
        // Grouped on the name rather than the part number: plenty of lines are
        // typed with no number at all, and grouping on a mostly-empty field
        // would collapse half the fleet's parts into one row.
        _id: { $toLower: '$parts.name' },
        name: { $last: '$parts.name' },
        partNumber: { $last: '$parts.partNumber' },
        quantity: { $sum: '$parts.quantity' },
        totalCost: { $sum: '$parts.amount' },
        lines: { $sum: 1 },
        vehicles: { $addToSet: '$truck' },
        lastAt: { $max: `$${dateField}` }
      }
    }
  ];

  const [services, repairs] = await Promise.all([
    ServiceRecord.aggregate(pipeline(serviceMatch(filters), 'servicedAt')),
    RepairRequest.aggregate(pipeline(repairMatch(filters), 'completedAt'))
  ]);

  const merged = new Map();

  for (const [rows, kind] of [[services, 'service'], [repairs, 'repair']]) {
    for (const row of rows) {
      const key = String(row._id || '').trim();
      if (!key) continue;

      const bucket = merged.get(key) || {
        key,
        name: row.name || key,
        partNumber: row.partNumber || '',
        quantity: 0,
        totalCost: 0,
        lines: 0,
        services: 0,
        repairs: 0,
        vehicleIds: new Set(),
        lastAt: null
      };

      bucket.quantity += row.quantity || 0;
      bucket.totalCost += row.totalCost || 0;
      bucket.lines += row.lines || 0;
      bucket[kind === 'service' ? 'services' : 'repairs'] += row.lines || 0;
      if (!bucket.partNumber && row.partNumber) bucket.partNumber = row.partNumber;
      for (const v of row.vehicles || []) bucket.vehicleIds.add(String(v));
      if (row.lastAt && (!bucket.lastAt || row.lastAt > bucket.lastAt)) bucket.lastAt = row.lastAt;

      merged.set(key, bucket);
    }
  }

  return [...merged.values()]
    .map(({ vehicleIds, ...bucket }) => ({
      ...bucket,
      quantity: roundTo(bucket.quantity, 2),
      totalCost: roundTo(bucket.totalCost),
      vehicles: vehicleIds.size,
      avgUnitPrice: bucket.quantity > 0 ? roundTo(bucket.totalCost / bucket.quantity) : null
    }))
    .sort((a, b) => b.totalCost - a.totalCost);
};

// Over time, bucketed by day, month or year — the trend behind "is maintenance
// spend going up".
export const byPeriod = async (filters, granularity = 'month') => {
  const FORMATS = { day: '%Y-%m-%d', month: '%Y-%m', year: '%Y' };
  const format = FORMATS[granularity] || FORMATS.month;

  const [services, repairs] = await Promise.all([
    ServiceRecord.aggregate([
      { $match: serviceMatch(filters) },
      {
        $group: {
          _id: { $dateToString: { format, date: '$servicedAt' } },
          ...COST_ACCUMULATORS
        }
      }
    ]),
    RepairRequest.aggregate([
      { $match: repairMatch(filters) },
      {
        $group: {
          _id: { $dateToString: { format, date: '$completedAt' } },
          ...COST_ACCUMULATORS,
          downtime: { $sum: '$downtimeHours' }
        }
      }
    ])
  ]);

  const merged = new Map();
  foldInto(merged, services, 'service');
  foldInto(merged, repairs, 'repair');

  // Chronological, unlike the cost reports: a trend read out of order is not a
  // trend.
  return [...merged.values()]
    .map((bucket) => ({ ...finishBucket(bucket), period: bucket.key }))
    .sort((a, b) => String(a.period).localeCompare(String(b.period)));
};

// --------------------------------------------------------------------------
// Component reports
// --------------------------------------------------------------------------

// M3-M08 at report level: tyre life and cost per kilometre, brand by brand.
//
// This is the report that decides tyre policy. Averaging cost per km across
// tyres would over-weight a tyre that ran 2,000 km before a puncture, so the
// brand figure is total spend over total distance — the same reasoning
// services/fuelReports.js applies to mileage.
export const tyreReport = async (filters) => {
  const match = { owner: oid(filters.accountId) };
  if (filters.truck) match.truck = oid(filters.truck);
  if (filters.status) match.status = filters.status;

  const rows = await Tyre.aggregate([
    { $match: match },
    {
      $group: {
        _id: { brand: '$brand', size: '$size' },
        tyres: { $sum: 1 },
        totalPrice: { $sum: '$price' },
        totalRetread: { $sum: '$retreadCost' },
        totalKm: { $sum: '$runningKm' },
        // Only tyres that have finished tell you what a tyre lasts. One still
        // running has covered some of its life, not all of it, and averaging
        // it in drags the figure down.
        scrappedKm: {
          $sum: { $cond: [{ $in: ['$status', ['Scrapped', 'Sold']] }, '$runningKm', 0] }
        },
        scrapped: {
          $sum: { $cond: [{ $in: ['$status', ['Scrapped', 'Sold']] }, 1, 0] }
        },
        fitted: { $sum: { $cond: [{ $eq: ['$status', 'Fitted'] }, 1, 0] } },
        retreaded: { $sum: { $cond: [{ $gt: [{ $size: { $ifNull: ['$retreads', []] } }, 0] }, 1, 0] } },
        avgTread: { $avg: '$treadDepthMm' }
      }
    },
    { $sort: { totalKm: -1 } }
  ]);

  return rows.map((row) => {
    const spend = (row.totalPrice || 0) + (row.totalRetread || 0);
    return {
      key: `${row._id.brand || 'Unbranded'} ${row._id.size || ''}`.trim(),
      brand: row._id.brand || 'Unbranded',
      size: row._id.size || '',
      tyres: row.tyres,
      fitted: row.fitted,
      scrapped: row.scrapped,
      retreaded: row.retreaded,
      totalCost: roundTo(spend),
      totalKm: roundTo(row.totalKm || 0, 0),
      // M3-M08 at the brand level.
      costPerKm: row.totalKm > 0 ? roundTo(spend / row.totalKm, 3) : null,
      // What a tyre of this brand actually lasted, from the ones that finished.
      avgLifeKm: row.scrapped > 0 ? roundTo(row.scrappedKm / row.scrapped, 0) : null,
      avgTreadMm: row.avgTread === null ? null : roundTo(row.avgTread, 1)
    };
  });
};

// M3-M09 at report level: battery stock, spend and how long they are lasting.
export const batteryReport = async (filters) => {
  const match = { owner: oid(filters.accountId) };
  if (filters.truck) match.truck = oid(filters.truck);
  if (filters.status) match.status = filters.status;

  const rows = await Battery.aggregate([
    { $match: match },
    {
      $group: {
        _id: '$brand',
        batteries: { $sum: 1 },
        totalCost: { $sum: '$cost' },
        fitted: { $sum: { $cond: [{ $eq: ['$status', 'Fitted'] }, 1, 0] } },
        scrapped: { $sum: { $cond: [{ $eq: ['$status', 'Scrapped'] }, 1, 0] } },
        warrantyClaims: { $sum: { $cond: [{ $eq: ['$status', 'Warranty Claim'] }, 1, 0] } },
        // Life in months, for the ones that have been removed and so have both
        // ends of their life recorded.
        lifeMonths: {
          $push: {
            $cond: [
              { $and: ['$installedAt', '$removedAt'] },
              {
                $divide: [
                  { $subtract: ['$removedAt', '$installedAt'] },
                  1000 * 60 * 60 * 24 * 30.44
                ]
              },
              '$$REMOVE'
            ]
          }
        }
      }
    },
    { $sort: { totalCost: -1 } }
  ]);

  return rows.map((row) => {
    const lives = row.lifeMonths || [];
    return {
      key: row._id || 'Unbranded',
      brand: row._id || 'Unbranded',
      batteries: row.batteries,
      fitted: row.fitted,
      scrapped: row.scrapped,
      warrantyClaims: row.warrantyClaims,
      totalCost: roundTo(row.totalCost),
      avgCost: row.batteries > 0 ? roundTo(row.totalCost / row.batteries) : null,
      avgLifeMonths: lives.length
        ? roundTo(lives.reduce((a, b) => a + b, 0) / lives.length, 1)
        : null
    };
  });
};

// The repair report: how jobs are distributed across priority and status, and
// how long they take. The operational counterpart to the cost reports.
export const repairReport = async (filters) => {
  const rows = await RepairRequest.aggregate([
    // Deliberately not restricted to Completed: this report is about the state
    // of the workshop queue as much as about finished work, so the open jobs
    // have to be in it. The date filter follows the report date for the same
    // reason.
    {
      $match: (() => {
        const match = { owner: oid(filters.accountId) };
        if (filters.from || filters.to) {
          match.reportedAt = {};
          if (filters.from) match.reportedAt.$gte = filters.from;
          if (filters.to) match.reportedAt.$lte = filters.to;
        }
        if (filters.truck) match.truck = oid(filters.truck);
        return match;
      })()
    },
    {
      $group: {
        _id: { status: '$status', priority: '$priority' },
        jobs: { $sum: 1 },
        totalCost: { $sum: '$totalCost' },
        estimatedCost: { $sum: '$estimatedCost' },
        downtime: { $sum: '$downtimeHours' },
        avgDowntime: { $avg: '$downtimeHours' }
      }
    },
    { $sort: { jobs: -1 } }
  ]);

  return rows.map((row) => ({
    key: `${row._id.status}|${row._id.priority}`,
    status: row._id.status,
    priority: row._id.priority,
    jobs: row.jobs,
    totalCost: roundTo(row.totalCost),
    estimatedCost: roundTo(row.estimatedCost),
    downtimeHours: roundTo(row.downtime),
    avgDowntimeHours: row.avgDowntime === null ? null : roundTo(row.avgDowntime, 1)
  }));
};
