import Truck from '../models/Truck.js';
import Driver from '../models/Driver.js';
import TripOrder from '../models/TripOrder.js';
import VehicleDocument from '../models/VehicleDocument.js';
import DriverDocument from '../models/DriverDocument.js';
import { expiryState } from '../utils/vehicleDocuments.js';
import { ACTIVE_STATUSES } from '../utils/tripOrders.js';

// The checks run before a vehicle or a driver is committed to a trip.
//
// Every check returns one of two things, and the distinction is the whole point
// of this module:
//
//   blockers — the assignment is refused. Reserved for conditions where going
//              ahead would corrupt data or put an illegal vehicle on the road:
//              a resource already out on another trip, expired statutory
//              paperwork, a load over the vehicle's rated capacity.
//
//   warnings — the assignment proceeds and the operator is told. Everything
//              that is a judgement call: paperwork expiring this month, a
//              vehicle flagged for maintenance, low fuel.
//
// A dispatcher at 6am with a load to move knows things this system does not.
// Blocking on everything questionable would train them to find a way around the
// software; warning on what is genuinely a choice keeps the blocks meaningful.
// Blockers can still be overridden explicitly by a seat holding trips:manage —
// see `allowOverride` on the assignment routes — and the override is audited.

// Statuses that mean the vehicle is unavailable for a new job, taken from the
// vehicle master rather than from its trips. 'Maintenance' warns rather than
// blocks: a truck can be booked for tomorrow while it is in the workshop today.
const UNAVAILABLE_VEHICLE_STATUSES = ['Inactive'];

// Fuel below this fraction of a tank is worth mentioning at dispatch. Not a
// blocker — the driver fills up on the way out, which is exactly why the
// checklist has a fuel line.
const LOW_FUEL_PCT = 20;

// Statutory paperwork a vehicle may not legally run without. An expired one of
// these is a blocker; the rest of the document types warn.
const CRITICAL_VEHICLE_DOCS = ['Insurance', 'PUC', 'Fitness', 'Permit'];

// Everything known about one vehicle that bears on whether it can take this
// trip. Shaped for the assignment panel, which shows the operator the vehicle's
// state before they commit to it.
export const inspectVehicle = async (truckId, { accountId, excludeTripId = null } = {}) => {
  const truck = await Truck.findOne({ _id: truckId, owner: accountId }).lean();
  if (!truck) return null;

  // The trip currently holding this vehicle, if any. Excluding the trip being
  // edited matters: re-saving a trip must not report its own vehicle as busy.
  const activeTrip = await TripOrder.findOne({
    owner: accountId,
    truck: truck._id,
    status: { $in: ACTIVE_STATUSES },
    ...(excludeTripId ? { _id: { $ne: excludeTripId } } : {})
  })
    .select('tripNumber status pickup.city destination.city')
    .lean();

  const documents = await VehicleDocument.find({ owner: accountId, truck: truck._id })
    .select('docType expiryDate documentNumber')
    .lean();

  const docs = documents.map((d) => ({
    docType: d.docType,
    documentNumber: d.documentNumber,
    expiryDate: d.expiryDate,
    state: expiryState(d.expiryDate)
  }));

  // The primary driver currently on this truck, so the assignment panel can
  // offer them rather than making the operator look the pairing up.
  const primaryDriver = await Driver.findOne({
    owner: accountId,
    truck: truck._id,
    isPrimary: true
  })
    .select('name mobile licenseNumber licenseExpiry status')
    .lean();

  return {
    truck: {
      _id: truck._id,
      number: truck.number,
      model: truck.model,
      vehicleType: truck.vehicleType,
      status: truck.status,
      odometer: truck.odometer,
      fuelType: truck.fuelType,
      capacity: truck.capacity || {},
      currentRoute: truck.currentRoute,
      device: truck.device || null
    },
    activeTrip: activeTrip || null,
    documents: docs,
    primaryDriver: primaryDriver || null
  };
};

// Everything known about one driver that bears on this trip.
export const inspectDriver = async (driverId, { accountId, excludeTripId = null } = {}) => {
  const driver = await Driver.findOne({ _id: driverId, owner: accountId })
    .populate('truck', 'number model')
    .lean();
  if (!driver) return null;

  const activeTrip = await TripOrder.findOne({
    owner: accountId,
    driver: driver._id,
    status: { $in: ACTIVE_STATUSES },
    ...(excludeTripId ? { _id: { $ne: excludeTripId } } : {})
  })
    .select('tripNumber status')
    .lean();

  const documents = await DriverDocument.find({ owner: accountId, driver: driver._id })
    .select('docType expiryDate documentNumber')
    .lean();

  return {
    driver: {
      _id: driver._id,
      name: driver.name,
      mobile: driver.mobile,
      licenseNumber: driver.licenseNumber,
      licenseExpiry: driver.licenseExpiry,
      licenseState: expiryState(driver.licenseExpiry),
      status: driver.status,
      truck: driver.truck || null
    },
    activeTrip: activeTrip || null,
    documents: documents.map((d) => ({
      docType: d.docType,
      documentNumber: d.documentNumber,
      expiryDate: d.expiryDate,
      state: expiryState(d.expiryDate)
    }))
  };
};

// Totals the cargo lines and compares them against what the vehicle is rated
// for. Returns blockers when the load exceeds capacity — an overloaded vehicle
// is a legal and safety problem, not a preference.
//
// A capacity of null means the master has not recorded one. That produces no
// finding at all: an unknown limit cannot be exceeded, and inventing a warning
// for every vehicle whose capacity was never filled in would bury the real
// ones.
export const validateCapacity = (cargo = [], capacity = {}) => {
  const blockers = [];
  const warnings = [];

  const totalWeight = cargo.reduce((sum, c) => sum + (Number(c?.weightKg) || 0), 0);
  const totalVolume = cargo.reduce((sum, c) => sum + (Number(c?.volumeM3) || 0), 0);

  const maxWeight = Number(capacity?.weightKg);
  const maxVolume = Number(capacity?.volumeM3);

  if (Number.isFinite(maxWeight) && maxWeight > 0 && totalWeight > maxWeight) {
    blockers.push(
      `Cargo weight ${totalWeight.toLocaleString()} kg exceeds the vehicle capacity of ${maxWeight.toLocaleString()} kg`
    );
  } else if (Number.isFinite(maxWeight) && maxWeight > 0 && totalWeight > maxWeight * 0.9) {
    // Near the limit is worth flagging: a load booked at 95% of rating leaves
    // no room for the pallet that turns up at the dock unannounced.
    warnings.push(
      `Cargo weight ${totalWeight.toLocaleString()} kg is close to the vehicle capacity of ${maxWeight.toLocaleString()} kg`
    );
  }

  if (Number.isFinite(maxVolume) && maxVolume > 0 && totalVolume > maxVolume) {
    blockers.push(
      `Cargo volume ${totalVolume} m³ exceeds the vehicle capacity of ${maxVolume} m³`
    );
  }

  return { blockers, warnings, totalWeight, totalVolume };
};

// The full pre-assignment verdict for a vehicle: may this truck take this trip,
// and what should the operator be told either way.
export const validateVehicleAssignment = async (
  truckId,
  { accountId, cargo = [], excludeTripId = null } = {}
) => {
  const detail = await inspectVehicle(truckId, { accountId, excludeTripId });
  if (!detail) return { ok: false, blockers: ['Vehicle not found'], warnings: [], detail: null };

  const blockers = [];
  const warnings = [];

  if (detail.activeTrip) {
    blockers.push(
      `This vehicle is already on trip ${detail.activeTrip.tripNumber}. Complete or cancel it first.`
    );
  }

  if (UNAVAILABLE_VEHICLE_STATUSES.includes(detail.truck.status)) {
    blockers.push(`This vehicle is marked ${detail.truck.status} and cannot be dispatched`);
  }

  if (detail.truck.status === 'Maintenance') {
    warnings.push('This vehicle is currently marked as under maintenance');
  }

  // Statutory paperwork. Expired critical documents block; expiring ones and
  // non-critical expiries warn.
  for (const doc of detail.documents) {
    if (doc.state === 'expired') {
      if (CRITICAL_VEHICLE_DOCS.includes(doc.docType)) {
        blockers.push(`The vehicle's ${doc.docType} expired on ${formatDate(doc.expiryDate)}`);
      } else {
        warnings.push(`The vehicle's ${doc.docType} expired on ${formatDate(doc.expiryDate)}`);
      }
    } else if (doc.state === 'expiring') {
      warnings.push(`The vehicle's ${doc.docType} expires on ${formatDate(doc.expiryDate)}`);
    }
  }

  // A vehicle with none of the critical paperwork on file at all is worth
  // saying so about — silence here otherwise reads as "all clear".
  const onFile = new Set(detail.documents.map((d) => d.docType));
  const missing = CRITICAL_VEHICLE_DOCS.filter((t) => !onFile.has(t));
  if (missing.length) {
    warnings.push(`No ${missing.join(', ')} document on file for this vehicle`);
  }

  const capacityCheck = validateCapacity(cargo, detail.truck.capacity);
  blockers.push(...capacityCheck.blockers);
  warnings.push(...capacityCheck.warnings);

  return {
    ok: blockers.length === 0,
    blockers,
    warnings,
    detail: { ...detail, capacityCheck }
  };
};

// The same verdict for a driver.
export const validateDriverAssignment = async (
  driverId,
  { accountId, excludeTripId = null } = {}
) => {
  const detail = await inspectDriver(driverId, { accountId, excludeTripId });
  if (!detail) return { ok: false, blockers: ['Driver not found'], warnings: [], detail: null };

  const blockers = [];
  const warnings = [];

  if (detail.activeTrip) {
    blockers.push(
      `This driver is already on trip ${detail.activeTrip.tripNumber}. Complete or cancel it first.`
    );
  }

  if (detail.driver.status === 'Inactive') {
    blockers.push('This driver is marked Inactive');
  }
  if (detail.driver.status === 'Leave' || detail.driver.status === 'Off Duty') {
    warnings.push(`This driver is marked ${detail.driver.status}`);
  }

  // Driving on an expired licence is an offence for both the driver and the
  // operator, so this blocks rather than warns.
  if (detail.driver.licenseState === 'expired') {
    blockers.push(`The driver's licence expired on ${formatDate(detail.driver.licenseExpiry)}`);
  } else if (detail.driver.licenseState === 'expiring') {
    warnings.push(`The driver's licence expires on ${formatDate(detail.driver.licenseExpiry)}`);
  } else if (detail.driver.licenseState === 'none') {
    warnings.push('No licence expiry recorded for this driver');
  }

  for (const doc of detail.documents) {
    if (doc.state === 'expired') {
      warnings.push(`The driver's ${doc.docType} expired on ${formatDate(doc.expiryDate)}`);
    } else if (doc.state === 'expiring') {
      warnings.push(`The driver's ${doc.docType} expires on ${formatDate(doc.expiryDate)}`);
    }
  }

  return { ok: blockers.length === 0, blockers, warnings, detail };
};

// Dates in these messages are read by a dispatcher, not parsed, so they are
// formatted the way the rest of the Indian-market UI shows them.
const formatDate = (d) => {
  if (!d) return 'an unknown date';
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return 'an unknown date';
  return date.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
};
