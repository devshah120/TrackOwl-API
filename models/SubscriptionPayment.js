import mongoose from 'mongoose';

// One Razorpay checkout for a plan: created as an Order before the customer
// pays, marked paid once the payment's signature checks out (from the browser
// callback or the Razorpay webhook — whichever arrives first; the other is a
// no-op). Amounts are in paise, as Razorpay stores them.

const subscriptionPaymentSchema = new mongoose.Schema({
  owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  plan: { type: mongoose.Schema.Types.ObjectId, ref: 'Plan', required: true },
  planName: { type: String, trim: true, default: '' },
  cycle: { type: String, enum: ['monthly', 'yearly'], required: true },
  amountPaise: { type: Number, required: true, min: 100 },
  currency: { type: String, default: 'INR' },

  // Our own receipt number, sent to Razorpay as the order receipt.
  receipt: { type: String, required: true, unique: true },
  razorpayOrderId: { type: String, required: true, unique: true },
  razorpayPaymentId: { type: String, default: '', index: true },
  razorpaySignature: { type: String, default: '' },
  method: { type: String, default: '' },

  status: { type: String, enum: ['created', 'paid', 'failed'], default: 'created', index: true },
  failureReason: { type: String, default: '' },
  paidAt: { type: Date, default: null },
  // The period this payment bought.
  periodStart: { type: Date, default: null },
  periodEnd: { type: Date, default: null },

  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  createdAt: { type: Date, default: Date.now }
});

export default mongoose.model('SubscriptionPayment', subscriptionPaymentSchema);
