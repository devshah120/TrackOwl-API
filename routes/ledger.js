import express from 'express';
import LedgerEntry from '../models/LedgerEntry.js';
import Truck from '../models/Truck.js';
import Driver from '../models/Driver.js';
import { protect, requirePermission } from '../middleware/auth.js';
import { auditCreate, auditUpdate, auditDelete } from '../utils/audit.js';

const router = express.Router();

const ownedBy = (req) => ({ owner: req.accountId });

// Receipts ride along in the JSON body as data URIs. Base64 inflates by ~4/3,
// so this caps the stored string rather than the original file — roughly a 3 MB
// upload. The browser downscales images before sending; this is the backstop
// for anything that slips through (a large PDF, or a caller that isn't our UI).
const MAX_RECEIPT_CHARS = 4 * 1024 * 1024;

const buildLedgerFields = (body) => {
  const fields = {};
  if (body.date !== undefined) fields.date = body.date;
  if (body.type !== undefined) fields.type = body.type;
  if (body.category !== undefined) fields.category = body.category;
  if (body.description !== undefined) fields.description = String(body.description).trim();
  if (body.amount !== undefined) fields.amount = Number(body.amount);
  if (body.paymentMethod !== undefined) fields.paymentMethod = body.paymentMethod;
  if (body.reference !== undefined) fields.reference = String(body.reference).trim();

  // Empty string clears the link; absent leaves it untouched.
  if (body.truck !== undefined) fields.truck = body.truck || null;
  if (body.driver !== undefined) fields.driver = body.driver || null;

  if (body.receipt !== undefined) {
    const r = body.receipt;
    fields.receipt = r && r.dataUrl
      ? {
          dataUrl: String(r.dataUrl),
          filename: String(r.filename || '').trim(),
          mimeType: String(r.mimeType || '').trim(),
          uploadedAt: new Date()
        }
      : {}; // receipt: null (or a blank one) removes the attachment
  }

  return fields;
};

// Rejects a receipt that is too large, or truck/driver ids the caller does not
// own — without this a client could attach an entry to another client's truck.
const validateLinks = async (req, fields) => {
  if (fields.receipt?.dataUrl) {
    if (!/^data:/.test(fields.receipt.dataUrl)) {
      return 'Receipt must be an uploaded file';
    }
    if (fields.receipt.dataUrl.length > MAX_RECEIPT_CHARS) {
      return 'That receipt is too large — please upload a file under 3 MB';
    }
  }

  if (fields.truck) {
    const truck = await Truck.findOne({ _id: fields.truck, ...ownedBy(req) }).select('_id');
    if (!truck) return 'Truck not found';
  }

  if (fields.driver) {
    const driver = await Driver.findOne({ _id: fields.driver, ...ownedBy(req) }).select('_id');
    if (!driver) return 'Driver not found';
  }

  return null;
};

// How a ledger entry names itself in the audit trail: the money and what it was
// for, which is what someone scanning the log is looking for. Falls back to the
// category when there is no description.
const ledgerLabel = (entry) =>
  `₹${Number(entry.amount || 0).toLocaleString('en-IN')} ${entry.description || entry.category || ''}`.trim();

// The ledger list and detail views show the truck number and driver name, so
// both refs are resolved on the way out.
const withLinks = (query) =>
  query.populate('truck', 'number model').populate('driver', 'name mobile');

// GET /api/ledger — the caller's entries, newest first.
//
// Receipts are excluded here: a data URI per row would bloat the list response
// well past what the table needs. The client fetches one via GET /:id/receipt
// when the user actually opens it.
router.get('/', protect, requirePermission('ledger', 'read'), async (req, res) => {
  try {
    const entries = await withLinks(
      LedgerEntry.find(ownedBy(req)).select('-receipt.dataUrl').sort({ date: -1 })
    );
    res.json({ success: true, entries });
  } catch (error) {
    console.error('[ledger] list failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to fetch ledger entries' });
  }
});

// GET /api/ledger/:id/receipt — the stored receipt for one entry, as a data URI.
router.get('/:id/receipt', protect, requirePermission('ledger', 'read'), async (req, res) => {
  try {
    const entry = await LedgerEntry.findOne({ _id: req.params.id, ...ownedBy(req) }).select('receipt');
    if (!entry) return res.status(404).json({ success: false, error: 'Ledger entry not found' });
    if (!entry.receipt?.dataUrl) {
      return res.status(404).json({ success: false, error: 'No receipt attached to this entry' });
    }
    res.json({ success: true, receipt: entry.receipt });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to fetch receipt' });
  }
});

// POST /api/ledger — create an entry for the caller.
router.post('/', protect, requirePermission('ledger', 'create'), async (req, res) => {
  try {
    const fields = buildLedgerFields(req.body || {});
    if (!fields.date || !fields.type || !fields.category || !fields.paymentMethod || !Number.isFinite(fields.amount)) {
      return res.status(400).json({ success: false, error: 'Date, type, category, amount, and payment method are required' });
    }

    const invalid = await validateLinks(req, fields);
    if (invalid) return res.status(400).json({ success: false, error: invalid });

    const created = await LedgerEntry.create({ ...fields, owner: req.accountId });
    const entry = await withLinks(
      LedgerEntry.findById(created._id).select('-receipt.dataUrl')
    );

    await auditCreate(req, { entity: 'ledger_entry', doc: created, label: ledgerLabel(created) });

    res.status(201).json({ success: true, entry });
  } catch (error) {
    console.error('[ledger] create failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to create ledger entry' });
  }
});

// PUT /api/ledger/:id — full update of one of the caller's entries.
router.put('/:id', protect, requirePermission('ledger', 'update'), async (req, res) => {
  try {
    const fields = buildLedgerFields(req.body || {});

    const invalid = await validateLinks(req, fields);
    if (invalid) return res.status(400).json({ success: false, error: invalid });

    // Without the receipt blob — the diff only ever reports whether one is
    // attached, so pulling megabytes of base64 back just to compare would be
    // wasted work.
    const before = await LedgerEntry.findOne({ _id: req.params.id, ...ownedBy(req) })
      .select('-receipt.dataUrl');
    if (!before) return res.status(404).json({ success: false, error: 'Ledger entry not found' });

    const entry = await withLinks(
      LedgerEntry.findOneAndUpdate(
        { _id: req.params.id, ...ownedBy(req) },
        { $set: fields },
        { new: true, runValidators: true, projection: '-receipt.dataUrl' }
      )
    );
    if (!entry) return res.status(404).json({ success: false, error: 'Ledger entry not found' });

    await auditUpdate(req, {
      entity: 'ledger_entry',
      before,
      after: entry,
      fields,
      label: ledgerLabel(entry)
    });

    res.json({ success: true, entry });
  } catch (error) {
    console.error('[ledger] update failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to update ledger entry' });
  }
});

// DELETE /api/ledger/:id — remove one of the caller's entries.
router.delete('/:id', protect, requirePermission('ledger', 'delete'), async (req, res) => {
  try {
    const entry = await LedgerEntry.findOneAndDelete(
      { _id: req.params.id, ...ownedBy(req) },
      { projection: '-receipt.dataUrl' }
    );
    if (!entry) return res.status(404).json({ success: false, error: 'Ledger entry not found' });

    await auditDelete(req, { entity: 'ledger_entry', doc: entry, label: ledgerLabel(entry) });

    res.json({ success: true, message: 'Ledger entry removed' });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to delete ledger entry' });
  }
});

export default router;
