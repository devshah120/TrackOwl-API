import mongoose from 'mongoose';

// A named area on the map that the alert engine watches vehicles cross — a
// customer's warehouse, the company yard, a toll plaza, a no-go zone.
//
// Two shapes: a circle (centre + radius, the quick way to fence a depot) and a
// polygon (for a site that is long and thin, or sits beside a highway a circle
// would swallow). Evaluated in services/gpsAlerts.js on every valid fix.
//
// `vehicles` narrows which trucks it applies to; empty means every vehicle in
// the account. `customer` is a label for the office ("this is Reliance's
// Bhiwandi DC") and a filter on the list — it does not restrict anything.

export const GEOFENCE_SHAPES = ['circle', 'polygon'];

export const GEOFENCE_CATEGORIES = ['customer', 'yard', 'warehouse', 'fuel_station', 'toll', 'restricted', 'other'];

export const GEOFENCE_CATEGORY_LABELS = {
  customer: 'Customer site',
  yard: 'Own yard / depot',
  warehouse: 'Warehouse',
  fuel_station: 'Fuel station',
  toll: 'Toll plaza',
  restricted: 'Restricted area',
  other: 'Other'
};

const pointSchema = new mongoose.Schema(
  {
    lat: { type: Number, required: true, min: -90, max: 90 },
    lng: { type: Number, required: true, min: -180, max: 180 }
  },
  { _id: false }
);

const geofenceSchema = new mongoose.Schema({
  owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

  name: { type: String, required: true, trim: true },
  category: { type: String, enum: GEOFENCE_CATEGORIES, default: 'other' },
  color: { type: String, trim: true, default: '#2563eb' },

  shape: { type: String, enum: GEOFENCE_SHAPES, default: 'circle' },
  center: { type: pointSchema, default: null },
  // Metres. Floor of 50 m: below that, ordinary GPS scatter would have a parked
  // vehicle "entering" and "leaving" all night.
  radiusM: { type: Number, min: 50, max: 100000, default: 500 },
  polygon: { type: [pointSchema], default: [] },

  vehicles: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Truck' }],
  customer: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', default: null },

  alertOnEntry: { type: Boolean, default: true },
  alertOnExit: { type: Boolean, default: true },
  // Alert once a vehicle has stayed inside this long. Null = no dwell alert.
  dwellAlertMinutes: { type: Number, min: 1, default: null },

  active: { type: Boolean, default: true, index: true },
  notes: { type: String, trim: true, default: '' },

  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

geofenceSchema.index({ owner: 1, name: 1 });

export default mongoose.model('Geofence', geofenceSchema);
