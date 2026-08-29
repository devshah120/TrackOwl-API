import mongoose from 'mongoose';

// The driver roster vocabulary. Exported so routes and the frontend options
// endpoint read one list instead of each re-declaring it.
//
// 'On Trip' is set by trip assignment rather than typed by hand, but it is a
// valid stored value like any other — the driver screen shows it read-only-ish
// and never blocks an operator from correcting it.
export const DRIVER_STATUSES = [
  'Available',
  'On Trip',
  'Off Duty',
  'Leave',
  'Inactive'
];

// Who to call if something happens on the road. Kept as a subdocument rather
// than three flat fields so the trio stays together and an empty contact is
// simply an empty object instead of three stray nulls.
const emergencyContactSchema = new mongoose.Schema(
  {
    name: { type: String, trim: true, default: '' },
    relation: { type: String, trim: true, default: '' },
    mobile: { type: String, trim: true, default: '' }
  },
  { _id: false }
);

// Drivers are their own collection rather than embedded in Truck: a truck can
// carry several drivers, and a driver outlives any one assignment (reassigned
// between trucks, or kept on the roster while unassigned). `truck` is therefore
// nullable — an unassigned driver is a valid record, not an orphan.
const driverSchema = new mongoose.Schema({
  owner: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  truck: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Truck',
    default: null,
    index: true
  },
  name: { type: String, required: true, trim: true },
  mobile: {
    type: String,
    required: true,
    match: [/^\d{10}$/, 'Mobile must be a valid 10-digit number']
  },
  licenseNumber: { type: String, trim: true, default: '' },
  licenseExpiry: Date,
  joiningDate: Date,
  salary: Number, // monthly salary
  emergencyContact: { type: emergencyContactSchema, default: () => ({}) },

  // Roster availability. Defaults to Available so a driver added mid-shift is
  // immediately assignable without an extra edit.
  status: {
    type: String,
    enum: DRIVER_STATUSES,
    default: 'Available',
    index: true
  },

  // The driver shown wherever a screen still has room for only one (fleet
  // table, LR/invoice defaults). Exactly one driver per truck should carry
  // this; setPrimaryDriver() in routes/drivers.js enforces that.
  isPrimary: { type: Boolean, default: false },

  createdAt: { type: Date, default: Date.now }
});

// The fleet list and the truck editor both fetch drivers truck-by-truck.
driverSchema.index({ owner: 1, truck: 1 });

export default mongoose.model('Driver', driverSchema);
