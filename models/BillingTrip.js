import mongoose from 'mongoose';

// A freight/billing record for a trip: party, LR/bill references, and payment
// status. Distinct from Trip.js (route-planning, origin/destination/device) —
// "truck" here is the plain truck number string, not a Truck ref, matching
// how the UI has always modeled it; avoids a populate/broken-reference risk
// if a truck is later renamed or deleted.
const billingTripSchema = new mongoose.Schema({
  owner: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  truck: { type: String, required: true, trim: true },
  lr: { type: String, trim: true, default: '' },
  bill: { type: String, trim: true, default: '' },
  partyName: { type: String, required: true, trim: true },
  status: {
    type: String,
    enum: ['Paid', 'Partial', 'Pending'],
    default: 'Pending'
  },
  amount: { type: Number, required: true, min: 0 },
  date: { type: Date, required: true },

  // --- Lorry Receipt / Tax Invoice detail ---
  // Everything below is optional: records created before these fields existed
  // stay valid, and the PDF generators leave the matching box blank.
  fromLocation: { type: String, trim: true, default: '' },
  toLocation: { type: String, trim: true, default: '' },

  // Consignor = supplier (sends the goods), consignee = buyer (receives them).
  // partyName above stays the consignee for the trips table's "Party" column.
  consignor: {
    type: {
      name: { type: String, trim: true, default: '' },
      gst: { type: String, trim: true, default: '' },
      address: { type: String, trim: true, default: '' },
      contact: { type: String, trim: true, default: '' }
    },
    default: () => ({}),
    _id: false
  },
  consignee: {
    type: {
      name: { type: String, trim: true, default: '' },
      gst: { type: String, trim: true, default: '' },
      address: { type: String, trim: true, default: '' },
      contact: { type: String, trim: true, default: '' }
    },
    default: () => ({}),
    _id: false
  },

  goods: {
    type: {
      description: { type: String, trim: true, default: '' },
      quantity: { type: Number, default: 0 },
      // Packaging unit for `quantity` (Boxes, Bags, Kg...). Weight is a mass
      // and carries its own unit, so the two are never conflated on the LR.
      unit: { type: String, trim: true, default: '' },
      weight: { type: Number, default: 0 },
      weightUnit: { type: String, trim: true, default: 'Kg' },
      declaredValue: { type: Number, default: 0 },
      freightRate: { type: Number, default: 0 }
    },
    default: () => ({}),
    _id: false
  },

  // Who settles the GST on this consignment — printed as a tick in the
  // "GST TAX PAYABLE BY" block of the LR.
  gstPayableBy: {
    type: String,
    enum: ['Consignor', 'Consignee', 'Transporter'],
    default: 'Consignee'
  },
  lrCharges: { type: Number, default: 0 },
  invoiceNo: { type: String, trim: true, default: '' },

  driver: {
    type: {
      name: { type: String, trim: true, default: '' },
      mobile: { type: String, trim: true, default: '' },
      licenseNumber: { type: String, trim: true, default: '' }
    },
    default: () => ({}),
    _id: false
  },

  payment: {
    type: {
      method: { type: String, trim: true, default: '' },
      advance: { type: Number, default: 0 },
      balance: { type: Number, default: 0 },
      notes: { type: String, trim: true, default: '' }
    },
    default: () => ({}),
    _id: false
  },

  loadingDate: { type: Date },
  deliveryDate: { type: Date },
  documents: {
    type: {
      tax: { type: Boolean, default: false },
      lr: { type: Boolean, default: false },
      goods: { type: Boolean, default: false }
    },
    default: () => ({ tax: false, lr: false, goods: false }),
    _id: false
  },

  createdAt: { type: Date, default: Date.now }
});

export default mongoose.model('BillingTrip', billingTripSchema);
