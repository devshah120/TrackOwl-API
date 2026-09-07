import mongoose from 'mongoose';
import {
  TRIP_TYPES,
  TRIP_STATUSES,
  STOP_TYPES,
  STOP_STATUSES,
  CARGO_UNITS,
  REVENUE_CATEGORIES,
  EXPENSE_CATEGORIES,
  PAYMENT_MODES,
  EVENT_TYPES,
  EVENT_SEVERITIES,
  TRIP_DOCUMENT_TYPES,
  CREW_ROLES,
  CHECKLIST_KEYS
} from '../utils/tripOrders.js';

// The operational trip — the job the office plans, dispatches, tracks and
// closes out. This is the record Trip Management works on.
//
// Three trip-shaped records now exist, and they are deliberately distinct:
//
//   TripOrder (here)  the job: who it is for, what it carries, who drives it,
//                     what it earned and what it cost.
//   Trip.js           the GPS route drawn on the map and the trail actually
//                     driven. Linked via `route`; its 4-value status enum is
//                     left untouched and driven through LEGACY_TRIP_STATUS.
//   BillingTrip.js    the LR and tax invoice paperwork. Linked via
//                     `billingTrip`; its embedded consignor/consignee blocks are
//                     what the printed documents render from, so they are not
//                     migrated here.
//
// Everything that already had a master is referenced, never copied: customer,
// truck, driver and crew are all ObjectId refs. The few denormalised fields
// that do exist (`vehicleNumber`, `driverName`, the odometer readings) are
// point-in-time facts about this trip — what the plate read on the day, what
// the odometer showed at the gate — and would be wrong if they followed a later
// edit to the master.

// A place on the trip. Same { name, lat, lng } core as Trip.js's placeSchema so
// a TripOrder route can be handed straight to the existing map components, plus
// the postal and contact detail an operational stop needs.
//
// Coordinates are optional here, unlike on Trip.js: an operator can type a
// pickup address the Places search has never heard of, and the trip must still
// save. It simply will not be drawable until coordinates are added.
const locationSchema = new mongoose.Schema(
  {
    name: { type: String, trim: true, default: '' },
    address: { type: String, trim: true, default: '' },
    city: { type: String, trim: true, default: '' },
    state: { type: String, trim: true, default: '' },
    pincode: { type: String, trim: true, default: '' },
    contactName: { type: String, trim: true, default: '' },
    contactPhone: { type: String, trim: true, default: '' },
    lat: { type: Number, default: null },
    lng: { type: Number, default: null },
    notes: { type: String, trim: true, default: '' }
  },
  { _id: false }
);

// Proof that goods changed hands. Used both on the trip as a whole and on an
// individual stop, because a multi-drop trip is signed for once per drop.
//
// `deliveredQuantity` is against the cargo total; `shortage` and `damage` are
// recorded rather than derived, since a receiver can sign for a short delivery
// without anyone knowing which line it came out of.
const podSchema = new mongoose.Schema(
  {
    arrivedAt: { type: Date, default: null },
    unloadingStartedAt: { type: Date, default: null },
    unloadingEndedAt: { type: Date, default: null },
    deliveredQuantity: { type: Number, min: 0, default: null },
    shortage: { type: Number, min: 0, default: 0 },
    damage: { type: Number, min: 0, default: 0 },
    receiverName: { type: String, trim: true, default: '' },
    receiverPhone: { type: String, trim: true, default: '' },
    remarks: { type: String, trim: true, default: '' },
    // Signature and photo are data URIs, the same storage choice as
    // VehicleDocument.attachment and LedgerEntry.receipt — the browser
    // downscales before sending and the sizes involved do not justify a
    // separate file store.
    signature: { type: String, default: '' },
    photo: { type: String, default: '' },
    capturedAt: { type: Date, default: null },
    capturedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
  },
  { _id: false }
);

// One stop on the route. Stops carry their own _id (unlike the schemas above)
// because the API addresses them individually — arrive, complete, skip and POD
// all target one stop.
const stopSchema = new mongoose.Schema({
  // Position in travel order, 1-based. Maintained by the route layer on every
  // add/delete/reorder so it is always dense and matches array order.
  sequence: { type: Number, required: true, min: 1 },
  stopType: { type: String, enum: STOP_TYPES, default: 'via' },
  location: { type: locationSchema, default: () => ({}) },

  // Planned arrival, then what actually happened.
  eta: { type: Date, default: null },
  arrivedAt: { type: Date, default: null },
  departedAt: { type: Date, default: null },

  // What is picked up or dropped here, in the cargo's own units. Both may be
  // set at a stop that swaps part of a load.
  loadingQuantity: { type: Number, min: 0, default: null },
  unloadingQuantity: { type: Number, min: 0, default: null },

  status: { type: String, enum: STOP_STATUSES, default: 'pending' },
  notes: { type: String, trim: true, default: '' },
  pod: { type: podSchema, default: () => ({}) }
});

// One line of freight. A trip carries several, and the totals across them are
// what gets compared against the vehicle's capacity.
const cargoSchema = new mongoose.Schema({
  cargoType: { type: String, trim: true, default: '' },
  description: { type: String, trim: true, default: '' },
  quantity: { type: Number, min: 0, default: 0 },
  unit: { type: String, enum: CARGO_UNITS, default: 'Boxes' },
  // Fixed units across the fleet — kilograms and cubic metres — matching
  // Truck.capacity so the comparison needs no conversion.
  weightKg: { type: Number, min: 0, default: 0 },
  volumeM3: { type: Number, min: 0, default: 0 },
  packages: { type: Number, min: 0, default: 0 },
  boxes: { type: Number, min: 0, default: 0 },
  specialInstructions: { type: String, trim: true, default: '' }
});

// A billable line. Amount is always stored positive; how it acts on the total
// is decided by its category (discount subtracts), never by a negative number
// sneaking in from the client.
const revenueSchema = new mongoose.Schema({
  category: { type: String, enum: REVENUE_CATEGORIES, required: true },
  description: { type: String, trim: true, default: '' },
  amount: { type: Number, required: true, min: [0, 'Amount cannot be negative'] },
  createdAt: { type: Date, default: Date.now },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
});

// What the trip cost to run. `receipt` is the scanned bill, stored the same way
// as the ledger's.
const expenseSchema = new mongoose.Schema({
  category: { type: String, enum: EXPENSE_CATEGORIES, required: true },
  description: { type: String, trim: true, default: '' },
  amount: { type: Number, required: true, min: [0, 'Amount cannot be negative'] },
  spentAt: { type: Date, default: Date.now },
  paidBy: { type: String, trim: true, default: '' },       // driver, office, card
  paymentMode: { type: String, enum: PAYMENT_MODES, default: 'Cash' },
  vendor: { type: String, trim: true, default: '' },
  // Litres and rate for a fuel line. Held here rather than in `description` so
  // fuel cost per km can be computed without parsing text.
  litres: { type: Number, min: 0, default: null },
  odometer: { type: Number, min: 0, default: null },
  receipt: {
    dataUrl: { type: String, default: '' },
    filename: { type: String, trim: true, default: '' },
    mimeType: { type: String, trim: true, default: '' }
  },
  createdAt: { type: Date, default: Date.now },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
});

// Something that happened on the trip. Written both by the system (a status
// change, a detected deviation) and by hand, which is why `source` exists —
// an operator reading the timeline needs to know whether the machine observed
// it or a person typed it.
const eventSchema = new mongoose.Schema({
  eventType: { type: String, enum: EVENT_TYPES, required: true },
  severity: { type: String, enum: EVENT_SEVERITIES, default: 'info' },
  message: { type: String, trim: true, default: '' },
  occurredAt: { type: Date, default: Date.now },
  lat: { type: Number, default: null },
  lng: { type: Number, default: null },
  source: { type: String, enum: ['system', 'manual'], default: 'system' },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
});

// A file attached to the trip. Mirrors VehicleDocument's attachment shape so
// the same upload component and the same size guard serve both.
const documentSchema = new mongoose.Schema({
  docType: { type: String, enum: TRIP_DOCUMENT_TYPES, default: 'other' },
  title: { type: String, trim: true, default: '' },
  documentNumber: { type: String, trim: true, default: '' },
  dataUrl: { type: String, default: '' },
  filename: { type: String, trim: true, default: '' },
  mimeType: { type: String, trim: true, default: '' },
  uploadedAt: { type: Date, default: Date.now },
  uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
});

// Every status the trip has been through, in order. Written by the status
// route on each accepted transition — this is the trip's own history, distinct
// from the account-wide AuditLog, and it is what the timeline renders from.
const statusHistorySchema = new mongoose.Schema(
  {
    from: { type: String, default: '' },
    to: { type: String, required: true },
    at: { type: Date, default: Date.now },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    byName: { type: String, trim: true, default: '' },
    reason: { type: String, trim: true, default: '' },
    lat: { type: Number, default: null },
    lng: { type: Number, default: null }
  },
  { _id: false }
);

// Extra people on board beyond the primary driver. `employee` points at the
// Driver roster where the person is on it; `name` covers a casual helper who is
// not, so crew can be recorded without polluting the driver master.
const crewSchema = new mongoose.Schema(
  {
    role: { type: String, enum: CREW_ROLES, default: 'helper' },
    employee: { type: mongoose.Schema.Types.ObjectId, ref: 'Driver', default: null },
    name: { type: String, trim: true, default: '' },
    mobile: { type: String, trim: true, default: '' }
  },
  { _id: false }
);

// One pre-departure check: ticked or not, by whom and when. Keys come from
// CHECKLIST_ITEMS; the mandatory ones gate dispatch.
const checklistItemSchema = new mongoose.Schema(
  {
    key: { type: String, enum: CHECKLIST_KEYS, required: true },
    checked: { type: Boolean, default: false },
    checkedAt: { type: Date, default: null },
    checkedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    notes: { type: String, trim: true, default: '' }
  },
  { _id: false }
);

// Odometer and fuel at one end of the trip, with where and when it was taken.
// The pair of these is what actual distance is computed from, so a reading is
// never stored without its timestamp.
const readingSchema = new mongoose.Schema(
  {
    at: { type: Date, default: null },
    odometer: { type: Number, min: 0, default: null },
    fuelLevel: { type: Number, min: 0, max: 100, default: null }, // percent
    lat: { type: Number, default: null },
    lng: { type: Number, default: null },
    location: { type: String, trim: true, default: '' },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
  },
  { _id: false }
);

const tripOrderSchema = new mongoose.Schema({
  // Scoped to the account exactly like every other business record here.
  owner: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },

  // Human key, generated server-side per account (TRP-2026-0001). Never taken
  // from the client — see services/tripNumber.js.
  tripNumber: { type: String, required: true, trim: true, uppercase: true },

  tripDate: { type: Date, required: true, default: Date.now, index: true },
  tripType: { type: String, enum: TRIP_TYPES, default: 'one_way', index: true },

  status: {
    type: String,
    enum: TRIP_STATUSES,
    default: 'draft',
    index: true
  },
  // Where a held trip goes back to when it resumes. Stamped when the trip is
  // put on hold and cleared when it leaves; without it, coming off hold would
  // have to guess a status and could silently skip a step.
  heldFrom: { type: String, enum: TRIP_STATUSES, default: null },

  statusHistory: { type: [statusHistorySchema], default: [] },

  // --- Customer -----------------------------------------------------------
  customer: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Customer',
    default: null,
    index: true
  },
  // The customer's own paperwork numbers for this job. Free text: they follow
  // whatever format the counterparty uses.
  customerReferences: {
    po: { type: String, trim: true, default: '' },
    bookingNumber: { type: String, trim: true, default: '' },
    customerRef: { type: String, trim: true, default: '' },
    invoiceRef: { type: String, trim: true, default: '' }
  },

  // --- Route --------------------------------------------------------------
  pickup: { type: locationSchema, default: () => ({}) },
  destination: { type: locationSchema, default: () => ({}) },
  // Planned times for the two ends. Intermediate stops carry their own ETAs.
  pickupPlannedAt: { type: Date, default: null },
  destinationExpectedAt: { type: Date, default: null },

  stops: { type: [stopSchema], default: [] },

  // --- Assignment ---------------------------------------------------------
  truck: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Truck',
    default: null,
    index: true
  },
  // The plate as it read when this trip ran. Denormalised on purpose: a truck
  // re-registered later must not silently rewrite the history of trips it
  // already completed.
  vehicleNumber: { type: String, trim: true, uppercase: true, default: '' },

  driver: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Driver',
    default: null,
    index: true
  },
  driverName: { type: String, trim: true, default: '' },

  crew: { type: [crewSchema], default: [] },

  // --- Load ---------------------------------------------------------------
  cargo: { type: [cargoSchema], default: [] },

  // LR / consignment references for this trip.
  consignment: {
    lrNumber: { type: String, trim: true, default: '' },
    consignmentNumber: { type: String, trim: true, default: '' },
    ewayBill: { type: String, trim: true, default: '' },
    invoiceNumber: { type: String, trim: true, default: '' },
    challanNumber: { type: String, trim: true, default: '' },
    poNumber: { type: String, trim: true, default: '' },
    deliveryOrder: { type: String, trim: true, default: '' }
  },

  // --- Money --------------------------------------------------------------
  revenue: { type: [revenueSchema], default: [] },
  expenses: { type: [expenseSchema], default: [] },

  // Totals are recomputed server-side from the two arrays above on every write
  // that touches them (see services/tripFinance.js). Stored rather than derived
  // on read so the trip list can sort and filter on profit without loading
  // every line of every trip.
  totals: {
    revenue: { type: Number, default: 0 },
    expenses: { type: Number, default: 0 },
    profit: { type: Number, default: 0 },
    marginPct: { type: Number, default: 0 }
  },

  // --- Execution ----------------------------------------------------------
  start: { type: readingSchema, default: () => ({}) },
  end: { type: readingSchema, default: () => ({}) },

  // Planned distance and time, from the route. Actuals are computed from the
  // odometer pair and the start/end timestamps.
  plannedKm: { type: Number, min: 0, default: null },
  plannedMinutes: { type: Number, min: 0, default: null },
  actualKm: { type: Number, min: 0, default: null },
  actualMinutes: { type: Number, min: 0, default: null },

  checklist: { type: [checklistItemSchema], default: [] },
  dispatchedAt: { type: Date, default: null },
  dispatchedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

  // Trip-level proof of delivery. A multi-drop trip signs per stop as well;
  // this is the final one.
  pod: { type: podSchema, default: () => ({}) },

  events: { type: [eventSchema], default: [] },
  documents: { type: [documentSchema], default: [] },

  // --- Links to the records that already existed ---------------------------
  // The GPS route/trail record. Created alongside the trip when the assigned
  // vehicle has a tracker and both ends have coordinates; null otherwise, and
  // the tracking tab then reports tracking as unavailable rather than inventing
  // a position.
  route: { type: mongoose.Schema.Types.ObjectId, ref: 'Trip', default: null },
  // The LR/invoice paperwork, when it has been raised for this trip.
  billingTrip: { type: mongoose.Schema.Types.ObjectId, ref: 'BillingTrip', default: null },

  notes: { type: String, trim: true, default: '' },

  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

// The trip number is unique per account, not globally — two customers can each
// have their own TRP-2026-0001. Partial filter keeps the index from tripping
// over any legacy row without a number.
tripOrderSchema.index(
  { owner: 1, tripNumber: 1 },
  { unique: true, partialFilterExpression: { tripNumber: { $type: 'string' } } }
);

// The trip list is the account's trips newest first, usually narrowed by
// status; the assignment guard looks up live trips for one vehicle or driver.
tripOrderSchema.index({ owner: 1, tripDate: -1 });
tripOrderSchema.index({ owner: 1, status: 1, tripDate: -1 });
tripOrderSchema.index({ owner: 1, truck: 1, status: 1 });
tripOrderSchema.index({ owner: 1, driver: 1, status: 1 });

tripOrderSchema.pre('save', function (next) {
  this.updatedAt = new Date();
  next();
});

tripOrderSchema.set('toJSON', { virtuals: true });

export default mongoose.model('TripOrder', tripOrderSchema);
