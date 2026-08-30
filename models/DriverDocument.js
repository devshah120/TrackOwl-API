import mongoose from 'mongoose';

// The driver paperwork vocabulary, the counterpart to VEHICLE_DOCUMENT_TYPES.
//
// 'Licence' is the driving licence itself; 'ID' covers the identity proofs an
// operator keeps on file (Aadhaar, PAN, voter card); 'Training' covers hazmat
// endorsements and defensive-driving certificates, which expire and so want
// chasing the same way a licence does. 'Medical' is the fitness certificate
// required for a heavy-vehicle badge. 'Other' is the escape hatch.
export const DRIVER_DOCUMENT_TYPES = [
  'Licence',
  'ID',
  'Training',
  'Medical',
  'Police Verification',
  'Other'
];

export const DRIVER_DOCUMENT_LABELS = {
  Licence: 'Driving Licence',
  ID: 'Identity Proof',
  Training: 'Training / Endorsement',
  Medical: 'Medical Certificate',
  'Police Verification': 'Police Verification',
  Other: 'Other'
};

// Same shape as VehicleDocument's attachment — kept as its own declaration
// rather than shared, so the two collections can diverge later (a driver photo
// is a plausible addition here) without one dragging the other along.
const attachmentSchema = new mongoose.Schema(
  {
    dataUrl: { type: String, default: '' },
    filename: { type: String, trim: true, default: '' },
    mimeType: { type: String, trim: true, default: '' },
    uploadedAt: { type: Date }
  },
  { _id: false }
);

// Driver documents are their own collection for the same reason vehicle ones
// are: a driver accumulates renewals over time, and the expiry scan queries by
// date across the whole roster.
const driverDocumentSchema = new mongoose.Schema({
  owner: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  driver: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Driver',
    required: true,
    index: true
  },
  docType: {
    type: String,
    enum: DRIVER_DOCUMENT_TYPES,
    required: true
  },
  documentNumber: { type: String, trim: true, default: '' },
  issuedBy: { type: String, trim: true, default: '' },
  issueDate: Date,
  // An identity proof does not expire; a licence and a training endorsement do.
  // Optional, and a document without one is never chased.
  expiryDate: { type: Date, index: true },
  notes: { type: String, trim: true, default: '' },

  attachment: { type: attachmentSchema, default: () => ({}) },

  createdAt: { type: Date, default: Date.now }
});

driverDocumentSchema.index({ owner: 1, driver: 1 });
driverDocumentSchema.index({ owner: 1, expiryDate: 1 });

export default mongoose.model('DriverDocument', driverDocumentSchema);
