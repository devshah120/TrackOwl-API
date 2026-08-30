import mongoose from 'mongoose';

// The device master vocabularies. Exported so routes and the frontend read the
// same lists instead of re-declaring them.

// What kind of unit this is. 'hardware' is a wired GPS tracker (Teltonika and
// friends) identified by its IMEI; 'phone' is a handset running Traccar Client,
// identified by a generated device id.
export const DEVICE_TYPES = ['hardware', 'phone'];

// Lifecycle status of the physical unit — deliberately distinct from the
// `status` virtual below, which is live telemetry (moving/idle/offline). A unit
// can be 'Active' in the master and 'offline' on the map at the same time: the
// first says it is in service, the second says it has not reported lately.
//
// 'In Stock' is bought but not yet fitted; 'Active' is fitted and in service;
// 'Faulty' is fitted but not reporting correctly; 'Repair' is pulled out for
// service; 'Retired' is written off and excluded from counts.
export const DEVICE_LIFECYCLE_STATUSES = ['In Stock', 'Active', 'Faulty', 'Repair', 'Retired'];

// A tracked device (a phone running Traccar Client, or a hardware GPS unit).
// `uniqueId` is the identifier configured in the Traccar Client app — or the
// IMEI for hardware — and is the join key between Traccar's own database and
// ours.
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

  // --- Device master ----------------------------------------------------
  // The hardware asset record: what the unit is, what SIM is in it, when it
  // was fitted and to which vehicle. `uniqueId` above is its gateway identity;
  // everything here describes the physical box so it can be tracked, serviced
  // and audited independently of the telemetry it produces.
  // Both registration paths write this explicitly, so it is only defaulted for
  // records predating the master. Derived from the uniqueId rather than assumed:
  // a hardware unit's uniqueId is its IMEI, a phone's is a generated 'trk-…' id,
  // which is the same rule registerDevice() applies. Assuming 'hardware' here
  // would relabel every legacy phone on read, since Mongoose fills defaults in
  // even for fields the document never stored.
  deviceType: {
    type: String,
    enum: DEVICE_TYPES,
    default: function () {
      return /^\d{15,17}$/.test(String(this.uniqueId || '')) ? 'hardware' : 'phone';
    }
  },
  // The unit's IMEI. For hardware this is the same value as `uniqueId` (the
  // IMEI *is* the gateway identity), but it is stored separately because a
  // phone-based device has an IMEI of its own that is not its device id.
  imei: { type: String, trim: true, default: '' },
  // Hardware model, e.g. FMB920, GT06N.
  model: { type: String, trim: true, default: '' },
  manufacturer: { type: String, trim: true, default: '' },
  firmwareVersion: { type: String, trim: true, default: '' },

  // The data SIM fitted to the unit. Kept on the device rather than in its own
  // master because a SIM lives and dies with the box it is sealed into.
  sim: {
    number: { type: String, trim: true, default: '' },      // MSISDN / mobile number
    iccid: { type: String, trim: true, default: '' },       // printed on the SIM
    provider: { type: String, trim: true, default: '' },    // Airtel, Jio, Vi, ...
    plan: { type: String, trim: true, default: '' },
    validTill: Date
  },

  // Fitment. `vehicle` mirrors Truck.device — the two are kept in step by the
  // admin device routes so neither side can point at a stale partner.
  vehicle: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Truck',
    default: null,
    index: true
  },
  installedAt: Date,
  installedBy: { type: String, trim: true, default: '' },
  notes: { type: String, trim: true, default: '' },

  // Lifecycle status of the box itself — see DEVICE_LIFECYCLE_STATUSES.
  lifecycleStatus: {
    type: String,
    enum: DEVICE_LIFECYCLE_STATUSES,
    default: 'Active'
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
