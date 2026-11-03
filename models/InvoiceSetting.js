import mongoose from 'mongoose';

// The account's invoice series and defaults. One document per account,
// created with defaults on first read.
//
// The number is built as  PREFIX / FY / SEQUENCE  — INV/2026-27/0001 — with
// the financial-year part optional. `startFrom` lets an operator moving from a
// paper book continue its numbering instead of restarting at 1.

const invoiceSettingSchema = new mongoose.Schema({
  owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },

  prefix: { type: String, trim: true, uppercase: true, default: 'INV' },
  // Indian financial year (April–March) in the number, restarting the
  // sequence each year — how GST invoice books are normally kept.
  useFinancialYear: { type: Boolean, default: true },
  separator: { type: String, enum: ['/', '-'], default: '/' },
  padding: { type: Number, min: 1, max: 8, default: 4 },
  startFrom: { type: Number, min: 1, default: 1 },

  // Used when the customer has no payment terms of its own.
  defaultDueDays: { type: Number, min: 0, max: 365, default: 30 },
  defaultGstRate: { type: Number, min: 0, max: 28, default: 5 },
  defaultReverseCharge: { type: Boolean, default: true },
  // SAC for goods transport agency services.
  defaultSac: { type: String, trim: true, default: '996791' },
  terms: {
    type: String,
    trim: true,
    default: 'Payment due by the date shown. Please quote the invoice number with your payment.'
  },

  updatedAt: { type: Date, default: Date.now },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
});

export default mongoose.model('InvoiceSetting', invoiceSettingSchema);
