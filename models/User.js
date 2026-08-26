import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { ROLES, ROLE_VALUES, expandGrants } from '../utils/permissions.js';

const userSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Name is required'],
    trim: true,
    minlength: [2, 'Name must be at least 2 characters']
  },
  email: {
    type: String,
    required: [true, 'Email is required'],
    unique: true,
    lowercase: true,
    match: [/^\w+([\.-]?\w+)*@\w+([\.-]?\w+)*(\.\w{2,3})+$/, 'Please provide a valid email']
  },
  mobile: {
    type: String,
    required: [true, 'Mobile number is required'],
    match: [/^\d{10}$/, 'Mobile must be a valid 10-digit number']
  },
  password: {
    type: String,
    required: [true, 'Password is required'],
    minlength: [8, 'Password must be at least 8 characters'],
    select: false
  },
  // Company and fleet size are collected at sign-up, so they are required of an
  // account owner but not of the staff seats they later add — a Fleet Manager
  // inherits both from the account they belong to.
  company: {
    type: String,
    required: [
      function () { return !this.account; },
      'Company name is required'
    ],
    trim: true,
    default: ''
  },
  fleet: {
    type: String,
    enum: {
      values: ['1–5 trucks', '6–20 trucks', '21–50 trucks', '50+ trucks', ''],
      message: 'Fleet size is not valid'
    },
    required: [
      function () { return !this.account; },
      'Fleet size is required'
    ],
    default: ''
  },
  address: { type: String, trim: true, default: '' },
  city: { type: String, trim: true, default: '' },
  gstNumber: { type: String, trim: true, default: '' },
  panNumber: { type: String, trim: true, default: '' },
  bankDetails: {
    type: {
      accountName: { type: String, trim: true, default: '' },
      accountNumber: { type: String, trim: true, default: '' },
      bankName: { type: String, trim: true, default: '' },
      ifscCode: { type: String, trim: true, default: '' },
      branchName: { type: String, trim: true, default: '' }
    },
    default: () => ({}),
    _id: false
  },
  // Authorised signatory mark stamped onto generated LRs and invoices. Held as
  // a data URI so it travels with the profile — the images are small enough
  // (canvas strokes or a downscaled upload) that a separate file store would
  // buy nothing.
  signature: {
    type: {
      dataUrl: { type: String, default: '' },
      signatoryName: { type: String, trim: true, default: '' },
      updatedAt: { type: Date }
    },
    default: () => ({}),
    _id: false
  },
  role: {
    type: String,
    enum: {
      values: ROLE_VALUES,
      message: 'Role must be one of: ' + ROLE_VALUES.join(', ')
    },
    default: ROLES.COMPANY_ADMIN
  },

  // The account this user belongs to — always a company_admin's id.
  //
  // Unset on a company_admin (they *are* the account) and on a super_admin
  // (who is scoped to no account at all). Set on every staff seat, which is
  // what lets a Fleet Manager and an Accountant added by the same admin see
  // one shared set of trucks, trips and ledger entries: `protect` resolves
  // this into `req.accountId`, and every data route scopes its queries by it
  // rather than by the caller's own id.
  account: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
    index: true
  },

  // Who added this seat. Audit only — nothing is scoped by it.
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },

  // Stamped on each successful login, so an admin can spot a dormant seat.
  lastLoginAt: { type: Date, default: null },
  isActive: {
    type: Boolean,
    default: true
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

// Hash password before saving
userSchema.pre('save', async function(next) {
  if (!this.isModified('password')) return next();

  try {
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (err) {
    next(err);
  }
});

// Method to compare passwords
userSchema.methods.matchPassword = async function(enteredPassword) {
  return await bcrypt.compare(enteredPassword, this.password);
};

// The id of the account whose data this user works on: their own for an
// account owner, the parent's for a staff seat. super_admin has no account —
// their routes are platform-wide and never scoped by this.
userSchema.virtual('accountId').get(function () {
  return this.account || this._id;
});

// Remove password from response, and hand the client its permission list so the
// UI can hide what the API would refuse. Derived from the role on every read
// rather than stored, so a change to the matrix takes effect immediately
// instead of needing a backfill.
userSchema.methods.toJSON = function() {
  const obj = this.toObject();
  delete obj.password;
  obj.accountId = String(this.account || this._id);
  obj.permissions = expandGrants(this.role);
  return obj;
};

export default mongoose.model('User', userSchema);
