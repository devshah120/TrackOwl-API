import mongoose from 'mongoose';
import {
  SERVICE_TYPES,
  REPAIR_STATUSES,
  REPAIR_PRIORITIES,
  TYRE_STATUSES,
  BATTERY_STATUSES,
  BATTERY_HEALTH,
  PAYMENT_MODES,
  WORKSHOP_TYPES,
  computeJobTotal
} from './maintenance.js';

// Turns request bodies into the shapes the maintenance models expect, dropping
// anything the caller has no business setting.
//
// Follows the same rule as utils/fuelFields.js and utils/tripOrderFields.js: a
// field the caller never sent is left alone, while a field sent empty is
// genuinely cleared. Those are different edits, and conflating them makes a
// partial save blank fields the user never touched.
//
// Nothing computed is accepted from the client. Job totals, tyre running
// kilometres, cost per km and the repair workflow stamps are produced
// server-side and would be meaningless — worse, forgeable — if a browser could
// post them.

// Attachments ride in the JSON body as data URIs, capped as elsewhere in the
// app. Base64 inflates by about 4/3, so this is roughly a 3 MB file.
export const MAX_INVOICE_CHARS = 4 * 1024 * 1024;

const num = (v) => {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const str = (v) => String(v ?? '').trim();

const date = (v) => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

export const objectId = (v) =>
  v && mongoose.Types.ObjectId.isValid(v) ? new mongoose.Types.ObjectId(v) : null;

// --------------------------------------------------------------------------
// Shared pieces
// --------------------------------------------------------------------------

// The workshop name as the vendor report will group by it: collapsed
// whitespace and a consistent case. Without this, "Sharma Motors", "sharma
// motors" and "Sharma  Motors" are three vendors in the vendor-wise report.
//
// Title case rather than upper, for the reason utils/fuelFields.js gives about
// station names: a column of shouting is harder to scan than one of names.
export const normaliseWorkshopName = (name) => {
  const cleaned = str(name).replace(/\s+/g, ' ');
  if (!cleaned) return '';
  return cleaned
    .split(' ')
    .map((word) =>
      // Words already all-caps are left alone: TVS, MRF and ABC are
      // initialisms, and "Tvs" would be wrong.
      word.length > 1 && word === word.toUpperCase()
        ? word
        : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
    )
    .join(' ');
};

export const cleanWorkshop = (input) => {
  if (!input || typeof input !== 'object') return {};
  return {
    name: normaliseWorkshopName(input.name),
    type: WORKSHOP_TYPES.includes(input.type) ? input.type : 'Local',
    contact: str(input.contact),
    city: str(input.city),
    gstin: str(input.gstin).toUpperCase()
  };
};

export const cleanInvoice = (input) => {
  if (!input || !input.dataUrl) return { dataUrl: '', filename: '', mimeType: '' };
  return {
    dataUrl: String(input.dataUrl),
    filename: str(input.filename),
    mimeType: str(input.mimeType)
  };
};

export const validateDataUrl = (dataUrl, { max = MAX_INVOICE_CHARS, label = 'invoice' } = {}) => {
  if (!dataUrl) return null;
  if (!/^data:/.test(String(dataUrl))) return `The ${label} must be an uploaded file`;
  if (String(dataUrl).length > max) {
    return `That ${label} is too large — please keep it under ${Math.round((max / (1024 * 1024)) * 0.75)} MB`;
  }
  return null;
};

// The parts fitted on a job. Lines with no name are dropped rather than
// rejected: a form with a spare blank row at the bottom is normal, and failing
// the save over it would be picking a fight with the user interface.
//
// Each line's `amount` is computed here from quantity × unitPrice, never taken
// from the body, so a line can never claim a total its own figures do not
// support.
export const cleanParts = (input) => {
  if (!Array.isArray(input)) return [];
  return input
    .filter((part) => part && str(part.name))
    .map((part) => {
      const quantity = Math.max(0, num(part.quantity) ?? 1);
      const unitPrice = Math.max(0, num(part.unitPrice) ?? 0);
      return {
        name: str(part.name),
        partNumber: str(part.partNumber),
        quantity,
        unitPrice,
        amount: Math.round(quantity * unitPrice * 100) / 100,
        warrantyMonths: num(part.warrantyMonths),
        remarks: str(part.remarks)
      };
    });
};

// The money fields every job card shares, plus the derived totals. Returns the
// fields to set and any complaints.
//
// The totals are recomputed from whatever the merged record will hold, which is
// why the caller passes `existing`: a partial edit that changes only the labour
// cost still has to re-add the parts already stored, or the total would drop to
// the labour alone.
const applyJobCosting = ({ body, fields, has, existing }) => {
  const errors = [];

  if (has('parts')) fields.parts = cleanParts(body.parts);

  for (const key of ['labourCost', 'taxAmount', 'discount']) {
    if (!has(key)) continue;
    const value = num(body[key]);
    if (value === null) {
      fields[key] = 0;
    } else if (value < 0) {
      errors.push(`The ${key === 'labourCost' ? 'labour cost' : key === 'taxAmount' ? 'tax' : 'discount'} cannot be negative`);
    } else {
      fields[key] = value;
    }
  }

  if (has('paymentMode')) {
    fields.paymentMode = PAYMENT_MODES.includes(body.paymentMode) ? body.paymentMode : 'Cash';
  }
  if (has('invoiceNumber')) fields.invoiceNumber = str(body.invoiceNumber);

  if (has('invoice')) {
    const invoice = cleanInvoice(body.invoice);
    const problem = validateDataUrl(invoice.dataUrl);
    if (problem) errors.push(problem);
    else fields.invoice = invoice;
  }

  // The merged view of the record: what is being set, over what is already
  // stored. Totals must describe the record as it will be after the save, not
  // the fragment that arrived in this request.
  const merged = {
    parts: fields.parts ?? existing?.parts ?? [],
    labourCost: fields.labourCost ?? existing?.labourCost ?? 0,
    taxAmount: fields.taxAmount ?? existing?.taxAmount ?? 0,
    discount: fields.discount ?? existing?.discount ?? 0
  };

  const totals = computeJobTotal(merged);
  fields.partsTotal = totals.partsTotal;
  fields.totalCost = totals.total;

  return errors;
};

// A date that must not be in the future, with an hour of slack for a device
// clock that runs fast. Used for every "when did this happen" field here: a
// service dated next month would sit at the head of the vehicle's history and
// mis-order everything real behind it.
const pastDate = (value, label) => {
  const when = date(value);
  if (!when) return { value: null, error: `Enter ${label}` };
  if (when.getTime() > Date.now() + 60 * 60 * 1000) {
    return { value: null, error: `${label.charAt(0).toUpperCase()}${label.slice(1)} cannot be in the future` };
  }
  return { value: when, error: null };
};

// --------------------------------------------------------------------------
// M3-M02 — Service record
// --------------------------------------------------------------------------

export const buildServiceFields = (body = {}, { partial = false, existing = null } = {}) => {
  const fields = {};
  const errors = [];
  const has = (key) => !partial || Object.prototype.hasOwnProperty.call(body, key);

  if (has('truck')) {
    const truck = objectId(body.truck);
    if (!truck) errors.push('Select the vehicle that was serviced');
    else fields.truck = truck;
  }

  if (has('serviceType')) {
    if (!SERVICE_TYPES.includes(body.serviceType)) errors.push('Select a valid service type');
    else fields.serviceType = body.serviceType;
  }

  if (has('servicedAt')) {
    const { value, error } = pastDate(body.servicedAt, 'the service date');
    if (error) errors.push(error);
    else fields.servicedAt = value;
  }

  if (has('odometer')) {
    const odometer = num(body.odometer);
    if (odometer !== null && odometer < 0) errors.push('The odometer reading cannot be negative');
    else fields.odometer = odometer;
  }

  if (has('workshop')) fields.workshop = cleanWorkshop(body.workshop);

  // The next-service clocks. Both optional and both clearable — a job with no
  // follow-up scheduled is a real job, and a reminder set by mistake has to be
  // removable.
  if (has('nextServiceDate')) fields.nextServiceDate = date(body.nextServiceDate);

  if (has('nextServiceKm')) {
    const km = num(body.nextServiceKm);
    if (km !== null && km < 0) errors.push('The next service reading cannot be negative');
    else fields.nextServiceKm = km;
  }

  // A next-service reading below the reading at the service itself would be
  // due the moment it was saved. Checked against the merged pair so the
  // complaint still fires when only one of the two is being edited.
  const odoNow = fields.odometer ?? existing?.odometer ?? null;
  const dueKm = fields.nextServiceKm ?? existing?.nextServiceKm ?? null;
  if (odoNow !== null && dueKm !== null && dueKm <= odoNow) {
    errors.push('The next service reading must be higher than the reading at this service');
  }

  if (has('repair')) fields.repair = objectId(body.repair);
  if (has('notes')) fields.notes = str(body.notes);

  errors.push(...applyJobCosting({ body, fields, has, existing }));

  return { fields, errors };
};

// --------------------------------------------------------------------------
// M3-M04 — Repair request
// --------------------------------------------------------------------------

// The status is deliberately absent from this builder. A repair moves through
// its workflow via its own endpoint, which checks the transition is legal and
// stamps the milestones — letting a plain field edit set it would let a job
// skip from Reported to Completed with no record of the work in between.
export const buildRepairFields = (body = {}, { partial = false, existing = null } = {}) => {
  const fields = {};
  const errors = [];
  const has = (key) => !partial || Object.prototype.hasOwnProperty.call(body, key);

  if (has('truck')) {
    const truck = objectId(body.truck);
    if (!truck) errors.push('Select the vehicle that needs repair');
    else fields.truck = truck;
  }

  if (has('issue')) {
    const issue = str(body.issue);
    if (!issue) errors.push('Describe what is wrong with the vehicle');
    else fields.issue = issue;
  }

  // Clearable: a request attributed to the wrong driver must be correctable,
  // and one raised by the office has no driver at all.
  if (has('reportedBy')) fields.reportedBy = objectId(body.reportedBy);

  if (has('reportedAt')) {
    const { value, error } = pastDate(body.reportedAt, 'the date the fault was reported');
    if (error) errors.push(error);
    else fields.reportedAt = value;
  }

  if (has('odometer')) {
    const odometer = num(body.odometer);
    if (odometer !== null && odometer < 0) errors.push('The odometer reading cannot be negative');
    else fields.odometer = odometer;
  }

  if (has('priority')) {
    fields.priority = REPAIR_PRIORITIES.includes(body.priority) ? body.priority : 'Medium';
  }

  if (has('workshop')) fields.workshop = cleanWorkshop(body.workshop);

  if (has('estimatedCost')) {
    const estimate = num(body.estimatedCost);
    if (estimate !== null && estimate < 0) errors.push('The estimate cannot be negative');
    else fields.estimatedCost = estimate;
  }

  if (has('diagnosis')) fields.diagnosis = str(body.diagnosis);
  if (has('workDone')) fields.workDone = str(body.workDone);
  if (has('notes')) fields.notes = str(body.notes);

  errors.push(...applyJobCosting({ body, fields, has, existing }));

  return { fields, errors };
};

// A status change, validated on its own because it carries a note rather than
// a record's worth of fields.
export const buildStatusChange = (body = {}) => {
  const errors = [];
  const status = str(body.status);

  if (!REPAIR_STATUSES.includes(status)) {
    errors.push('Select a valid repair status');
  }

  return { status, note: str(body.note), errors };
};

// --------------------------------------------------------------------------
// M3-M06 — Tyre
// --------------------------------------------------------------------------

// Fitment is deliberately absent here too: a tyre goes on and comes off a
// vehicle through its own endpoints, which open and close the stint the
// distance tracking is measured over. A plain field edit that could rewrite
// `truck` and `position` would leave the running kilometres describing a
// journey the tyre never made.
export const buildTyreFields = (body = {}, { partial = false } = {}) => {
  const fields = {};
  const errors = [];
  const has = (key) => !partial || Object.prototype.hasOwnProperty.call(body, key);

  if (has('tyreNumber')) {
    const number = str(body.tyreNumber).toUpperCase();
    if (!number) errors.push('Enter the tyre number');
    else fields.tyreNumber = number;
  }

  if (has('brand')) fields.brand = str(body.brand);
  if (has('model')) fields.model = str(body.model);
  if (has('size')) fields.size = str(body.size);
  if (has('serialNumber')) fields.serialNumber = str(body.serialNumber).toUpperCase();

  if (has('purchaseDate')) fields.purchaseDate = date(body.purchaseDate);
  if (has('purchaseFrom')) fields.purchaseFrom = normaliseWorkshopName(body.purchaseFrom);
  if (has('invoiceNumber')) fields.invoiceNumber = str(body.invoiceNumber);

  if (has('price')) {
    const price = num(body.price);
    if (price !== null && price < 0) errors.push('The price cannot be negative');
    else fields.price = price ?? 0;
  }

  if (has('warrantyMonths')) {
    const months = num(body.warrantyMonths);
    if (months !== null && months < 0) errors.push('The warranty cannot be negative');
    else fields.warrantyMonths = months;
  }

  if (has('ratedKm')) {
    const km = num(body.ratedKm);
    if (km !== null && km < 0) errors.push('The rated life cannot be negative');
    else fields.ratedKm = km;
  }

  // Status is settable here only for the stock-side transitions the fitment
  // endpoints do not cover — scrapping a worn tyre, marking one sold. The
  // route refuses the ones that imply a fitment.
  if (has('status')) {
    if (!TYRE_STATUSES.includes(body.status)) errors.push('Select a valid tyre status');
    else fields.status = body.status;
  }

  if (has('treadDepthMm')) {
    const tread = num(body.treadDepthMm);
    if (tread !== null && (tread < 0 || tread > 30)) {
      errors.push('That tread depth reading looks wrong');
    } else {
      fields.treadDepthMm = tread;
      // The reading is only meaningful with a date against it, and the date is
      // now — a tread depth typed today does not describe last month.
      fields.treadCheckedAt = tread === null ? null : new Date();
    }
  }

  if (has('scrapReason')) fields.scrapReason = str(body.scrapReason);

  if (has('salvageValue')) {
    const value = num(body.salvageValue);
    if (value !== null && value < 0) errors.push('The salvage value cannot be negative');
    else fields.salvageValue = value;
  }

  if (has('notes')) fields.notes = str(body.notes);

  return { fields, errors };
};

// Fitting a tyre to a vehicle: which vehicle, which position, at what reading.
export const buildFitment = (body = {}) => {
  const errors = [];

  const truck = objectId(body.truck);
  if (!truck) errors.push('Select the vehicle the tyre is going on');

  const position = str(body.position);
  if (!position) errors.push('Select the position the tyre is fitted at');

  const odometer = num(body.odometer);
  if (odometer === null) {
    // Required, unlike most odometer fields here: without a reading at fitment
    // there is no anchor to measure the tyre's distance from, and M3-M08's cost
    // per km is the whole reason the master exists.
    errors.push('Enter the vehicle odometer reading, so the tyre’s distance can be measured');
  } else if (odometer < 0) {
    errors.push('The odometer reading cannot be negative');
  }

  const fittedAt = date(body.fittedAt) || new Date();
  if (fittedAt.getTime() > Date.now() + 60 * 60 * 1000) {
    errors.push('The fitment date cannot be in the future');
  }

  return {
    fitment: { truck, position, odometer, fittedAt, notes: str(body.notes) },
    errors
  };
};

// Taking a tyre off: at what reading, why, and what state it came off in.
export const buildRemoval = (body = {}) => {
  const errors = [];

  const odometer = num(body.odometer);
  if (odometer === null) {
    errors.push('Enter the vehicle odometer reading at removal');
  } else if (odometer < 0) {
    errors.push('The odometer reading cannot be negative');
  }

  const removedAt = date(body.removedAt) || new Date();
  if (removedAt.getTime() > Date.now() + 60 * 60 * 1000) {
    errors.push('The removal date cannot be in the future');
  }

  const tread = num(body.treadAtRemovalMm);
  if (tread !== null && (tread < 0 || tread > 30)) {
    errors.push('That tread depth reading looks wrong');
  }

  // Where the tyre goes next. Anything that is not a terminal state puts it
  // back in stock, because a tyre that has come off a vehicle and not been
  // scrapped is, by definition, on the shelf.
  const status = TYRE_STATUSES.includes(body.status) ? body.status : 'Removed';

  return {
    removal: {
      odometer,
      removedAt,
      treadAtRemovalMm: tread,
      reason: str(body.reason),
      status,
      notes: str(body.notes)
    },
    errors
  };
};

// A retread: what it cost and who did it.
export const buildRetread = (body = {}) => {
  const errors = [];

  const cost = num(body.cost);
  if (cost !== null && cost < 0) errors.push('The retread cost cannot be negative');

  const when = date(body.date) || new Date();
  if (when.getTime() > Date.now() + 60 * 60 * 1000) {
    errors.push('The retread date cannot be in the future');
  }

  return {
    retread: {
      date: when,
      vendor: normaliseWorkshopName(body.vendor),
      cost: cost ?? 0,
      notes: str(body.notes)
    },
    errors
  };
};

// --------------------------------------------------------------------------
// M3-M09 — Battery
// --------------------------------------------------------------------------

export const buildBatteryFields = (body = {}, { partial = false } = {}) => {
  const fields = {};
  const errors = [];
  const has = (key) => !partial || Object.prototype.hasOwnProperty.call(body, key);

  if (has('serialNumber')) {
    const serial = str(body.serialNumber).toUpperCase();
    if (!serial) errors.push('Enter the battery serial number');
    else fields.serialNumber = serial;
  }

  if (has('brand')) fields.brand = str(body.brand);
  if (has('model')) fields.model = str(body.model);

  if (has('voltage')) {
    const voltage = num(body.voltage);
    if (voltage !== null && (voltage <= 0 || voltage > 100)) {
      errors.push('That voltage looks wrong');
    } else {
      fields.voltage = voltage ?? 12;
    }
  }

  if (has('capacityAh')) {
    const capacity = num(body.capacityAh);
    if (capacity !== null && capacity < 0) errors.push('The capacity cannot be negative');
    else fields.capacityAh = capacity;
  }

  if (has('purchaseDate')) fields.purchaseDate = date(body.purchaseDate);
  if (has('purchaseFrom')) fields.purchaseFrom = normaliseWorkshopName(body.purchaseFrom);
  if (has('invoiceNumber')) fields.invoiceNumber = str(body.invoiceNumber);

  if (has('cost')) {
    const cost = num(body.cost);
    if (cost !== null && cost < 0) errors.push('The cost cannot be negative');
    else fields.cost = cost ?? 0;
  }

  if (has('warrantyMonths')) {
    const months = num(body.warrantyMonths);
    if (months !== null && months < 0) errors.push('The warranty cannot be negative');
    else fields.warrantyMonths = months;
  }

  if (has('status')) {
    if (!BATTERY_STATUSES.includes(body.status)) errors.push('Select a valid battery status');
    else fields.status = body.status;
  }

  if (has('expectedReplacementDate')) {
    fields.expectedReplacementDate = date(body.expectedReplacementDate);
  }

  if (has('removalReason')) fields.removalReason = str(body.removalReason);
  if (has('notes')) fields.notes = str(body.notes);

  return { fields, errors };
};

// Fitting a battery to a vehicle.
export const buildBatteryInstall = (body = {}) => {
  const errors = [];

  const truck = objectId(body.truck);
  if (!truck) errors.push('Select the vehicle the battery is going on');

  const odometer = num(body.odometer);
  if (odometer !== null && odometer < 0) errors.push('The odometer reading cannot be negative');

  const installedAt = date(body.installedAt) || new Date();
  if (installedAt.getTime() > Date.now() + 60 * 60 * 1000) {
    errors.push('The installation date cannot be in the future');
  }

  return {
    install: {
      truck,
      // Free text, like a tyre position: 'Battery 1' / 'Battery 2' on a pair,
      // and whatever the fleet calls it on anything else.
      position: str(body.position),
      odometer,
      installedAt
    },
    errors
  };
};

// A voltage/health check (M3-M09's "voltage/health").
export const buildBatteryCheck = (body = {}) => {
  const errors = [];

  const voltage = num(body.voltage);
  if (voltage !== null && (voltage < 0 || voltage > 100)) {
    errors.push('That voltage reading looks wrong');
  }

  const health = str(body.health);
  if (health && !BATTERY_HEALTH.includes(health)) {
    errors.push('Select a valid health verdict');
  }

  if (voltage === null && !health) {
    // A check that recorded neither a reading nor a verdict recorded nothing.
    errors.push('Record a voltage reading, a health verdict, or both');
  }

  const when = date(body.date) || new Date();
  if (when.getTime() > Date.now() + 60 * 60 * 1000) {
    errors.push('The check date cannot be in the future');
  }

  const gravity = num(body.specificGravity);
  if (gravity !== null && (gravity < 1 || gravity > 1.5)) {
    errors.push('That specific gravity reading looks wrong');
  }

  return {
    check: {
      date: when,
      voltage,
      health: health || null,
      specificGravity: gravity,
      checkedBy: str(body.checkedBy),
      notes: str(body.notes)
    },
    errors
  };
};

// --------------------------------------------------------------------------
// M3-M10 — Settings
// --------------------------------------------------------------------------

// Cleans a settings payload. Out-of-range numbers are rejected rather than
// clamped, for the reason utils/fuelFields.js gives: a threshold silently
// changed from what was typed is a setting the user believes is in force and
// is not.
export const buildSettingsFields = (body = {}) => {
  const fields = {};
  const errors = [];

  const bounded = (key, label, min, max) => {
    if (!Object.prototype.hasOwnProperty.call(body, key)) return;
    const value = num(body[key]);
    if (value === null) {
      errors.push(`${label} must be a number`);
      return;
    }
    if (value < min || value > max) {
      errors.push(`${label} must be between ${min} and ${max}`);
      return;
    }
    fields[key] = value;
  };

  // Bounds mirror the schema's validators so the message comes back from one
  // place rather than as a Mongoose ValidationError at save time.
  bounded('serviceDueDays', 'The service reminder window', 1, 365);
  bounded('serviceDueKm', 'The service reminder distance', 50, 50000);
  bounded('overdueGraceDays', 'The overdue grace period', 1, 730);
  bounded('tyreMinTreadMm', 'The minimum tread depth', 1.6, 10);
  bounded('batteryLifeMonths', 'The expected battery life', 6, 120);
  bounded('warrantyWarnDays', 'The warranty warning window', 1, 180);

  return { fields, errors };
};
