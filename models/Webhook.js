import mongoose from 'mongoose';

// An outbound integration: TrackOwl POSTs a JSON event to this URL whenever
// one of the subscribed events happens in the account. This is how the app
// talks to everything else — an ERP or Tally bridge, a WhatsApp/SMS gateway,
// Zapier/Make, a customer's own portal — without a bespoke connector for each.
//
// Each delivery is signed with HMAC-SHA256 over the raw body using `secret`
// (header X-TrackOwl-Signature: sha256=<hex>), so the receiver can prove the
// request came from TrackOwl. See services/webhooks.js.

export const WEBHOOK_EVENTS = [
  'alert.created',
  'trip.status_changed',
  'trip.closed',
  'invoice.created',
  'invoice.payment_received'
];

export const WEBHOOK_EVENT_LABELS = {
  'alert.created': 'Any new alert (GPS, geofence, route, expiry, maintenance)',
  'trip.status_changed': 'Trip status changed',
  'trip.closed': 'Trip settled and closed',
  'invoice.created': 'Invoice raised',
  'invoice.payment_received': 'Payment received on an invoice'
};

const webhookSchema = new mongoose.Schema({
  owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  name: { type: String, required: true, trim: true },
  url: { type: String, required: true, trim: true },
  events: { type: [String], enum: WEBHOOK_EVENTS, default: [] },
  // Never returned in full after creation — the list shows the last 4 chars.
  secret: { type: String, required: true },
  active: { type: Boolean, default: true },

  lastDeliveredAt: { type: Date, default: null },
  lastStatus: { type: Number, default: null },
  lastError: { type: String, default: '' },
  // Consecutive failures. At 20 the hook is switched off so a dead endpoint
  // is not hammered forever; fixing it and re-enabling resets the count.
  failures: { type: Number, default: 0 },

  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  createdAt: { type: Date, default: Date.now }
});

export default mongoose.model('Webhook', webhookSchema);
