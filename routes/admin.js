import express from 'express';
import User from '../models/User.js';
import Truck, { VEHICLE_STATUSES } from '../models/Truck.js';
import Driver from '../models/Driver.js';
import Device, { DEVICE_TYPES, DEVICE_LIFECYCLE_STATUSES } from '../models/Device.js';
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
import { recordAudit, auditCreate, auditUpdate, auditDelete } from '../utils/audit.js';
import { listEntries } from './audit.js';

// Drivers are owned by the truck's client, not by the admin making the call.
const rawDriverRows = (body) =>
  Array.isArray(body?.drivers) ? body.drivers : body?.driver ? [body.driver] : [];

const router = express.Router();

// Every route here is platform-wide (crosses client boundaries), so it is
// gated to superadmin on top of normal auth.
router.use(protect, requireSuperAdmin);

// A Super Admin acts *on* a client's account, not inside their own — so these
// entries are filed against the affected client rather than against req.accountId
// (which for a platform operator is their own id and belongs to nobody's fleet).
// The actor stays the admin, which is exactly the pair an audit needs: whose
// data changed, and who reached in and changed it.
const onBehalfOf = (accountId) => ({ account: accountId });

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

    await recordAudit(req, {
      entity: 'user',
      entityId: user._id,
      entityLabel: user.name,
      action: isActive ? 'activate' : 'deactivate',
      ...onBehalfOf(user._id),
      summary: `Client account ${user.company || user.name} ${isActive ? 'activated' : 'deactivated'} by platform admin`,
      changes: [{ field: 'isActive', label: 'Active', from: !isActive, to: isActive }]
    });

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

    const before = await User.findOne({ _id: req.params.id, role: ROLES.COMPANY_ADMIN });
    if (!before) return res.status(404).json({ success: false, error: 'Client not found' });

    const user = await User.findOneAndUpdate(
      { _id: req.params.id, role: ROLES.COMPANY_ADMIN },
      { $set: updates },
      { new: true, runValidators: true }
    );
    if (!user) return res.status(404).json({ success: false, error: 'Client not found' });

    await auditUpdate(req, {
      entity: 'user',
      before,
      after: user,
      fields: updates,
      label: user.name,
      ...onBehalfOf(user._id)
    });

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

    // Filed against the platform (account: null) rather than against the client:
    // the account it would have belonged to no longer exists, and an entry
    // nobody can ever read is not a record of anything. This is the one deletion
    // where the platform-wide view is the only place the evidence survives.
    await auditDelete(req, {
      entity: 'user',
      doc: user,
      label: user.name,
      fields: ['name', 'email', 'mobile', 'company', 'role'],
      account: null,
      summary: `Client account ${user.company || user.name} deleted with all of its trucks, drivers and ledger entries`
    });

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

    await auditCreate(req, {
      entity: 'truck',
      doc: truck,
      label: truck.number,
      ...onBehalfOf(owner),
      summary: `Truck ${truck.number} created by platform admin`
    });

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

    const before = await Truck.findById(req.params.id);
    if (!before) return res.status(404).json({ success: false, error: 'Truck not found' });

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

    await auditUpdate(req, {
      entity: 'truck',
      before,
      after: truck,
      fields,
      label: truck.number,
      ...onBehalfOf(ownerId)
    });

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

    await auditDelete(req, {
      entity: 'truck',
      doc: truck,
      label: truck.number,
      ...onBehalfOf(truck.owner),
      summary: `Truck ${truck.number} deleted by platform admin`
    });

    res.json({ success: true, message: 'Truck removed' });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to delete truck' });
  }
});

// --- Device master -------------------------------------------------------
// The tracking hardware, managed as its own asset register: what each unit is,
// which SIM is in it, when it was fitted and to which vehicle. Distinct from
// the trucks master (what is being tracked) and from live tracking (what the
// unit is reporting right now).

// The master fields a superadmin may write. Deliberately a whitelist: the
// gateway identity (uniqueId, traccarId) and the telemetry cache
// (lastPosition, lastSeenAt) are owned by the ingest path and must never be
// settable from an admin form.
const readDeviceMaster = (body = {}) => {
  const master = {};
  const str = (key, value) => {
    if (value !== undefined) master[key] = String(value).trim();
  };

  str('model', body.model);
  str('manufacturer', body.manufacturer);
  str('firmwareVersion', body.firmwareVersion);
  str('installedBy', body.installedBy);
  str('notes', body.notes);
  if (body.imei !== undefined) master.imei = String(body.imei).replace(/\D/g, '');
  if (body.lifecycleStatus !== undefined) master.lifecycleStatus = body.lifecycleStatus;
  if (body.installedAt !== undefined) master.installedAt = body.installedAt || null;

  // SIM arrives as a nested object; each field is optional, so build it up
  // key by key rather than replacing the whole subdocument with a partial one.
  if (body.sim && typeof body.sim === 'object') {
    const sim = {};
    for (const key of ['number', 'iccid', 'provider', 'plan']) {
      if (body.sim[key] !== undefined) sim[key] = String(body.sim[key]).trim();
    }
    if (body.sim.validTill !== undefined) sim.validTill = body.sim.validTill || null;
    if (Object.keys(sim).length) master.sim = sim;
  }

  return master;
};

// Validates the master payload against the model's vocabularies before it
// reaches Mongoose, so a bad value comes back as a readable 400 rather than a
// generic cast error.
const validateDeviceMaster = (master) => {
  if (master.lifecycleStatus && !DEVICE_LIFECYCLE_STATUSES.includes(master.lifecycleStatus)) {
    return `Status must be one of: ${DEVICE_LIFECYCLE_STATUSES.join(', ')}`;
  }
  if (master.imei && !/^\d{15,17}$/.test(master.imei)) {
    return 'IMEI must be 15-17 digits';
  }
  return null;
};

// A device is fitted to at most one truck and a truck carries at most one
// device, so pointing a device at a vehicle means clearing whatever either
// side used to point at. Both sides are written here — Device.vehicle and
// Truck.device — so the two can never disagree. Returns an error message, or
// null on success; the caller still has to save the device.
const linkDeviceToVehicle = async (device, vehicleId) => {
  const previous = device.vehicle ? String(device.vehicle) : null;
  const next = vehicleId ? String(vehicleId) : null;
  if (previous === next) return null;

  if (next) {
    const truck = await Truck.findById(next);
    if (!truck) return 'Vehicle not found';
    // A truck belonging to a different client would put the device on a fleet
    // its owner cannot see, so the pairing has to stay inside one account.
    if (device.owner && String(truck.owner) !== String(device.owner)) {
      return 'That vehicle belongs to a different client';
    }
    // Free the truck's previous device, and the device's previous truck.
    if (truck.device && String(truck.device) !== String(device._id)) {
      await Device.updateOne({ _id: truck.device }, { $set: { vehicle: null } });
    }
    await Truck.updateOne({ _id: next }, { $set: { device: device._id } });
  }

  if (previous && previous !== next) {
    await Truck.updateOne({ _id: previous, device: device._id }, { $set: { device: null } });
  }

  device.vehicle = next;
  return null;
};

// POST /api/admin/devices — register a tracking device (phone or hardware) on
// behalf of a chosen client. Same gateway-registration flow as a client's own
// POST /api/track/devices, just with an explicit owner instead of the caller,
// plus the device-master fields the client-side form does not collect.
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

    const master = readDeviceMaster(req.body);
    const invalid = validateDeviceMaster(master);
    if (invalid) return res.status(400).json({ success: false, error: invalid });

    const { device, setup } = await registerDevice({
      name: req.body.name,
      type: req.body.type,
      uniqueId: req.body.uniqueId,
      ownerId: owner,
      master
    });

    // Fitment is linked after creation, since it writes the truck side too.
    if (req.body.vehicle) {
      const linkError = await linkDeviceToVehicle(device, req.body.vehicle);
      if (linkError) return res.status(400).json({ success: false, error: linkError });
      await device.save();
    }

    await auditCreate(req, {
      entity: 'device',
      doc: device,
      label: device.name,
      fields: ['name', 'uniqueId', 'type', 'lifecycleStatus', 'vehicle'],
      ...onBehalfOf(owner),
      summary: `Device ${device.name} (${device.uniqueId}) registered for ${ownerUser.company || ownerUser.name} by platform admin`
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

// GET /api/admin/devices — every tracked device across every client, owner and
// fitted vehicle attached. Powers both the global live-tracking map and the
// device master table.
router.get('/devices', async (req, res) => {
  try {
    const devices = await Device.find()
      .populate('owner', 'name company email')
      .populate('vehicle', 'number model')
      .sort({ lastSeenAt: -1 });
    res.json({ success: true, devices });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to fetch devices' });
  }
});

// GET /api/admin/devices/options — the master's vocabularies, so the frontend
// dropdowns are fed from the same lists the model validates against. Declared
// before /devices/:id so "options" is not read as an id.
router.get('/devices/options', (req, res) => {
  res.json({
    success: true,
    options: {
      deviceTypes: DEVICE_TYPES,
      lifecycleStatuses: DEVICE_LIFECYCLE_STATUSES
    }
  });
});

// PUT /api/admin/devices/:id — edit one device's master record. The gateway
// identity (uniqueId) is not editable: it is baked into the hardware and known
// to Traccar, so changing it here would silently orphan the device's feed.
router.put('/devices/:id', async (req, res) => {
  try {
    const device = await Device.findById(req.params.id);
    if (!device) return res.status(404).json({ success: false, error: 'Device not found' });

    // A plain copy taken before the Object.assign below mutates the document —
    // read afterwards, it would compare the new values against themselves.
    const before = device.toObject();

    const master = readDeviceMaster(req.body);
    const invalid = validateDeviceMaster(master);
    if (invalid) return res.status(400).json({ success: false, error: invalid });

    if (req.body.name !== undefined) {
      const name = String(req.body.name).trim();
      if (!name) return res.status(400).json({ success: false, error: 'Device name is required' });
      device.name = name;
    }

    if (req.body.owner !== undefined) {
      const ownerId = req.body.owner || null;
      if (ownerId) {
        const ownerUser = await User.findOne({ _id: ownerId, role: ROLES.COMPANY_ADMIN });
        if (!ownerUser) return res.status(404).json({ success: false, error: 'Client not found' });
      }
      // Moving a device to another client would leave it fitted to a truck that
      // client does not own, so the fitment is dropped along with the transfer.
      if (String(device.owner || '') !== String(ownerId || '')) {
        await linkDeviceToVehicle(device, null);
      }
      device.owner = ownerId;
    }

    // SIM is a subdocument: merge the submitted keys instead of replacing the
    // whole thing, so a form that omits the ICCID does not wipe it.
    const { sim, ...flat } = master;
    Object.assign(device, flat);
    if (sim) Object.assign(device.sim, sim);

    if (req.body.vehicle !== undefined) {
      const linkError = await linkDeviceToVehicle(device, req.body.vehicle || null);
      if (linkError) return res.status(400).json({ success: false, error: linkError });
    }

    await device.save();
    const saved = await Device.findById(device._id)
      .populate('owner', 'name company email')
      .populate('vehicle', 'number model');

    await auditUpdate(req, {
      entity: 'device',
      before,
      after: device.toObject(),
      // Named explicitly rather than diffing the whole document: `master` holds
      // only the fields the form submits, and `owner`/`vehicle` are handled by
      // their own branches above.
      fields: { name: 1, owner: 1, vehicle: 1, lifecycleStatus: 1, type: 1, ...master },
      label: device.name,
      ...onBehalfOf(device.owner)
    });

    res.json({ success: true, message: 'Device updated', device: saved });
  } catch (error) {
    console.error('[admin] device update failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to update device' });
  }
});

// DELETE /api/admin/devices/:id — remove a device from the master. The truck it
// was fitted to is unlinked so it does not keep a dangling ref; the recorded
// positions are left alone, since retiring a unit should not erase the history
// of where the vehicle actually went.
router.delete('/devices/:id', async (req, res) => {
  try {
    const device = await Device.findById(req.params.id);
    if (!device) return res.status(404).json({ success: false, error: 'Device not found' });

    await Truck.updateMany({ device: device._id }, { $set: { device: null } });
    await device.deleteOne();

    await auditDelete(req, {
      entity: 'device',
      doc: device,
      label: device.name,
      fields: ['name', 'uniqueId', 'type', 'lifecycleStatus', 'vehicle'],
      ...onBehalfOf(device.owner),
      summary: `Device ${device.name} (${device.uniqueId}) removed from the master by platform admin`
    });

    res.json({ success: true, message: 'Device removed' });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to delete device' });
  }
});

// --- Audit trail ---------------------------------------------------------
// The platform-wide view of the same log every account sees a slice of. Reads
// across account boundaries, which is why it lives here behind requireSuperAdmin
// rather than on /api/audit.

// GET /api/admin/audit — every account's activity, newest first, with the same
// filters the account-level list accepts plus `account` to narrow to one client.
//
// The unscoped read is the point: entries that belong to no account — a failed
// sign-in against an unknown email, a role-matrix edit, a deleted client — exist
// only here, and they are precisely the ones a platform operator needs.
router.get('/audit', async (req, res) => {
  try {
    const scope = {};
    if (req.query.account && /^[0-9a-fA-F]{24}$/.test(req.query.account)) {
      scope.account = req.query.account;
    }
    await listEntries(req, res, scope);
  } catch (error) {
    console.error('[admin] audit list failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to load audit log' });
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
    // What the role could do before this save, for the audit entry's "from"
    // side. Read through grantsFor so an unstored role reports its shipped
    // defaults rather than an empty list it never actually had.
    const previous = grantsFor(role);

    const updated = await RolePermission.findOneAndUpdate(
      { role },
      { $set: { grants: deduped, updatedBy: req.user._id, updatedAt: new Date() } },
      { new: true, upsert: true, runValidators: true }
    );

    // The cache is what every request actually reads, so a save that did not
    // refresh it would appear to work and change nothing.
    await loadRolePermissions();

    // The matrix is platform-wide, so this is filed against the platform rather
    // than any one account — and it is the single highest-value entry in the
    // trail: it is the change that silently alters what everyone else can do.
    await recordAudit(req, {
      entity: 'role_permission',
      entityId: updated._id,
      entityLabel: ROLE_LABELS[role] || role,
      action: 'permission_change',
      account: null,
      changes: [{ field: 'grants', label: 'Permissions', from: previous, to: deduped }]
    });

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
    const previous = grantsFor(role);
    await RolePermission.findOneAndUpdate(
      { role },
      { $set: { grants: defaults, updatedBy: req.user._id, updatedAt: new Date() } },
      { new: true, upsert: true, runValidators: true }
    );
    await loadRolePermissions();

    await recordAudit(req, {
      entity: 'role_permission',
      entityLabel: ROLE_LABELS[role] || role,
      action: 'permission_reset',
      account: null,
      changes: [{ field: 'grants', label: 'Permissions', from: previous, to: defaults }]
    });

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
