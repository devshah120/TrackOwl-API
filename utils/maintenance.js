// The maintenance module's vocabulary and its cost arithmetic, in one place so
// the models, the routes, the reports and the frontend all read the same lists
// and the same formulas.
//
// Maintenance is vehicle-centric in the same way fuelling is (utils/fuel.js):
// a service, a repair, a tyre and a battery all belong to a vehicle and to no
// trip. What makes this module its own thing rather than more of the fuel one
// is that it tracks *fitted components* — a tyre and a battery are assets that
// live on a vehicle, move between positions, and are eventually scrapped —
// where a filling is an event that happens once and is over.

// --------------------------------------------------------------------------
// M3-M03 — Service types
// --------------------------------------------------------------------------

// What was done to the vehicle. This drives the service reminders (M3-M10),
// because "next oil change" and "next brake inspection" are different clocks
// running on the same vehicle, and a single "last serviced" date cannot say
// which of them is due.
export const SERVICE_TYPES = [
  'General',
  'Oil',
  'Filters',
  'Brakes',
  'AC',
  'Battery',
  'Suspension',
  'Alignment',
  'Electrical',
  'Engine',
  'Transmission',
  'Clutch',
  'Other'
];

export const SERVICE_TYPE_LABELS = {
  General: 'General service',
  Oil: 'Oil change',
  Filters: 'Filters',
  Brakes: 'Brakes',
  AC: 'Air conditioning',
  Battery: 'Battery',
  Suspension: 'Suspension',
  Alignment: 'Wheel alignment',
  Electrical: 'Electrical',
  Engine: 'Engine',
  Transmission: 'Transmission',
  Clutch: 'Clutch',
  Other: 'Other'
};

// Typical intervals per service type, used to pre-fill the "next service"
// fields on the record form (M3-M02) so the office is not looking up an oil
// change interval on every job card.
//
// These are suggestions offered at the keyboard, never applied behind the
// user's back: the record stores whatever the workshop actually specified, and
// a fleet running a different schedule simply types its own. A vehicle serviced
// early keeps the date it was given, not the one this table would compute.
//
// `km` null means the item is not sensibly measured in distance (an AC regas is
// a seasonal job), and `months` null likewise.
export const SERVICE_INTERVALS = {
  General: { km: 20000, months: 12 },
  Oil: { km: 10000, months: 6 },
  Filters: { km: 20000, months: 12 },
  Brakes: { km: 30000, months: 12 },
  AC: { km: null, months: 12 },
  Battery: { km: null, months: 24 },
  Suspension: { km: 50000, months: 24 },
  Alignment: { km: 20000, months: 6 },
  Electrical: { km: null, months: 12 },
  Engine: { km: 100000, months: 36 },
  Transmission: { km: 80000, months: 36 },
  Clutch: { km: 80000, months: 24 },
  Other: { km: null, months: null }
};

// --------------------------------------------------------------------------
// M3-M05 — Repair workflow
// --------------------------------------------------------------------------

// The states a repair request moves through. Ordered as the work actually
// happens, because the dashboard counts "open" as everything before the last
// two and the UI renders the stepper straight from this list.
export const REPAIR_STATUSES = [
  'Reported',
  'Approved',
  'In Repair',
  'Waiting Parts',
  'Completed',
  'Cancelled'
];

export const REPAIR_STATUS_LABELS = {
  Reported: 'Reported',
  Approved: 'Approved',
  'In Repair': 'In repair',
  'Waiting Parts': 'Waiting for parts',
  Completed: 'Completed',
  Cancelled: 'Cancelled'
};

// Which states may follow which. Enforced server-side rather than left to the
// UI because the status drives the vehicle's own availability: a request that
// jumped from Reported straight to Completed would leave a vehicle marked
// under repair with nothing left saying why.
//
// 'Waiting Parts' and 'In Repair' go both ways: a job stalls waiting for a
// part, the part arrives, work resumes, and it can stall again on the next
// part. That loop is the normal life of a workshop job, not an exception.
//
// Cancelled is reachable from anything unfinished — a request raised in error,
// or a fault that cleared on its own. Completed is terminal: a job that has to
// be reopened is a new request against the same vehicle, so the cost history
// keeps the two visits separate.
export const REPAIR_TRANSITIONS = {
  Reported: ['Approved', 'Cancelled'],
  Approved: ['In Repair', 'Waiting Parts', 'Cancelled'],
  'In Repair': ['Waiting Parts', 'Completed', 'Cancelled'],
  'Waiting Parts': ['In Repair', 'Completed', 'Cancelled'],
  Completed: [],
  Cancelled: []
};

// Statuses that mean the vehicle is off the road. The dashboard's "under
// repair" count (M3-M01) and the vehicle-availability guard both read this,
// so the two can never disagree about what "under repair" means.
export const ACTIVE_REPAIR_STATUSES = ['Approved', 'In Repair', 'Waiting Parts'];

// Everything not yet finished, including the request nobody has looked at.
export const OPEN_REPAIR_STATUSES = ['Reported', ...ACTIVE_REPAIR_STATUSES];

export const isOpenRepair = (status) => OPEN_REPAIR_STATUSES.includes(status);

// How urgent. Drives the dashboard ordering and nothing else — this module
// deliberately does not auto-escalate on age, because a low-priority job left
// open for a month is usually a job nobody needs, not an emergency.
export const REPAIR_PRIORITIES = ['Low', 'Medium', 'High', 'Critical'];

export const REPAIR_PRIORITY_LABELS = {
  Low: 'Low',
  Medium: 'Medium',
  High: 'High',
  Critical: 'Critical — vehicle grounded'
};

// --------------------------------------------------------------------------
// M3-M06 / M3-M07 — Tyres
// --------------------------------------------------------------------------

// Where a tyre is fitted. Positions are stored as strings rather than an
// enum of fixed slots because axle counts vary across a mixed fleet — a
// two-axle van and a five-axle trailer cannot share one list.
//
// The list below is the common set offered in the picker (M3-M07); a position
// outside it is accepted as typed, which is what "expandable for multiple
// axles" has to mean in practice. `Spare` and `Stock` are the two that are not
// road positions and are treated specially by the wear calculation.
export const TYRE_POSITIONS = [
  'Front Left',
  'Front Right',
  'Axle 2 Left Outer',
  'Axle 2 Left Inner',
  'Axle 2 Right Inner',
  'Axle 2 Right Outer',
  'Axle 3 Left Outer',
  'Axle 3 Left Inner',
  'Axle 3 Right Inner',
  'Axle 3 Right Outer',
  'Rear Left',
  'Rear Right',
  'Spare',
  'Stock'
];

// Positions where a fitted tyre is not accumulating road distance. A spare
// riding under the chassis and a tyre sitting in the store both cover zero
// kilometres, so neither takes odometer movement into its wear figure.
export const NON_RUNNING_TYRE_POSITIONS = ['Spare', 'Stock'];

export const isRunningPosition = (position) =>
  Boolean(position) && !NON_RUNNING_TYRE_POSITIONS.includes(position);

// A tyre's life stage. `Scrapped` and `Sold` are terminal; `Retreaded` is not —
// a retreaded casing goes back on the vehicle and keeps earning kilometres,
// which is exactly why retreading is worth tracking.
export const TYRE_STATUSES = [
  'In Stock',
  'Fitted',
  'Removed',
  'Retreaded',
  'Scrapped',
  'Sold'
];

export const TYRE_STATUS_LABELS = {
  'In Stock': 'In stock',
  Fitted: 'Fitted',
  Removed: 'Removed',
  Retreaded: 'Retreaded',
  Scrapped: 'Scrapped',
  Sold: 'Sold'
};

// Statuses where the tyre is on a vehicle and its odometer is being followed.
export const ON_VEHICLE_TYRE_STATUSES = ['Fitted', 'Retreaded'];

// --------------------------------------------------------------------------
// M3-M09 — Batteries
// --------------------------------------------------------------------------

export const BATTERY_STATUSES = ['In Stock', 'Fitted', 'Removed', 'Scrapped', 'Warranty Claim'];

export const BATTERY_STATUS_LABELS = {
  'In Stock': 'In stock',
  Fitted: 'Fitted',
  Removed: 'Removed',
  Scrapped: 'Scrapped',
  'Warranty Claim': 'Warranty claim'
};

// A battery's measured condition. Voltage alone does not say whether a battery
// is finished — a tired one reads fine at rest and collapses under load — so
// health is recorded as a judgement alongside the reading rather than derived
// from it.
export const BATTERY_HEALTH = ['Good', 'Fair', 'Weak', 'Dead'];

// Nominal voltages seen on commercial vehicles. Offered in the picker; a
// reading is stored as measured.
export const BATTERY_VOLTAGES = [12, 24, 48];

// --------------------------------------------------------------------------
// Money
// --------------------------------------------------------------------------

// How the workshop was paid, mirroring the fuel and trip expense vocabularies
// so a maintenance cost that reaches the ledger does not need translating.
export const PAYMENT_MODES = [
  'Cash',
  'UPI',
  'Card',
  'Bank Transfer',
  'Credit',
  'Company Account'
];

// Who did the work. Kept because the cost reports break down by it (M3-M11)
// and because in-house work has a materially different cost shape — labour is
// already on the payroll — from a job sent to an outside garage.
export const WORKSHOP_TYPES = ['In-house', 'Authorised', 'Local', 'Roadside'];

// --------------------------------------------------------------------------
// M3-M10 — Reminder thresholds
// --------------------------------------------------------------------------

// Shipped defaults for the per-account reminder windows (see
// models/MaintenanceSetting.js). Chosen so a reminder arrives while there is
// still time to book the vehicle in, without it sitting on the dashboard for
// so long that it becomes furniture.
export const DEFAULT_SETTINGS = {
  // Days before a date-based service falls due that it starts showing as
  // upcoming.
  serviceDueDays: 15,
  // Kilometres before a distance-based service falls due, likewise. A truck
  // covering 300 km a day crosses 1000 km in three days, which is enough
  // notice to find a slot without the warning going stale.
  serviceDueKm: 1000,
  // How long after the due date a service keeps being counted as overdue on
  // the dashboard before it is treated as abandoned. It stays on the record
  // either way — this only decides what the tile counts.
  overdueGraceDays: 90,
  // Tyre tread depth in millimetres at which a tyre is called due for
  // replacement. 1.6mm is the common legal minimum, so the default warns
  // above it rather than at it.
  tyreMinTreadMm: 3,
  // Battery age in months at which one is flagged for replacement regardless
  // of how it is reading.
  batteryLifeMonths: 36,
  // Days before a battery warranty expires that it is worth surfacing — a
  // failing battery still inside warranty is a claim, not a purchase.
  warrantyWarnDays: 30
};

// --------------------------------------------------------------------------
// Arithmetic
// --------------------------------------------------------------------------
//
// The same rule as utils/fuel.js: every one of these returns null rather than 0
// when the inputs are missing. "We do not know this tyre's cost per km" and
// "this tyre costs nothing to run" are different facts, and collapsing them
// puts a fabricated zero into a fleet average.

const round = (n, places = 2) => {
  if (!Number.isFinite(n)) return null;
  const f = 10 ** places;
  return Math.round(n * f) / f;
};

const positive = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

const nonNegative = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

// The bill. Parts plus labour plus tax, less any discount — computed here so a
// service record, a repair request and the reports can never each add up a job
// card their own way.
//
// Total is *derived and stored*, not typed: the line items are what the
// workshop invoiced, and a total that disagrees with them is a data-entry
// error rather than a fact worth keeping.
export const computeJobTotal = ({ parts = [], labourCost = 0, taxAmount = 0, discount = 0 } = {}) => {
  const partsTotal = (Array.isArray(parts) ? parts : []).reduce((sum, part) => {
    const qty = nonNegative(part?.quantity) ?? 0;
    const rate = nonNegative(part?.unitPrice) ?? 0;
    return sum + qty * rate;
  }, 0);

  const labour = nonNegative(labourCost) ?? 0;
  const tax = nonNegative(taxAmount) ?? 0;
  const off = nonNegative(discount) ?? 0;

  return {
    partsTotal: round(partsTotal),
    labourCost: round(labour),
    taxAmount: round(tax),
    discount: round(off),
    // Floored at zero: a discount larger than the bill is a typo, and a
    // negative maintenance cost would quietly credit the fleet's cost per km.
    total: round(Math.max(0, partsTotal + labour + tax - off))
  };
};

// M3-M08 — a tyre's cost per kilometre: what it cost, divided by the distance
// it has run. The figure that decides whether the cheap tyre was cheap.
//
// Retreads are included in the cost when they have been recorded, because a
// casing retreaded twice cost what it cost plus both retreads, and comparing
// its per-km figure against a new tyre's is only fair if all of that money is
// counted.
export const computeTyreCostPerKm = ({ price = 0, retreadCost = 0, distanceKm } = {}) => {
  const km = positive(distanceKm);
  const spent = (nonNegative(price) ?? 0) + (nonNegative(retreadCost) ?? 0);
  if (km === null || spent <= 0) return null;
  return round(spent / km, 3);
};

// Maintenance cost per kilometre for a vehicle over a period — the figure that
// belongs beside fuel's cost per km when a rate is being quoted.
export const computeCostPerKm = (cost, distanceKm) => {
  const spent = nonNegative(cost);
  const km = positive(distanceKm);
  if (spent === null || km === null) return null;
  return round(spent / km, 3);
};

// --------------------------------------------------------------------------
// M3-M10 — when the next service falls due
// --------------------------------------------------------------------------

// Days between two dates, positive when `to` is in the future. Null when either
// end is missing, so a service with no due date reports "no date-based due"
// rather than "due today".
export const daysUntil = (to, from = new Date()) => {
  if (!to) return null;
  const target = to instanceof Date ? to : new Date(to);
  if (Number.isNaN(target.getTime())) return null;
  // Compared at day resolution: a service due at 23:00 tonight is due today,
  // not in 0.4 days, and the dashboard counts whole days.
  const a = Date.UTC(target.getFullYear(), target.getMonth(), target.getDate());
  const b = Date.UTC(from.getFullYear(), from.getMonth(), from.getDate());
  return Math.round((a - b) / 86400000);
};

// How a due item stands right now, from whichever of its two clocks is closer.
//
// A service can be due on date, on distance, or on both, and the two disagree
// constantly — a truck doing 400 km a day hits 10,000 km long before six
// months are up, while one parked for the season hits the date first. Whichever
// arrives first is the one that matters, so this reduces both to a single
// verdict and says which clock produced it.
//
// Returns:
//   status  — 'overdue' | 'due' | 'ok' | 'unknown'
//   by      — 'date' | 'km' | null, the clock that decided it
//   days    — days until the due date, negative when past (null if no date)
//   km      — kilometres until the due reading, negative when past (null if none)
export const assessDue = ({
  dueDate = null,
  dueKm = null,
  currentOdometer = null,
  warnDays = DEFAULT_SETTINGS.serviceDueDays,
  warnKm = DEFAULT_SETTINGS.serviceDueKm,
  now = new Date()
} = {}) => {
  const days = daysUntil(dueDate, now);
  const odo = nonNegative(currentOdometer);
  const target = positive(dueKm);
  const km = odo === null || target === null ? null : round(target - odo, 0);

  if (days === null && km === null) {
    return { status: 'unknown', by: null, days: null, km: null };
  }

  // Past due on either clock wins outright: a vehicle 2,000 km past its oil
  // change is overdue even if the date has not arrived.
  if ((days !== null && days < 0) || (km !== null && km < 0)) {
    return {
      status: 'overdue',
      by: days !== null && days < 0 ? 'date' : 'km',
      days,
      km
    };
  }

  const dateSoon = days !== null && days <= warnDays;
  const kmSoon = km !== null && km <= warnKm;

  if (dateSoon || kmSoon) {
    // Which clock is nearer, expressed as a fraction of its own warning
    // window so days and kilometres can be compared at all.
    const dateShare = dateSoon ? days / Math.max(1, warnDays) : Infinity;
    const kmShare = kmSoon ? km / Math.max(1, warnKm) : Infinity;
    return {
      status: 'due',
      by: dateShare <= kmShare ? 'date' : 'km',
      days,
      km
    };
  }

  return { status: 'ok', by: null, days, km };
};

// The next due date/reading implied by a service type's interval, offered as a
// suggestion on the form. Returns nulls where the interval has no such clock.
export const suggestNextService = ({ serviceType, servicedAt = new Date(), odometer = null } = {}) => {
  const interval = SERVICE_INTERVALS[serviceType] || SERVICE_INTERVALS.Other;
  const base = servicedAt instanceof Date ? servicedAt : new Date(servicedAt);
  const odo = nonNegative(odometer);

  let nextDate = null;
  if (interval.months && !Number.isNaN(base.getTime())) {
    nextDate = new Date(base);
    // setMonth rolls over correctly (31 Jan + 1 month lands in early March),
    // which is close enough for a suggested service date and avoids pretending
    // to a precision a workshop schedule does not have.
    nextDate.setMonth(nextDate.getMonth() + interval.months);
  }

  return {
    nextServiceDate: nextDate,
    nextServiceKm: interval.km && odo !== null ? round(odo + interval.km, 0) : null
  };
};

export { round as roundTo, positive as positiveNumber, nonNegative as nonNegativeNumber };
