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
    default: 'planned',
    index: true
  },
  note: { type: String, trim: true, default: '' },

  createdAt: { type: Date, default: Date.now },

  // When the user explicitly started the trip. Set on the transition into
  // 'active', and used as the lower bound of the GPS fixes that make up the
  // trip's actual-path trail — fixes before this moment belong to a previous
  // journey, not this one.
  startedAt: { type: Date, default: null },

  // When the trip actually finished. Set on the transition into 'completed', and
  // used to bound the GPS fixes that make up the trip's actual-path trail — past
  // this moment the device's fixes belong to some later journey, not this one.
  completedAt: { type: Date, default: null }
});

tripSchema.set('toJSON', { virtuals: true });

export default mongoose.model('Trip', tripSchema);
