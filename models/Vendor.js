import mongoose from 'mongoose';

// A supplier the business pays: a workshop, a fuel pump on credit, a tyre
// dealer, a market vehicle hired for a load, the office landlord. The payable
// side of the books, mirroring the Customer master on the receivable side.
//
// Bills against a vendor live in VendorBill; this record holds who they are
// and how they are paid.

export const VENDOR_CATEGORIES = [
  'fuel_station',
  'workshop',
  'tyre_dealer',
  'spare_parts',
  'market_vehicle',
  'broker',
  'toll_fastag',
  'insurance',
  'office',
  'other'
];

export const VENDOR_CATEGORY_LABELS = {
  fuel_station: 'Fuel station',
  workshop: 'Workshop / garage',
  tyre_dealer: 'Tyre dealer',
  spare_parts: 'Spare parts',
  market_vehicle: 'Hired vehicle owner',
  broker: 'Broker / agent',
  toll_fastag: 'Toll / FASTag',
  insurance: 'Insurance',
  office: 'Office & admin',
  other: 'Other'
};

export const VENDOR_STATUSES = ['Active', 'Inactive'];

const vendorSchema = new mongoose.Schema({
  owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

  name: { type: String, required: true, trim: true },
  category: { type: String, enum: VENDOR_CATEGORIES, default: 'other', index: true },
  contactName: { type: String, trim: true, default: '' },
  mobile: { type: String, trim: true, default: '' },
  email: { type: String, trim: true, lowercase: true, default: '' },
  gstin: { type: String, trim: true, uppercase: true, default: '' },
  pan: { type: String, trim: true, uppercase: true, default: '' },
  address: {
    line1: { type: String, trim: true, default: '' },
    city: { type: String, trim: true, default: '' },
    state: { type: String, trim: true, default: '' },
    pincode: { type: String, trim: true, default: '' }
  },
  // Days of credit the vendor gives us; drives a bill's default due date.
  creditDays: { type: Number, min: 0, max: 365, default: 0 },
  bank: {
    accountName: { type: String, trim: true, default: '' },
    accountNumber: { type: String, trim: true, default: '' },
    ifsc: { type: String, trim: true, uppercase: true, default: '' },
    upi: { type: String, trim: true, default: '' }
  },
  status: { type: String, enum: VENDOR_STATUSES, default: 'Active' },
  notes: { type: String, trim: true, default: '' },

  createdAt: { type: Date, default: Date.now }
});

vendorSchema.index({ owner: 1, name: 1 });

export default mongoose.model('Vendor', vendorSchema);
