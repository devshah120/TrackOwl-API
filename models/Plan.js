import mongoose from 'mongoose';

// A subscription plan offered on the pricing page — Starter, Professional,
// Enterprise, or whatever the platform operator defines. Managed by the Super
// Admin (Admin → Plans & Billing); the public pricing page and the in-app
// billing page both read from here, so changing a price or a feature line is a
// form edit, not a deploy.
//
// Prices are whole rupees as shown to the customer. They are what the customer
// pays (Razorpay is charged this amount × 100 paise).
//
// Limits and modules are live: an edit applies to every subscriber of the
// plan at once. Only the price waits for the next payment, naturally.

const planSchema = new mongoose.Schema({
  // Stable identifier used in URLs (/billing?plan=professional). Not editable
  // once the plan has subscribers, so links and history keep pointing at it.
  key: { type: String, required: true, unique: true, trim: true, lowercase: true, match: /^[a-z0-9-]{2,40}$/ },
  name: { type: String, required: true, trim: true },
  description: { type: String, trim: true, default: '' },

  monthlyPrice: { type: Number, min: 0, required: true },
  yearlyPrice: { type: Number, min: 0, required: true },

  // The app modules this plan includes (services/planCatalog.js). Enforced:
  // a module not listed here is refused by the API and hidden in the menu.
  // Unset on plans created before modules existed — those are migrated once
  // by ensurePlans().
  modules: { type: [String], default: undefined },
  // Extra lines for the pricing page that are not app modules — support
  // level, onboarding, SLA. Descriptive only.
  extraFeatures: { type: [String], default: [] },
  // Legacy free-text feature list from before modules. Kept so nothing is
  // lost; the pricing page now builds its list from limits + modules + extras.
  features: { type: [String], default: [] },

  // Enforced limits. Null = unlimited.
  maxVehicles: { type: Number, min: 1, default: null },
  maxUsers: { type: Number, min: 1, default: null },

  highlight: { type: Boolean, default: false }, // "Most Popular"
  active: { type: Boolean, default: true }, // offered to new subscribers
  sortOrder: { type: Number, default: 0 },

  updatedAt: { type: Date, default: Date.now },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
});

export default mongoose.model('Plan', planSchema);
