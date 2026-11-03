import Position from '../models/Position.js';
import TripOrder from '../models/TripOrder.js';
import VehicleDocument from '../models/VehicleDocument.js';
import DriverDocument from '../models/DriverDocument.js';
import FuelEntry from '../models/FuelEntry.js';
import LedgerEntry from '../models/LedgerEntry.js';

// Retention and archival (brief §14). Both policies are OFF unless their
// environment variable is set, because both delete data:
//
//   POSITION_RETENTION_DAYS   (min 30)   GPS positions older than this are
//                                        deleted.
//   DOCUMENT_RETENTION_DAYS   (min 365)  uploaded files are archived: the
//                                        stored file is removed, the record
//                                        (type, number, dates, filename) is
//                                        kept and stamped `archivedAt`, so the
//                                        history still reads correctly and the
//                                        screen can say the copy was archived.
//
// What counts as "old" for documents is deliberately conservative:
//   - trip documents, POD photos and expense receipts on trips CLOSED or
//     CANCELLED more than N days ago (an open trip's paperwork is never
//     touched, however old)
//   - vehicle and driver documents that EXPIRED more than N days ago (a
//     current RC or licence is never touched)
//   - fuel and ledger receipts dated more than N days ago
// Signatures are kept: they are small and they are the proof.
//
// Take a backup (deploy/backup-mongo.sh) before enabling either.

const DAY = 24 * 60 * 60 * 1000;
export const lastRun = { positions: null, documents: null };

const purgePositions = async (days) => {
  const cutoff = new Date(Date.now() - days * DAY);
  let removed = 0;
  for (;;) {
    const batch = await Position.find({ fixTime: { $lt: cutoff } }).select('_id').limit(5000).lean();
    if (!batch.length) break;
    const { deletedCount } = await Position.deleteMany({ _id: { $in: batch.map((p) => p._id) } });
    removed += deletedCount;
  }
  lastRun.positions = { at: new Date(), removed, days };
  if (removed) console.log(`[retention] purged ${removed} GPS positions older than ${days} days`);
};

const archiveDocuments = async (days) => {
  const cutoff = new Date(Date.now() - days * DAY);
  const at = new Date();
  const counts = {};

  // Trips: closed/cancelled before the cutoff, with any stored file left.
  counts.tripDocuments = (
    await TripOrder.updateMany(
      { status: { $in: ['closed', 'cancelled'] }, updatedAt: { $lt: cutoff }, 'documents.dataUrl': { $nin: ['', null] } },
      { $set: { 'documents.$[d].dataUrl': '', 'documents.$[d].archivedAt': at } },
      { arrayFilters: [{ 'd.dataUrl': { $nin: ['', null] } }], strict: false }
    )
  ).modifiedCount;
  counts.tripReceipts = (
    await TripOrder.updateMany(
      { status: { $in: ['closed', 'cancelled'] }, updatedAt: { $lt: cutoff }, 'expenses.receipt.dataUrl': { $nin: ['', null] } },
      { $set: { 'expenses.$[e].receipt.dataUrl': '', 'expenses.$[e].receipt.archivedAt': at } },
      { arrayFilters: [{ 'e.receipt.dataUrl': { $nin: ['', null] } }], strict: false }
    )
  ).modifiedCount;
  counts.podPhotos = (
    await TripOrder.updateMany(
      { status: { $in: ['closed', 'cancelled'] }, updatedAt: { $lt: cutoff }, 'pod.photo': { $nin: ['', null] } },
      { $set: { 'pod.photo': '', 'pod.photoArchivedAt': at } },
      { strict: false }
    )
  ).modifiedCount;

  // Statutory documents long since expired.
  for (const [key, Model] of [['vehicleDocuments', VehicleDocument], ['driverDocuments', DriverDocument]]) {
    counts[key] = (
      await Model.updateMany(
        { expiryDate: { $ne: null, $lt: cutoff }, 'attachment.dataUrl': { $nin: ['', null] } },
        { $set: { 'attachment.dataUrl': '', 'attachment.archivedAt': at } },
        { strict: false }
      )
    ).modifiedCount;
  }

  counts.fuelReceipts = (
    await FuelEntry.updateMany(
      { filledAt: { $lt: cutoff }, 'receipt.dataUrl': { $nin: ['', null] } },
      { $set: { 'receipt.dataUrl': '', 'receipt.archivedAt': at } },
      { strict: false }
    )
  ).modifiedCount;
  counts.ledgerReceipts = (
    await LedgerEntry.updateMany(
      { date: { $lt: cutoff }, 'receipt.dataUrl': { $nin: ['', null] } },
      { $set: { 'receipt.dataUrl': '', 'receipt.archivedAt': at } },
      { strict: false }
    )
  ).modifiedCount;

  lastRun.documents = { at, days, ...counts };
  const total = Object.values(counts).reduce((s, n) => s + n, 0);
  if (total) console.log(`[retention] archived files on ${total} record(s) older than ${days} days`, counts);
};

export const startRetention = () => {
  const positionDays = Number(process.env.POSITION_RETENTION_DAYS);
  const documentDays = Number(process.env.DOCUMENT_RETENTION_DAYS);
  const jobs = [];

  if (Number.isFinite(positionDays) && positionDays >= 30) {
    jobs.push(() => purgePositions(positionDays));
    console.log(`✓ GPS retention: positions kept for ${positionDays} days`);
  }
  if (Number.isFinite(documentDays) && documentDays >= 365) {
    jobs.push(() => archiveDocuments(documentDays));
    console.log(`✓ Document retention: uploaded files archived after ${documentDays} days`);
  } else if (process.env.DOCUMENT_RETENTION_DAYS) {
    console.warn('⚠ DOCUMENT_RETENTION_DAYS must be at least 365 — document archival is off');
  }
  if (!jobs.length) return;

  const run = async () => {
    for (const job of jobs) {
      try {
        await job();
      } catch (error) {
        console.error('[retention] run failed:', error.message);
      }
    }
  };
  setTimeout(run, 5 * 60 * 1000).unref();
  setInterval(run, DAY).unref();
};
