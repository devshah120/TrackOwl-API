import mongoose from 'mongoose';
import FuelEntry from '../models/FuelEntry.js';
import { roundTo, PROPULSION_FUEL_TYPES } from '../utils/fuel.js';

// M3-F07 — the fuel reports: consumption, cost and efficiency grouped by
// vehicle, driver, station, date, fuel type or trip.
//
// Every one of these is a database aggregation rather than a load-and-reduce in
// Node. A fleet accumulates a fuel entry per vehicle per few days, so a year of
// a hundred trucks is tens of thousands of rows; pulling them into the API
// process to sum them would be slow and would get slower exactly as the reports
// became worth reading.
//
// How efficiency is aggregated
// ----------------------------
// The mileage of a group is *not* the average of its entries' KM/L figures.
// Averaging ratios weights a 20-litre top-up the same as a 400-litre fill, and
// the answer drifts away from the truth as the fills get more uneven.
//
// The honest figure is total distance divided by total fuel, so that is what
// these compute — summing the distance and the quantity over the entries that
// carry a real measurement, then dividing once at the end.

// The match stage every report starts from. Filters are applied in the database
// so an index can be used, and the date range is inclusive of its end day.
const buildMatch = ({ accountId, from, to, truck, driver, fuelType, station, trip, flaggedOnly }) => {
  const match = { owner: new mongoose.Types.ObjectId(accountId) };

  if (from || to) {
    match.filledAt = {};
    if (from) match.filledAt.$gte = from;
    if (to) match.filledAt.$lte = to;
  }

  if (truck) match.truck = new mongoose.Types.ObjectId(truck);
  if (driver) match.driver = new mongoose.Types.ObjectId(driver);
  if (trip) match.trip = new mongoose.Types.ObjectId(trip);
  if (fuelType) match.fuelType = fuelType;
  if (station) match['station.name'] = station;
  if (flaggedOnly) match.isFlagged = true;

  return match;
};

// The accumulators shared by every grouping. Kept in one place so the vehicle
// report and the station report cannot end up computing "total spend"
// differently.
//
// `measuredDistance` and `measuredQuantity` deliberately count only entries
// with a real measurement behind them (see services/fuelEfficiency.js). Total
// quantity includes every filling — that is what was bought — but the mileage
// denominator must only include fuel whose distance is actually known, or the
// ratio is fuel we can account for divided by distance we cannot.
const GROUP_ACCUMULATORS = {
  entries: { $sum: 1 },
  quantity: { $sum: '$quantity' },
  amount: { $sum: '$amount' },
  flagged: { $sum: { $cond: ['$isFlagged', 1, 0] } },
  measuredDistance: {
    $sum: { $cond: [{ $gt: ['$efficiency.distanceKm', 0] }, '$efficiency.distanceKm', 0] }
  },
  measuredQuantity: {
    $sum: { $cond: [{ $gt: ['$efficiency.distanceKm', 0] }, '$quantity', 0] }
  },
  measuredAmount: {
    $sum: { $cond: [{ $gt: ['$efficiency.distanceKm', 0] }, '$amount', 0] }
  },
  firstFill: { $min: '$filledAt' },
  lastFill: { $max: '$filledAt' }
};

// Turns one aggregated group into the numbers a report row shows.
//
// The three efficiency figures are computed from the summed distance and fuel,
// and are null when there is no measured distance in the group — a vehicle
// whose entries all lack odometer readings reports "not known", never zero.
const finishRow = (row) => {
  const distance = Number(row.measuredDistance) || 0;
  const fuel = Number(row.measuredQuantity) || 0;
  const measuredSpend = Number(row.measuredAmount) || 0;
  const hasMeasurement = distance > 0 && fuel > 0;

  return {
    entries: row.entries || 0,
    quantity: roundTo(row.quantity || 0, 3),
    amount: roundTo(row.amount || 0),
    flagged: row.flagged || 0,
    distanceKm: distance > 0 ? roundTo(distance) : null,
    // M3-F03, M3-F04, M3-F05 at group level.
    kmPerUnit: hasMeasurement ? roundTo(distance / fuel) : null,
    costPerKm: distance > 0 && measuredSpend > 0 ? roundTo(measuredSpend / distance) : null,
    unitsPer100Km: hasMeasurement ? roundTo((fuel / distance) * 100) : null,
    // The average price paid per unit across the group.
    avgRate: row.quantity > 0 ? roundTo((row.amount || 0) / row.quantity, 3) : null,
    firstFill: row.firstFill || null,
    lastFill: row.lastFill || null
  };
};

// --------------------------------------------------------------------------
// The account-level summary
// --------------------------------------------------------------------------

// The stat strip above the fuel register: what was bought, what it cost, how
// efficiently it was burnt, and how much needs looking at.
export const summary = async (filters) => {
  const match = buildMatch(filters);

  const [totals, byFuelType] = await Promise.all([
    FuelEntry.aggregate([{ $match: match }, { $group: { _id: null, ...GROUP_ACCUMULATORS } }]),
    FuelEntry.aggregate([
      { $match: match },
      { $group: { _id: '$fuelType', ...GROUP_ACCUMULATORS } },
      { $sort: { amount: -1 } }
    ])
  ]);

  return {
    totals: finishRow(totals[0] || {}),
    byFuelType: byFuelType.map((row) => ({ fuelType: row._id, ...finishRow(row) }))
  };
};

// --------------------------------------------------------------------------
// The grouped reports
// --------------------------------------------------------------------------

// By vehicle. The report the workshop actually acts on: it is where a truck
// quietly losing a kilometre per litre shows up.
export const byVehicle = async (filters) => {
  const match = buildMatch(filters);

  const rows = await FuelEntry.aggregate([
    { $match: match },
    {
      $group: {
        _id: '$truck',
        vehicleNumber: { $last: '$vehicleNumber' },
        ...GROUP_ACCUMULATORS
      }
    },
    { $sort: { amount: -1 } },
    { $limit: 500 },
    {
      $lookup: {
        from: 'trucks',
        localField: '_id',
        foreignField: '_id',
        as: 'truck'
      }
    }
  ]);

  return rows.map((row) => {
    const truck = row.truck?.[0] || null;
    return {
      truck: row._id,
      // The master's current plate where the vehicle still exists, falling back
      // to the plate stored on the entries — a deleted truck still has fuel
      // history, and it should not become an anonymous row.
      vehicleNumber: truck?.number || row.vehicleNumber || 'Unknown vehicle',
      model: truck?.model || '',
      vehicleType: truck?.vehicleType || '',
      fuelType: truck?.fuelType || '',
      ...finishRow(row)
    };
  });
};

// By driver. Reads as a driver-behaviour report, and should be read carefully:
// a driver on hill routes will burn more than one on the highway, so this is a
// prompt to ask a question, not an answer on its own.
export const byDriver = async (filters) => {
  const match = buildMatch(filters);

  const rows = await FuelEntry.aggregate([
    // Entries with no driver are excluded rather than grouped under null: a
    // bucket labelled "no driver" is not a driver and would sit in the ranking
    // as though it were one.
    { $match: { ...match, driver: { $ne: null } } },
    {
      $group: {
        _id: '$driver',
        driverName: { $last: '$driverName' },
        ...GROUP_ACCUMULATORS
      }
    },
    { $sort: { amount: -1 } },
    { $limit: 500 },
    { $lookup: { from: 'drivers', localField: '_id', foreignField: '_id', as: 'driver' } }
  ]);

  return rows.map((row) => ({
    driver: row._id,
    driverName: row.driver?.[0]?.name || row.driverName || 'Unknown driver',
    mobile: row.driver?.[0]?.mobile || '',
    ...finishRow(row)
  }));
};

// By station. What the fleet spends where, and at what price — the report that
// answers "should we be negotiating with this pump".
export const byStation = async (filters) => {
  const match = buildMatch(filters);

  const rows = await FuelEntry.aggregate([
    { $match: { ...match, 'station.name': { $nin: ['', null] } } },
    {
      $group: {
        _id: '$station.name',
        city: { $last: '$station.city' },
        state: { $last: '$station.state' },
        ...GROUP_ACCUMULATORS
      }
    },
    { $sort: { amount: -1 } },
    { $limit: 500 }
  ]);

  return rows.map((row) => ({
    station: row._id,
    city: row.city || '',
    state: row.state || '',
    ...finishRow(row)
  }));
};

// By trip. Only entries actually linked to a trip appear — an unlinked yard
// filling has no trip to be reported under.
export const byTrip = async (filters) => {
  const match = buildMatch(filters);

  const rows = await FuelEntry.aggregate([
    { $match: { ...match, trip: { $ne: null } } },
    { $group: { _id: '$trip', ...GROUP_ACCUMULATORS } },
    { $sort: { amount: -1 } },
    { $limit: 500 },
    { $lookup: { from: 'triporders', localField: '_id', foreignField: '_id', as: 'trip' } }
  ]);

  return rows.map((row) => {
    const trip = row.trip?.[0] || null;
    return {
      trip: row._id,
      tripNumber: trip?.tripNumber || 'Unknown trip',
      status: trip?.status || '',
      tripDate: trip?.tripDate || null,
      route: trip ? `${trip.pickup?.city || '—'} → ${trip.destination?.city || '—'}` : '',
      // The trip's own actual distance, which is a different measurement from
      // the fuel chain's: it comes from the trip's start and end odometer
      // readings. Shown alongside so a reader can see whether the two agree.
      tripActualKm: trip?.actualKm ?? null,
      ...finishRow(row)
    };
  });
};

// Over time. `granularity` buckets by day, month or year; the month view is
// what a monthly fuel spend review is built on.
export const byPeriod = async (filters, granularity = 'month') => {
  const match = buildMatch(filters);

  const formats = { day: '%Y-%m-%d', month: '%Y-%m', year: '%Y' };
  const format = formats[granularity] || formats.month;

  const rows = await FuelEntry.aggregate([
    { $match: match },
    {
      $group: {
        // Bucketed in the account's own timezone rather than UTC: a filling at
        // 11pm in India belongs to that day's fuel spend, not the next one's.
        _id: { $dateToString: { format, date: '$filledAt', timezone: 'Asia/Kolkata' } },
        ...GROUP_ACCUMULATORS
      }
    },
    { $sort: { _id: 1 } },
    { $limit: 400 }
  ]);

  return rows.map((row) => ({ period: row._id, ...finishRow(row) }));
};

// --------------------------------------------------------------------------
// Fleet efficiency ranking
// --------------------------------------------------------------------------

// Vehicles ordered by how efficiently they run, best first — the fleet-wide
// view behind M3-F06's "compare with fleet average".
//
// Only vehicles with a real measurement appear, and only propulsion fuels are
// considered: a ranking that included AdBlue purchases would be nonsense.
export const efficiencyRanking = async (filters) => {
  const match = buildMatch({ ...filters, flaggedOnly: false });

  const rows = await FuelEntry.aggregate([
    {
      $match: {
        ...match,
        fuelType: { $in: PROPULSION_FUEL_TYPES },
        'efficiency.distanceKm': { $gt: 0 }
      }
    },
    {
      $group: {
        _id: { truck: '$truck', fuelType: '$fuelType' },
        vehicleNumber: { $last: '$vehicleNumber' },
        ...GROUP_ACCUMULATORS
      }
    },
    { $limit: 500 }
  ]);

  const ranked = rows
    .map((row) => ({
      truck: row._id.truck,
      fuelType: row._id.fuelType,
      vehicleNumber: row.vehicleNumber || 'Unknown vehicle',
      ...finishRow(row)
    }))
    .filter((row) => row.kmPerUnit !== null)
    .sort((a, b) => b.kmPerUnit - a.kmPerUnit);

  // The fleet average per fuel type, so a row can be read against its own
  // class. Weighted by distance and fuel for the reason given at the top —
  // averaging the per-vehicle ratios would over-weight a van that barely runs.
  const fleetAverages = {};
  for (const row of ranked) {
    const bucket = (fleetAverages[row.fuelType] ||= { distance: 0, quantity: 0 });
    bucket.distance += row.distanceKm || 0;
    bucket.quantity += row.quantity || 0;
  }

  const averages = Object.fromEntries(
    Object.entries(fleetAverages).map(([fuelType, b]) => [
      fuelType,
      b.quantity > 0 ? roundTo(b.distance / b.quantity) : null
    ])
  );

  return {
    vehicles: ranked.map((row) => ({
      ...row,
      fleetAverage: averages[row.fuelType] ?? null,
      // How this vehicle sits against its class, as a percentage. Positive is
      // better than average.
      vsFleetPct:
        averages[row.fuelType] && row.kmPerUnit
          ? roundTo(((row.kmPerUnit - averages[row.fuelType]) / averages[row.fuelType]) * 100)
          : null
    })),
    fleetAverages: averages
  };
};

export { buildMatch };
