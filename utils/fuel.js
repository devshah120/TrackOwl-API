// The fuel module's vocabulary and the efficiency arithmetic, in one place so
// the model, the routes, the reports and the frontend all read the same lists
// and the same formulas.
//
// Kept separate from utils/tripOrders.js because fuelling is not a trip-shaped
// event: a yard top-up on a Sunday belongs to a vehicle and to nobody's trip,
// and the fleet's mileage history has to include it.

// --------------------------------------------------------------------------
// M3-F02 — Fuel types
// --------------------------------------------------------------------------

// What goes into the tank. `unit` matters because the efficiency figures below
// are only comparable within a unit: 40 litres of diesel and 40 kg of CNG are
// not the same purchase, and averaging them would be meaningless.
//
// Deliberately wider than Truck.FUEL_TYPES (the vehicle master's list of what a
// vehicle *runs on*). AdBlue is not a fuel a truck runs on — it is a consumable
// bought at the same pump, on the same bill, and the office wants it in the
// same register. So the two lists are related but not the same, and a fuel
// entry is never validated against the vehicle's own fuel type.
export const FUEL_TYPES = [
  'Diesel',
  'Petrol',
  'CNG',
  'LNG',
  'Electric',
  'AdBlue',
  'Other'
];

export const FUEL_TYPE_LABELS = {
  Diesel: 'Diesel',
  Petrol: 'Petrol',
  CNG: 'CNG',
  LNG: 'LNG',
  Electric: 'EV Charging',
  AdBlue: 'AdBlue / DEF',
  Other: 'Other'
};

// The unit each fuel type is sold in. Diesel and petrol by the litre, CNG and
// LNG by the kilogram, EV charging by the kilowatt-hour.
export const FUEL_UNITS = {
  Diesel: 'L',
  Petrol: 'L',
  CNG: 'kg',
  LNG: 'kg',
  Electric: 'kWh',
  AdBlue: 'L',
  Other: 'L'
};

export const unitFor = (fuelType) => FUEL_UNITS[fuelType] || 'L';

// Fuel types that actually propel the vehicle, and therefore the only ones the
// mileage figures are computed over.
//
// AdBlue is excluded on purpose: it is consumed by the emissions system, not
// the engine, so counting its litres into KM/L would silently understate every
// vehicle's mileage. It is still costed — it is real money spent on the
// vehicle — it just never lands in a distance-per-unit figure.
export const PROPULSION_FUEL_TYPES = ['Diesel', 'Petrol', 'CNG', 'LNG', 'Electric'];

export const isPropulsion = (fuelType) => PROPULSION_FUEL_TYPES.includes(fuelType);

// --------------------------------------------------------------------------
// M3-F01 — Fuel entry vocabulary
// --------------------------------------------------------------------------

// How the fuel was paid for. Mirrors the trip expense list (utils/tripOrders.js
// PAYMENT_MODES) so a fuel entry that syncs onto a trip does not have to
// translate between two vocabularies.
export const PAYMENT_MODES = [
  'Cash',
  'UPI',
  'Card',
  'Bank Transfer',
  'Fuel Card',
  'Credit',
  'Company Account'
];

// Whether the tank was filled to the brim. This is not cosmetic: distance
// divided by fuel is only a true mileage figure between two full-to-full
// fillings, because only then is the fuel burnt exactly the fuel bought.
// Partial fills are recorded and costed like any other, but the tank-to-tank
// mileage calculation spans them rather than treating each as its own
// measurement.
export const FILL_TYPES = ['full', 'partial'];

export const FILL_TYPE_LABELS = {
  full: 'Full tank',
  partial: 'Partial fill'
};

// --------------------------------------------------------------------------
// M3-F06 — Abnormal efficiency
// --------------------------------------------------------------------------

// What a vehicle's mileage is judged against.
//   vehicle — this vehicle's own history. The default and the fairer test: a
//             loaded tipper and an empty van have no business being compared.
//   fleet   — the account's average for the same fuel type. Useful for a
//             vehicle too new to have a history of its own.
export const BASELINE_MODES = ['vehicle', 'fleet'];

export const BASELINE_MODE_LABELS = {
  vehicle: "This vehicle's own history",
  fleet: 'Fleet average for the same fuel type'
};

// Why an entry was flagged. Stored on the flag rather than derived at read
// time so the reason survives a later change to the thresholds — the office
// needs to know what the rule was when the flag was raised.
export const FLAG_REASONS = [
  'low_efficiency',    // burnt materially more fuel per km than the baseline
  'high_efficiency',   // implausibly good — usually a mis-keyed odometer
  'odometer_rollback', // odometer lower than the previous entry's
  'quantity_spike',    // more fuel than the tank plausibly holds
  'rate_outlier'       // price per unit far off recent purchases
];

export const FLAG_REASON_LABELS = {
  low_efficiency: 'Low efficiency',
  high_efficiency: 'Unusually high efficiency',
  odometer_rollback: 'Odometer went backwards',
  quantity_spike: 'Quantity spike',
  rate_outlier: 'Unusual rate'
};

// Shipped defaults for the per-account thresholds (see models/FuelSetting.js).
// Chosen to be quiet on a normal fleet: a 20% swing either side of a vehicle's
// own average is wide enough that ordinary load and traffic variation does not
// trip it, and narrow enough to catch a mis-keyed odometer or a siphoned tank.
export const DEFAULT_SETTINGS = {
  baselineMode: 'vehicle',
  // Percent below baseline mileage before an entry is flagged.
  lowEfficiencyPct: 20,
  // Percent above. Flagged too, because impossibly good mileage is the usual
  // signature of a data-entry error, and an unflagged one quietly drags the
  // vehicle's own baseline off for months afterwards.
  highEfficiencyPct: 30,
  // How many prior measured fillings a vehicle needs before it is judged at
  // all. Below this the baseline is one or two numbers and flagging on it
  // would be noise.
  minSamples: 3,
  // Ignore anything older than this when computing the baseline: a mileage
  // average that reaches back three years describes a different vehicle.
  baselineWindowDays: 180,
  // Percent off the recent median rate before the price is called unusual.
  rateOutlierPct: 25,
  // A single filling larger than this many units is treated as a spike. Set
  // generously — a twin-tank tractor unit legitimately takes several hundred
  // litres — since this only exists to catch a slipped decimal point.
  maxQuantityPerFill: 600
};

// --------------------------------------------------------------------------
// M3-F03 / F04 / F05 — the efficiency formulas
// --------------------------------------------------------------------------
//
// All three are the same measurement expressed three ways, and all three are
// computed here rather than in the browser, for the reason services/
// tripFinance.js gives: a number the UI derives for itself is one nobody can
// audit, and two screens disagreeing is worse than either being stale.
//
// Every one of them returns null rather than 0 when the inputs are missing.
// "We do not know this vehicle's mileage" and "this vehicle does zero km per
// litre" are different facts, and collapsing them puts a fabricated zero into
// a fleet average.

const round = (n, places = 2) => {
  if (!Number.isFinite(n)) return null;
  const f = 10 ** places;
  return Math.round(n * f) / f;
};

// A positive, finite number, or null. Used to gate every formula below so a
// blank field, a zero divisor or a stray string can never produce Infinity or
// NaN and have it stored as though it were a measurement.
const positive = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

// M3-F03 — distance per unit of fuel. KM/L for a diesel or petrol vehicle,
// km/kg for CNG, km/kWh for an EV; the number means the same thing in each
// case, which is why it is one function and not three.
export const computeKmPerUnit = (distanceKm, quantity) => {
  const km = positive(distanceKm);
  const qty = positive(quantity);
  if (km === null || qty === null) return null;
  return round(km / qty);
};

// M3-F04 — fuel cost per kilometre. What it costs in fuel to move the vehicle
// one km, which is the figure that goes into a rate quote.
export const computeCostPerKm = (cost, distanceKm) => {
  const spent = Number(cost);
  const km = positive(distanceKm);
  if (!Number.isFinite(spent) || spent < 0 || km === null) return null;
  return round(spent / km);
};

// M3-F05 — litres per 100 km. The same measurement as KM/L inverted, and the
// one that is comparable across vehicle classes, because unlike KM/L it scales
// linearly with consumption.
export const computeUnitsPer100Km = (quantity, distanceKm) => {
  const qty = positive(quantity);
  const km = positive(distanceKm);
  if (qty === null || km === null) return null;
  return round((qty / km) * 100);
};

// The three figures together, from one distance/quantity/cost triple. Callers
// take this rather than the three functions separately so a screen can never
// show KM/L computed one way and L/100KM another.
export const computeEfficiency = ({ distanceKm, quantity, cost } = {}) => ({
  distanceKm: positive(distanceKm) === null ? null : round(distanceKm),
  kmPerUnit: computeKmPerUnit(distanceKm, quantity),
  costPerKm: computeCostPerKm(cost, distanceKm),
  unitsPer100Km: computeUnitsPer100Km(quantity, distanceKm)
});

// --------------------------------------------------------------------------
// Amount reconciliation
// --------------------------------------------------------------------------

// Quantity, rate and amount are all captured (M3-F01) and any two determine the
// third. The pump prints all three, so all three are stored — but they must
// agree, and the receipt is the thing being recorded, so `amount` is treated as
// what was actually paid and the rate is derived from it when it is missing.
//
// Returns the completed triple plus whether the numbers were consistent, which
// the route surfaces as a warning rather than an error: a bill really can be
// rounded to the rupee at the pump, and refusing to save it would be wrong.
export const reconcileAmount = ({ quantity, rate, amount } = {}) => {
  const qty = positive(quantity);
  const unitRate = positive(rate);
  const paidNum = Number(amount);
  const paid = Number.isFinite(paidNum) && paidNum >= 0 ? paidNum : null;

  // Everything present: check they agree, to within a rupee plus a whisker for
  // the pump's own rounding.
  if (qty !== null && unitRate !== null && paid !== null) {
    const expected = qty * unitRate;
    const tolerance = Math.max(1, expected * 0.01);
    return {
      quantity: round(qty, 3),
      rate: round(unitRate, 3),
      amount: round(paid),
      consistent: Math.abs(expected - paid) <= tolerance,
      expectedAmount: round(expected)
    };
  }

  // Two of the three: derive the missing one.
  if (qty !== null && unitRate !== null) {
    const expected = qty * unitRate;
    return {
      quantity: round(qty, 3),
      rate: round(unitRate, 3),
      amount: round(expected),
      consistent: true,
      expectedAmount: round(expected)
    };
  }
  if (qty !== null && paid !== null) {
    return {
      quantity: round(qty, 3),
      rate: round(paid / qty, 3),
      amount: round(paid),
      consistent: true,
      expectedAmount: round(paid)
    };
  }
  if (unitRate !== null && paid !== null) {
    return {
      quantity: round(paid / unitRate, 3),
      rate: round(unitRate, 3),
      amount: round(paid),
      consistent: true,
      expectedAmount: round(paid)
    };
  }

  // Not enough to work with. The route rejects this; it is not something to
  // guess at.
  return {
    quantity: qty === null ? null : round(qty, 3),
    rate: unitRate === null ? null : round(unitRate, 3),
    amount: paid === null ? null : round(paid),
    consistent: true,
    expectedAmount: null
  };
};

export { round as roundTo };
