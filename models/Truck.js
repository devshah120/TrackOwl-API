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

// The vehicle master vocabularies. Exported so routes, scripts and the admin
// stats endpoint all read the same lists instead of re-declaring them, and so
// the frontend can be fed them from one place.
export const VEHICLE_TYPES = [
  'Truck',
  'Trailer',
  'Tanker',
  'Container',
  'Tipper',
  'Pickup',
  'Van',
  'Bus',
  'Other'
];

export const FUEL_TYPES = ['Diesel', 'Petrol', 'CNG', 'LNG', 'Electric', 'Hybrid'];

export const BODY_TYPES = [
  'Open',
  'Closed',
  'Flatbed',
  'Tanker',
  'Container',
  'Tipper',
  'Refrigerated',
  'Other'
];

// Operational status. 'Active' means in service but not currently on a trip;
// 'In Transit' is on a running trip; 'Idle' is parked and available;
// 'Maintenance' is off the road being worked on; 'Offline' has lost telemetry;
// 'Inactive' is retired or sold and excluded from fleet counts.
export const VEHICLE_STATUSES = [
  'Active',
  'Idle',
  'In Transit',
  'Maintenance',
  'Offline',
  'Inactive'
];

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
  // --- Vehicle master ---------------------------------------------------
  // Identity and classification. `number` above is the registration; the rest
  // of the master describes what the vehicle *is*, as opposed to what it is
  // doing right now (status) or carrying (capacity).
  vehicleType: {
    type: String,
    enum: VEHICLE_TYPES,
    default: 'Truck'
  },
  make: { type: String, trim: true, default: '' },       // e.g. Tata, Ashok Leyland
  manufactureYear: {
    type: Number,
    min: [1980, 'Manufacture year looks too old'],
    // Next year is allowed: dealers register the coming model year early.
    max: [new Date().getFullYear() + 1, 'Manufacture year cannot be in the future']
  },
  fuelType: {
    type: String,
    enum: FUEL_TYPES,
    default: 'Diesel'
  },

  // Odometer in kilometres. Monotonic in practice, so updates guard against
  // a lower reading (see routes/trucks.js) rather than trusting the client.
  odometer: {
    type: Number,
    min: [0, 'Odometer cannot be negative'],
    default: 0
  },

  // What the vehicle can legally and physically carry. Units are fixed so the
  // numbers stay comparable across the fleet without per-record conversion:
  // weight in kilograms, volume in cubic metres.
  capacity: {
    weightKg: { type: Number, min: [0, 'Capacity weight cannot be negative'], default: null },
    volumeM3: { type: Number, min: [0, 'Capacity volume cannot be negative'], default: null },
    bodyType: { type: String, enum: BODY_TYPES, default: 'Open' }
  },

  // Purchase details — what it cost and where it came from. Kept here rather
  // than in the ledger because these are properties of the asset, not
  // transactions against it.
  purchase: {
    date: Date,
    price: { type: Number, min: [0, 'Purchase price cannot be negative'], default: null },
    vendor: { type: String, trim: true, default: '' },
    financedBy: { type: String, trim: true, default: '' } // bank / NBFC, blank if owned outright
  },

  status: {
    type: String,
    enum: VEHICLE_STATUSES,
    default: 'Idle'
  },
  currentRoute: { type: String, trim: true, default: '' },
  driver: legacyDriverSchema,

  // The GPS unit fitted to this truck, if it has one. A truck carries at most
  // one tracker, so the link lives here as a single ref rather than a list.
  // Optional: plenty of trucks are managed on paperwork alone, and those simply
  // never appear on the live map.
  device: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Device',
    default: null,
    index: true
  },

  createdAt: { type: Date, default: Date.now }
});

export default mongoose.model('Truck', truckSchema);
