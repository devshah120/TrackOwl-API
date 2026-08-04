import express from 'express';
import Truck from '../models/Truck.js';
import Driver from '../models/Driver.js';
import Notification from '../models/Notification.js';
import { protect } from '../middleware/auth.js';
import { readDriverList, syncTruckDrivers, attachDrivers } from '../utils/drivers.js';

const router = express.Router();

const ownedBy = (req) => ({ owner: req.user._id });

// Builds a Truck-shaped update object from the flat AddNewTruck form payload,
// only including fields that were actually sent. Drivers are not part of this —
// they are their own collection now and are synced separately.
const buildTruckFields = (body) => {
  const fields = {};
  if (body.number !== undefined) fields.number = String(body.number).trim();
  if (body.model !== undefined) fields.model = String(body.model).trim();
  if (body.registrationDate !== undefined) fields.registrationDate = body.registrationDate || undefined;
  if (body.insuranceExpiry !== undefined) fields.insuranceExpiry = body.insuranceExpiry || undefined;
  if (body.status !== undefined) fields.status = body.status;
  if (body.currentRoute !== undefined) fields.currentRoute = String(body.currentRoute).trim();
  return fields;
};

// The raw driver rows as sent, kept alongside the normalised list so
// syncTruckDrivers can match each row back to its existing _id.
const rawDriverRows = (body) =>
  Array.isArray(body?.drivers) ? body.drivers : body?.driver ? [body.driver] : [];

// GET /api/trucks — the caller's trucks, newest first, each with its drivers.
router.get('/', protect, async (req, res) => {
  try {
    const trucks = await Truck.find(ownedBy(req)).sort({ createdAt: -1 });
    res.json({ success: true, trucks: await attachDrivers(trucks, req.user._id) });
  } catch (error) {
    console.error('[trucks] list failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to fetch trucks' });
  }
});

// POST /api/trucks — create a truck and its drivers for the caller.
router.post('/', protect, async (req, res) => {
  try {
    const body = req.body || {};
    const fields = buildTruckFields(body);
    if (!fields.number || !fields.model) {
      return res.status(400).json({ success: false, error: 'Truck number and model are required' });
    }

    const drivers = readDriverList(body);
    const truck = await Truck.create({ ...fields, owner: req.user._id });

    try {
      await syncTruckDrivers(truck._id, req.user._id, drivers, rawDriverRows(body));
    } catch (err) {
      // A truck with no valid drivers is worse than no truck at all here — the
      // form submitted both together, so roll back rather than leave a stray.
      await Truck.deleteOne({ _id: truck._id });
      await Driver.deleteMany({ truck: truck._id });
      if (err.name === 'ValidationError') {
        return res.status(400).json({ success: false, error: err.message });
      }
      throw err;
    }

    const saved = await attachDrivers(truck, req.user._id);
    const names = (saved.drivers || []).map((d) => d.name).filter(Boolean);

    Notification.create({
      owner: req.user._id,
      type: 'event',
      title: 'Truck Added',
      message: `Truck ${truck.number} added to fleet${names.length ? ` with driver${names.length > 1 ? 's' : ''} ${names.join(', ')}` : ''}`,
      vehicle: truck.number
    }).catch((err) => console.error('[trucks] notification failed:', err.message));

    res.status(201).json({ success: true, truck: saved });
  } catch (error) {
    console.error('[trucks] create failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to create truck' });
  }
});

// PUT /api/trucks/:id — full update of one of the caller's trucks, drivers included.
router.put('/:id', protect, async (req, res) => {
  try {
    const body = req.body || {};
    const fields = buildTruckFields(body);
    const truck = await Truck.findOneAndUpdate(
      { _id: req.params.id, ...ownedBy(req) },
      { $set: fields },
      { new: true, runValidators: true }
    );
    if (!truck) return res.status(404).json({ success: false, error: 'Truck not found' });

    await syncTruckDrivers(truck._id, req.user._id, readDriverList(body), rawDriverRows(body));

    res.json({ success: true, truck: await attachDrivers(truck, req.user._id) });
  } catch (error) {
    if (error.name === 'ValidationError') {
      return res.status(400).json({ success: false, error: error.message });
    }
    console.error('[trucks] update failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to update truck' });
  }
});

// DELETE /api/trucks/:id — remove one of the caller's trucks and its drivers.
router.delete('/:id', protect, async (req, res) => {
  try {
    const truck = await Truck.findOneAndDelete({ _id: req.params.id, ...ownedBy(req) });
    if (!truck) return res.status(404).json({ success: false, error: 'Truck not found' });

    await Driver.deleteMany({ truck: truck._id, ...ownedBy(req) });

    res.json({ success: true, message: 'Truck removed' });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to delete truck' });
  }
});

export default router;
