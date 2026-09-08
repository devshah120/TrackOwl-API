import mongoose from 'mongoose';
import { BATTERY_STATUSES, BATTERY_HEALTH } from '../utils/maintenance.js';

// M3-M09 — the battery master.
//
// The same asset shape as the tyre: bought, fitted to a vehicle, monitored,
// replaced. It is a separate collection rather than a `type` on Tyre because
// what makes a battery due for replacement has nothing to do with distance —
// a battery dies of age and of how it is charged, not of kilometres — so it
// carries voltage and health readings where a tyre carries tread and running
// kilometres, and neither set means anything on the other.
//
// A commercial vehicle usually carries two batteries wired in series, so
// several rows can point at one truck at once. `position` distinguishes them.

// One voltage/health check. Kept as history rather than only the latest reading
// because a battery's decline is the signal — a single reading says little,
// three readings falling over six weeks says the battery is finished.
const checkSchema = new mongoose.Schema(
  {
    date: { type: Date, default: Date.now },
    // Resting voltage as measured. Stored as read rather than judged, because
    // what counts as low depends on the nominal voltage and the temperature.
    voltage: { type: Number, min: 0, default: null },
    // The tester's verdict, which is not derivable from the voltage above — a
    // tired battery reads fine at rest and collapses under load.
    health: { type: String, enum: BATTERY_HEALTH, default: null },
    // Specific gravity, where a hydrometer was used on a serviceable battery.
    specificGravity: { type: Number, min: 0, default: null },
    checkedBy: { type: String, trim: true, default: '' },
    notes: { type: String, trim: true, default: '' }
  },
  { _id: true }
);

const batterySchema = new mongoose.Schema({
  owner: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },

  // --- Identity -----------------------------------------------------------

  // The manufacturer's serial. Unlike a tyre, a battery carries no fleet tag in
  // common practice, so the serial is the identifier — and it is required,
  // because a battery master with unidentifiable rows cannot support a warranty
  // claim, which is most of the point of keeping one.
  serialNumber: { type: String, trim: true, uppercase: true, required: true },

  brand: { type: String, trim: true, default: '' },
  model: { type: String, trim: true, default: '' },

  // Nominal voltage of the battery itself (12V, 24V), as distinct from the
  // measured readings in `checks`.
  voltage: { type: Number, min: 0, default: 12 },
  // Rated capacity in amp-hours.
  capacityAh: { type: Number, min: 0, default: null },

  purchaseDate: { type: Date, default: null },
  purchaseFrom: { type: String, trim: true, default: '' },
  invoiceNumber: { type: String, trim: true, default: '' },
  cost: { type: Number, min: [0, 'Cost cannot be negative'], default: 0 },

  warrantyMonths: { type: Number, min: 0, default: null },
  // Computed from the purchase date and the warranty months on write, so the
  // "in warranty" filter and the expiry reminder are one indexed comparison
  // rather than an arithmetic expression per row.
  warrantyExpiry: { type: Date, default: null, index: true },

  // --- Where it is --------------------------------------------------------

  status: { type: String, enum: BATTERY_STATUSES, default: 'In Stock', index: true },

  truck: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Truck',
    default: null,
    index: true
  },
  vehicleNumber: { type: String, trim: true, uppercase: true, default: '' },
  // Which of the vehicle's batteries this is — commonly 'Battery 1' / 'Battery
  // 2'. Free text for the same reason tyre positions are.
  position: { type: String, trim: true, default: '' },

  installedAt: { type: Date, default: null },
  installedOdometer: { type: Number, min: 0, default: null },

  // --- Condition ----------------------------------------------------------

  checks: { type: [checkSchema], default: [] },
  // The latest check, denormalised so the list can show and sort on current
  // health without unwinding the array.
  lastCheckedAt: { type: Date, default: null },
  lastVoltage: { type: Number, default: null },
  health: { type: String, enum: [...BATTERY_HEALTH, null], default: null, index: true },

  // When it was taken off, and why.
  removedAt: { type: Date, default: null },
  removalReason: { type: String, trim: true, default: '' },
  // The battery that took its place, so a vehicle's battery history reads as a
  // chain rather than a set of unconnected rows.
  replacedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Battery', default: null },

  // Expected replacement date. Either set by hand or derived from the purchase
  // date and the account's battery life setting; stored either way so the
  // reminder query is indexable.
  expectedReplacementDate: { type: Date, default: null, index: true },

  notes: { type: String, trim: true, default: '' },

  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

// A serial identifies a battery, so it must not repeat within an account.
batterySchema.index({ owner: 1, serialNumber: 1 }, { unique: true });

// The vehicle's fitted batteries, read whenever a vehicle is opened.
batterySchema.index({ owner: 1, truck: 1, status: 1 });

// The register and the replacement-due query.
batterySchema.index({ owner: 1, status: 1, expectedReplacementDate: 1 });
batterySchema.index({ owner: 1, createdAt: -1 });

batterySchema.pre('save', function (next) {
  this.updatedAt = new Date();

  // Warranty expiry follows the purchase date and the warranty term. Kept in
  // the model rather than the field builder because the two inputs can each be
  // set from different places (a purchase correction, a warranty extension) and
  // the derived date must never be left describing an older pair.
  if (this.purchaseDate && this.warrantyMonths) {
    const expiry = new Date(this.purchaseDate);
    expiry.setMonth(expiry.getMonth() + this.warrantyMonths);
    this.warrantyExpiry = expiry;
  } else {
    this.warrantyExpiry = null;
  }

  next();
});

batterySchema.set('toJSON', { virtuals: true });

export default mongoose.model('Battery', batterySchema);
