import mongoose from 'mongoose';

// Legacy single-driver shape. Drivers now live in their own collection (see
// models/Driver.js) because a truck can carry several of them, but this stays
// so records written before the migration are still readable — and so
// scripts/migrateDrivers.js has something to migrate from. Nothing writes it
// any more; reads go through utils/drivers.js attachDrivers(), which fills
// `driver` with the truck's primary Driver document.
const legacyDriverSchema = new mongoose.Schema(
  {
    name: { type: String, trim: true },
    mobile: String,
    licenseNumber: { type: String, trim: true, default: '' },
    licenseExpiry: Date,
    salary: Number // monthly salary
  },
  { _id: false }
);

const truckSchema = new mongoose.Schema({
  owner: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  number: { type: String, required: true, trim: true, uppercase: true }, // e.g. MH-01-AB-1234
  model: { type: String, required: true, trim: true },
  registrationDate: Date,
  insuranceExpiry: Date,
  status: {
    type: String,
    enum: ['Running', 'Idle', 'Stopped'],
    default: 'Idle'
  },
  currentRoute: { type: String, trim: true, default: '' },
  driver: legacyDriverSchema,

  createdAt: { type: Date, default: Date.now }
});

export default mongoose.model('Truck', truckSchema);
