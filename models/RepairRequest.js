import mongoose from 'mongoose';
import {
  REPAIR_STATUSES,
  REPAIR_PRIORITIES,
  PAYMENT_MODES,
  WORKSHOP_TYPES,
  ACTIVE_REPAIR_STATUSES
} from '../utils/maintenance.js';

// M3-M04 / M3-M05 — a reported fault and the work done about it.
//
// Unplanned work, as opposed to ServiceRecord which is a scheduled visit. See
// the note there for why the two are separate collections.
//
// The record covers the whole life of the job: what was reported and by whom,
// what it was estimated at, what it actually cost, and every state it passed
// through on the way. The status history is kept on the document rather than
// left to the audit trail because downtime — how long a vehicle sat waiting
// for a part — is a maintenance question the reports answer, not an
// administrative one, and reconstructing it from audit rows would make it
// unqueryable.

// Same shape as the service record's parts, deliberately: a brake pad fitted
// during a repair and one fitted at a service are the same purchase, and the
// parts report reads both collections into one list.
const partSchema = new mongoose.Schema(
  {
    name: { type: String, trim: true, required: true },
    partNumber: { type: String, trim: true, default: '' },
    quantity: { type: Number, min: [0, 'Quantity cannot be negative'], default: 1 },
    unitPrice: { type: Number, min: [0, 'Price cannot be negative'], default: 0 },
    amount: { type: Number, min: 0, default: 0 },
    warrantyMonths: { type: Number, min: 0, default: null },
    remarks: { type: String, trim: true, default: '' }
  },
  { _id: true }
);

const invoiceSchema = new mongoose.Schema(
  {
    dataUrl: { type: String, default: '' },
    filename: { type: String, trim: true, default: '' },
    mimeType: { type: String, trim: true, default: '' }
  },
  { _id: false }
);

const workshopSchema = new mongoose.Schema(
  {
    name: { type: String, trim: true, default: '' },
    type: { type: String, enum: WORKSHOP_TYPES, default: 'Local' },
    contact: { type: String, trim: true, default: '' },
    city: { type: String, trim: true, default: '' },
    gstin: { type: String, trim: true, uppercase: true, default: '' }
  },
  { _id: false }
);

// One step of the workflow (M3-M05). Written by the status route, never edited:
// this is what happened, and a corrected note does not change the fact that the
// job sat in Waiting Parts for nine days.
const historySchema = new mongoose.Schema(
  {
    status: { type: String, enum: REPAIR_STATUSES, required: true },
    at: { type: Date, default: Date.now },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    byName: { type: String, trim: true, default: '' },
    note: { type: String, trim: true, default: '' }
  },
  { _id: false }
);

const repairRequestSchema = new mongoose.Schema({
  owner: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },

  // A short human handle for the job, unique within the account. Generated
  // server-side (see services/maintenanceNumber.js) because a workshop, a
  // driver and the office all need to refer to the same job out loud, and an
  // ObjectId is not something anyone reads down a phone.
  requestNumber: { type: String, trim: true, uppercase: true, default: '', index: true },

  // --- M3-M04: what is wrong, on what ------------------------------------

  truck: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Truck',
    required: true,
    index: true
  },
  vehicleNumber: { type: String, trim: true, uppercase: true, default: '' },

  // What the reporter said was wrong, in their words. Required: a repair
  // request with no fault on it is not a request, it is a blank row.
  issue: { type: String, trim: true, required: true },

  // Who raised it. Usually the driver, so the link points at Driver — but the
  // office raises requests too, which is why `reportedByName` stands on its own
  // and the reference is optional.
  reportedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Driver',
    default: null,
    index: true
  },
  reportedByName: { type: String, trim: true, default: '' },
  // The user who typed it, as distinct from the driver who noticed the fault.
  raisedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

  reportedAt: { type: Date, required: true, default: Date.now, index: true },
  odometer: { type: Number, min: [0, 'Odometer cannot be negative'], default: null },

  priority: { type: String, enum: REPAIR_PRIORITIES, default: 'Medium', index: true },

  workshop: { type: workshopSchema, default: () => ({}) },

  // --- M3-M05: where the job has got to -----------------------------------

  status: {
    type: String,
    enum: REPAIR_STATUSES,
    default: 'Reported',
    index: true
  },
  // Every state the job has been in. Seeded with the Reported entry on create,
  // appended to by the status route.
  history: { type: [historySchema], default: [] },

  // The milestones the downtime report measures between. Stamped by the status
  // route as the job crosses each one, rather than derived from `history` on
  // read, so the report can filter and sort on them in the database.
  approvedAt: { type: Date, default: null },
  approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  startedAt: { type: Date, default: null },
  completedAt: { type: Date, default: null, index: true },

  // How long the vehicle was actually off the road, in hours: from the moment
  // work was approved to the moment it was finished. Computed on completion and
  // stored, because the reports sum it across a fleet and a date range.
  //
  // Measured from approval rather than from the report, deliberately: a fault
  // reported on a Friday and approved on Monday did not ground the vehicle over
  // the weekend, and counting the wait for a decision as downtime would blame
  // the workshop for the office.
  downtimeHours: { type: Number, min: 0, default: null },

  // --- Money --------------------------------------------------------------

  // What the workshop quoted. Kept alongside the actual so the estimate
  // variance report can answer "which garages quote low and bill high".
  estimatedCost: { type: Number, min: [0, 'Estimate cannot be negative'], default: null },

  parts: { type: [partSchema], default: [] },
  labourCost: { type: Number, min: [0, 'Labour cost cannot be negative'], default: 0 },
  taxAmount: { type: Number, min: [0, 'Tax cannot be negative'], default: 0 },
  discount: { type: Number, min: [0, 'Discount cannot be negative'], default: 0 },

  // Derived by computeJobTotal exactly as on the service record.
  partsTotal: { type: Number, min: 0, default: 0 },
  totalCost: { type: Number, min: 0, default: 0, index: true },

  paymentMode: { type: String, enum: PAYMENT_MODES, default: 'Cash' },
  invoiceNumber: { type: String, trim: true, default: '' },
  invoice: { type: invoiceSchema, default: () => ({}) },

  // What was actually done, filled in as the job progresses.
  diagnosis: { type: String, trim: true, default: '' },
  workDone: { type: String, trim: true, default: '' },
  notes: { type: String, trim: true, default: '' },

  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

// The open-jobs board: what is outstanding, worst first. The dashboard's
// under-repair count and the repair list both run off this.
repairRequestSchema.index({ owner: 1, status: 1, priority: -1, reportedAt: -1 });

// One vehicle's repair history.
repairRequestSchema.index({ owner: 1, truck: 1, reportedAt: -1 });

// The register, newest first.
repairRequestSchema.index({ owner: 1, reportedAt: -1 });

// The cost reports, which read completed jobs over a date range.
repairRequestSchema.index({ owner: 1, completedAt: -1 });

// The request number lookup. Sparse because the number is only assigned once
// the document is saved, and a partial index keeps blanks out of it.
repairRequestSchema.index(
  { owner: 1, requestNumber: 1 },
  { unique: true, partialFilterExpression: { requestNumber: { $type: 'string', $ne: '' } } }
);

// Is this job holding a vehicle off the road right now? Used by the dashboard
// and by the vehicle screen, defined here so both ask the same question.
repairRequestSchema.virtual('isActive').get(function () {
  return ACTIVE_REPAIR_STATUSES.includes(this.status);
});

repairRequestSchema.pre('save', function (next) {
  this.updatedAt = new Date();
  next();
});

repairRequestSchema.set('toJSON', { virtuals: true });

export default mongoose.model('RepairRequest', repairRequestSchema);
