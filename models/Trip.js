import mongoose from 'mongoose';

// A planned journey for one device: where it's going from and to. The origin and
// destination are captured as a place name plus coordinates (resolved by the
// frontend via a Places search), so the map can draw a "from → to" road route
// without re-geocoding on every view.
const placeSchema = new mongoose.Schema(
  {
    name: { type: String, trim: true, required: true }, // human label, e.g. "Mumbai, Maharashtra"
    lat: { type: Number, required: true },
    lng: { type: Number, required: true }
  },
  { _id: false }
);

const tripSchema = new mongoose.Schema({
  device: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Device',
    required: true,
    index: true
  },
  // Scopes every trip to the fleet owner, exactly like Device.owner. A trip is
  // shareable publicly, so it must never be visible to another account.
  owner: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  origin: { type: placeSchema, required: true },
  destination: { type: placeSchema, required: true },

  // Cached OSRM road geometry as an array of [lat, lng] points, so the map draws
  // the route instantly and the public page doesn't hammer the routing service.
  // Optional: a trip is still valid if routing was unavailable at creation.
  routePolyline: {
    type: [[Number]],
    default: undefined
  },
  distanceKm: Number,      // route distance, from OSRM
  durationMin: Number,     // estimated drive time, from OSRM

  status: {
    type: String,
    enum: ['planned', 'active', 'completed', 'cancelled'],
    default: 'active',
    index: true
  },
  note: { type: String, trim: true, default: '' },

  createdAt: { type: Date, default: Date.now }
});

tripSchema.set('toJSON', { virtuals: true });

export default mongoose.model('Trip', tripSchema);
