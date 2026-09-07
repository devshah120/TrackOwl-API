// The Trip Management vocabulary and its rules. Kept in one module so the
// model, the routes, the audit labels and the /options endpoint that feeds the
// frontend all read the same lists instead of each re-declaring them.
//
// This is the operational trip — the job the office dispatches. It is
// deliberately separate from two records that already existed:
//
//   Trip.js        the GPS route drawn on the map, and the trail the vehicle
//                  actually drove. A TripOrder points at one via `route`.
//   BillingTrip.js the LR and tax invoice paperwork. A TripOrder points at one
//                  via `billingTrip`.
//
// Neither is modified by this module; both are linked to, so the journey, its
// paperwork and its GPS record stay one thing without any of the three having
// to know the internals of the others.

// ---------------------------------------------------------------------------
// Trip types
// ---------------------------------------------------------------------------

// What shape of job this is. Stored as the machine value; TRIP_TYPE_LABELS
// carries what the operator reads.
export const TRIP_TYPES = [
  'local',
  'one_way',
  'round_trip',
  'multi_stop',
  'dedicated',
  'return_load',
  'empty_return',
  'delivery',
  'pickup',
  'intercity',
  'interstate'
];

export const TRIP_TYPE_LABELS = {
  local: 'Local',
  one_way: 'One-way',
  round_trip: 'Round-trip',
  multi_stop: 'Multi-stop',
  dedicated: 'Dedicated',
  return_load: 'Return-load',
  empty_return: 'Empty-return',
  delivery: 'Delivery',
  pickup: 'Pickup',
  intercity: 'Intercity',
  interstate: 'Interstate'
};

// ---------------------------------------------------------------------------
// Trip status
// ---------------------------------------------------------------------------

// The full operational lifecycle. Ordering here is the natural forward path,
// which is what the detail page's progress strip walks.
export const TRIP_STATUSES = [
  'draft',
  'planned',
  'assigned',
  'ready',
  'dispatched',
  'in_transit',
  'at_pickup',
  'loading',
  'loaded',
  'at_destination',
  'unloading',
  'delivered',
  'completed',
  'cancelled',
  'on_hold'
];

export const TRIP_STATUS_LABELS = {
  draft: 'Draft',
  planned: 'Planned',
  assigned: 'Assigned',
  ready: 'Ready',
  dispatched: 'Dispatched',
  in_transit: 'In Transit',
  at_pickup: 'At Pickup',
  loading: 'Loading',
  loaded: 'Loaded',
  at_destination: 'At Destination',
  unloading: 'Unloading',
  delivered: 'Delivered',
  completed: 'Completed',
  cancelled: 'Cancelled',
  on_hold: 'On Hold'
};

// Statuses that mean the trip is over. No further movement is recorded against
// them, and they are excluded from the "already busy" checks when assigning a
// vehicle or driver to something else.
export const TERMINAL_STATUSES = ['completed', 'cancelled'];

// Statuses where the vehicle is out on the job. This is what makes a vehicle or
// driver busy: a trip in any of these holds its resources, so assigning the
// same truck to a second trip is refused. `dispatched` counts — the vehicle has
// left the yard even if no GPS fix has arrived yet.
export const ACTIVE_STATUSES = [
  'dispatched',
  'in_transit',
  'at_pickup',
  'loading',
  'loaded',
  'at_destination',
  'unloading'
];

// The legacy 4-value vocabulary on models/Trip.js, which the GPS trail and the
// public tracking page still read. A TripOrder drives its linked Trip through
// this map so those two features keep behaving exactly as before — the mapping
// is one-way, and Trip's own enum is never widened.
export const LEGACY_TRIP_STATUS = {
  draft: 'planned',
  planned: 'planned',
  assigned: 'planned',
  ready: 'planned',
  dispatched: 'active',
  in_transit: 'active',
  at_pickup: 'active',
  loading: 'active',
  loaded: 'active',
  at_destination: 'active',
  unloading: 'active',
  delivered: 'active',
  completed: 'completed',
  cancelled: 'cancelled',
  on_hold: 'planned'
};

// Which statuses a trip may move to from where it is. A transition missing from
// this map is refused, which is what stops a trip being marked Delivered
// straight out of Draft — the checklist, the dispatch and the pickup would all
// be skipped, and the audit trail would have no record of them happening.
//
// Three rules run through it:
//   * `cancelled` and `on_hold` are reachable from any live status (see
//     canTransition), so they are not repeated in every row.
//   * `completed` is only reachable from `delivered`: a trip is finished by
//     closing it out after the goods land, never directly from the road.
//   * Terminal statuses lead nowhere. Reopening a completed trip is not an
//     edit, it is a new trip.
export const STATUS_TRANSITIONS = {
  draft: ['planned', 'assigned'],
  planned: ['assigned', 'draft'],
  assigned: ['ready', 'planned'],
  ready: ['dispatched', 'assigned'],
  dispatched: ['in_transit', 'at_pickup', 'ready'],
  in_transit: ['at_pickup', 'at_destination', 'loading', 'unloading'],
  at_pickup: ['loading', 'in_transit'],
  loading: ['loaded', 'at_pickup'],
  loaded: ['in_transit', 'at_destination'],
  at_destination: ['unloading', 'in_transit'],
  unloading: ['delivered', 'at_destination'],
  delivered: ['completed', 'unloading'],
  completed: [],
  cancelled: [],
  on_hold: []
};

// Statuses a trip may be put on hold or cancelled from — anything that has not
// already finished. Held separately from STATUS_TRANSITIONS because they are
// escapes from the flow rather than steps along it.
const INTERRUPTIBLE = TRIP_STATUSES.filter(
  (s) => !TERMINAL_STATUSES.includes(s) && s !== 'on_hold'
);

// May this trip move from `from` to `to`? Returns a reason string when it may
// not, so the route can say why rather than just refusing.
//
// Coming off hold is the one transition that cannot be answered from `from`
// alone: the trip resumes wherever it was before, which the caller supplies as
// `resumeTo` (the status stamped when it was held). Falling back to 'planned'
// keeps a trip recoverable even if that record is missing.
export const canTransition = (from, to, { resumeTo = null } = {}) => {
  if (!TRIP_STATUSES.includes(to)) return `"${to}" is not a valid trip status`;
  if (from === to) return null; // re-sending the same status is a no-op, not an error

  if (TERMINAL_STATUSES.includes(from)) {
    return `A ${TRIP_STATUS_LABELS[from].toLowerCase()} trip cannot change status`;
  }

  if (to === 'cancelled') {
    return INTERRUPTIBLE.includes(from) || from === 'on_hold'
      ? null
      : `A trip cannot be cancelled from ${TRIP_STATUS_LABELS[from]}`;
  }

  if (to === 'on_hold') {
    return INTERRUPTIBLE.includes(from)
      ? null
      : `A trip cannot be put on hold from ${TRIP_STATUS_LABELS[from]}`;
  }

  // Leaving a hold: only back to where it was held, so time on hold cannot be
  // used to skip a step in the flow.
  if (from === 'on_hold') {
    const target = resumeTo || 'planned';
    return to === target
      ? null
      : `This trip was held at ${TRIP_STATUS_LABELS[target]} and can only resume there`;
  }

  const allowed = STATUS_TRANSITIONS[from] || [];
  return allowed.includes(to)
    ? null
    : `A trip cannot go from ${TRIP_STATUS_LABELS[from]} to ${TRIP_STATUS_LABELS[to]}`;
};

// ---------------------------------------------------------------------------
// Stops
// ---------------------------------------------------------------------------

export const STOP_TYPES = ['pickup', 'delivery', 'via', 'rest', 'fuel', 'checkpoint'];

export const STOP_TYPE_LABELS = {
  pickup: 'Pickup',
  delivery: 'Delivery',
  via: 'Via',
  rest: 'Rest',
  fuel: 'Fuel',
  checkpoint: 'Checkpoint'
};

// A stop's own progress, independent of the trip's. 'skipped' is a real outcome
// rather than a deletion: a stop the driver was told to bypass is part of what
// happened on the trip and belongs in the record.
export const STOP_STATUSES = ['pending', 'arrived', 'completed', 'skipped'];

export const STOP_STATUS_LABELS = {
  pending: 'Pending',
  arrived: 'Arrived',
  completed: 'Completed',
  skipped: 'Skipped'
};

// ---------------------------------------------------------------------------
// Cargo
// ---------------------------------------------------------------------------

// Packaging unit for a cargo line's `quantity`. Weight carries its own unit
// (always kg here) so a count of boxes is never mistaken for a mass.
export const CARGO_UNITS = [
  'Boxes',
  'Bags',
  'Pallets',
  'Drums',
  'Crates',
  'Rolls',
  'Bundles',
  'Pieces',
  'Nos',
  'Kg',
  'Litres',
  'Tonnes'
];

// ---------------------------------------------------------------------------
// Revenue and expenses
// ---------------------------------------------------------------------------

// What the customer is billed for. `discount` and `tax` are signed differently
// from the rest — see computeRevenue in services/tripFinance.js — which is why
// they are named here rather than left as free text.
export const REVENUE_CATEGORIES = [
  'freight',
  'loading',
  'unloading',
  'detention',
  'waiting',
  'extra_km',
  'other',
  'discount',
  'tax'
];

export const REVENUE_CATEGORY_LABELS = {
  freight: 'Freight',
  loading: 'Loading',
  unloading: 'Unloading',
  detention: 'Detention',
  waiting: 'Waiting',
  extra_km: 'Extra KM',
  other: 'Other',
  discount: 'Discount',
  tax: 'Tax'
};

// What the trip cost to run.
export const EXPENSE_CATEGORIES = [
  'fuel',
  'toll',
  'parking',
  'driver_allowance',
  'food',
  'hotel',
  'loading',
  'unloading',
  'repair',
  'tyre',
  'permit',
  'challan',
  'miscellaneous'
];

export const EXPENSE_CATEGORY_LABELS = {
  fuel: 'Fuel',
  toll: 'Toll',
  parking: 'Parking',
  driver_allowance: 'Driver Allowance',
  food: 'Food',
  hotel: 'Hotel',
  loading: 'Loading',
  unloading: 'Unloading',
  repair: 'Repair',
  tyre: 'Tyre',
  permit: 'Permit',
  challan: 'Challan',
  miscellaneous: 'Miscellaneous'
};

export const PAYMENT_MODES = [
  'Cash',
  'UPI',
  'Card',
  'Bank Transfer',
  'Fuel Card',
  'Credit',
  'Company Account'
];

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export const EVENT_TYPES = [
  'overspeed',
  'idle',
  'geofence',
  'route_deviation',
  'unexpected_stop',
  'offline',
  'status_change',
  'manual'
];

export const EVENT_TYPE_LABELS = {
  overspeed: 'Overspeed',
  idle: 'Idle',
  geofence: 'Geofence',
  route_deviation: 'Route Deviation',
  unexpected_stop: 'Unexpected Stop',
  offline: 'Offline',
  status_change: 'Status Change',
  manual: 'Manual Event'
};

export const EVENT_SEVERITIES = ['info', 'warning', 'critical'];

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

export const TRIP_DOCUMENT_TYPES = [
  'lr',
  'invoice',
  'eway_bill',
  'pod',
  'challan',
  'po',
  'receipt',
  'other'
];

export const TRIP_DOCUMENT_TYPE_LABELS = {
  lr: 'Lorry Receipt',
  invoice: 'Invoice',
  eway_bill: 'E-way Bill',
  pod: 'Proof of Delivery',
  challan: 'Challan',
  po: 'Purchase Order',
  receipt: 'Receipt',
  other: 'Other'
};

// ---------------------------------------------------------------------------
// Crew
// ---------------------------------------------------------------------------

export const CREW_ROLES = ['secondary_driver', 'helper', 'cleaner', 'other'];

export const CREW_ROLE_LABELS = {
  secondary_driver: 'Secondary Driver',
  helper: 'Helper',
  cleaner: 'Cleaner',
  other: 'Other Crew'
};

// ---------------------------------------------------------------------------
// Dispatch checklist
// ---------------------------------------------------------------------------

// The pre-departure checks. `mandatory` is what makes dispatch possible: a trip
// cannot leave the yard with one of these unticked, while the rest are recorded
// for the file but never block.
//
// Cargo is not mandatory because an empty-return leg legitimately carries none;
// the cargo-against-capacity check that does matter runs in the assignment
// validator instead.
export const CHECKLIST_ITEMS = [
  { key: 'vehicle', label: 'Vehicle inspected and roadworthy', mandatory: true },
  { key: 'driver', label: 'Driver briefed and fit to drive', mandatory: true },
  { key: 'documents', label: 'Vehicle and driver documents valid', mandatory: true },
  { key: 'fuel', label: 'Fuel level recorded', mandatory: false },
  { key: 'odometer', label: 'Starting odometer recorded', mandatory: true },
  { key: 'inspection', label: 'Pre-trip inspection completed', mandatory: false },
  { key: 'cargo', label: 'Cargo loaded and secured', mandatory: false },
  { key: 'acknowledgement', label: 'Driver acknowledgement taken', mandatory: true }
];

export const CHECKLIST_KEYS = CHECKLIST_ITEMS.map((i) => i.key);
export const MANDATORY_CHECKLIST_KEYS = CHECKLIST_ITEMS.filter((i) => i.mandatory).map((i) => i.key);
