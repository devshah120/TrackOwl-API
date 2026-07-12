import mongoose from 'mongoose';

// One GPS fix, as forwarded by Traccar. Traccar sends speed in knots and keeps
// ignition/battery/motion inside a loose `attributes` bag; we normalise the
// fields we care about into real columns and keep the raw bag for anything else.
const positionSchema = new mongoose.Schema({
  device: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Device',
    required: true
  },
  deviceUniqueId: {
    type: String,
    required: true
  },
  latitude: {
    type: Number,
    required: true,
    min: -90,
    max: 90
  },
  longitude: {
    type: Number,
    required: true,
    min: -180,
    max: 180
  },
  speed: {
    type: Number,       // km/h (converted from Traccar's knots)
    default: 0
  },
  course: {
    type: Number,       // heading in degrees
    default: 0
  },
  altitude: Number,
  accuracy: Number,
  ignition: {
    type: Boolean,
    default: false
  },
  battery: Number,      // percent, when the phone reports it
  motion: Boolean,
  valid: {
    type: Boolean,
    default: true
  },
  protocol: String,
  // Time the fix was taken on the device, vs. when we received it.
  fixTime: {
    type: Date,
    required: true
  },
  serverTime: {
    type: Date,
    default: Date.now
  },
  // Everything else Traccar sent, unmodified.
  attributes: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  }
});

// The dominant query is "latest fixes for this device, newest first".
positionSchema.index({ device: 1, fixTime: -1 });

export default mongoose.model('Position', positionSchema);
