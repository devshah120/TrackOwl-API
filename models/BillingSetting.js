import mongoose from 'mongoose';

// Platform-wide billing settings, one document, managed by the Super Admin.

const billingSettingSchema = new mongoose.Schema({
  singleton: { type: String, default: 'billing', unique: true },

  // Free trial given to every new account, and once to every existing account
  // the first time it is seen after billing went live.
  trialDays: { type: Number, min: 0, max: 365, default: 14 },
  // Extra days after a trial or a paid period ends before the account is
  // blocked — time for a payment that failed or a renewal that was forgotten.
  graceDays: { type: Number, min: 0, max: 60, default: 3 },
  // Master switch. Off = plans and payments still work, but nobody is ever
  // blocked and limits are not enforced. A safety valve, not the normal state.
  enforce: { type: Boolean, default: true },
  // Renewal reminders, in days before the period ends.
  reminderDays: { type: [Number], default: () => [7, 3, 1] },

  // Razorpay credentials, entered in the Super Admin panel. The key secret is
  // stored encrypted (utils/secretBox.js) and never sent to a browser. When
  // empty, the server falls back to the RAZORPAY_* values in .env.
  // `webhookSecretEnc` is unused — no webhook is configured.
  razorpay: {
    keyId: { type: String, trim: true, default: '' },
    keySecretEnc: { type: String, default: '' },
    webhookSecretEnc: { type: String, default: '' },
    // Last successful "Test connection".
    verifiedAt: { type: Date, default: null },
    updatedAt: { type: Date, default: null },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
  },

  updatedAt: { type: Date, default: Date.now },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
});

export default mongoose.model('BillingSetting', billingSettingSchema);
