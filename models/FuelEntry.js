import mongoose from 'mongoose';
import {
  FUEL_TYPES,
  PAYMENT_MODES,
  FILL_TYPES,
  FLAG_REASONS
} from '../utils/fuel.js';

// One fuelling. The vehicle-centric record of what went into a tank, what it
// cost, and what the odometer read at the time.
//
// This is a master register in its own right rather than a line on a trip.
// A vehicle is fuelled whether or not it is on a job — a yard top-up between
// trips, a fill on the way back empty — and the fleet's mileage history is only
// continuous if every one of those is recorded. Hanging fuel off TripOrder
// would lose exactly the fillings that fall between trips, and the odometer
// chain that mileage is computed from would then have holes in it.
//
// Its relationship to the trip expense line is one-way and explicit: when
// `trip` is set, services/fuelTripSync.js writes a matching `fuel` expense onto
// that TripOrder and stores the line's id in `tripExpenseId`. The entry here is
// the source of truth; the expense line is a projection of it kept in step so
// trip profitability stays correct without anyone typing the bill twice.

// The scanned bill. Same data-URI storage as LedgerEntry.receipt and
// TripOrder.expenses[].receipt — the browser downscales before sending, and
// the sizes involved do not justify a separate file store.
const receiptSchema = new mongoose.Schema(
  {
    dataUrl: { type: String, default: '' },
    filename: { type: String, trim: true, default: '' },
    mimeType: { type: String, trim: true, default: '' }
  },
  { _id: false }
);

// Where the fuel was bought. Free text plus optional coordinates rather than a
// station master: a fleet buys from hundreds of pumps it will never visit
// twice, and forcing each to be created before a bill can be entered would put
// a data-entry chore in front of every receipt.
//
// `name` is what the reports group by, so it is normalised on write (see
// utils/fuelFields.js) — otherwise "HP Petrol Pump" and "hp petrol pump " would
// be two stations in the station-wise report.
const stationSchema = new mongoose.Schema(
  {
    name: { type: String, trim: true, default: '' },
    code: { type: String, trim: true, default: '' },      // pump/vendor code on the bill
    city: { type: String, trim: true, default: '' },
    state: { type: String, trim: true, default: '' },
    lat: { type: Number, default: null },
    lng: { type: Number, default: null }
  },
  { _id: false }
);

// A raised outlier flag (M3-F06). Several can apply to one entry — a mis-keyed
// odometer typically trips both the efficiency and the rollback rules — so this
// is an array rather than a single verdict.
//
// The threshold and observed values are stored alongside the reason because the
// thresholds are per-account and editable: without them, an entry flagged under
// last quarter's settings could not be explained today.
const flagSchema = new mongoose.Schema(
  {
    reason: { type: String, enum: FLAG_REASONS, required: true },
    message: { type: String, trim: true, default: '' },
    // What was measured, what it was compared against, and by how far it
    // missed. All three so the reports can sort by severity without recomputing.
    observed: { type: Number, default: null },
    baseline: { type: Number, default: null },
    deviationPct: { type: Number, default: null },
    raisedAt: { type: Date, default: Date.now }
  },
  { _id: false }
);

const fuelEntrySchema = new mongoose.Schema({
  // Scoped to the account exactly like every other business record here.
  owner: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },

  // --- M3-F01: what was filled, when, into what ---------------------------

  // The vehicle is the one thing a fuel entry cannot be without: it is what
  // makes the odometer chain and every efficiency figure possible.
  truck: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Truck',
    required: true,
    index: true
  },
  // The plate as it read on the day. Denormalised for the same reason
  // TripOrder does it: a vehicle re-registered later must not silently rewrite
  // the fuel history of the vehicle it used to be.
  vehicleNumber: { type: String, trim: true, uppercase: true, default: '' },

  // Who filled it. Optional — a workshop hand or the owner can fuel a vehicle,
  // and a bill with no driver against it is still a real bill.
  driver: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Driver',
    default: null,
    index: true
  },
  driverName: { type: String, trim: true, default: '' },

  // When the fuel actually went in, not when the row was typed. Indexed with
  // the vehicle because almost every query here is "this vehicle, in date
  // order" — that is what the odometer chain walks.
  filledAt: { type: Date, required: true, default: Date.now, index: true },

  station: { type: stationSchema, default: () => ({}) },

  // --- M3-F02: fuel type, quantity, rate, amount --------------------------

  fuelType: { type: String, enum: FUEL_TYPES, required: true, index: true },
  // The unit `quantity` is expressed in, copied from FUEL_UNITS at write time.
  // Stored rather than looked up so a historic CNG entry still reads in kg if
  // the unit table is ever revised.
  unit: { type: String, trim: true, default: 'L' },

  // Quantity to three places: CNG and AdBlue bills routinely carry them.
  quantity: {
    type: Number,
    required: true,
    min: [0, 'Quantity cannot be negative']
  },
  // Price per unit. Derived from amount/quantity when the bill does not print
  // it — see reconcileAmount in utils/fuel.js.
  rate: { type: Number, min: [0, 'Rate cannot be negative'], default: null },
  // What was actually paid. This is the figure the ledger and the cost reports
  // use: it is the money that left the account, rounding at the pump included.
  amount: {
    type: Number,
    required: true,
    min: [0, 'Amount cannot be negative']
  },

  // Whether the tank was brimmed. Drives which entries can anchor a
  // full-to-full mileage measurement.
  fillType: { type: String, enum: FILL_TYPES, default: 'full' },

  // Odometer at the pump, in kilometres — the same unit as Truck.odometer.
  // Optional, because a bill can be entered days later by someone who does not
  // have the reading; an entry without one is costed normally but cannot
  // measure mileage, and says so rather than guessing.
  odometer: { type: Number, min: [0, 'Odometer cannot be negative'], default: null },

  paymentMode: { type: String, enum: PAYMENT_MODES, default: 'Cash' },
  // Bill/invoice number printed on the receipt, for reconciling against a fuel
  // card statement.
  billNumber: { type: String, trim: true, default: '' },
  receipt: { type: receiptSchema, default: () => ({}) },

  // --- Links ---------------------------------------------------------------

  // The trip this fuelling belongs to, when it belongs to one. Optional by
  // design: see the note at the top.
  trip: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'TripOrder',
    default: null,
    index: true
  },
  // The id of the expense line this entry maintains on that trip. Held so the
  // sync can update or remove exactly the line it created, and never touch a
  // fuel expense someone added by hand on the trip itself.
  tripExpenseId: { type: mongoose.Schema.Types.ObjectId, default: null },

  remarks: { type: String, trim: true, default: '' },

  // --- M3-F03/F04/F05: computed efficiency --------------------------------
  //
  // Computed server-side by services/fuelEfficiency.js from this entry and the
  // previous one for the same vehicle, then stored. Stored rather than derived
  // on read so the list and the reports can sort and filter on mileage without
  // walking every vehicle's history on every request — the same trade
  // TripOrder.totals makes.
  //
  // All null until there is a previous odometer reading to measure against, so
  // the first entry for a vehicle reports no mileage rather than a fabricated
  // one.
  efficiency: {
    // Kilometres covered since the previous filling.
    distanceKm: { type: Number, default: null },
    // M3-F03. Distance per unit: KM/L, km/kg or km/kWh depending on fuel type.
    kmPerUnit: { type: Number, default: null },
    // M3-F04. Fuel cost per kilometre.
    costPerKm: { type: Number, default: null },
    // M3-F05. Units per 100 km.
    unitsPer100Km: { type: Number, default: null },
    // The entry this was measured from, so the figure can be explained.
    previousEntry: { type: mongoose.Schema.Types.ObjectId, ref: 'FuelEntry', default: null },
    previousOdometer: { type: Number, default: null },
    // How many fillings the distance spans. 1 for a clean full-to-full
    // measurement; more when partial fills sit in between and their fuel had to
    // be rolled in. Surfaced so a reader knows how the number was arrived at.
    fillsSpanned: { type: Number, default: null },
    // Whether this is a true full-to-full measurement. A figure computed across
    // a partial fill is an estimate, and the UI marks it as one.
    measured: { type: Boolean, default: false },
    computedAt: { type: Date, default: null }
  },

  // --- M3-F06: outlier flags ----------------------------------------------

  flags: { type: [flagSchema], default: [] },
  // Denormalised so the list can filter on "show me the flagged ones" with an
  // index rather than an array scan.
  isFlagged: { type: Boolean, default: false, index: true },
  // An operator can dismiss a flag they have looked into. The flag stays on the
  // record — it happened — but it stops counting as outstanding.
  reviewedAt: { type: Date, default: null },
  reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  reviewNote: { type: String, trim: true, default: '' },

  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

// The odometer chain. Every efficiency computation asks "the entry for this
// vehicle immediately before this date", and the reports walk a vehicle's
// fillings in order — this index serves both.
fuelEntrySchema.index({ owner: 1, truck: 1, filledAt: -1 });

// The register itself: the account's fillings, newest first.
fuelEntrySchema.index({ owner: 1, filledAt: -1 });

// The station-wise and flagged-entry reports.
fuelEntrySchema.index({ owner: 1, 'station.name': 1, filledAt: -1 });
fuelEntrySchema.index({ owner: 1, isFlagged: 1, filledAt: -1 });

fuelEntrySchema.pre('save', function (next) {
  this.updatedAt = new Date();
  // isFlagged is never set by hand: it is exactly "there is at least one flag",
  // kept in one place so the index cannot drift from the array it summarises.
  this.isFlagged = (this.flags || []).length > 0;
  next();
});

fuelEntrySchema.set('toJSON', { virtuals: true });

export default mongoose.model('FuelEntry', fuelEntrySchema);
