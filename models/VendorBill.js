import mongoose from 'mongoose';

// A bill received from a vendor — a payable — and the payments made against
// it.
//
// `expenseHead` says what the bill is for, and it decides how the Finance
// view treats it (services/finance.js):
//
//   Heads the operational modules already cost — fuel, maintenance, tyres,
//   trip expenses — are tracked here as PAYABLES ONLY. The cost itself is
//   already counted from the fuel register / job cards / trip lines, so
//   counting the bill as well would double it.
//
//   Overhead heads (office, rent, salaries, insurance, professional fees,
//   hired vehicles, other) have no other home, so these bills ARE the expense
//   and count in the P&L.

export const EXPENSE_HEADS = [
  'fuel',
  'maintenance',
  'tyres',
  'trip_expense',
  'hired_vehicle',
  'insurance',
  'permit_tax',
  'office',
  'rent',
  'salaries',
  'professional',
  'other'
];

export const EXPENSE_HEAD_LABELS = {
  fuel: 'Fuel (payable only)',
  maintenance: 'Maintenance (payable only)',
  tyres: 'Tyres & batteries (payable only)',
  trip_expense: 'Trip expense (payable only)',
  hired_vehicle: 'Hired vehicle',
  insurance: 'Insurance',
  permit_tax: 'Permit & road tax',
  office: 'Office expenses',
  rent: 'Rent',
  salaries: 'Salaries',
  professional: 'Professional fees',
  other: 'Other'
};

// Heads whose cost is already counted by another module.
export const PAYABLE_ONLY_HEADS = ['fuel', 'maintenance', 'tyres', 'trip_expense'];

export const VENDOR_BILL_STATUSES = ['unpaid', 'partially_paid', 'paid', 'cancelled'];

export const VENDOR_PAYMENT_MODES = ['Bank Transfer', 'UPI', 'Cheque', 'Cash', 'Card', 'Fuel Card', 'Other'];

const paymentSchema = new mongoose.Schema({
  date: { type: Date, required: true },
  amount: { type: Number, required: true, min: 0.01 },
  mode: { type: String, enum: VENDOR_PAYMENT_MODES, default: 'Bank Transfer' },
  reference: { type: String, trim: true, default: '' },
  notes: { type: String, trim: true, default: '' },
  createdAt: { type: Date, default: Date.now },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
});

const vendorBillSchema = new mongoose.Schema({
  owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  vendor: { type: mongoose.Schema.Types.ObjectId, ref: 'Vendor', required: true, index: true },

  billNumber: { type: String, trim: true, default: '' },
  billDate: { type: Date, required: true, index: true },
  dueDate: { type: Date, required: true },

  expenseHead: { type: String, enum: EXPENSE_HEADS, default: 'other', index: true },
  description: { type: String, trim: true, default: '' },
  // Optional links, for vehicle-wise cost and for finding the bill from a trip.
  truck: { type: mongoose.Schema.Types.ObjectId, ref: 'Truck', default: null, index: true },
  tripOrder: { type: mongoose.Schema.Types.ObjectId, ref: 'TripOrder', default: null },

  amount: { type: Number, required: true, min: 0 }, // before GST
  gstAmount: { type: Number, min: 0, default: 0 },
  // Input GST is recoverable for a registered business, so it is kept out of
  // the expense; the P&L uses `amount`, the payable uses `total`.
  total: { type: Number, required: true, min: 0 },
  paid: { type: Number, default: 0 },
  balance: { type: Number, default: 0 },

  payments: { type: [paymentSchema], default: [] },
  status: { type: String, enum: VENDOR_BILL_STATUSES, default: 'unpaid', index: true },

  attachment: {
    dataUrl: { type: String, default: '' },
    filename: { type: String, trim: true, default: '' },
    mimeType: { type: String, trim: true, default: '' }
  },
  notes: { type: String, trim: true, default: '' },

  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

vendorBillSchema.index({ owner: 1, vendor: 1, billNumber: 1 });

export default mongoose.model('VendorBill', vendorBillSchema);
