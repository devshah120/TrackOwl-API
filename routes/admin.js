import express from 'express';
import User from '../models/User.js';
import Truck, { VEHICLE_STATUSES } from '../models/Truck.js';
import Driver from '../models/Driver.js';
import Device from '../models/Device.js';
import LedgerEntry from '../models/LedgerEntry.js';
import Notification from '../models/Notification.js';
import { protect, requireSuperAdmin } from '../middleware/auth.js';
import RolePermission from '../models/RolePermission.js';
import {
  ROLES,
  ROLE_LABELS,
  RESOURCES,
  ACTIONS,
  EDITABLE_ROLES,
  LOCKED_ROLES,
  DEFAULT_GRANTS,
  isValidGrant,
  sameEffectiveGrants,
  grantsFor
} from '../utils/permissions.js';
import { loadRolePermissions } from '../services/rolePermissions.js';
import { registerDevice } from '../services/deviceRegistration.js';
import { readDriverList, syncTruckDrivers, attachDrivers } from '../utils/drivers.js';

// Drivers are owned by the truck's client, not by the admin making the call.
const rawDriverRows = (body) =>
  Array.isArray(body?.drivers) ? body.drivers : body?.driver ? [body.driver] : [];

const router = express.Router();

// Every route here is platform-wide (crosses client boundaries), so it is
// gated to superadmin on top of normal auth.
router.use(protect, requireSuperAdmin);

// GET /api/admin/users — every client account, with a truck count and a count
// of the staff seats on it. Only account owners are listed: their team shows as
// a number here and is managed by the owner inside their own account.
router.get('/users', async (req, res) => {
  try {
    const users = await User.find({ role: ROLES.COMPANY_ADMIN }).sort({ createdAt: -1 });
    const [truckCounts, seatCounts] = await Promise.all([
      Truck.aggregate([{ $group: { _id: '$owner', count: { $sum: 1 } } }]),
      User.aggregate([
        { $match: { account: { $ne: null } } },
        { $group: { _id: '$account', count: { $sum: 1 } } }
      ])
    ]);
    const countByOwner = new Map(truckCounts.map((t) => [String(t._id), t.count]));
    const seatsByOwner = new Map(seatCounts.map((s) => [String(s._id), s.count]));

    const withCounts = users.map((u) => ({
      ...u.toJSON(),
      truckCount: countByOwner.get(String(u._id)) || 0,
      // The owner's own seat plus everyone they have added.
      userCount: (seatsByOwner.get(String(u._id)) || 0) + 1
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
      { _id: req.params.id, role: ROLES.COMPANY_ADMIN },
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
      { _id: req.params.id, role: ROLES.COMPANY_ADMIN },
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
    const user = await User.findOneAndDelete({ _id: req.params.id, role: ROLES.COMPANY_ADMIN });
    if (!user) return res.status(404).json({ success: false, error: 'Client not found' });

    await Promise.all([
      // The staff seats on this account: their logins die with the account, and
      // the data they created was owned by the account anyway.
      User.deleteMany({ account: user._id }),
      Truck.deleteMany({ owner: user._id }),
      Driver.deleteMany({ owner: user._id }),
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
    res.json({ success: true, trucks: await attachDrivers(trucks) });
  } catch (error) {
    console.error('[admin] list trucks failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to fetch trucks' });
  }
});

// POST /api/admin/trucks — superadmin creates a truck for a given client.
router.post('/trucks', async (req, res) => {
  try {
    const { owner, number, model, registrationDate, insuranceExpiry, status, currentRoute } = req.body || {};

    if (!owner || !number || !model) {
      return res.status(400).json({ success: false, error: 'owner, truck number, and model are required' });
    }

    const ownerUser = await User.findOne({ _id: owner, role: ROLES.COMPANY_ADMIN });
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
      currentRoute: currentRoute ? String(currentRoute).trim() : undefined
    });

    try {
      await syncTruckDrivers(truck._id, owner, readDriverList(req.body), rawDriverRows(req.body));
    } catch (err) {
      await Truck.deleteOne({ _id: truck._id });
      await Driver.deleteMany({ truck: truck._id });
      if (err.name === 'ValidationError') {
        return res.status(400).json({ success: false, error: err.message });
      }
      throw err;
    }

    Notification.create({
      owner,
      type: 'event',
      title: 'Truck Added',
      message: `Truck ${truck.number} added to fleet by admin`,
      vehicle: truck.number
    }).catch((err) => console.error('[admin] notification failed:', err.message));

    res.status(201).json({ success: true, truck: await attachDrivers(truck) });
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

    const truck = await Truck.findByIdAndUpdate(
      req.params.id,
      { $set: fields },
      { new: true, runValidators: true }
    ).populate('owner', 'name company email');

    if (!truck) return res.status(404).json({ success: false, error: 'Truck not found' });

    // Drivers belong to the truck's client — `owner` is populated here, so read
    // the id off the populated document rather than the field itself.
    const ownerId = truck.owner?._id || truck.owner;
    await syncTruckDrivers(truck._id, ownerId, readDriverList(body), rawDriverRows(body));

    res.json({ success: true, truck: await attachDrivers(truck) });
  } catch (error) {
    if (error.name === 'ValidationError') {
      return res.status(400).json({ success: false, error: error.message });
    }
    console.error('[admin] update truck failed:', error.message);
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

    const ownerUser = await User.findOne({ _id: owner, role: ROLES.COMPANY_ADMIN });
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
      User.countDocuments({ role: ROLES.COMPANY_ADMIN }),
      Truck.find().select('status'),
      Device.find().select('lastSeenAt lastPosition.speed'),
      LedgerEntry.aggregate([
        { $group: { _id: '$type', total: { $sum: '$amount' } } }
      ])
    ]);

    // Seeded from the model's status list so a new status shows up as a zero
    // bucket rather than being missing from the overview until one is used.
    const trucksByStatus = trucks.reduce(
      (acc, t) => {
        acc[t.status] = (acc[t.status] || 0) + 1;
        return acc;
      },
      Object.fromEntries(VEHICLE_STATUSES.map((s) => [s, 0]))
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

// ---------------------------------------------------------------------------
// Role permission matrix
//
// The platform-wide definition of what each staff role may do. Editing this
// changes every customer's Fleet Manager, Accountant, Viewer and Driver at
// once, which is why it lives behind the superadmin gate at the top of this
// file rather than in a customer's own settings.
//
// super_admin and company_admin are absent by design: they are fixed in code so
// that no edit can leave the platform with nobody able to reach this editor.
// ---------------------------------------------------------------------------

// GET /api/admin/permissions — the current matrix, plus the vocabulary the
// editor needs to render a grid (which resources and actions exist) and the
// shipped defaults so the UI can offer a per-role "reset".
router.get('/permissions', async (req, res) => {
  try {
    const rows = await RolePermission.find().populate('updatedBy', 'name email');
    const storedByRole = new Map(rows.map((r) => [r.role, r]));

    const roles = EDITABLE_ROLES.map((role) => {
      const stored = storedByRole.get(role);
      return {
        role,
        label: ROLE_LABELS[role],
        // grantsFor is the runtime's own answer, so what the editor shows is
        // exactly what the guards will enforce.
        grants: grantsFor(role),
        defaults: DEFAULT_GRANTS[role] || [],
        // Whether this role still means what shipped — drives an "edited"
        // marker in the UI. Compared by effect, not by text: the editor saves
        // what the ticks say, so an untouched Viewer comes back as nine
        // explicit grants instead of '*:read' and must not read as customised.
        isCustomised: !sameEffectiveGrants(grantsFor(role), DEFAULT_GRANTS[role] || []),
        updatedBy: stored?.updatedBy || null,
        updatedAt: stored?.updatedAt || null
      };
    });

    res.json({
      success: true,
      matrix: {
        resources: RESOURCES,
        // `manage` is an internal shorthand that implies the other four; the
        // editor works in concrete verbs, so it is not offered as a column.
        actions: ACTIONS.filter((a) => a !== 'manage'),
        roles,
        // Shown read-only in the editor so it is obvious why they are absent.
        locked: LOCKED_ROLES.map((role) => ({
          role,
          label: ROLE_LABELS[role],
          grants: grantsFor(role)
        }))
      }
    });
  } catch (error) {
    console.error('[admin] permissions fetch failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to fetch permissions' });
  }
});

// PUT /api/admin/permissions/:role — replace one role's grants.
//
// The whole list is sent rather than a diff: the editor holds the full row, and
// a replace makes "unticking the last box" unambiguous.
router.put('/permissions/:role', async (req, res) => {
  try {
    const { role } = req.params;
    const { grants } = req.body || {};

    if (LOCKED_ROLES.includes(role)) {
      return res.status(400).json({
        success: false,
        error: `${ROLE_LABELS[role] || role} is fixed and cannot be edited`
      });
    }
    if (!EDITABLE_ROLES.includes(role)) {
      return res.status(404).json({ success: false, error: 'Unknown role' });
    }
    if (!Array.isArray(grants)) {
      return res.status(400).json({ success: false, error: 'grants must be an array' });
    }

    // Reject the whole payload on a bad entry rather than silently dropping it,
    // so the editor cannot quietly save something narrower than it displays.
    const invalid = grants.filter((g) => !isValidGrant(g));
    if (invalid.length) {
      return res.status(400).json({
        success: false,
        error: `Not a valid permission: ${invalid.slice(0, 3).join(', ')}`
      });
    }

    const deduped = [...new Set(grants)];

    const updated = await RolePermission.findOneAndUpdate(
      { role },
      { $set: { grants: deduped, updatedBy: req.user._id, updatedAt: new Date() } },
      { new: true, upsert: true, runValidators: true }
    );

    // The cache is what every request actually reads, so a save that did not
    // refresh it would appear to work and change nothing.
    await loadRolePermissions();

    res.json({
      success: true,
      message: `${ROLE_LABELS[role]} permissions updated`,
      role: {
        role,
        label: ROLE_LABELS[role],
        grants: grantsFor(role),
        defaults: DEFAULT_GRANTS[role] || [],
        updatedAt: updated.updatedAt
      }
    });
  } catch (error) {
    if (error.name === 'ValidationError') {
      return res.status(400).json({ success: false, error: error.message });
    }
    console.error('[admin] permissions update failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to update permissions' });
  }
});

// POST /api/admin/permissions/:role/reset — put one role back to its shipped
// defaults. The way out of an edit that went wrong, without having to remember
// what the original ticks were.
router.post('/permissions/:role/reset', async (req, res) => {
  try {
    const { role } = req.params;

    if (LOCKED_ROLES.includes(role)) {
      return res.status(400).json({
        success: false,
        error: `${ROLE_LABELS[role] || role} is fixed and cannot be edited`
      });
    }
    if (!EDITABLE_ROLES.includes(role)) {
      return res.status(404).json({ success: false, error: 'Unknown role' });
    }

    const defaults = DEFAULT_GRANTS[role] || [];
    await RolePermission.findOneAndUpdate(
      { role },
      { $set: { grants: defaults, updatedBy: req.user._id, updatedAt: new Date() } },
      { new: true, upsert: true, runValidators: true }
    );
    await loadRolePermissions();

    res.json({
      success: true,
      message: `${ROLE_LABELS[role]} reset to defaults`,
      role: { role, label: ROLE_LABELS[role], grants: grantsFor(role), defaults }
    });
  } catch (error) {
    console.error('[admin] permissions reset failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to reset permissions' });
  }
});

export default router;
