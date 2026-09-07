import mongoose from 'mongoose';

// The customer master. Until now a customer existed only as free text on each
// BillingTrip (`partyName`, plus the embedded consignor/consignee blocks), which
// means the same company is re-typed on every consignment and nothing can be
// looked up across their trips. Trip Management needs a real record to point at
// — payment terms, GSTIN and billing address have to come from somewhere when a
// trip is created — so the party gets promoted to its own collection here.
//
// BillingTrip is deliberately left alone: its embedded blocks are what the
// printed LR and tax invoice are rendered from, and rewriting those would put
// every historic document at risk. New trips copy the master's details onto the
// paperwork at creation time; old records keep whatever was typed.

// How a customer settles: the credit window in days, and whether freight is
// billed to the consignor or the consignee by default. Both are defaults a trip
// inherits and may override, not rules the trip has to obey.
export const PAYMENT_TERMS = [
  'Advance',
  'Cash on Delivery',
  'Net 7',
  'Net 15',
  'Net 30',
  'Net 45',
  'Net 60',
  'Net 90',
  'Credit'
];

// Where a customer sits in the account's book. 'Blacklisted' is kept distinct
// from 'Inactive': an inactive customer is simply dormant and can be picked
// again, a blacklisted one is refused at trip creation.
export const CUSTOMER_STATUSES = ['Active', 'Inactive', 'Blacklisted'];

// A named person to call at the customer, rather than one mobile number on the
// company record. Kept as a list because the billing contact and the person who
// receives the goods are rarely the same, and a trip needs the second.
const contactSchema = new mongoose.Schema(
  {
    name: { type: String, trim: true, default: '' },
    designation: { type: String, trim: true, default: '' },
    mobile: { type: String, trim: true, default: '' },
    email: { type: String, trim: true, lowercase: true, default: '' },
    // Marks the person the office calls by default. At most one should carry
    // it; routes/customers.js enforces that on write, the same way
    // Driver.isPrimary is enforced.
    isPrimary: { type: Boolean, default: false }
  },
  { _id: false }
);

// Postal address, split into the fields an invoice and an e-way bill need
// separately. `state` matters beyond the address: an interstate movement is
// determined by comparing it against the transporter's own state, which is what
// decides IGST vs CGST/SGST on the invoice.
const addressSchema = new mongoose.Schema(
  {
    line1: { type: String, trim: true, default: '' },
    line2: { type: String, trim: true, default: '' },
    city: { type: String, trim: true, default: '' },
    state: { type: String, trim: true, default: '' },
    pincode: { type: String, trim: true, default: '' },
    country: { type: String, trim: true, default: 'India' }
  },
  { _id: false }
);

const customerSchema = new mongoose.Schema({
  // Scoped to the account exactly like Truck.owner and Driver.owner — one
  // company's customer list is never visible to another.
  owner: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },

  // Trading name, and the legal name if it differs. The legal name is what goes
  // on the tax invoice; the trading name is what the dispatcher recognises in a
  // dropdown, so both are kept.
  name: { type: String, required: true, trim: true },
  legalName: { type: String, trim: true, default: '' },

  // A short human key the office uses on paperwork ("ACME-01"). Generated from
  // the name when not supplied, and unique within the account so it can be
  // searched on unambiguously.
  code: { type: String, trim: true, uppercase: true, default: '' },

  gstin: { type: String, trim: true, uppercase: true, default: '' },
  pan: { type: String, trim: true, uppercase: true, default: '' },

  billingAddress: { type: addressSchema, default: () => ({}) },
  // Where the goods usually go, when that is a fixed place different from the
  // billing office. Purely a convenience default for trip creation.
  shippingAddress: { type: addressSchema, default: () => ({}) },

  contacts: { type: [contactSchema], default: [] },

  paymentTerms: {
    type: String,
    enum: PAYMENT_TERMS,
    default: 'Net 30'
  },
  // Credit exposure the office is willing to carry. Advisory: the trip screen
  // warns when a new trip would push the customer past it, but does not block —
  // that call belongs to a person, not a schema.
  creditLimit: {
    type: Number,
    min: [0, 'Credit limit cannot be negative'],
    default: null
  },
  // Default GST percentage applied to this customer's freight, mirroring
  // BillingTrip.gstRate so a trip can inherit it instead of being re-typed.
  gstRate: { type: Number, min: 0, max: 100, default: 0 },

  status: {
    type: String,
    enum: CUSTOMER_STATUSES,
    default: 'Active',
    index: true
  },

  notes: { type: String, trim: true, default: '' },

  createdAt: { type: Date, default: Date.now }
});

// The customer picker searches by name within one account; the code lookup is
// the exact-match path behind it.
customerSchema.index({ owner: 1, name: 1 });
customerSchema.index({ owner: 1, code: 1 });

export default mongoose.model('Customer', customerSchema);
