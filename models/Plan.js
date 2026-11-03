import mongoose from 'mongoose';

// A subscription plan offered on the pricing page — Starter, Professional,
// Enterprise, or whatever the platform operator defines. Managed by the Super
// Admin (Admin → Plans & Billing); the public pricing page and the in-app
// billing page both read from here, so changing a price or a feature line is a
// form edit, not a deploy.
//
// Prices are whole rupees as shown to the customer. They are what the customer
// pays (Razorpay is charged this amount × 100 paise).

const planSchema = new mongoose.Schema({
  // Stable identifier used in URLs (/billing?plan=professional). Not editable
  // once the plan has subscribers, so links and history keep pointing at it.
  key: { type: String, required: true, unique: true, trim: true, lowercase: true, match: /^[a-z0-9-]{2,40}$/ },
  name: { type: String, required: true, trim: true },
  description: { type: String, trim: true, default: '' },

  monthlyPrice: { type: Number, min: 0, required: true },
  yearlyPrice: { type: Number, min: 0, required: true },

  // What the plan includes, one line each, in display order.
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
