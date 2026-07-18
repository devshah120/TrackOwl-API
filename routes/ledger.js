import express from 'express';
import LedgerEntry from '../models/LedgerEntry.js';
import { protect } from '../middleware/auth.js';

const router = express.Router();

const ownedBy = (req) => ({ owner: req.user._id });

const buildLedgerFields = (body) => {
  const fields = {};
  if (body.date !== undefined) fields.date = body.date;
  if (body.type !== undefined) fields.type = body.type;
  if (body.category !== undefined) fields.category = body.category;
  if (body.description !== undefined) fields.description = String(body.description).trim();
  if (body.amount !== undefined) fields.amount = Number(body.amount);
  if (body.paymentMethod !== undefined) fields.paymentMethod = body.paymentMethod;
  if (body.reference !== undefined) fields.reference = String(body.reference).trim();
  return fields;
};

// GET /api/ledger — the caller's entries, newest first.
router.get('/', protect, async (req, res) => {
  try {
    const entries = await LedgerEntry.find(ownedBy(req)).sort({ date: -1 });
    res.json({ success: true, entries });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to fetch ledger entries' });
  }
});

// POST /api/ledger — create an entry for the caller.
router.post('/', protect, async (req, res) => {
  try {
    const fields = buildLedgerFields(req.body || {});
    if (!fields.date || !fields.type || !fields.category || !fields.paymentMethod || !Number.isFinite(fields.amount)) {
      return res.status(400).json({ success: false, error: 'Date, type, category, amount, and payment method are required' });
    }

    const entry = await LedgerEntry.create({ ...fields, owner: req.user._id });
    res.status(201).json({ success: true, entry });
  } catch (error) {
    console.error('[ledger] create failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to create ledger entry' });
  }
});

// PUT /api/ledger/:id — full update of one of the caller's entries.
router.put('/:id', protect, async (req, res) => {
  try {
    const fields = buildLedgerFields(req.body || {});
    const entry = await LedgerEntry.findOneAndUpdate(
      { _id: req.params.id, ...ownedBy(req) },
      { $set: fields },
      { new: true, runValidators: true }
    );
    if (!entry) return res.status(404).json({ success: false, error: 'Ledger entry not found' });
    res.json({ success: true, entry });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to update ledger entry' });
  }
});

// DELETE /api/ledger/:id — remove one of the caller's entries.
router.delete('/:id', protect, async (req, res) => {
  try {
    const entry = await LedgerEntry.findOneAndDelete({ _id: req.params.id, ...ownedBy(req) });
    if (!entry) return res.status(404).json({ success: false, error: 'Ledger entry not found' });
    res.json({ success: true, message: 'Ledger entry removed' });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to delete ledger entry' });
  }
});

export default router;
