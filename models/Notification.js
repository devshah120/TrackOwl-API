import mongoose from 'mongoose';

// A notification shown in the bell dropdown. `dedupeKey`, when set, stops a
// recurring condition (offline device, expiring insurance) from spawning a new
// row every time it's noticed — the lazy synthesizer upserts on this key instead
// of blindly inserting.
const notificationSchema = new mongoose.Schema({
  owner: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  type: {
    type: String,
    enum: ['alert', 'event'],
    required: true
  },
  severity: {
    type: String,
    enum: ['critical', 'warning', 'info'],
    default: undefined
  },
  // What raised it — lets the Alerts screen filter "overspeed only" or
  // "compliance only". Older rows predate this and carry ''.
  category: { type: String, trim: true, default: '', index: true },
  title: { type: String, required: true, trim: true },
  message: { type: String, required: true, trim: true },
  vehicle: { type: String, trim: true, default: '' },
  read: { type: Boolean, default: false },
  // "Seen" and "dealt with" are different: an expiring permit is read the day
  // it appears and acknowledged when somebody has actually booked the renewal.
  acknowledgedAt: { type: Date, default: null },
  acknowledgedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  acknowledgedByName: { type: String, trim: true, default: '' },
  // Where the alert happened, for GPS-raised alerts.
  lat: { type: Number, default: null },
  lng: { type: Number, default: null },
  dedupeKey: { type: String, index: true },
  // When the background scheduler handed this alert to email / webhooks.
  // Null = not yet delivered. See services/scheduler.js.
  deliveredAt: { type: Date, default: null },

  createdAt: { type: Date, default: Date.now, index: true }
});

// One row per (owner, dedupeKey) — lets the lazy synthesizer upsert instead of
// duplicating an alert every time the condition is re-checked.
notificationSchema.index(
  { owner: 1, dedupeKey: 1 },
  { unique: true, partialFilterExpression: { dedupeKey: { $type: 'string' } } }
);

export default mongoose.model('Notification', notificationSchema);
