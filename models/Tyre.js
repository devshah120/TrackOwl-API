import mongoose from 'mongoose';
import { TYRE_STATUSES, isRunningPosition } from '../utils/maintenance.js';

// M3-M06 / M3-M07 / M3-M08 — the tyre master.
//
// A tyre is an asset, not an event. It is bought, fitted to a position on a
// vehicle, rotated to other positions, taken off, sometimes retreaded and put
// back, and eventually scrapped — and the whole point of tracking it is to
// learn what it cost per kilometre over that life (M3-M08). That is why this
// is its own collection with its own history, rather than a line on a service
// record: a tyre outlives the visit that fitted it.
//
// Distance is the hard part. A tyre has no odometer of its own, so the
// kilometres it has run are accumulated from the vehicle's odometer across
// every stint it spent fitted to a running position. `runningKm` below is that
// accumulated total, and services/tyreTracking.js is what maintains it.

// One stint on a vehicle: fitted here, at this reading, until removed there.
// Kept as history rather than overwritten because a tyre moved between axles
// (a rotation) has run different distances at different positions, and the
// wear pattern is the reason anyone rotates them.
const fitmentSchema = new mongoose.Schema(
  {
    truck: { type: mongoose.Schema.Types.ObjectId, ref: 'Truck', default: null },
    vehicleNumber: { type: String, trim: true, uppercase: true, default: '' },
    position: { type: String, trim: true, default: '' },

    fittedAt: { type: Date, default: Date.now },
    // The vehicle's odometer when the tyre went on. The distance this stint
    // contributed is (removedOdometer − fittedOdometer), so a stint with either
    // end missing contributes nothing rather than a guess.
    fittedOdometer: { type: Number, min: 0, default: null },

    removedAt: { type: Date, default: null },
    removedOdometer: { type: Number, min: 0, default: null },

    // What this stint added to the tyre's running total, computed when the
    // stint closes. Stored so the total can be audited against the stints that
    // make it up.
    distanceKm: { type: Number, min: 0, default: null },

    // Tread measured when the tyre came off, if it was measured.
    treadAtRemovalMm: { type: Number, min: 0, default: null },
    reason: { type: String, trim: true, default: '' },
    notes: { type: String, trim: true, default: '' }
  },
  { _id: true }
);

// A retread. Each one costs money and buys more life, and both facts belong in
// the cost-per-km figure — see computeTyreCostPerKm.
const retreadSchema = new mongoose.Schema(
  {
    date: { type: Date, default: Date.now },
    vendor: { type: String, trim: true, default: '' },
    cost: { type: Number, min: 0, default: 0 },
    // The tyre's running total at the moment it went for retreading, so the
    // life earned by each retread can be separated from the original casing's.
    atKm: { type: Number, min: 0, default: null },
    notes: { type: String, trim: true, default: '' }
  },
  { _id: true }
);

const tyreSchema = new mongoose.Schema({
  owner: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },

  // --- M3-M06: identity ---------------------------------------------------

  // The fleet's own number for the tyre, stencilled on the sidewall. This is
  // what a workshop hand reads out, so it is the field the list searches on and
  // it is unique within the account.
  tyreNumber: { type: String, trim: true, uppercase: true, required: true },

  brand: { type: String, trim: true, default: '' },
  model: { type: String, trim: true, default: '' },
  // e.g. 295/80 R22.5. Free text: sizes are written a dozen ways and an enum
  // would reject the one printed on the tyre in front of the user.
  size: { type: String, trim: true, default: '' },
  // The manufacturer's serial / DOT code. Distinct from tyreNumber, which is
  // the fleet's own tag.
  serialNumber: { type: String, trim: true, uppercase: true, default: '' },

  purchaseDate: { type: Date, default: null },
  purchaseFrom: { type: String, trim: true, default: '' },
  invoiceNumber: { type: String, trim: true, default: '' },
  price: { type: Number, min: [0, 'Price cannot be negative'], default: 0 },
  warrantyMonths: { type: Number, min: 0, default: null },
  // Manufacturer's rated life, when the supplier quotes one. Purely a
  // comparison point for the cost-per-km report — nothing is enforced against
  // it, because a tyre that beat its rating is good news, not an error.
  ratedKm: { type: Number, min: 0, default: null },

  // --- M3-M07: where it is now --------------------------------------------

  status: { type: String, enum: TYRE_STATUSES, default: 'In Stock', index: true },

  // The vehicle and position it is fitted to right now, null when it is not
  // fitted. Denormalised from the open fitment below so the list and the
  // vehicle's tyre layout can be read without unwinding history on every row.
  truck: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Truck',
    default: null,
    index: true
  },
  vehicleNumber: { type: String, trim: true, uppercase: true, default: '' },
  position: { type: String, trim: true, default: '' },
  fittedAt: { type: Date, default: null },

  // --- M3-M08: life and cost ----------------------------------------------

  // Kilometres this tyre has run, accumulated across closed fitments plus the
  // open one's progress. Maintained by services/tyreTracking.js.
  runningKm: { type: Number, min: 0, default: 0 },

  // Cost per kilometre: (price + retreads) / runningKm. Stored so the list can
  // sort on it; recomputed whenever runningKm or the costs move. Null until the
  // tyre has actually run somewhere — a brand-new tyre does not cost infinity
  // per kilometre, it has no figure yet.
  costPerKm: { type: Number, default: null },

  // Latest tread reading, and when it was taken. The replacement reminder
  // (M3-M10) compares this against the account's minimum.
  treadDepthMm: { type: Number, min: 0, default: null },
  treadCheckedAt: { type: Date, default: null },

  fitments: { type: [fitmentSchema], default: [] },
  retreads: { type: [retreadSchema], default: [] },
  // Sum of the retread costs, denormalised so the cost figure does not have to
  // reduce the array on every read.
  retreadCost: { type: Number, min: 0, default: 0 },

  // Where the tyre ended up, for the ones that are finished.
  removedAt: { type: Date, default: null },
  scrapReason: { type: String, trim: true, default: '' },
  // What it fetched if it was sold on. Not netted off the cost per km: that
  // figure is what the tyre cost to run, and a scrap sale is a separate
  // recovery the ledger records.
  salvageValue: { type: Number, min: 0, default: null },

  notes: { type: String, trim: true, default: '' },

  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

// The tyre number is how the fleet refers to a tyre, so it must not repeat
// within an account. Scoped to the owner rather than global — two fleets
// numbering their tyres from 1 is normal.
tyreSchema.index({ owner: 1, tyreNumber: 1 }, { unique: true });

// The vehicle's current tyre layout (M3-M07), which is read every time a
// vehicle is opened.
tyreSchema.index({ owner: 1, truck: 1, position: 1 });

// The register and the replacement-due query.
tyreSchema.index({ owner: 1, status: 1, treadDepthMm: 1 });
tyreSchema.index({ owner: 1, createdAt: -1 });

// Is this tyre currently accumulating road distance? A spare bolted under the
// chassis is fitted but running nothing, and the distance tracker checks this
// before adding odometer movement to it.
tyreSchema.virtual('isRunning').get(function () {
  return Boolean(this.truck) && isRunningPosition(this.position);
});

tyreSchema.pre('save', function (next) {
  this.updatedAt = new Date();
  next();
});

tyreSchema.set('toJSON', { virtuals: true });

export default mongoose.model('Tyre', tyreSchema);
