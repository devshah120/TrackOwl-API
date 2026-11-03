import mongoose from 'mongoose';

// A customer invoice — the receivable. Raised against the Customer master and,
// line by line, against the operational trips (TripOrder) it bills for.
//
// Distinct from BillingTrip, which is the LR / tax-invoice *paperwork* printed
// for one consignment and keeps its own embedded party text. An Invoice is the
// accounting record: numbered from a configurable series, due on a date, and
// settled by payments, credit notes and TDS. One invoice may bill several
// trips; one trip is billed by at most one live invoice.
//
// Every total is computed server-side (services/invoiceMath.js) and stored, so
// lists and the ageing report can sort and sum without reloading every line.

export const INVOICE_STATUSES = ['draft', 'issued', 'partially_paid', 'paid', 'cancelled'];

export const INVOICE_STATUS_LABELS = {
  draft: 'Draft',
  issued: 'Unpaid',
  partially_paid: 'Partially Paid',
  paid: 'Paid',
  cancelled: 'Cancelled'
};

export const INVOICE_LINE_KINDS = ['freight', 'loading', 'unloading', 'detention', 'other'];

// How GST is charged. Road transport (GTA) in India is commonly billed under
// reverse charge — the recipient pays the tax to the government — in which case
// the tax is shown on the invoice but is not part of what the customer pays us.
export const GST_MODES = ['cgst_sgst', 'igst', 'none'];

export const ADJUSTMENT_KINDS = ['credit_note', 'tds', 'write_off'];

export const ADJUSTMENT_LABELS = {
  credit_note: 'Credit note',
  tds: 'TDS deducted',
  write_off: 'Write-off'
};

const fileSchema = new mongoose.Schema(
  {
    dataUrl: { type: String, default: '' },
    filename: { type: String, trim: true, default: '' },
    mimeType: { type: String, trim: true, default: '' }
  },
  { _id: false }
);

const lineSchema = new mongoose.Schema({
  kind: { type: String, enum: INVOICE_LINE_KINDS, default: 'freight' },
  description: { type: String, trim: true, default: '' },
  // The trip this line bills, when it bills one. The number and plate are a
  // point-in-time copy for the printed document.
  tripOrder: { type: mongoose.Schema.Types.ObjectId, ref: 'TripOrder', default: null, index: true },
  tripNumber: { type: String, trim: true, default: '' },
  vehicleNumber: { type: String, trim: true, default: '' },
  lrNumber: { type: String, trim: true, default: '' },
  route: { type: String, trim: true, default: '' },
  sac: { type: String, trim: true, default: '' },
  quantity: { type: Number, min: 0, default: 1 },
  rate: { type: Number, min: 0, default: 0 },
  amount: { type: Number, min: 0, default: 0 }
});

export const RECEIPT_MODES = ['Bank Transfer', 'UPI', 'Cheque', 'Cash', 'Card', 'Other'];

const paymentSchema = new mongoose.Schema({
  date: { type: Date, required: true },
  amount: { type: Number, required: true, min: 0.01 },
  mode: { type: String, enum: RECEIPT_MODES, default: 'Bank Transfer' },
  reference: { type: String, trim: true, default: '' },
  notes: { type: String, trim: true, default: '' },
  receipt: { type: fileSchema, default: () => ({}) },
  createdAt: { type: Date, default: Date.now },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  createdByName: { type: String, trim: true, default: '' }
});

const adjustmentSchema = new mongoose.Schema({
  kind: { type: String, enum: ADJUSTMENT_KINDS, required: true },
  date: { type: Date, required: true },
  amount: { type: Number, required: true, min: 0.01 },
  reference: { type: String, trim: true, default: '' },
  notes: { type: String, trim: true, default: '' },
  createdAt: { type: Date, default: Date.now },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
});

const invoiceSchema = new mongoose.Schema({
  owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

  invoiceNumber: { type: String, required: true, trim: true, uppercase: true },
  invoiceDate: { type: Date, required: true, index: true },
  dueDate: { type: Date, required: true, index: true },

  customer: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true, index: true },
  // Who it was billed to, as it read on the day. A later edit to the customer
  // master must not rewrite an invoice already sent.
  billTo: {
    name: { type: String, trim: true, default: '' },
    gstin: { type: String, trim: true, default: '' },
    address: { type: String, trim: true, default: '' },
    state: { type: String, trim: true, default: '' },
    contact: { type: String, trim: true, default: '' }
  },
  placeOfSupply: { type: String, trim: true, default: '' },

  lines: { type: [lineSchema], default: [] },
  discount: { type: Number, min: 0, default: 0 },

  gst: {
    rate: { type: Number, min: 0, max: 28, default: 0 },
    mode: { type: String, enum: GST_MODES, default: 'none' },
    reverseCharge: { type: Boolean, default: false }
  },

  totals: {
    subtotal: { type: Number, default: 0 },
    taxable: { type: Number, default: 0 },
    cgst: { type: Number, default: 0 },
    sgst: { type: Number, default: 0 },
    igst: { type: Number, default: 0 },
    tax: { type: Number, default: 0 },
    roundOff: { type: Number, default: 0 },
    // What the customer owes us: taxable value + tax, unless under reverse
    // charge, where the tax is the customer's to pay to the government.
    total: { type: Number, default: 0 },
    received: { type: Number, default: 0 },
    adjusted: { type: Number, default: 0 },
    balance: { type: Number, default: 0 }
  },

  payments: { type: [paymentSchema], default: [] },
  adjustments: { type: [adjustmentSchema], default: [] },

  status: { type: String, enum: INVOICE_STATUSES, default: 'issued', index: true },
  cancelledAt: { type: Date, default: null },
  cancelReason: { type: String, trim: true, default: '' },

  notes: { type: String, trim: true, default: '' },
  terms: { type: String, trim: true, default: '' },

  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

invoiceSchema.index({ owner: 1, invoiceNumber: 1 }, { unique: true });
invoiceSchema.index({ owner: 1, status: 1, dueDate: 1 });
invoiceSchema.index({ owner: 1, 'lines.tripOrder': 1 });

export default mongoose.model('Invoice', invoiceSchema);
