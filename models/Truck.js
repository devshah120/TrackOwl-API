import mongoose from 'mongoose';

// A truck's driver, captured on the same form as the truck itself. Strictly
// 1:1 with a truck in the current UI — no independent driver lifecycle, so
// this stays embedded rather than a separate collection (same pattern as
// Trip.js's placeSchema).
const driverSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    mobile: {
      type: String,
      required: true,
      match: [/^\d{10}$/, 'Mobile must be a valid 10-digit number']
    },
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
  driver: driverSchema,

  createdAt: { type: Date, default: Date.now }
});

export default mongoose.model('Truck', truckSchema);
