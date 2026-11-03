import mongoose from 'mongoose';

// One account's plan: which plan, until when, and how it got there. Keyed by
// the account (the owner seat's user id), exactly like every business record.
//
// Status, derived from the dates by services/subscriptions.js:
//   trialing   inside the free trial
//   active     inside a paid (or Super-Admin-granted) period
//   grace      period over, inside the grace days — still usable, nagged
//   expired    past grace — blocked until it pays
//   cancelled  switched off by the Super Admin
//
// Payments are prepaid: each successful Razorpay payment adds one month or one
// year to `currentPeriodEnd` (see services/subscriptions.js, applyPayment).

export const SUBSCRIPTION_STATUSES = ['trialing', 'active', 'grace', 'expired', 'cancelled'];

const eventSchema = new mongoose.Schema(
  {
    at: { type: Date, default: Date.now },
    kind: { type: String, trim: true }, // trial_started, paid, granted, trial_extended, cancelled, plan_changed
    message: { type: String, trim: true, default: '' },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    byName: { type: String, trim: true, default: '' }
  },
  { _id: false }
);

const subscriptionSchema = new mongoose.Schema({
  owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },

  plan: { type: mongoose.Schema.Types.ObjectId, ref: 'Plan', default: null },
  // What the plan was when it was bought — a later price or limit edit by the
  // Super Admin applies at the next renewal, not halfway through a paid period.
  planSnapshot: {
    key: { type: String, default: '' },
    name: { type: String, default: '' },
    maxVehicles: { type: Number, default: null },
    maxUsers: { type: Number, default: null }
  },
  cycle: { type: String, enum: ['monthly', 'yearly', null], default: null },

  trialEndsAt: { type: Date, default: null },
  currentPeriodStart: { type: Date, default: null },
  currentPeriodEnd: { type: Date, default: null },
  cancelledAt: { type: Date, default: null },

  // Renewal reminder stages already sent for the current period end, so each
  // fires once. Reset when the period moves.
  remindersSent: { type: [String], default: [] },

  history: { type: [eventSchema], default: [] },

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

export default mongoose.model('Subscription', subscriptionSchema);
