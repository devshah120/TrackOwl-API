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
