import mongoose from 'mongoose';

// The vehicle paperwork vocabulary. Exported so the route's options endpoint,
// the notification synthesizer and the frontend all read one list instead of
// each re-declaring it.
//
// These are the statutory documents an Indian commercial vehicle has to carry:
// the registration certificate, the insurance cover note, the pollution
// certificate, the fitness certificate, the route permit and the road tax
// receipt. 'Other' is the escape hatch for anything a particular operator keeps
// on file (a national permit annexure, a hypothecation letter) without needing
// a schema change.
export const VEHICLE_DOCUMENT_TYPES = [
  'RC',
  'Insurance',
  'PUC',
  'Fitness',
  'Permit',
  'Tax',
  'Other'
];

// Longer labels for the UI. The stored value stays the short code so a rename
// here never invalidates existing records.
export const VEHICLE_DOCUMENT_LABELS = {
  RC: 'Registration Certificate (RC)',
  Insurance: 'Insurance',
  PUC: 'Pollution Certificate (PUC)',
  Fitness: 'Fitness Certificate',
  Permit: 'Permit',
  Tax: 'Road Tax',
  Other: 'Other'
};

// The scanned copy backing a document, held as a data URI in the same spirit as
// LedgerEntry.receipt: images are downscaled in the browser first, so a separate
// file store would buy little at this size. PDFs pass through untouched, which
// is why `mimeType` and `filename` are kept alongside.
const attachmentSchema = new mongoose.Schema(
  {
    dataUrl: { type: String, default: '' },
    filename: { type: String, trim: true, default: '' },
    mimeType: { type: String, trim: true, default: '' },
    uploadedAt: { type: Date }
  },
  { _id: false }
);

// Vehicle documents are their own collection rather than an array on Truck: a
// truck accumulates many of them over its life (a fresh insurance cover note
// every year, a new PUC every six months), and the expiry scan wants to query
// across the whole fleet by date without unwinding every truck's array.
const vehicleDocumentSchema = new mongoose.Schema({
  owner: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  truck: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Truck',
    required: true,
    index: true
  },
  docType: {
    type: String,
    enum: VEHICLE_DOCUMENT_TYPES,
    required: true
  },
  // The number printed on the document itself — the policy number, the RC
  // number, the permit number. Optional: a scan of the paper is often filed
  // before anyone types the number off it.
  documentNumber: { type: String, trim: true, default: '' },
  // Who issued it: the RTO, the insurer, the testing centre.
  issuedBy: { type: String, trim: true, default: '' },
  issueDate: Date,
  // The date the expiry scan works off. Optional because an RC does not expire
  // in the way a PUC does — a document with no expiry is simply never chased.
  expiryDate: { type: Date, index: true },
  notes: { type: String, trim: true, default: '' },

  attachment: { type: attachmentSchema, default: () => ({}) },

  createdAt: { type: Date, default: Date.now }
});

// The truck editor fetches one truck's documents; the expiry scan sweeps an
// account's by date. Both are covered here.
vehicleDocumentSchema.index({ owner: 1, truck: 1 });
vehicleDocumentSchema.index({ owner: 1, expiryDate: 1 });

export default mongoose.model('VehicleDocument', vehicleDocumentSchema);
