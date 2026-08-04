import mongoose from 'mongoose';

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
  salary: Number, // monthly salary

  // The driver shown wherever a screen still has room for only one (fleet
  // table, LR/invoice defaults). Exactly one driver per truck should carry
  // this; setPrimaryDriver() in routes/drivers.js enforces that.
  isPrimary: { type: Boolean, default: false },

  createdAt: { type: Date, default: Date.now }
});

// The fleet list and the truck editor both fetch drivers truck-by-truck.
driverSchema.index({ owner: 1, truck: 1 });

export default mongoose.model('Driver', driverSchema);
