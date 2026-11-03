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
    // The first six are the original set. The rest let overheads and the
    // accounting heads the brief calls out be recorded, and each is treated
    // deliberately by the Finance view (services/finance.js):
    //   P&L overheads:   Salary, Office, Insurance, Permit & Tax, Other
    //   P&L finance:     EMI Interest, Depreciation
    //   Cash only:       EMI Principal, GST (balance-sheet movements, not costs)
    //   Cash only:       Trip, Fuel, Toll, Maintenance — already costed by the
    //                    trip, fuel and maintenance modules
    enum: ['Trip', 'Fuel', 'Toll', 'Maintenance', 'Salary', 'Office', 'Insurance', 'Permit & Tax', 'EMI Principal', 'EMI Interest', 'Depreciation', 'GST', 'Other'],
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

  // Which truck and driver this money was spent on or earned by. Both optional
  // — office costs and other overheads belong to no vehicle. They are stored as
  // independent refs rather than deriving the driver from the truck, because a
  // truck carries several drivers and the entry records whoever actually ran it.
  truck: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Truck',
    default: null,
    index: true
  },
  driver: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Driver',
    default: null,
    index: true
  },

  // Scanned bill or receipt backing this entry, held as a data URI in the same
  // spirit as User.signature: images are downscaled in the browser first, so a
  // separate file store would buy little at this size. PDFs are passed through
  // as-is, which is why `mimeType` and `filename` are kept alongside.
  receipt: {
    type: {
      dataUrl: { type: String, default: '' },
      filename: { type: String, trim: true, default: '' },
      mimeType: { type: String, trim: true, default: '' },
      uploadedAt: { type: Date }
    },
    default: () => ({}),
    _id: false
  },

  createdAt: { type: Date, default: Date.now }
});

export default mongoose.model('LedgerEntry', ledgerEntrySchema);
