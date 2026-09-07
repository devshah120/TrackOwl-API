import mongoose from 'mongoose';
import {
  FUEL_TYPES,
  PAYMENT_MODES,
  FILL_TYPES,
  BASELINE_MODES,
  DEFAULT_SETTINGS,
  unitFor,
  reconcileAmount
} from './fuel.js';

// Turns a request body into the shape FuelEntry expects, dropping anything the
// caller has no business setting.
//
// Follows the same rule as utils/tripOrderFields.js: a field the caller never
// sent is left alone, while a field sent empty is genuinely cleared. Those are
// different edits, and conflating them makes a partial save blank fields the
// user never touched.
//
// Nothing computed is accepted from the client. The efficiency block and the
// outlier flags are produced by services/fuelEfficiency.js and would be
// meaningless — worse, forgeable — if a browser could post them.

// Attachments ride in the JSON body as data URIs, capped as elsewhere in the
// app. Base64 inflates by about 4/3, so this is roughly a 3 MB file.
export const MAX_RECEIPT_CHARS = 4 * 1024 * 1024;

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

// A latitude/longitude pair, only accepted when both are present and in range.
// A half-set coordinate would put a station marker on the equator.
const coords = (lat, lng) => {
  const la = num(lat);
  const ln = num(lng);
  if (la === null || ln === null) return { lat: null, lng: null };
  if (la < -90 || la > 90 || ln < -180 || ln > 180) return { lat: null, lng: null };
  return { lat: la, lng: ln };
};

// The station name as the reports will group by it: collapsed whitespace and a
// consistent case. Without this, "HP Petrol Pump", "hp petrol pump" and
// "HP  Petrol Pump" are three stations in the station-wise report.
//
// Title case rather than upper: these names are read in a table, and a column
// of shouting is harder to scan than one of names.
export const normaliseStationName = (name) => {
  const cleaned = str(name).replace(/\s+/g, ' ');
  if (!cleaned) return '';
  return cleaned
    .split(' ')
    .map((word) =>
      // Words that are already all-caps are left as they are: HP, BPCL, IOCL
      // are initialisms, and "Hp" would be wrong.
      word.length > 1 && word === word.toUpperCase()
        ? word
        : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
    )
    .join(' ');
};

export const cleanStation = (input) => {
  if (!input || typeof input !== 'object') return {};
  const { lat, lng } = coords(input.lat, input.lng);
  return {
    name: normaliseStationName(input.name),
    code: str(input.code),
    city: str(input.city),
    state: str(input.state),
    lat,
    lng
  };
};

// The scanned bill. Same shape and the same size guard as the trip expense and
// ledger receipts.
export const cleanReceipt = (input) => {
  if (!input || !input.dataUrl) return { dataUrl: '', filename: '', mimeType: '' };
  return {
    dataUrl: String(input.dataUrl),
    filename: str(input.filename),
    mimeType: str(input.mimeType)
  };
};

export const validateDataUrl = (dataUrl, { max = MAX_RECEIPT_CHARS, label = 'receipt' } = {}) => {
  if (!dataUrl) return null;
  if (!/^data:/.test(String(dataUrl))) return `The ${label} must be an uploaded file`;
  if (String(dataUrl).length > max) {
    return `That ${label} is too large — please keep it under ${Math.round((max / (1024 * 1024)) * 0.75)} MB`;
  }
  return null;
};

// --------------------------------------------------------------------------
// The fuel entry itself
// --------------------------------------------------------------------------

// Builds the writable fields of a fuel entry from a request body.
//
// `partial` is what separates a create from an edit: on create every field is
// considered and the defaults apply; on update only the keys actually present
// in the body are returned, so a form that submits one tab does not blank the
// rest.
//
// Returns { fields, errors }. Validation that needs the database — does this
// truck exist, does this trip belong to the caller — is the route's job; this
// only decides whether the values are well-formed on their own.
export const buildEntryFields = (body = {}, { partial = false } = {}) => {
  const fields = {};
  const errors = [];
  const has = (key) => !partial || Object.prototype.hasOwnProperty.call(body, key);

  if (has('truck')) {
    const truck = objectId(body.truck);
    if (!truck) errors.push('Select the vehicle that was fuelled');
    else fields.truck = truck;
  }

  if (has('driver')) {
    // Explicitly clearable: a driver wrongly attached should be removable.
    fields.driver = objectId(body.driver);
  }

  if (has('filledAt')) {
    const when = date(body.filledAt);
    if (!when) {
      errors.push('Enter the date and time of the filling');
    } else if (when.getTime() > Date.now() + 60 * 60 * 1000) {
      // An hour of slack for a device clock that runs fast. Beyond that a
      // future filling is a typo, and it would sit at the head of the odometer
      // chain and mis-measure every real entry behind it.
      errors.push('The filling date cannot be in the future');
    } else {
      fields.filledAt = when;
    }
  }

  if (has('fuelType')) {
    if (!FUEL_TYPES.includes(body.fuelType)) errors.push('Select a valid fuel type');
    else {
      fields.fuelType = body.fuelType;
      // The unit follows from the fuel type and is never taken from the client.
      fields.unit = unitFor(body.fuelType);
    }
  }

  // Quantity, rate and amount are reconciled together — any two give the third
  // — so they are handled as a group rather than field by field.
  if (has('quantity') || has('rate') || has('amount')) {
    const reconciled = reconcileAmount({
      quantity: body.quantity,
      rate: body.rate,
      amount: body.amount
    });

    if (reconciled.quantity === null || reconciled.quantity <= 0) {
      errors.push('Enter how much fuel was filled');
    }
    if (reconciled.amount === null) {
      errors.push('Enter the amount paid, or the rate so it can be worked out');
    }

    if (reconciled.quantity !== null) fields.quantity = reconciled.quantity;
    if (reconciled.rate !== null) fields.rate = reconciled.rate;
    if (reconciled.amount !== null) fields.amount = reconciled.amount;
  }

  if (has('fillType')) {
    fields.fillType = FILL_TYPES.includes(body.fillType) ? body.fillType : 'full';
  }

  if (has('odometer')) {
    const odometer = num(body.odometer);
    if (odometer !== null && odometer < 0) errors.push('The odometer reading cannot be negative');
    else fields.odometer = odometer;
  }

  if (has('paymentMode')) {
    fields.paymentMode = PAYMENT_MODES.includes(body.paymentMode) ? body.paymentMode : 'Cash';
  }

  if (has('billNumber')) fields.billNumber = str(body.billNumber);
  if (has('remarks')) fields.remarks = str(body.remarks);
  if (has('station')) fields.station = cleanStation(body.station);

  if (has('receipt')) {
    const receipt = cleanReceipt(body.receipt);
    const problem = validateDataUrl(receipt.dataUrl);
    if (problem) errors.push(problem);
    else fields.receipt = receipt;
  }

  if (has('trip')) {
    // Clearable, like driver: a bill attached to the wrong trip must be
    // detachable.
    fields.trip = objectId(body.trip);
  }

  return { fields, errors };
};

// --------------------------------------------------------------------------
// Settings
// --------------------------------------------------------------------------

// Cleans a settings payload. Out-of-range numbers are rejected rather than
// clamped: a threshold silently changed from what was typed is a setting the
// user believes is in force and is not.
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

  if (Object.prototype.hasOwnProperty.call(body, 'baselineMode')) {
    if (!BASELINE_MODES.includes(body.baselineMode)) {
      errors.push('Select what mileage should be compared against');
    } else {
      fields.baselineMode = body.baselineMode;
    }
  }

  // Bounds mirror the schema's validators so the message comes back from one
  // place rather than as a Mongoose ValidationError at save time.
  bounded('lowEfficiencyPct', 'The low-efficiency threshold', 1, 90);
  bounded('highEfficiencyPct', 'The high-efficiency threshold', 1, 500);
  bounded('minSamples', 'The minimum sample count', 2, 50);
  bounded('baselineWindowDays', 'The baseline window', 7, 1095);
  bounded('rateOutlierPct', 'The rate outlier threshold', 1, 200);
  bounded('maxQuantityPerFill', 'The maximum quantity per filling', 1, 100000);

  return { fields, errors };
};

export { DEFAULT_SETTINGS };
