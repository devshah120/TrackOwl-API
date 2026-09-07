import FuelEntry from '../models/FuelEntry.js';
import { settingsFor } from '../models/FuelSetting.js';
import {
  computeEfficiency,
  isPropulsion,
  roundTo,
  FLAG_REASON_LABELS,
  unitFor
} from '../utils/fuel.js';

// Every mileage figure and every outlier flag in the fuel module is produced
// here, on the server. The frontend renders what this returns and derives
// nothing of its own — the same rule services/tripFinance.js states for money,
// and for the same reason: a browser-side number is one nobody can audit.
//
// The measurement this module implements
// --------------------------------------
// Mileage is distance divided by fuel burnt, and the only moment we know how
// much fuel was burnt is between two full tanks. Fill to the brim, drive, fill
// to the brim again: the second fill replaces exactly what the drive consumed.
//
// So a measurement here spans from the previous *full* filling up to this one,
// and the fuel counted is this fill plus any partial fills in between — those
// went into the tank over the same stretch of road and were burnt on it. This
// is why `fillsSpanned` exists on the record: a reader can see whether they are
// looking at a clean full-to-full number or one rolled up across partials.
//
// An entry that is itself a partial fill gets no mileage figure at all. The
// tank is at an unknown level at both ends, so any number computed would be
// arithmetic without a measurement behind it. It reports null and says why,
// rather than publishing a figure that would then pollute the vehicle baseline.

// --------------------------------------------------------------------------
// The odometer chain
// --------------------------------------------------------------------------

// The fillings for one vehicle that sit strictly before `filledAt`, newest
// first. `excludeId` drops the entry being recomputed so an edit does not
// measure against itself.
//
// Ordered by (filledAt, _id) so two fillings recorded with the same timestamp
// — a same-day pair typed from two receipts — still have one stable order, and
// the chain walked backwards matches the chain walked forwards.
const priorEntries = async ({ accountId, truck, filledAt, excludeId = null, limit = 25 }) => {
  const query = {
    owner: accountId,
    truck,
    filledAt: { $lt: filledAt }
  };
  if (excludeId) query._id = { $ne: excludeId };

  return FuelEntry.find(query)
    .sort({ filledAt: -1, _id: -1 })
    .limit(limit)
    .select('filledAt odometer quantity amount fuelType fillType efficiency')
    .lean();
};

// Walks back from the entry being measured to the most recent *full* filling
// that carries an odometer reading, accumulating the fuel bought in between.
//
// Returns null when there is nothing to measure against — a vehicle's first
// entry, or a history of partial fills that never anchors. That is a real
// answer, not a failure: the caller stores nulls and the UI says the mileage is
// not yet known.
const findMeasurementBase = (priors, fuelType) => {
  // Only the same fuel type can be rolled in. A diesel tractor that also buys
  // AdBlue has two independent consumption streams, and adding AdBlue litres
  // into a diesel measurement would understate its mileage.
  let carriedQuantity = 0;
  let fills = 1;

  for (const prior of priors) {
    if (prior.fuelType !== fuelType) continue;

    // A prior full fill with a usable odometer anchors the measurement.
    if (prior.fillType === 'full' && Number.isFinite(prior.odometer) && prior.odometer !== null) {
      return { anchor: prior, carriedQuantity, fillsSpanned: fills };
    }

    // A partial fill in between: its fuel was burnt over this same stretch, so
    // it counts toward the total consumed.
    if (prior.fillType === 'partial') {
      carriedQuantity += Number(prior.quantity) || 0;
      fills += 1;
      continue;
    }

    // A full fill with no odometer reading breaks the chain: we know the tank
    // was brimmed but not where. Nothing further back can be measured against,
    // because the distance across this point is unknowable.
    if (prior.fillType === 'full') return null;
  }

  return null;
};

// The efficiency block for one entry, measured against the vehicle's history.
//
// `entry` may be an unsaved document or a plain object; only the fields used
// here are read, so the create and update paths can both call it before saving.
export const measureEntry = async ({ accountId, entry, excludeId = null }) => {
  const empty = {
    distanceKm: null,
    kmPerUnit: null,
    costPerKm: null,
    unitsPer100Km: null,
    previousEntry: null,
    previousOdometer: null,
    fillsSpanned: null,
    measured: false,
    computedAt: new Date()
  };

  // AdBlue and the like are costed but never produce a mileage figure.
  if (!isPropulsion(entry.fuelType)) return empty;

  // Without an odometer reading on this entry there is no distance to divide.
  if (!Number.isFinite(entry.odometer) || entry.odometer === null) return empty;

  // A partial fill cannot anchor its own measurement — see the note at the top.
  if (entry.fillType !== 'full') return empty;

  const priors = await priorEntries({
    accountId,
    truck: entry.truck,
    filledAt: entry.filledAt,
    excludeId
  });

  const base = findMeasurementBase(priors, entry.fuelType);
  if (!base) return empty;

  const distanceKm = Number(entry.odometer) - Number(base.anchor.odometer);

  // A non-positive distance means the odometer went backwards or stood still.
  // Both are data errors, flagged separately by `evaluateFlags`; publishing a
  // negative or infinite mileage from them would be worse than publishing none.
  if (!Number.isFinite(distanceKm) || distanceKm <= 0) {
    return { ...empty, previousEntry: base.anchor._id, previousOdometer: base.anchor.odometer };
  }

  // Fuel burnt over the stretch: this fill plus any partials rolled in.
  const quantity = (Number(entry.quantity) || 0) + base.carriedQuantity;
  // Cost is matched to that same fuel, so cost/km and km/unit describe the
  // same stretch of road rather than two different ones.
  const cost = Number(entry.amount) || 0;

  const figures = computeEfficiency({ distanceKm, quantity, cost });

  return {
    ...figures,
    previousEntry: base.anchor._id,
    previousOdometer: base.anchor.odometer,
    fillsSpanned: base.fillsSpanned,
    // A clean full-to-full measurement spans exactly one fill. More than that
    // means partials were rolled in, which is a good estimate but not a direct
    // measurement, and the UI labels it as such.
    measured: base.fillsSpanned === 1,
    computedAt: new Date()
  };
};

// --------------------------------------------------------------------------
// M3-F06 — the baseline and the outlier rules
// --------------------------------------------------------------------------

// The median of a list of numbers. Used for the baseline rather than the mean
// because fuel data has outliers by definition — that is what this module
// looks for — and a single mis-keyed odometer would drag a mean far enough to
// hide the very entries the check exists to catch.
const median = (values) => {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

// What this vehicle's mileage is normally, from its own recent measured
// fillings. Returns null when there are too few to judge against.
const vehicleBaseline = async ({ accountId, truck, fuelType, filledAt, settings, excludeId }) => {
  const since = new Date(filledAt);
  since.setDate(since.getDate() - settings.baselineWindowDays);

  const query = {
    owner: accountId,
    truck,
    fuelType,
    filledAt: { $lt: filledAt, $gte: since },
    // Only true measurements form a baseline. An estimate rolled across
    // partials is good enough to show a reader and not good enough to judge
    // other entries by.
    'efficiency.measured': true,
    'efficiency.kmPerUnit': { $ne: null, $gt: 0 }
  };
  if (excludeId) query._id = { $ne: excludeId };

  const rows = await FuelEntry.find(query)
    .sort({ filledAt: -1 })
    .limit(50)
    .select('efficiency.kmPerUnit')
    .lean();

  if (rows.length < settings.minSamples) return null;
  return { value: median(rows.map((r) => r.efficiency?.kmPerUnit)), samples: rows.length };
};

// The account's average mileage for this fuel type, across every vehicle.
// The fallback when a vehicle has no history of its own, and the comparison
// used outright when the account has chosen `fleet` mode.
const fleetBaseline = async ({ accountId, fuelType, filledAt, settings, excludeId }) => {
  const since = new Date(filledAt);
  since.setDate(since.getDate() - settings.baselineWindowDays);

  const query = {
    owner: accountId,
    fuelType,
    filledAt: { $lt: filledAt, $gte: since },
    'efficiency.measured': true,
    'efficiency.kmPerUnit': { $ne: null, $gt: 0 }
  };
  if (excludeId) query._id = { $ne: excludeId };

  const rows = await FuelEntry.find(query)
    .sort({ filledAt: -1 })
    .limit(200)
    .select('efficiency.kmPerUnit')
    .lean();

  if (rows.length < settings.minSamples) return null;
  return { value: median(rows.map((r) => r.efficiency?.kmPerUnit)), samples: rows.length };
};

// The recent price per unit for this fuel type across the account, for the rate
// check. Compared account-wide rather than per vehicle because pump prices move
// with the market, not with the vehicle.
const recentRate = async ({ accountId, fuelType, filledAt, excludeId }) => {
  const since = new Date(filledAt);
  since.setDate(since.getDate() - 30);

  const query = {
    owner: accountId,
    fuelType,
    filledAt: { $lt: filledAt, $gte: since },
    rate: { $ne: null, $gt: 0 }
  };
  if (excludeId) query._id = { $ne: excludeId };

  const rows = await FuelEntry.find(query).sort({ filledAt: -1 }).limit(50).select('rate').lean();
  if (rows.length < 3) return null;
  return median(rows.map((r) => r.rate));
};

// Percent difference of `observed` from `baseline`, signed: negative means
// below the baseline.
const deviation = (observed, baseline) => {
  if (!Number.isFinite(observed) || !Number.isFinite(baseline) || baseline === 0) return null;
  return roundTo(((observed - baseline) / baseline) * 100);
};

// Judges one entry against the account's thresholds and returns the flags it
// earns (M3-F06). Pure with respect to the entry: it returns flags rather than
// setting them, so the caller decides what to store.
export const evaluateFlags = async ({ accountId, entry, efficiency, settings, excludeId = null }) => {
  const flags = [];
  const unit = unitFor(entry.fuelType);

  // --- Odometer went backwards -------------------------------------------
  // Checked before efficiency because it explains most efficiency flags: a
  // reading typed as 45000 instead of 145000 trips both, and the office should
  // see the cause, not just the symptom.
  if (Number.isFinite(entry.odometer) && entry.odometer !== null) {
    const previous = efficiency?.previousOdometer;
    if (Number.isFinite(previous) && entry.odometer < previous) {
      flags.push({
        reason: 'odometer_rollback',
        message: `Odometer reads ${entry.odometer.toLocaleString('en-IN')} km, lower than the previous filling at ${Number(previous).toLocaleString('en-IN')} km`,
        observed: entry.odometer,
        baseline: previous,
        deviationPct: deviation(entry.odometer, previous),
        raisedAt: new Date()
      });
    }
  }

  // --- Implausible quantity ----------------------------------------------
  const quantity = Number(entry.quantity);
  if (Number.isFinite(quantity) && quantity > settings.maxQuantityPerFill) {
    flags.push({
      reason: 'quantity_spike',
      message: `${quantity} ${unit} in a single filling is above the ${settings.maxQuantityPerFill} ${unit} threshold — check for a misplaced decimal point`,
      observed: quantity,
      baseline: settings.maxQuantityPerFill,
      deviationPct: deviation(quantity, settings.maxQuantityPerFill),
      raisedAt: new Date()
    });
  }

  // --- Unusual rate -------------------------------------------------------
  const rate = Number(entry.rate);
  if (Number.isFinite(rate) && rate > 0) {
    const typical = await recentRate({ accountId, fuelType: entry.fuelType, filledAt: entry.filledAt, excludeId });
    if (typical) {
      const off = deviation(rate, typical);
      if (off !== null && Math.abs(off) > settings.rateOutlierPct) {
        flags.push({
          reason: 'rate_outlier',
          message: `Rate of ₹${rate}/${unit} is ${Math.abs(off)}% ${off > 0 ? 'above' : 'below'} the recent typical ₹${roundTo(typical)}/${unit}`,
          observed: rate,
          baseline: roundTo(typical),
          deviationPct: off,
          raisedAt: new Date()
        });
      }
    }
  }

  // --- Efficiency against the baseline ------------------------------------
  // Only a genuine measurement is judged. An entry with no mileage figure, or
  // one estimated across partial fills, is not evidence of anything.
  const observed = efficiency?.kmPerUnit;
  if (Number.isFinite(observed) && observed > 0 && efficiency?.measured) {
    const useFleet = settings.baselineMode === 'fleet';

    // In vehicle mode, fall back to the fleet when the vehicle is too new to
    // have a history — otherwise a brand-new truck could burn fuel at any rate
    // for its first months and never be questioned.
    let baseline = useFleet
      ? await fleetBaseline({ accountId, fuelType: entry.fuelType, filledAt: entry.filledAt, settings, excludeId })
      : await vehicleBaseline({ accountId, truck: entry.truck, fuelType: entry.fuelType, filledAt: entry.filledAt, settings, excludeId });

    let source = useFleet ? 'fleet' : 'vehicle';
    if (!baseline && !useFleet) {
      baseline = await fleetBaseline({ accountId, fuelType: entry.fuelType, filledAt: entry.filledAt, settings, excludeId });
      source = 'fleet';
    }

    if (baseline?.value) {
      const off = deviation(observed, baseline.value);
      const against = source === 'fleet' ? 'the fleet average' : 'this vehicle’s average';

      if (off !== null && off < -settings.lowEfficiencyPct) {
        flags.push({
          reason: 'low_efficiency',
          message: `${observed} km/${unit} is ${Math.abs(off)}% below ${against} of ${roundTo(baseline.value)} km/${unit}`,
          observed,
          baseline: roundTo(baseline.value),
          deviationPct: off,
          raisedAt: new Date()
        });
      } else if (off !== null && off > settings.highEfficiencyPct) {
        flags.push({
          reason: 'high_efficiency',
          message: `${observed} km/${unit} is ${off}% above ${against} of ${roundTo(baseline.value)} km/${unit} — check the odometer and quantity`,
          observed,
          baseline: roundTo(baseline.value),
          deviationPct: off,
          raisedAt: new Date()
        });
      }
    }
  }

  return flags;
};

// Measures an entry and judges it in one call — what the create and update
// routes use, so the two can never apply the rules differently.
export const analyseEntry = async ({ accountId, entry, excludeId = null, settings = null }) => {
  const thresholds = settings || (await settingsFor(accountId));
  const efficiency = await measureEntry({ accountId, entry, excludeId });
  const flags = await evaluateFlags({ accountId, entry, efficiency, settings: thresholds, excludeId });
  return { efficiency, flags };
};

// --------------------------------------------------------------------------
// Recomputing the chain
// --------------------------------------------------------------------------

// Every entry for a vehicle from `since` onwards, re-measured in date order.
//
// Needed because a fuel entry is not an isolated fact: it sits in a chain, and
// inserting a back-dated filling, correcting an odometer or deleting a row
// changes the measurement of everything after it. Without this, an office that
// enters last Tuesday's receipt on Friday would leave the intervening entries
// reporting mileage measured from the wrong anchor.
//
// Walks forward and saves one at a time rather than in bulk: each measurement
// reads the entries before it, so they have to be correct before the next is
// computed.
export const recomputeChain = async ({ accountId, truck, since = null, settings = null }) => {
  if (!truck) return { updated: 0 };

  const thresholds = settings || (await settingsFor(accountId));

  const query = { owner: accountId, truck };
  if (since) query.filledAt = { $gte: since };

  const entries = await FuelEntry.find(query).sort({ filledAt: 1, _id: 1 });

  let updated = 0;
  for (const entry of entries) {
    const { efficiency, flags } = await analyseEntry({
      accountId,
      entry,
      excludeId: entry._id,
      settings: thresholds
    });

    entry.efficiency = efficiency;
    // A review already given stands: re-measuring an entry because a later row
    // moved must not re-raise a flag someone has already looked into and
    // dismissed. Only an untouched entry has its flags replaced.
    if (!entry.reviewedAt) entry.flags = flags;

    await entry.save();
    updated += 1;
  }

  return { updated };
};
