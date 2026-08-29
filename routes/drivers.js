import express from 'express';
import Driver, { DRIVER_STATUSES } from '../models/Driver.js';
import Truck from '../models/Truck.js';
import { protect, requirePermission } from '../middleware/auth.js';
import { normaliseDriver } from '../utils/drivers.js';

const router = express.Router();

const ownedBy = (req) => ({ owner: req.accountId });

// Confirms a truck belongs to the caller before a driver is pinned to it, so a
// client cannot attach drivers to someone else's truck by guessing an id.
const resolveTruck = async (req, truckId) => {
  if (!truckId) return null;
  return Truck.findOne({ _id: truckId, ...ownedBy(req) });
};

// Keeps the "one primary per truck" rule when a driver is flagged primary:
// demotes whichever sibling held it before.
const demoteSiblings = async (truckId, ownerId, exceptId) => {
  if (!truckId) return;
  await Driver.updateMany(
    { truck: truckId, owner: ownerId, _id: { $ne: exceptId } },
    { $set: { isPrimary: false } }
  );
};

// GET /api/drivers/options — the driver master vocabulary, so the driver form
// and status filter are populated from the same list the model validates on.
router.get('/options', protect, requirePermission('drivers', 'read'), (req, res) => {
  res.json({ success: true, options: { statuses: DRIVER_STATUSES } });
});

// GET /api/drivers — the caller's drivers. `?truck=<id>` narrows to one truck;
// `?unassigned=1` returns those not on any truck; `?status=` filters the roster.
router.get('/', protect, requirePermission('drivers', 'read'), async (req, res) => {
  try {
    const query = ownedBy(req);
    if (req.query.truck) query.truck = req.query.truck;
    if (req.query.unassigned === '1') query.truck = null;
    if (req.query.status && DRIVER_STATUSES.includes(req.query.status)) {
      query.status = req.query.status;
    }

    const drivers = await Driver.find(query)
      .populate('truck', 'number model')
      .sort({ isPrimary: -1, createdAt: 1 });

    res.json({ success: true, drivers });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to fetch drivers' });
  }
});

// POST /api/drivers — add one driver, optionally assigned to a truck.
router.post('/', protect, requirePermission('drivers', 'create'), async (req, res) => {
  try {
    const fields = normaliseDriver(req.body || {});
    if (!fields || !fields.name || !fields.mobile) {
      return res.status(400).json({ success: false, error: 'Driver name and mobile are required' });
    }

    const truckId = req.body.truck || null;
    if (truckId && !(await resolveTruck(req, truckId))) {
      return res.status(404).json({ success: false, error: 'Truck not found' });
    }

    // First driver on a truck becomes its primary automatically.
    if (truckId && !fields.isPrimary) {
      const existing = await Driver.countDocuments({ truck: truckId, ...ownedBy(req) });
      if (existing === 0) fields.isPrimary = true;
    }

    const driver = await Driver.create({ ...fields, truck: truckId, owner: req.accountId });
    if (driver.isPrimary) await demoteSiblings(truckId, req.accountId, driver._id);

    res.status(201).json({ success: true, driver });
  } catch (error) {
    if (error.name === 'ValidationError') {
      return res.status(400).json({ success: false, error: error.message });
    }
    console.error('[drivers] create failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to create driver' });
  }
});

// PUT /api/drivers/:id — update one of the caller's drivers.
router.put('/:id', protect, requirePermission('drivers', 'update'), async (req, res) => {
  try {
    const fields = normaliseDriver(req.body || {});
    if (!fields || !fields.name || !fields.mobile) {
      return res.status(400).json({ success: false, error: 'Driver name and mobile are required' });
    }

    // `truck` is only touched when the caller actually sent it, so a plain
    // detail edit does not silently unassign the driver.
    if (req.body.truck !== undefined) {
      const truckId = req.body.truck || null;
      if (truckId && !(await resolveTruck(req, truckId))) {
        return res.status(404).json({ success: false, error: 'Truck not found' });
      }
      fields.truck = truckId;
    }

    const driver = await Driver.findOneAndUpdate(
      { _id: req.params.id, ...ownedBy(req) },
      { $set: fields },
      { new: true, runValidators: true }
    );
    if (!driver) return res.status(404).json({ success: false, error: 'Driver not found' });

    if (driver.isPrimary) await demoteSiblings(driver.truck, req.accountId, driver._id);

    res.json({ success: true, driver });
  } catch (error) {
    if (error.name === 'ValidationError') {
      return res.status(400).json({ success: false, error: error.message });
    }
    res.status(500).json({ success: false, error: 'Failed to update driver' });
  }
});

// DELETE /api/drivers/:id — remove a driver from the roster entirely.
router.delete('/:id', protect, requirePermission('drivers', 'delete'), async (req, res) => {
  try {
    const driver = await Driver.findOneAndDelete({ _id: req.params.id, ...ownedBy(req) });
    if (!driver) return res.status(404).json({ success: false, error: 'Driver not found' });

    // Removing the primary leaves the truck without one; promote the oldest
    // remaining driver so single-driver views keep showing something.
    if (driver.isPrimary && driver.truck) {
      const next = await Driver.findOne({ truck: driver.truck, ...ownedBy(req) }).sort({ createdAt: 1 });
      if (next) {
        next.isPrimary = true;
        await next.save();
      }
    }

    res.json({ success: true, message: 'Driver removed' });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to delete driver' });
  }
});

export default router;
