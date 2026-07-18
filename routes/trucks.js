import express from 'express';
import Truck from '../models/Truck.js';
import { protect } from '../middleware/auth.js';

const router = express.Router();

const ownedBy = (req) => ({ owner: req.user._id });

// Builds a Truck-shaped update object from the flat AddNewTruck form payload,
// only including fields that were actually sent.
const buildTruckFields = (body) => {
  const fields = {};
  if (body.number !== undefined) fields.number = String(body.number).trim();
  if (body.model !== undefined) fields.model = String(body.model).trim();
  if (body.registrationDate !== undefined) fields.registrationDate = body.registrationDate || undefined;
  if (body.insuranceExpiry !== undefined) fields.insuranceExpiry = body.insuranceExpiry || undefined;
  if (body.status !== undefined) fields.status = body.status;
  if (body.currentRoute !== undefined) fields.currentRoute = String(body.currentRoute).trim();

  if (body.driver && typeof body.driver === 'object') {
    fields.driver = {
      name: String(body.driver.name || '').trim(),
      mobile: String(body.driver.mobile || '').trim(),
      licenseNumber: String(body.driver.licenseNumber || '').trim(),
      licenseExpiry: body.driver.licenseExpiry || undefined,
      salary: body.driver.salary !== undefined && body.driver.salary !== ''
        ? Number(body.driver.salary)
        : undefined
    };
  }

  return fields;
};

// GET /api/trucks — the caller's trucks, newest first.
router.get('/', protect, async (req, res) => {
  try {
    const trucks = await Truck.find(ownedBy(req)).sort({ createdAt: -1 });
    res.json({ success: true, trucks });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to fetch trucks' });
  }
});

// POST /api/trucks — create a truck (with its embedded driver) for the caller.
router.post('/', protect, async (req, res) => {
  try {
    const fields = buildTruckFields(req.body || {});
    if (!fields.number || !fields.model) {
      return res.status(400).json({ success: false, error: 'Truck number and model are required' });
    }

    const truck = await Truck.create({ ...fields, owner: req.user._id });
    res.status(201).json({ success: true, truck });
  } catch (error) {
    console.error('[trucks] create failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to create truck' });
  }
});

// PUT /api/trucks/:id — full update of one of the caller's trucks.
router.put('/:id', protect, async (req, res) => {
  try {
    const fields = buildTruckFields(req.body || {});
    const truck = await Truck.findOneAndUpdate(
      { _id: req.params.id, ...ownedBy(req) },
      { $set: fields },
      { new: true, runValidators: true }
    );
    if (!truck) return res.status(404).json({ success: false, error: 'Truck not found' });
    res.json({ success: true, truck });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to update truck' });
  }
});

// DELETE /api/trucks/:id — remove one of the caller's trucks.
router.delete('/:id', protect, async (req, res) => {
  try {
    const truck = await Truck.findOneAndDelete({ _id: req.params.id, ...ownedBy(req) });
    if (!truck) return res.status(404).json({ success: false, error: 'Truck not found' });
    res.json({ success: true, message: 'Truck removed' });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to delete truck' });
  }
});

export default router;
