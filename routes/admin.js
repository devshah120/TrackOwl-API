import express from 'express';
import User from '../models/User.js';
import Truck from '../models/Truck.js';
import Device from '../models/Device.js';
import LedgerEntry from '../models/LedgerEntry.js';
import Notification from '../models/Notification.js';
import { protect, requireSuperAdmin } from '../middleware/auth.js';
import { registerDevice } from '../services/deviceRegistration.js';

const router = express.Router();

// Every route here is platform-wide (crosses client boundaries), so it is
// gated to superadmin on top of normal auth.
router.use(protect, requireSuperAdmin);

// GET /api/admin/users — every client account, with a truck count each.
router.get('/users', async (req, res) => {
  try {
    const users = await User.find({ role: 'client' }).sort({ createdAt: -1 });
    const truckCounts = await Truck.aggregate([
      { $group: { _id: '$owner', count: { $sum: 1 } } }
    ]);
    const countByOwner = new Map(truckCounts.map((t) => [String(t._id), t.count]));

    const withCounts = users.map((u) => ({
      ...u.toJSON(),
      truckCount: countByOwner.get(String(u._id)) || 0
    }));

    res.json({ success: true, users: withCounts });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to fetch clients' });
  }
});

// PATCH /api/admin/users/:id/status — activate or deactivate a client account.
router.patch('/users/:id/status', async (req, res) => {
  try {
    const { isActive } = req.body;
    if (typeof isActive !== 'boolean') {
      return res.status(400).json({ success: false, error: 'isActive (boolean) is required' });
    }

    const user = await User.findOneAndUpdate(
      { _id: req.params.id, role: 'client' },
      { $set: { isActive } },
      { new: true }
    );
    if (!user) return res.status(404).json({ success: false, error: 'Client not found' });

    res.json({ success: true, user });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to update client status' });
  }
});

// PUT /api/admin/users/:id — edit a client's profile fields.
router.put('/users/:id', async (req, res) => {
  try {
    const { name, email, mobile, company, fleet } = req.body || {};
    const updates = {};
    if (name !== undefined) updates.name = String(name).trim();
    if (email !== undefined) updates.email = String(email).trim().toLowerCase();
    if (mobile !== undefined) updates.mobile = String(mobile).replace(/\D/g, '');
    if (company !== undefined) updates.company = String(company).trim();
    if (fleet !== undefined) updates.fleet = fleet;

    const user = await User.findOneAndUpdate(
      { _id: req.params.id, role: 'client' },
      { $set: updates },
      { new: true, runValidators: true }
    );
    if (!user) return res.status(404).json({ success: false, error: 'Client not found' });

    res.json({ success: true, user });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ success: false, error: 'That email is already in use' });
    }
    res.status(500).json({ success: false, error: error.message || 'Failed to update client' });
  }
});

// DELETE /api/admin/users/:id — remove a client account and everything they own.
router.delete('/users/:id', async (req, res) => {
  try {
    const user = await User.findOneAndDelete({ _id: req.params.id, role: 'client' });
    if (!user) return res.status(404).json({ success: false, error: 'Client not found' });

    await Promise.all([
      Truck.deleteMany({ owner: user._id }),
      Device.updateMany({ owner: user._id }, { $unset: { owner: '' } }),
      LedgerEntry.deleteMany({ owner: user._id }),
      Notification.deleteMany({ owner: user._id })
    ]);

    res.json({ success: true, message: 'Client removed' });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to delete client' });
  }
});

// GET /api/admin/trucks — every truck across every client, owner attached.
router.get('/trucks', async (req, res) => {
  try {
    const trucks = await Truck.find()
      .populate('owner', 'name company email')
      .sort({ createdAt: -1 });
    res.json({ success: true, trucks });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to fetch trucks' });
  }
});

// POST /api/admin/trucks — superadmin creates a truck for a given client.
router.post('/trucks', async (req, res) => {
  try {
    const { owner, number, model, registrationDate, insuranceExpiry, status, currentRoute, driver } = req.body || {};

    if (!owner || !number || !model) {
      return res.status(400).json({ success: false, error: 'owner, truck number, and model are required' });
    }

    const ownerUser = await User.findOne({ _id: owner, role: 'client' });
    if (!ownerUser) {
      return res.status(404).json({ success: false, error: 'Client not found' });
    }

    const truck = await Truck.create({
      owner,
      number: String(number).trim(),
      model: String(model).trim(),
      registrationDate: registrationDate || undefined,
      insuranceExpiry: insuranceExpiry || undefined,
      status,
      currentRoute: currentRoute ? String(currentRoute).trim() : undefined,
      driver
    });

    Notification.create({
      owner,
      type: 'event',
      title: 'Truck Added',
      message: `Truck ${truck.number} added to fleet by admin`,
      vehicle: truck.number
    }).catch((err) => console.error('[admin] notification failed:', err.message));

    res.status(201).json({ success: true, truck });
  } catch (error) {
    console.error('[admin] create truck failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to create truck' });
  }
});

// PUT /api/admin/trucks/:id — edit any client's truck.
router.put('/trucks/:id', async (req, res) => {
  try {
    const fields = {};
    const body = req.body || {};
    if (body.number !== undefined) fields.number = String(body.number).trim();
    if (body.model !== undefined) fields.model = String(body.model).trim();
    if (body.registrationDate !== undefined) fields.registrationDate = body.registrationDate || undefined;
    if (body.insuranceExpiry !== undefined) fields.insuranceExpiry = body.insuranceExpiry || undefined;
    if (body.status !== undefined) fields.status = body.status;
    if (body.currentRoute !== undefined) fields.currentRoute = String(body.currentRoute).trim();
    if (body.driver !== undefined) fields.driver = body.driver;

    const truck = await Truck.findByIdAndUpdate(
      req.params.id,
      { $set: fields },
      { new: true, runValidators: true }
    ).populate('owner', 'name company email');

    if (!truck) return res.status(404).json({ success: false, error: 'Truck not found' });
    res.json({ success: true, truck });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to update truck' });
  }
});

// DELETE /api/admin/trucks/:id — remove any client's truck.
router.delete('/trucks/:id', async (req, res) => {
  try {
    const truck = await Truck.findByIdAndDelete(req.params.id);
    if (!truck) return res.status(404).json({ success: false, error: 'Truck not found' });
    res.json({ success: true, message: 'Truck removed' });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to delete truck' });
  }
});

// POST /api/admin/devices — register a tracking device (phone or hardware) on
// behalf of a chosen client. Same gateway-registration flow as a client's own
// POST /api/track/devices, just with an explicit owner instead of the caller.
router.post('/devices', async (req, res) => {
  try {
    const { owner } = req.body || {};
    if (!owner) {
      return res.status(400).json({ success: false, error: 'owner (client id) is required' });
    }

    const ownerUser = await User.findOne({ _id: owner, role: 'client' });
    if (!ownerUser) {
      return res.status(404).json({ success: false, error: 'Client not found' });
    }

    const { device, setup } = await registerDevice({
      name: req.body.name,
      type: req.body.type,
      uniqueId: req.body.uniqueId,
      ownerId: owner
    });

    res.status(201).json({
      success: true,
      message: `${device.name} registered for ${ownerUser.company}`,
      device,
      setup
    });
  } catch (error) {
    if (error.status) {
      return res.status(error.status).json({ success: false, error: error.message });
    }
    console.error('[admin] device registration failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to register device' });
  }
});

// GET /api/admin/devices — every tracked device across every client, owner attached.
// Powers the global live-tracking map.
router.get('/devices', async (req, res) => {
  try {
    const devices = await Device.find()
      .populate('owner', 'name company email')
      .sort({ lastSeenAt: -1 });
    res.json({ success: true, devices });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to fetch devices' });
  }
});

// GET /api/admin/stats — platform-wide numbers for the admin overview page.
router.get('/stats', async (req, res) => {
  try {
    const [clientCount, trucks, devices, ledgerTotals] = await Promise.all([
      User.countDocuments({ role: 'client' }),
      Truck.find().select('status'),
      Device.find().select('lastSeenAt lastPosition.speed'),
      LedgerEntry.aggregate([
        { $group: { _id: '$type', total: { $sum: '$amount' } } }
      ])
    ]);

    const trucksByStatus = trucks.reduce(
      (acc, t) => {
        acc[t.status] = (acc[t.status] || 0) + 1;
        return acc;
      },
      { Running: 0, Idle: 0, Stopped: 0 }
    );

    const now = Date.now();
    const devicesByStatus = devices.reduce(
      (acc, d) => {
        const staleMs = d.lastSeenAt ? now - new Date(d.lastSeenAt).getTime() : Infinity;
        if (staleMs > 2 * 60 * 1000) acc.offline += 1;
        else if ((d.lastPosition?.speed || 0) > 3) acc.moving += 1;
        else acc.idle += 1;
        return acc;
      },
      { moving: 0, idle: 0, offline: 0 }
    );

    const totals = ledgerTotals.reduce(
      (acc, row) => {
        acc[row._id] = row.total;
        return acc;
      },
      { income: 0, expense: 0 }
    );

    res.json({
      success: true,
      stats: {
        totalClients: clientCount,
        totalTrucks: trucks.length,
        trucksByStatus,
        totalDevices: devices.length,
        devicesByStatus,
        ledger: {
          totalIncome: totals.income,
          totalExpense: totals.expense,
          net: totals.income - totals.expense
        }
      }
    });
  } catch (error) {
    console.error('[admin] stats failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to fetch platform stats' });
  }
});

export default router;
