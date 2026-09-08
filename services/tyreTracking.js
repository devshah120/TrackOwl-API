import Tyre from '../models/Tyre.js';
import Truck from '../models/Truck.js';
import {
  computeTyreCostPerKm,
  isRunningPosition,
  ON_VEHICLE_TYRE_STATUSES,
  roundTo
} from '../utils/maintenance.js';

// M3-M08 — how a tyre accumulates kilometres, and what that makes it cost.
//
// A tyre has no odometer. Its distance is inferred entirely from the vehicle's:
// a tyre fitted at 40,000 km and removed at 92,000 km ran 52,000 of them. That
// single subtraction is the whole idea, and everything below exists to keep it
// honest across the ways a tyre actually moves around a fleet:
//
//   - it is rotated between positions on the same vehicle, closing one stint
//     and opening the next;
//   - it is moved to a different vehicle, whose odometer is a completely
//     different number;
//   - it sits as a spare, fitted but running nothing;
//   - it is retreaded and goes back on, still earning kilometres against the
//     same casing.
//
// So distance lives on the *stints*, not on the tyre, and `runningKm` is their
// sum. Recomputing from the stints rather than incrementing a counter means a
// corrected odometer reading fixes the total instead of compounding the error.

// What a single stint contributed. Null-safe and never negative: an odometer
// pair that runs backwards is a mis-keyed reading, and letting it subtract from
// the tyre's life would quietly make a worn tyre look new.
const stintDistance = (fitment) => {
  if (!fitment) return 0;

  // A spare or a tyre in stock covers nothing, however long it was there.
  if (!isRunningPosition(fitment.position)) return 0;

  const from = Number(fitment.fittedOdometer);
  const to = Number(fitment.removedOdometer);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 0;

  return Math.max(0, to - from);
};

// The distance an open stint has run so far, measured against where the
// vehicle is right now.
//
// This is what makes a fitted tyre's figure move without anything writing to it
// every day: the tyre's own row stores the closed stints, and the open one is
// measured on demand from the vehicle master's current odometer.
const openStintDistance = (fitment, currentOdometer) => {
  if (!fitment || fitment.removedAt) return 0;
  if (!isRunningPosition(fitment.position)) return 0;

  const from = Number(fitment.fittedOdometer);
  const now = Number(currentOdometer);
  if (!Number.isFinite(from) || !Number.isFinite(now)) return 0;

  return Math.max(0, now - from);
};

// Recomputes a tyre's running total and cost per km from its own stints, and
// saves it.
//
// `currentOdometer` is the vehicle's reading for the open stint, looked up when
// not supplied. Passing it lets a caller that already has the vehicle in hand
// avoid a second read.
//
// Takes a document rather than an id so the caller can hand over one it has
// already modified — fitting a tyre appends a stint and recomputes in one save
// rather than two.
export const recomputeTyre = async (tyre, { currentOdometer = undefined, save = true } = {}) => {
  if (!tyre) return null;

  const fitments = tyre.fitments || [];
  const open = fitments.find((f) => !f.removedAt) || null;

  let odometer = currentOdometer;
  if (open && odometer === undefined) {
    const truck = await Truck.findById(open.truck).select('odometer').lean();
    odometer = truck?.odometer ?? null;
  }

  // Closed stints carry their own stored distance where it has been computed,
  // and are recomputed from their odometer pair otherwise — so a corrected
  // reading on an old stint flows through to the total.
  const closedKm = fitments
    .filter((f) => f.removedAt)
    .reduce((sum, f) => sum + stintDistance(f), 0);

  const openKm = openStintDistance(open, odometer);

  tyre.runningKm = roundTo(closedKm + openKm, 0) ?? 0;

  // Retread costs are part of what the casing has cost to run, so they belong
  // in the per-km figure. Summed here rather than trusted from the stored
  // field, for the same reason the distance is.
  tyre.retreadCost = roundTo(
    (tyre.retreads || []).reduce((sum, r) => sum + (Number(r.cost) || 0), 0)
  ) ?? 0;

  tyre.costPerKm = computeTyreCostPerKm({
    price: tyre.price,
    retreadCost: tyre.retreadCost,
    distanceKm: tyre.runningKm
  });

  if (save) await tyre.save();
  return tyre;
};

// Fits a tyre to a vehicle at a position.
//
// Refuses when the tyre is already on a vehicle: a tyre in two places is not a
// data problem to be resolved later, it is a fact about the world that is
// wrong, and the fix is to remove it from the first vehicle. Returns
// `{ tyre, error }` rather than throwing, because "that tyre is already fitted"
// is an answer for the user, not an exception.
export const fitTyre = async ({ accountId, tyre, truck, position, odometer, fittedAt, notes }) => {
  if (ON_VEHICLE_TYRE_STATUSES.includes(tyre.status) && tyre.truck) {
    return {
      tyre: null,
      error: `That tyre is already fitted to ${tyre.vehicleNumber || 'another vehicle'} at ${tyre.position || 'a position'}. Remove it first.`
    };
  }

  const vehicle = await Truck.findOne({ _id: truck, owner: accountId }).select('number odometer').lean();
  if (!vehicle) return { tyre: null, error: 'That vehicle could not be found' };

  // Two tyres cannot occupy one position. Checked rather than allowed and
  // reported later, because the vehicle's tyre layout (M3-M07) is read straight
  // off these rows and a doubled position would render as a contradiction.
  const occupied = await Tyre.findOne({
    owner: accountId,
    truck,
    position,
    status: { $in: ON_VEHICLE_TYRE_STATUSES },
    _id: { $ne: tyre._id }
  })
    .select('tyreNumber')
    .lean();

  if (occupied) {
    return {
      tyre: null,
      error: `Tyre ${occupied.tyreNumber} is already fitted at ${position} on ${vehicle.number}. Remove it first.`
    };
  }

  // A fitment reading below the vehicle's own odometer is accepted — a tyre
  // fitted last month is being recorded today — but one above it is not: it
  // would give the tyre a negative distance until the vehicle caught up.
  if (Number.isFinite(vehicle.odometer) && odometer > vehicle.odometer) {
    return {
      tyre: null,
      error: `The vehicle's odometer reads ${vehicle.odometer} km, so the tyre cannot have been fitted at ${odometer} km`
    };
  }

  tyre.fitments.push({
    truck,
    vehicleNumber: vehicle.number || '',
    position,
    fittedAt: fittedAt || new Date(),
    fittedOdometer: odometer,
    notes: notes || ''
  });

  // The denormalised "where is it now", so the register and the vehicle layout
  // can be read without unwinding the history on every row.
  tyre.truck = truck;
  tyre.vehicleNumber = vehicle.number || '';
  tyre.position = position;
  tyre.fittedAt = fittedAt || new Date();
  // A retreaded casing going back on stays Retreaded — that is a property of
  // the tyre, not of where it is — while anything else becomes Fitted.
  tyre.status = tyre.status === 'Retreaded' ? 'Retreaded' : 'Fitted';
  tyre.removedAt = null;

  await recomputeTyre(tyre, { currentOdometer: vehicle.odometer });

  return { tyre, error: null };
};

// Takes a tyre off, closing the open stint and banking its distance.
export const removeTyre = async ({ tyre, odometer, removedAt, treadAtRemovalMm, reason, status, notes }) => {
  const open = (tyre.fitments || []).find((f) => !f.removedAt);
  if (!open) {
    return { tyre: null, error: 'That tyre is not currently fitted to a vehicle' };
  }

  if (Number.isFinite(open.fittedOdometer) && odometer < open.fittedOdometer) {
    return {
      tyre: null,
      error: `The tyre was fitted at ${open.fittedOdometer} km, so it cannot come off at ${odometer} km`
    };
  }

  open.removedAt = removedAt || new Date();
  open.removedOdometer = odometer;
  open.distanceKm = stintDistance(open);
  open.treadAtRemovalMm = treadAtRemovalMm ?? null;
  open.reason = reason || '';
  if (notes) open.notes = notes;

  // Off the vehicle: the denormalised position fields are cleared, because a
  // tyre in the store is not at Front Left of anything.
  tyre.truck = null;
  tyre.vehicleNumber = '';
  tyre.position = '';
  tyre.fittedAt = null;
  tyre.removedAt = open.removedAt;
  tyre.status = status || 'Removed';

  // A tread reading taken at removal is the tyre's current tread — it is the
  // most recent measurement there is.
  if (treadAtRemovalMm !== null && treadAtRemovalMm !== undefined) {
    tyre.treadDepthMm = treadAtRemovalMm;
    tyre.treadCheckedAt = open.removedAt;
  }

  await recomputeTyre(tyre, { currentOdometer: odometer });

  return { tyre, error: null };
};

// Records a retread. The casing keeps its accumulated distance: that is the
// point of the figure — a tyre retreaded at 80,000 km and run to 140,000 has
// cost its purchase price plus the retread over the whole 140,000, and pricing
// it any other way makes retreading look worse than it is.
export const retreadTyre = async ({ tyre, date, vendor, cost, notes }) => {
  if (tyre.truck) {
    return { tyre: null, error: 'Remove the tyre from the vehicle before sending it for retreading' };
  }

  tyre.retreads.push({
    date: date || new Date(),
    vendor: vendor || '',
    cost: cost || 0,
    atKm: tyre.runningKm ?? null,
    notes: notes || ''
  });

  tyre.status = 'Retreaded';
  // A retread resets the tread: the casing comes back with new rubber on it.
  // Left null rather than assumed to be a particular depth — the workshop
  // measures it, and inventing a number here would put a fabricated reading in
  // front of the replacement reminder.
  tyre.treadDepthMm = null;
  tyre.treadCheckedAt = null;

  await recomputeTyre(tyre);

  return { tyre, error: null };
};

// Re-measures every tyre currently fitted to a vehicle, called when that
// vehicle's odometer moves.
//
// Cheap in the normal case — a vehicle carries between four and fourteen tyres
// — and it keeps the register's cost-per-km column honest without a nightly
// job. Failures are logged and swallowed: an odometer update must not fail
// because a tyre figure could not be refreshed.
export const recomputeForTruck = async ({ accountId, truck, odometer }) => {
  try {
    const tyres = await Tyre.find({
      owner: accountId,
      truck,
      status: { $in: ON_VEHICLE_TYRE_STATUSES }
    });

    for (const tyre of tyres) {
      await recomputeTyre(tyre, { currentOdometer: odometer });
    }

    return { updated: tyres.length };
  } catch (error) {
    console.error('[maintenance] tyre recompute failed:', error.message);
    return { updated: 0 };
  }
};

export { stintDistance, openStintDistance };
