import express from 'express';
import Notification from '../models/Notification.js';
import Truck from '../models/Truck.js';
import Device from '../models/Device.js';
import VehicleDocument, { VEHICLE_DOCUMENT_LABELS } from '../models/VehicleDocument.js';
import DriverDocument, { DRIVER_DOCUMENT_LABELS } from '../models/DriverDocument.js';
import { protect } from '../middleware/auth.js';
import { EXPIRY_WARN_DAYS } from '../utils/vehicleDocuments.js';

const router = express.Router();

const ownedBy = (req) => ({ owner: req.accountId });

// Upsert on dedupeKey so a recurring condition (still offline, still expiring)
// is noticed once and then left alone — re-fetching the list must not spawn
// duplicate rows every poll.
const upsertNotification = (owner, doc) =>
  Notification.findOneAndUpdate(
    { owner, dedupeKey: doc.dedupeKey },
    { $setOnInsert: { owner, createdAt: new Date(), read: false, ...doc } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

// Scans the caller's trucks and devices for conditions the UI has always
// implied but nothing ever actually detected: expiring/expired insurance and a
// device that has gone offline. No scheduler — this runs inline whenever the
// notification list is fetched, which is often enough (the bell polls) without
// needing a background job.
const synthesizeNotifications = async (req) => {
  const owner = req.accountId;
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;

  const trucks = await Truck.find(ownedBy(req)).select('number insuranceExpiry');
  await Promise.all(
    trucks.map((truck) => {
      if (!truck.insuranceExpiry) return null;
      const daysLeft = Math.ceil((truck.insuranceExpiry.getTime() - now) / day);
      if (daysLeft > 30) return null;

      const expired = daysLeft < 0;
      return upsertNotification(owner, {
        type: 'alert',
        severity: expired ? 'critical' : 'warning',
        title: expired ? 'Insurance Expired' : 'Insurance Expiring Soon',
        message: expired
          ? `Truck ${truck.number} insurance expired ${Math.abs(daysLeft)} day(s) ago`
          : `Truck ${truck.number} insurance expires in ${daysLeft} day(s)`,
        vehicle: truck.number,
        // Re-derived daily so an expired truck's alert eventually flips from
        // "expiring soon" to "expired" instead of freezing on the first message.
        dedupeKey: `insurance:${truck._id}:${expired ? 'expired' : 'soon'}`
      });
    })
  );

  // --- Vehicle and driver paperwork ---------------------------------------
  // The document collections carry the statutory expiries (RC, insurance, PUC,
  // fitness, permit, tax) and the driver ones (licence, training, medical).
  // Only documents that actually carry an expiry are scanned — an RC or an
  // identity proof without one is not overdue, it simply never lapses.
  const dueBefore = new Date(now + EXPIRY_WARN_DAYS * day);

  const vehicleDocs = await VehicleDocument.find({
    ...ownedBy(req),
    expiryDate: { $ne: null, $lte: dueBefore }
  })
    .select('docType documentNumber expiryDate truck')
    .populate('truck', 'number');

  await Promise.all(
    vehicleDocs.map((doc) => {
      const daysLeft = Math.ceil((doc.expiryDate.getTime() - now) / day);
      const expired = daysLeft < 0;
      const label = VEHICLE_DOCUMENT_LABELS[doc.docType] || doc.docType;
      // A document whose truck has since been deleted should not raise an alert
      // nobody can act on; the cascade normally removes these, so this only
      // catches records orphaned by an older delete.
      if (!doc.truck) return null;

      return upsertNotification(owner, {
        type: 'alert',
        severity: expired ? 'critical' : 'warning',
        title: expired ? `${label} Expired` : `${label} Expiring Soon`,
        message: expired
          ? `${label} for truck ${doc.truck.number} expired ${Math.abs(daysLeft)} day(s) ago`
          : `${label} for truck ${doc.truck.number} expires in ${daysLeft} day(s)`,
        vehicle: doc.truck.number,
        // Keyed on the document rather than the truck, so a vehicle with an
        // expiring PUC *and* an expired permit raises both. Re-derived across
        // the expired boundary for the same reason the insurance alert is: the
        // message has to flip from "expiring" to "expired" rather than freeze.
        dedupeKey: `vehicle-doc:${doc._id}:${expired ? 'expired' : 'soon'}`
      });
    })
  );

  const driverDocs = await DriverDocument.find({
    ...ownedBy(req),
    expiryDate: { $ne: null, $lte: dueBefore }
  })
    .select('docType documentNumber expiryDate driver')
    .populate('driver', 'name');

  await Promise.all(
    driverDocs.map((doc) => {
      const daysLeft = Math.ceil((doc.expiryDate.getTime() - now) / day);
      const expired = daysLeft < 0;
      const label = DRIVER_DOCUMENT_LABELS[doc.docType] || doc.docType;
      if (!doc.driver) return null;

      return upsertNotification(owner, {
        type: 'alert',
        severity: expired ? 'critical' : 'warning',
        title: expired ? `${label} Expired` : `${label} Expiring Soon`,
        message: expired
          ? `${label} for ${doc.driver.name} expired ${Math.abs(daysLeft)} day(s) ago`
          : `${label} for ${doc.driver.name} expires in ${daysLeft} day(s)`,
        // `vehicle` is the bell's subject line; for a driver document the
        // person is the subject, so their name goes there.
        vehicle: doc.driver.name,
        dedupeKey: `driver-doc:${doc._id}:${expired ? 'expired' : 'soon'}`
      });
    })
  );

  const devices = await Device.find(ownedBy(req)).select('name lastSeenAt');
  await Promise.all(
    devices.map((device) => {
      if (!device.lastSeenAt) return null;
      const staleMs = now - device.lastSeenAt.getTime();
      if (staleMs <= 2 * 60 * 1000) return null; // matches Device.status's own "offline" threshold

      return upsertNotification(owner, {
        type: 'alert',
        severity: 'critical',
        title: 'Truck Offline',
        message: `${device.name} has been offline since ${device.lastSeenAt.toLocaleString()}`,
        vehicle: device.name,
        dedupeKey: `offline:${device._id}:${device.lastSeenAt.getTime()}`
      });
    })
  );
};

// GET /api/notifications — the caller's notifications, newest first. Runs the
// lazy synthesizer first so expiry/offline alerts are always up to date.
router.get('/', protect, async (req, res) => {
  try {
    await synthesizeNotifications(req);
    const notifications = await Notification.find(ownedBy(req)).sort({ createdAt: -1 }).limit(50);
    res.json({ success: true, notifications });
  } catch (error) {
    console.error('[notifications] fetch failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to fetch notifications' });
  }
});

// POST /api/notifications/:id/read — mark one as read.
router.post('/:id/read', protect, async (req, res) => {
  try {
    const notification = await Notification.findOneAndUpdate(
      { _id: req.params.id, ...ownedBy(req) },
      { $set: { read: true } },
      { new: true }
    );
    if (!notification) return res.status(404).json({ success: false, error: 'Notification not found' });
    res.json({ success: true, notification });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to mark notification as read' });
  }
});

// POST /api/notifications/read-all — mark every unread notification as read.
router.post('/read-all', protect, async (req, res) => {
  try {
    await Notification.updateMany({ ...ownedBy(req), read: false }, { $set: { read: true } });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to mark notifications as read' });
  }
});

export default router;
