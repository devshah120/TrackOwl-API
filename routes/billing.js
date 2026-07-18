import express from 'express';
import BillingTrip from '../models/BillingTrip.js';
import Notification from '../models/Notification.js';
import { protect } from '../middleware/auth.js';

const router = express.Router();

const ownedBy = (req) => ({ owner: req.user._id });

const buildBillingFields = (body) => {
  const fields = {};
  if (body.truck !== undefined) fields.truck = String(body.truck).trim();
  if (body.lr !== undefined) fields.lr = String(body.lr).trim();
  if (body.bill !== undefined) fields.bill = String(body.bill).trim();
  if (body.partyName !== undefined) fields.partyName = String(body.partyName).trim();
  if (body.status !== undefined) fields.status = body.status;
  if (body.amount !== undefined) fields.amount = Number(body.amount);
  if (body.date !== undefined) fields.date = body.date;
  if (body.documents && typeof body.documents === 'object') {
    fields.documents = {
      tax: Boolean(body.documents.tax),
      lr: Boolean(body.documents.lr),
      goods: Boolean(body.documents.goods)
    };
  }
  return fields;
};

// GET /api/billing-trips — the caller's billing trips, newest first.
router.get('/', protect, async (req, res) => {
  try {
    const billingTrips = await BillingTrip.find(ownedBy(req)).sort({ date: -1 });
    res.json({ success: true, billingTrips });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to fetch billing trips' });
  }
});

// POST /api/billing-trips — create a billing trip for the caller.
router.post('/', protect, async (req, res) => {
  try {
    const fields = buildBillingFields(req.body || {});
    if (!fields.truck || !fields.partyName || !fields.date || !Number.isFinite(fields.amount)) {
      return res.status(400).json({ success: false, error: 'Truck, party name, date, and amount are required' });
    }

    const billingTrip = await BillingTrip.create({ ...fields, owner: req.user._id });

    Notification.create({
      owner: req.user._id,
      type: 'event',
      title: 'Trip Added',
      message: `Trip for ${billingTrip.partyName} (${billingTrip.truck}) added — ₹${billingTrip.amount.toLocaleString()}`,
      vehicle: billingTrip.truck
    }).catch((err) => console.error('[billing] notification failed:', err.message));

    res.status(201).json({ success: true, billingTrip });
  } catch (error) {
    console.error('[billing] create failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to create billing trip' });
  }
});

// PUT /api/billing-trips/:id — full update (edit modal + payment recording).
router.put('/:id', protect, async (req, res) => {
  try {
    const fields = buildBillingFields(req.body || {});
    const before = await BillingTrip.findOne({ _id: req.params.id, ...ownedBy(req) }).select('status');
    if (!before) return res.status(404).json({ success: false, error: 'Billing trip not found' });

    const billingTrip = await BillingTrip.findOneAndUpdate(
      { _id: req.params.id, ...ownedBy(req) },
      { $set: fields },
      { new: true, runValidators: true }
    );

    if (fields.status === 'Paid' && before.status !== 'Paid') {
      Notification.create({
        owner: req.user._id,
        type: 'event',
        title: 'Trip Completed',
        message: `Payment recorded for ${billingTrip.partyName} (${billingTrip.truck}) — ₹${billingTrip.amount.toLocaleString()}`,
        vehicle: billingTrip.truck
      }).catch((err) => console.error('[billing] notification failed:', err.message));
    }

    res.json({ success: true, billingTrip });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to update billing trip' });
  }
});

// DELETE /api/billing-trips/:id — remove one of the caller's billing trips.
router.delete('/:id', protect, async (req, res) => {
  try {
    const billingTrip = await BillingTrip.findOneAndDelete({ _id: req.params.id, ...ownedBy(req) });
    if (!billingTrip) return res.status(404).json({ success: false, error: 'Billing trip not found' });
    res.json({ success: true, message: 'Billing trip removed' });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to delete billing trip' });
  }
});

export default router;
