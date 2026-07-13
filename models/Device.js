import mongoose from 'mongoose';

// A tracked device (a phone running Traccar Client, or a hardware GPS unit).
// `uniqueId` is the identifier configured in the Traccar Client app and is the
// join key between Traccar's own database and ours.
const deviceSchema = new mongoose.Schema({
  uniqueId: {
    type: String,
    required: [true, 'Device uniqueId is required'],
    unique: true,
    trim: true,
    index: true
  },
  name: {
    type: String,
    trim: true,
    default: 'Unnamed device'
  },
  // Traccar's internal numeric device id, learned from the forwarded payload.
  traccarId: {
    type: Number,
    index: true
  },
  // Unset until a user claims the device. Every authenticated device query filters
  // on this, so an unclaimed device is visible to nobody (and shareable by nobody).
  owner: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    index: true
  },
  // Denormalised copy of the newest position so the dashboard and the public
  // tracking page can render without scanning the positions collection.
  lastPosition: {
    latitude: Number,
    longitude: Number,
    speed: Number,        // km/h
    course: Number,       // degrees, 0 = north
    ignition: Boolean,
    fixTime: Date
  },
  lastSeenAt: {
    type: Date,
    index: true
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

// A device is considered online if it reported within the last 2 minutes.
deviceSchema.virtual('status').get(function () {
  if (!this.lastSeenAt) return 'offline';
  const staleMs = Date.now() - this.lastSeenAt.getTime();
  if (staleMs > 2 * 60 * 1000) return 'offline';
  if (this.lastPosition?.speed > 3) return 'moving';
  return 'idle';
});

deviceSchema.set('toJSON', { virtuals: true });

export default mongoose.model('Device', deviceSchema);
