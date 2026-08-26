import mongoose from 'mongoose';

// A point of contact at the company — accounts, operations, the person whose
// number goes on an LR. Kept as a subdocument list rather than its own
// collection because contacts are only ever read through their company and
// there are a handful of them, not thousands.
const contactSchema = new mongoose.Schema(
  {
    name: { type: String, required: [true, 'Contact name is required'], trim: true },
    designation: { type: String, trim: true, default: '' },
    phone: {
      type: String,
      trim: true,
      default: '',
      // Optional, but a value that is present must be a real 10-digit Indian
      // mobile — the same rule User.mobile enforces.
      match: [/^$|^\d{10}$/, 'Contact phone must be a valid 10-digit number']
    },
    email: {
      type: String,
      trim: true,
      lowercase: true,
      default: '',
      match: [/^$|^\w+([.-]?\w+)*@\w+([.-]?\w+)*(\.\w{2,3})+$/, 'Contact email is not valid']
    },
    // Exactly one contact carries this flag; the pre-validate hook below keeps
    // that true no matter what the client sends.
    isPrimary: { type: Boolean, default: false }
  },
  { _id: true }
);

const addressSchema = new mongoose.Schema(
  {
    line1: { type: String, trim: true, default: '' },
    line2: { type: String, trim: true, default: '' },
    city: { type: String, trim: true, default: '' },
    state: { type: String, trim: true, default: '' },
    pincode: {
      type: String,
      trim: true,
      default: '',
      match: [/^$|^\d{6}$/, 'Pincode must be 6 digits']
    },
    country: { type: String, trim: true, default: 'India' }
  },
  { _id: false }
);

// GSTIN: 2-digit state code, 10-char PAN, entity number, 'Z', checksum.
const GSTIN_PATTERN = /^[0-3][0-9][A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
const PAN_PATTERN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

const companySchema = new mongoose.Schema({
  // Master data belongs to the account that created it. One company per owner
  // today (the unique index below), but the ref rather than a flat field on
  // User leaves room for a second branch office later.
  owner: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    unique: true,
    index: true
  },

  // The trading name — this is what heads every LR, invoice and declaration.
  name: {
    type: String,
    required: [true, 'Company name is required'],
    trim: true,
    minlength: [2, 'Company name must be at least 2 characters']
  },
  // The name on the certificate of incorporation, when it differs from the
  // trading name. Invoices print this one where it is set.
  legalName: { type: String, trim: true, default: '' },

  gstin: {
    type: String,
    trim: true,
    uppercase: true,
    default: '',
    match: [GSTIN_PATTERN, 'GSTIN must be a valid 15-character GST number']
  },
  pan: {
    type: String,
    trim: true,
    uppercase: true,
    default: '',
    match: [PAN_PATTERN, 'PAN must be a valid 10-character PAN']
  },

  address: { type: addressSchema, default: () => ({}) },
  contacts: { type: [contactSchema], default: [] },

  // Held as a data URI for the same reason User.signature is: PDFKit takes the
  // bytes directly, the images are small once downscaled, and a file store
  // would add a deployment dependency for no gain. Route-level validation caps
  // the size and confirms the bytes are really PNG/JPEG.
  logo: {
    type: {
      dataUrl: { type: String, default: '' },
      updatedAt: { type: Date }
    },
    default: () => ({}),
    _id: false
  },

  // IANA zone name. Trip timestamps are stored in UTC; this is what they are
  // rendered in on documents and reports.
  timezone: { type: String, trim: true, default: 'Asia/Kolkata' },

  // Whether this company record is in use. Distinct from User.isActive, which
  // governs whether the login works at all — a company can be archived while
  // its account stays open.
  status: {
    type: String,
    enum: ['active', 'inactive'],
    default: 'active'
  },

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

// Keep the primary-contact flag honest: promote the first contact when none is
// marked, and demote the rest when several are.
companySchema.pre('validate', function (next) {
  if (Array.isArray(this.contacts) && this.contacts.length) {
    const firstPrimary = this.contacts.findIndex((c) => c.isPrimary);
    this.contacts.forEach((contact, i) => {
      contact.isPrimary = i === (firstPrimary === -1 ? 0 : firstPrimary);
    });
  }
  next();
});

companySchema.pre('save', function (next) {
  this.updatedAt = new Date();
  next();
});

// The contact whose details head the documents, with a safe fallback so
// callers never have to null-check.
companySchema.methods.primaryContact = function () {
  return this.contacts?.find((c) => c.isPrimary) || this.contacts?.[0] || null;
};

export default mongoose.model('Company', companySchema);
