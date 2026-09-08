import mongoose from 'mongoose';
import { SERVICE_TYPES, PAYMENT_MODES, WORKSHOP_TYPES } from '../utils/maintenance.js';

// M3-M02 — one service visit. What was done to a vehicle, when, at what
// odometer, by whom, and what it cost.
//
// Scheduled work, as opposed to RepairRequest which is a fault someone
// reported. The two are separate collections rather than one table with a
// flag because they answer different questions and have different shapes: a
// service is planned, has a next-due date, and is measured by interval
// adherence; a repair is unplanned, has a workflow and an approval, and is
// measured by downtime. Squeezing both into one record would leave half the
// fields blank on every row.
//
// A completed repair does *not* write a service record. The maintenance cost
// reports read both collections and add them up; duplicating the bill into a
// second row would double-count every repair in the vehicle's cost per km.

// A part fitted during the visit. Cost is captured per line rather than as one
// parts total so the parts report (M3-M11) can answer "what do we spend on
// brake pads across the fleet" — a question a single total cannot.
const partSchema = new mongoose.Schema(
  {
    name: { type: String, trim: true, required: true },
    partNumber: { type: String, trim: true, default: '' },
    quantity: { type: Number, min: [0, 'Quantity cannot be negative'], default: 1 },
    unitPrice: { type: Number, min: [0, 'Price cannot be negative'], default: 0 },
    // Extended amount for the line, computed on write from quantity × unitPrice
    // so no reader has to multiply, and so the stored total is auditable
    // against the lines that make it up.
    amount: { type: Number, min: 0, default: 0 },
    warrantyMonths: { type: Number, min: 0, default: null },
    remarks: { type: String, trim: true, default: '' }
  },
  { _id: true }
);

// The invoice image. Same data-URI storage as the fuel receipt and the ledger
// attachment — the browser downscales before sending, and the sizes involved
// do not justify a separate file store.
const invoiceSchema = new mongoose.Schema(
  {
    dataUrl: { type: String, default: '' },
    filename: { type: String, trim: true, default: '' },
    mimeType: { type: String, trim: true, default: '' }
  },
  { _id: false }
);

// Who did the work. Free text plus a type rather than a vendor master, for the
// same reason fuel stations are free text: a fleet uses roadside garages it
// will never see again, and forcing each to be created before a bill can be
// entered puts a data-entry chore in front of every invoice.
//
// `name` is what the vendor report groups by, so it is normalised on write
// (see utils/maintenanceFields.js).
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

const serviceRecordSchema = new mongoose.Schema({
  owner: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },

  // --- What was serviced --------------------------------------------------

  truck: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Truck',
    required: true,
    index: true
  },
  // The plate as it read on the day. Denormalised for the same reason
  // FuelEntry does it: a vehicle re-registered later must not silently rewrite
  // the service history of the vehicle it used to be.
  vehicleNumber: { type: String, trim: true, uppercase: true, default: '' },

  serviceType: { type: String, enum: SERVICE_TYPES, required: true, index: true },

  // When the work was done, not when the row was typed. Indexed with the
  // vehicle because almost every query here is "this vehicle, in date order".
  servicedAt: { type: Date, required: true, default: Date.now, index: true },

  // Odometer at the workshop, in kilometres — the same unit as Truck.odometer.
  // This is what the next-service-KM reminder is measured from, so a record
  // without it can still be costed but cannot drive a distance-based reminder.
  odometer: { type: Number, min: [0, 'Odometer cannot be negative'], default: null },

  workshop: { type: workshopSchema, default: () => ({}) },

  // --- The bill -----------------------------------------------------------

  parts: { type: [partSchema], default: [] },
  labourCost: { type: Number, min: [0, 'Labour cost cannot be negative'], default: 0 },
  taxAmount: { type: Number, min: [0, 'Tax cannot be negative'], default: 0 },
  discount: { type: Number, min: [0, 'Discount cannot be negative'], default: 0 },

  // Derived from the lines above by computeJobTotal, never accepted from the
  // client. Stored rather than computed on read so the cost reports can sum and
  // sort without rebuilding every job card — the same trade TripOrder.totals
  // makes.
  partsTotal: { type: Number, min: 0, default: 0 },
  totalCost: { type: Number, min: 0, default: 0, index: true },

  paymentMode: { type: String, enum: PAYMENT_MODES, default: 'Cash' },
  invoiceNumber: { type: String, trim: true, default: '' },
  invoice: { type: invoiceSchema, default: () => ({}) },

  // --- M3-M10: when this is due again -------------------------------------
  //
  // Both clocks are stored, and either may be null. The vehicle's own odometer
  // is what the KM one is compared against at read time, so a reminder stays
  // correct as the vehicle runs without anything having to rewrite this row.
  //
  // Held on the service record rather than in a separate schedule collection
  // because the due date *is* a property of the last service: "next oil change
  // at 55,000 km" is what this visit determined, and a schedule maintained
  // apart from the visits it comes from drifts out of step with them.
  nextServiceDate: { type: Date, default: null, index: true },
  nextServiceKm: { type: Number, min: 0, default: null },

  // Set when a later service of the same type supersedes this one, so the
  // reminder query only ever looks at the newest record per vehicle and type
  // rather than resolving that on every read.
  supersededAt: { type: Date, default: null },

  // The repair this service came out of, when the visit was booked to fix a
  // reported fault and the workshop also did scheduled work. Optional and
  // rare; it exists so the two records can be read together rather than to
  // move any cost between them — each still carries only its own money.
  repair: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'RepairRequest',
    default: null
  },

  notes: { type: String, trim: true, default: '' },

  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

// The service history of one vehicle, newest first — the detail screen and the
// "what was the last service of this type" lookup the reminders run.
serviceRecordSchema.index({ owner: 1, truck: 1, servicedAt: -1 });

// The register itself: the account's services, newest first.
serviceRecordSchema.index({ owner: 1, servicedAt: -1 });

// The reminder query: the current (not superseded) record per vehicle and
// type, ordered by when it next falls due.
serviceRecordSchema.index({ owner: 1, supersededAt: 1, nextServiceDate: 1 });

// The service-type and vendor cost reports.
serviceRecordSchema.index({ owner: 1, serviceType: 1, servicedAt: -1 });
serviceRecordSchema.index({ owner: 1, 'workshop.name': 1, servicedAt: -1 });

serviceRecordSchema.pre('save', function (next) {
  this.updatedAt = new Date();
  next();
});

serviceRecordSchema.set('toJSON', { virtuals: true });

export default mongoose.model('ServiceRecord', serviceRecordSchema);
