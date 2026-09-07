import mongoose from 'mongoose';
import {
  TRIP_TYPES,
  STOP_TYPES,
  STOP_STATUSES,
  CARGO_UNITS,
  REVENUE_CATEGORIES,
  EXPENSE_CATEGORIES,
  PAYMENT_MODES,
  TRIP_DOCUMENT_TYPES,
  CREW_ROLES,
  CHECKLIST_KEYS
} from './tripOrders.js';

// Turns a request body into the shape TripOrder expects, dropping anything the
// caller has no business setting.
//
// The rule followed throughout, matching utils/vehicleDocuments.js and
// utils/drivers.js: a field the caller never sent is left alone, while a field
// sent empty is genuinely cleared. Those are different edits — a partial save
// from one tab of the detail page must not blank the fields belonging to
// another tab.

// Attachments ride in the JSON body as data URIs. Same cap as the vehicle and
// driver documents, for the same reason: base64 inflates by about 4/3, so this
// is roughly a 3 MB file.
export const MAX_ATTACHMENT_CHARS = 4 * 1024 * 1024;

// Signatures are a few strokes on a canvas, not a photo. A much smaller cap is
// enough and stops a full-resolution image being posted into the field.
export const MAX_SIGNATURE_CHARS = 512 * 1024;

const num = (v) => {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const str = (v) => String(v ?? '').trim();

// A non-negative amount. Rejects negatives outright rather than clamping:
// silently turning -500 into 0 hides a data-entry error inside a total.
const amount = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100) / 100;
};

const date = (v) => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

export const objectId = (v) =>
  v && mongoose.Types.ObjectId.isValid(v) ? new mongoose.Types.ObjectId(v) : null;

// A latitude/longitude pair, only accepted when both are present and in range.
// A half-set coordinate would put a marker on the equator.
const coords = (lat, lng) => {
  const la = num(lat);
  const ln = num(lng);
  if (la === null || ln === null) return { lat: null, lng: null };
  if (la < -90 || la > 90 || ln < -180 || ln > 180) return { lat: null, lng: null };
  return { lat: la, lng: ln };
};

// A pickup, destination or stop address.
export const cleanLocation = (input) => {
  if (!input || typeof input !== 'object') return {};
  const { lat, lng } = coords(input.lat, input.lng);
  return {
    name: str(input.name),
    address: str(input.address),
    city: str(input.city),
    state: str(input.state),
    pincode: str(input.pincode),
    contactName: str(input.contactName),
    contactPhone: str(input.contactPhone),
    notes: str(input.notes),
    lat,
    lng
  };
};

// One stop. `sequence` is deliberately ignored here — the route layer numbers
// stops from their array position so the sequence is always dense and matches
// travel order, whatever the client sent.
export const cleanStop = (input = {}, index = 0) => ({
  stopType: STOP_TYPES.includes(input.stopType) ? input.stopType : 'via',
  location: cleanLocation(input.location),
  eta: date(input.eta),
  loadingQuantity: num(input.loadingQuantity),
  unloadingQuantity: num(input.unloadingQuantity),
  status: STOP_STATUSES.includes(input.status) ? input.status : 'pending',
  notes: str(input.notes),
  sequence: index + 1
});

export const cleanCargo = (input = {}) => ({
  cargoType: str(input.cargoType),
  description: str(input.description),
  quantity: num(input.quantity) ?? 0,
  unit: CARGO_UNITS.includes(input.unit) ? input.unit : 'Boxes',
  weightKg: num(input.weightKg) ?? 0,
  volumeM3: num(input.volumeM3) ?? 0,
  packages: num(input.packages) ?? 0,
  boxes: num(input.boxes) ?? 0,
  specialInstructions: str(input.specialInstructions)
});

// A revenue line. Returns null when the category or amount is unusable, so the
// caller can reject the request rather than storing a line that would skew a
// total silently.
export const cleanRevenueLine = (input = {}, userId = null) => {
  if (!REVENUE_CATEGORIES.includes(input.category)) return null;
  const value = amount(input.amount);
  if (value === null) return null;
  return {
    category: input.category,
    description: str(input.description),
    amount: value,
    createdAt: new Date(),
    createdBy: userId
  };
};

export const cleanExpenseLine = (input = {}, userId = null) => {
  if (!EXPENSE_CATEGORIES.includes(input.category)) return null;
  const value = amount(input.amount);
  if (value === null) return null;

  const receipt =
    input.receipt && input.receipt.dataUrl
      ? {
          dataUrl: String(input.receipt.dataUrl),
          filename: str(input.receipt.filename),
          mimeType: str(input.receipt.mimeType)
        }
      : { dataUrl: '', filename: '', mimeType: '' };

  return {
    category: input.category,
    description: str(input.description),
    amount: value,
    spentAt: date(input.spentAt) || new Date(),
    paidBy: str(input.paidBy),
    paymentMode: PAYMENT_MODES.includes(input.paymentMode) ? input.paymentMode : 'Cash',
    vendor: str(input.vendor),
    litres: num(input.litres),
    odometer: num(input.odometer),
    receipt,
    createdAt: new Date(),
    createdBy: userId
  };
};

export const cleanCrewMember = (input = {}) => ({
  role: CREW_ROLES.includes(input.role) ? input.role : 'helper',
  employee: objectId(input.employee),
  name: str(input.name),
  mobile: str(input.mobile)
});

export const cleanDocument = (input = {}, userId = null) => {
  if (!input?.dataUrl) return null;
  return {
    docType: TRIP_DOCUMENT_TYPES.includes(input.docType) ? input.docType : 'other',
    title: str(input.title),
    documentNumber: str(input.documentNumber),
    dataUrl: String(input.dataUrl),
    filename: str(input.filename),
    mimeType: str(input.mimeType),
    uploadedAt: new Date(),
    uploadedBy: userId
  };
};

// A proof-of-delivery block, at trip or stop level.
export const cleanPod = (input = {}, userId = null) => ({
  arrivedAt: date(input.arrivedAt),
  unloadingStartedAt: date(input.unloadingStartedAt),
  unloadingEndedAt: date(input.unloadingEndedAt),
  deliveredQuantity: num(input.deliveredQuantity),
  shortage: num(input.shortage) ?? 0,
  damage: num(input.damage) ?? 0,
  receiverName: str(input.receiverName),
  receiverPhone: str(input.receiverPhone),
  remarks: str(input.remarks),
  signature: input.signature ? String(input.signature) : '',
  photo: input.photo ? String(input.photo) : '',
  capturedAt: new Date(),
  capturedBy: userId
});

// An odometer/fuel reading at one end of the trip.
export const cleanReading = (input = {}, userId = null) => {
  const { lat, lng } = coords(input.lat, input.lng);
  return {
    at: date(input.at) || new Date(),
    odometer: num(input.odometer),
    fuelLevel: num(input.fuelLevel),
    lat,
    lng,
    location: str(input.location),
    by: userId
  };
};

// Rejects an attachment that is not an uploaded file or is too large. Returns
// an error string, or null when acceptable. Mirrors validateAttachment in
// utils/vehicleDocuments.js so both upload paths behave identically.
export const validateDataUrl = (dataUrl, { max = MAX_ATTACHMENT_CHARS, label = 'file' } = {}) => {
  if (!dataUrl) return null;
  if (!/^data:/.test(String(dataUrl))) return `The ${label} must be an uploaded file`;
  if (String(dataUrl).length > max) {
    return `That ${label} is too large — please keep it under ${Math.round(max / (1024 * 1024) * 0.75)} MB`;
  }
  return null;
};

// The top-level trip fields, built only from what the caller actually sent.
// Assignment (truck/driver/crew), stops, cargo, money and status all have their
// own endpoints and are deliberately not settable here — each has validation
// this generic builder cannot perform.
export const buildTripFields = (body = {}) => {
  const fields = {};

  if (body.tripDate !== undefined) fields.tripDate = date(body.tripDate) || new Date();
  if (body.tripType !== undefined && TRIP_TYPES.includes(body.tripType)) {
    fields.tripType = body.tripType;
  }
  if (body.notes !== undefined) fields.notes = str(body.notes);
  if (body.customer !== undefined) fields.customer = objectId(body.customer);

  if (body.customerReferences !== undefined) {
    const r = body.customerReferences || {};
    fields.customerReferences = {
      po: str(r.po),
      bookingNumber: str(r.bookingNumber),
      customerRef: str(r.customerRef),
      invoiceRef: str(r.invoiceRef)
    };
  }

  if (body.pickup !== undefined) fields.pickup = cleanLocation(body.pickup);
  if (body.destination !== undefined) fields.destination = cleanLocation(body.destination);
  if (body.pickupPlannedAt !== undefined) fields.pickupPlannedAt = date(body.pickupPlannedAt);
  if (body.destinationExpectedAt !== undefined) {
    fields.destinationExpectedAt = date(body.destinationExpectedAt);
  }

  if (body.consignment !== undefined) {
    const c = body.consignment || {};
    fields.consignment = {
      lrNumber: str(c.lrNumber),
      consignmentNumber: str(c.consignmentNumber),
      ewayBill: str(c.ewayBill),
      invoiceNumber: str(c.invoiceNumber),
      challanNumber: str(c.challanNumber),
      poNumber: str(c.poNumber),
      deliveryOrder: str(c.deliveryOrder)
    };
  }

  if (body.plannedKm !== undefined) fields.plannedKm = num(body.plannedKm);
  if (body.plannedMinutes !== undefined) fields.plannedMinutes = num(body.plannedMinutes);

  return fields;
};

// The checklist, normalised to one entry per known key. Anything the client
// sends for an unknown key is dropped, and a key it omits keeps its stored
// state rather than being silently unticked.
export const buildChecklist = (input = [], existing = [], userId = null) => {
  const sent = new Map(
    (Array.isArray(input) ? input : [])
      .filter((i) => CHECKLIST_KEYS.includes(i?.key))
      .map((i) => [i.key, i])
  );
  const before = new Map((existing || []).map((i) => [i.key, i]));

  return CHECKLIST_KEYS.map((key) => {
    const prior = before.get(key);
    if (!sent.has(key)) {
      return (
        prior || { key, checked: false, checkedAt: null, checkedBy: null, notes: '' }
      );
    }

    const item = sent.get(key);
    const checked = Boolean(item.checked);
    return {
      key,
      checked,
      // The tick keeps its original timestamp when it was already ticked, so
      // re-saving the checklist does not rewrite when each check was made.
      checkedAt: checked ? prior?.checkedAt || new Date() : null,
      checkedBy: checked ? prior?.checkedBy || userId : null,
      notes: item.notes !== undefined ? str(item.notes) : prior?.notes || ''
    };
  });
};
