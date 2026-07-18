import mongoose from 'mongoose';

const ledgerEntrySchema = new mongoose.Schema({
  owner: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  date: { type: Date, required: true },
  type: {
    type: String,
    enum: ['income', 'expense'],
    required: true
  },
  category: {
    type: String,
    enum: ['Trip', 'Fuel', 'Toll', 'Maintenance', 'Salary', 'Other'],
    required: true
  },
  description: { type: String, trim: true, default: '' },
  amount: { type: Number, required: true, min: 0 },
  paymentMethod: {
    type: String,
    enum: ['Bank Transfer', 'Cash', 'Cheque', 'Card', 'UPI'],
    required: true
  },
  reference: { type: String, trim: true, default: '' },

  createdAt: { type: Date, default: Date.now }
});

export default mongoose.model('LedgerEntry', ledgerEntrySchema);
