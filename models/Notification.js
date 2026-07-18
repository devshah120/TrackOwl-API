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
    enum: ['critical', 'warning'],
    default: undefined
  },
  title: { type: String, required: true, trim: true },
  message: { type: String, required: true, trim: true },
  vehicle: { type: String, trim: true, default: '' },
  read: { type: Boolean, default: false },
  dedupeKey: { type: String, index: true },

  createdAt: { type: Date, default: Date.now, index: true }
});

// One row per (owner, dedupeKey) — lets the lazy synthesizer upsert instead of
// duplicating an alert every time the condition is re-checked.
notificationSchema.index(
  { owner: 1, dedupeKey: 1 },
  { unique: true, partialFilterExpression: { dedupeKey: { $type: 'string' } } }
);

export default mongoose.model('Notification', notificationSchema);
