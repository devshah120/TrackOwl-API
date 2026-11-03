import Notification from '../models/Notification.js';
import Truck from '../models/Truck.js';
import Device from '../models/Device.js';
import VehicleDocument, { VEHICLE_DOCUMENT_LABELS } from '../models/VehicleDocument.js';
import DriverDocument, { DRIVER_DOCUMENT_LABELS } from '../models/DriverDocument.js';
import { getAlertSettings } from './gpsAlerts.js';
import { allReminders } from './maintenanceReminders.js';

// The condition-based alerts: document expiry, device offline, maintenance due.
// Moved out of routes/notifications.js so the scheduler can run it for every
// account without a request.

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_STAGES = [30, 15, 7, 0];

// Upsert on dedupeKey so a recurring condition (still offline, still expiring)
// is noticed once and then left alone — re-fetching the list must not spawn
// duplicate rows every poll.
const upsertNotification = (owner, doc) =>
  Notification.findOneAndUpdate(
    { owner, dedupeKey: doc.dedupeKey },
    { $setOnInsert: { owner, createdAt: new Date(), read: false, ...doc } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

// Which reminder stage a document is in, given how many days it has left and
// the account's configured stages (e.g. [30, 15, 7, 0]). A document 12 days out
// is in the 15-day stage; past its date it is 'expired'; further out than the
// widest stage it is in none. The stage goes into the dedupe key, so moving
// from the 15-day stage to the 7-day one raises a fresh reminder while
// re-checking within a stage raises nothing.
const stageFor = (daysLeft, stages) => {
  if (daysLeft < 0) return 'expired';
  const within = stages.filter((s) => daysLeft <= s);
  return within.length ? `d${Math.min(...within)}` : null;
};

const expiryWording = (daysLeft) =>
  daysLeft < 0
    ? `expired ${Math.abs(daysLeft)} day(s) ago`
    : daysLeft === 0
      ? 'expires today'
      : `expires in ${daysLeft} day(s)`;

// Scans an account's records for conditions the UI has always implied but
// nothing ever actually detected: expiring/expired paperwork, a device that has
// gone offline, and maintenance coming due. Run by the background scheduler
// (services/scheduler.js) for every account, and again — throttled — when the
// bell is opened, so a fresh condition shows without waiting for the next run.
export const synthesizeNotifications = async (owner, { includeMaintenance = true } = {}) => {
  const now = Date.now();
  const settings = await getAlertSettings(owner);
  const stages = settings.compliance?.reminderDays?.length ? settings.compliance.reminderDays : DEFAULT_STAGES;
  const widest = Math.max(...stages);
  const daysUntil = (date) => Math.ceil((date.getTime() - now) / DAY_MS);

  const compliance = (subjectKey, { label, subject, vehicle, daysLeft, ownStages }) => {
    const stage = stageFor(daysLeft, ownStages?.length ? ownStages : stages);
    if (!stage) return null;
    const expired = stage === 'expired';
    return upsertNotification(owner, {
      type: 'alert',
      category: 'compliance',
      severity: expired || daysLeft <= 7 ? 'critical' : 'warning',
      title: expired ? `${label} Expired` : daysLeft === 0 ? `${label} Due Today` : `${label} Expiring Soon`,
      message: `${label} for ${subject} ${expiryWording(daysLeft)}`,
      vehicle,
      dedupeKey: `${subjectKey}:${stage}`
    });
  };

  // The truck master's own insurance date, kept for accounts that never moved
  // to the document register.
  const trucks = await Truck.find({ owner }).select('number insuranceExpiry');
  await Promise.all(
    trucks.map((truck) =>
      truck.insuranceExpiry
        ? compliance(`insurance:${truck._id}`, {
            label: 'Insurance',
            subject: `truck ${truck.number}`,
            vehicle: truck.number,
            daysLeft: daysUntil(truck.insuranceExpiry)
          })
        : null
    )
  );

  // --- Vehicle and driver paperwork ---------------------------------------
  // The document collections carry the statutory expiries (RC, insurance, PUC,
  // fitness, permit, tax, FASTag) and the driver ones (licence, training,
  // medical). Only documents that actually carry an expiry are scanned — an RC
  // or an identity proof without one is not overdue, it simply never lapses.
  // A document may carry stages wider than the account's, so look far enough
  // ahead for those too.
  const dueBefore = new Date(now + Math.max(widest, 365) * DAY_MS);

  const vehicleDocs = await VehicleDocument.find({
    ...{ owner },
    expiryDate: { $ne: null, $lte: dueBefore }
  })
    .select('docType documentNumber expiryDate truck reminderDays')
    .populate('truck', 'number');

  await Promise.all(
    vehicleDocs.map((doc) => {
      // A document whose truck has since been deleted should not raise an alert
      // nobody can act on.
      if (!doc.truck) return null;
      return compliance(`vehicle-doc:${doc._id}`, {
        label: VEHICLE_DOCUMENT_LABELS[doc.docType] || doc.docType,
        subject: `truck ${doc.truck.number}`,
        vehicle: doc.truck.number,
        daysLeft: daysUntil(doc.expiryDate),
        ownStages: doc.reminderDays
      });
    })
  );

  const driverDocs = await DriverDocument.find({
    ...{ owner },
    expiryDate: { $ne: null, $lte: dueBefore }
  })
    .select('docType documentNumber expiryDate driver reminderDays')
    .populate('driver', 'name');

  await Promise.all(
    driverDocs.map((doc) => {
      if (!doc.driver) return null;
      // `vehicle` is the bell's subject line; for a driver document the person
      // is the subject, so their name goes there.
      return compliance(`driver-doc:${doc._id}`, {
        label: DRIVER_DOCUMENT_LABELS[doc.docType] || doc.docType,
        subject: doc.driver.name,
        vehicle: doc.driver.name,
        daysLeft: daysUntil(doc.expiryDate),
        ownStages: doc.reminderDays
      });
    })
  );

  const devices = await Device.find({ owner }).select('name lastSeenAt');
  await Promise.all(
    devices.map((device) => {
      if (!device.lastSeenAt) return null;
      const staleMs = now - device.lastSeenAt.getTime();
      if (staleMs <= 2 * 60 * 1000) return null; // matches Device.status's own "offline" threshold

      return upsertNotification(owner, {
        type: 'alert',
        category: 'offline',
        severity: 'critical',
        title: 'Truck Offline',
        message: `${device.name} has been offline since ${device.lastSeenAt.toLocaleString('en-IN', {
          timeZone: settings.timezone || 'Asia/Kolkata'
        })}`,
        vehicle: device.name,
        dedupeKey: `offline:${device._id}:${device.lastSeenAt.getTime()}`
      });
    })
  );

  // --- Maintenance ---------------------------------------------------------
  // Due and overdue services, tyres and batteries, from the same engine the
  // Reminders screen uses. Keyed on status so "due" and then "overdue" each
  // appear once. Only for seats that can see maintenance at all.
  if (includeMaintenance && settings.maintenanceInBell !== false) {
    const { items } = await allReminders(owner);
    await Promise.all(
      items.map((item) =>
        upsertNotification(owner, {
          type: 'alert',
          category: 'maintenance',
          severity: item.status === 'overdue' ? 'critical' : 'warning',
          title: item.status === 'overdue' ? 'Maintenance Overdue' : 'Maintenance Due',
          message: `${item.vehicleNumber ? `${item.vehicleNumber}: ` : ''}${item.label}`,
          vehicle: item.vehicleNumber || '',
          dedupeKey: `maint:${item.kind}:${item.sourceId}:${item.by || ''}:${item.status}`
        })
      )
    );
  }
};
