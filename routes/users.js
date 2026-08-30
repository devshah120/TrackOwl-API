import express from 'express';
import User from '../models/User.js';
import { protect, requirePermission } from '../middleware/auth.js';
import { recordAudit, auditCreate, auditUpdate, auditDelete } from '../utils/audit.js';
import { validateEmail, validatePassword, validateMobile } from '../utils/validators.js';
import {
  ASSIGNABLE_ROLES,
  ROLE_LABELS,
  expandGrants
} from '../utils/permissions.js';

const router = express.Router();

// The roster is the set of seats belonging to one account: the owner plus every
// staff user pointing at them. Scoped by req.accountId, so a Fleet Manager
// listing the team sees their own colleagues and nobody else's.
const rosterOf = (req) => ({
  $or: [{ _id: req.accountId }, { account: req.accountId }]
});

// Roles a caller may hand out. Neither an owner nor the platform operator may
// mint a super_admin or a second company_admin through this route — an account
// has exactly one owner, which keeps `User.account` a single unambiguous hop.
const isAssignable = (role) => ASSIGNABLE_ROLES.includes(role);

// Writing the roster follows the permission matrix like every other resource:
// a seat holding `users:create` may add a colleague, `users:update` may edit
// one, `users:delete` may remove one. A Super Admin who has not granted those
// leaves the roster owner-only, which is the shipped default.
//
// Self-promotion is not a risk here because `isAssignable` caps every role this
// route will accept at the four staff seats — company_admin comes only from
// registration or a Super Admin, and super_admin from neither. The worst a
// staff seat with `users:update` can do is move a peer between staff roles,
// which is exactly what granting them the permission means.
//
// The owner's own row is refused by each handler below regardless of grants, so
// there is always a seat left that can reach Settings and undo a bad edit.

// GET /api/users/roles — the roles this account may assign, for the form's
// dropdown. Sent from the server so the labels and the enum cannot drift apart.
router.get('/roles', protect, requirePermission('users', 'read'), (req, res) => {
  res.json({
    success: true,
    roles: ASSIGNABLE_ROLES.map((role) => ({
      value: role,
      label: ROLE_LABELS[role],
      permissions: expandGrants(role)
    }))
  });
});

// GET /api/users — every seat on the caller's account, owner first.
router.get('/', protect, requirePermission('users', 'read'), async (req, res) => {
  try {
    const users = await User.find(rosterOf(req)).sort({ createdAt: 1 });

    // The owner heads the list regardless of who was created when.
    const ordered = [
      ...users.filter((u) => String(u._id) === String(req.accountId)),
      ...users.filter((u) => String(u._id) !== String(req.accountId))
    ];

    res.json({
      success: true,
      users: ordered.map((u) => ({
        ...u.toJSON(),
        isAccountOwner: String(u._id) === String(req.accountId)
      }))
    });
  } catch (error) {
    console.error('[users] list failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to fetch users' });
  }
});

// POST /api/users — add a seat to the caller's account.
//
// The new user inherits the account's company name rather than supplying their
// own: they are staff at one company, not a separate registration.
router.post('/', protect, requirePermission('users', 'create'), async (req, res) => {
  try {
    const { name, email, mobile, password, role } = req.body || {};

    if (!name || !email || !mobile || !password || !role) {
      return res.status(400).json({
        success: false,
        error: 'Name, email, mobile, password and role are all required'
      });
    }

    if (!isAssignable(role)) {
      return res.status(400).json({
        success: false,
        error: `Role must be one of: ${ASSIGNABLE_ROLES.map((r) => ROLE_LABELS[r]).join(', ')}`
      });
    }

    if (!validateEmail(email)) {
      return res.status(400).json({ success: false, error: 'Invalid email format' });
    }
    if (!validateMobile(mobile)) {
      return res.status(400).json({ success: false, error: 'Mobile must be a valid 10-digit number' });
    }
    if (!validatePassword(password)) {
      return res.status(400).json({ success: false, error: 'Password must be at least 8 characters' });
    }

    const normalisedEmail = String(email).trim().toLowerCase();
    const existing = await User.findOne({ email: normalisedEmail });
    if (existing) {
      return res.status(409).json({ success: false, error: 'That email is already registered' });
    }

    // Staff inherit the account's company name so documents and lists stay
    // consistent no matter which seat created a record.
    const owner = await User.findById(req.accountId).select('company');

    const user = await User.create({
      name: String(name).trim(),
      email: normalisedEmail,
      mobile: String(mobile).replace(/[^0-9]/g, ''),
      password,
      role,
      company: owner?.company || '',
      account: req.accountId,
      createdBy: req.user._id
    });

    // The password is never snapshotted — `fields` names exactly what the log
    // may carry, and the redaction in utils/audit.js is the backstop.
    await auditCreate(req, {
      entity: 'user',
      doc: user,
      label: user.name,
      fields: ['name', 'email', 'mobile', 'role', 'isActive'],
      summary: `${user.name} added as ${ROLE_LABELS[user.role]}`
    });

    res.status(201).json({
      success: true,
      message: `${user.name} added as ${ROLE_LABELS[user.role]}`,
      user: user.toJSON()
    });
  } catch (error) {
    if (error.name === 'ValidationError') {
      return res.status(400).json({ success: false, error: error.message });
    }
    if (error.code === 11000) {
      return res.status(409).json({ success: false, error: 'That email is already registered' });
    }
    console.error('[users] create failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to create user' });
  }
});

// PUT /api/users/:id — edit a staff seat's details or role.
//
// The account owner's own row is not editable here: it is the login profile,
// which they change under Settings → Company Details.
router.put('/:id', protect, requirePermission('users', 'update'), async (req, res) => {
  try {
    if (String(req.params.id) === String(req.accountId)) {
      return res.status(400).json({
        success: false,
        error: 'Edit the account owner from your own profile settings'
      });
    }

    const { name, email, mobile, role } = req.body || {};
    const updates = {};

    if (name !== undefined) {
      const value = String(name).trim();
      if (!value) return res.status(400).json({ success: false, error: 'Name cannot be empty' });
      updates.name = value;
    }

    if (email !== undefined) {
      const value = String(email).trim().toLowerCase();
      if (!validateEmail(value)) {
        return res.status(400).json({ success: false, error: 'Invalid email format' });
      }
      updates.email = value;
    }

    if (mobile !== undefined) {
      const value = String(mobile).replace(/[^0-9]/g, '');
      if (!validateMobile(value)) {
        return res.status(400).json({ success: false, error: 'Mobile must be a valid 10-digit number' });
      }
      updates.mobile = value;
    }

    if (role !== undefined) {
      if (!isAssignable(role)) {
        return res.status(400).json({
          success: false,
          error: `Role must be one of: ${ASSIGNABLE_ROLES.map((r) => ROLE_LABELS[r]).join(', ')}`
        });
      }
      updates.role = role;
    }

    const before = await User.findOne({ _id: req.params.id, account: req.accountId });
    if (!before) return res.status(404).json({ success: false, error: 'User not found' });

    const user = await User.findOneAndUpdate(
      { _id: req.params.id, account: req.accountId },
      { $set: updates },
      { new: true, runValidators: true }
    );

    if (!user) return res.status(404).json({ success: false, error: 'User not found' });

    // A role change is the entry an audit actually gets read for, so it is
    // called out in the summary rather than left as one field among several.
    const roleChanged = updates.role && updates.role !== before.role;
    await auditUpdate(req, {
      entity: 'user',
      before,
      after: user,
      fields: updates,
      label: user.name,
      summary: roleChanged
        ? `${user.name} changed from ${ROLE_LABELS[before.role] || before.role} to ${ROLE_LABELS[user.role] || user.role}`
        : undefined
    });

    res.json({ success: true, message: 'User updated', user: user.toJSON() });
  } catch (error) {
    if (error.name === 'ValidationError') {
      return res.status(400).json({ success: false, error: error.message });
    }
    if (error.code === 11000) {
      return res.status(409).json({ success: false, error: 'That email is already registered' });
    }
    console.error('[users] update failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to update user' });
  }
});

// PATCH /api/users/:id/status — switch a seat on or off. `protect` re-checks
// isActive on every request, so this takes effect immediately rather than when
// the user's token expires.
router.patch('/:id/status', protect, requirePermission('users', 'update'), async (req, res) => {
  try {
    const { isActive } = req.body || {};
    if (typeof isActive !== 'boolean') {
      return res.status(400).json({ success: false, error: 'isActive (boolean) is required' });
    }

    if (String(req.params.id) === String(req.accountId)) {
      return res.status(400).json({
        success: false,
        error: 'You cannot deactivate your own account'
      });
    }

    const user = await User.findOneAndUpdate(
      { _id: req.params.id, account: req.accountId },
      { $set: { isActive } },
      { new: true }
    );

    if (!user) return res.status(404).json({ success: false, error: 'User not found' });

    // Logged as activate/deactivate rather than as an `update` with one boolean
    // field: revoking someone's access is its own event, and an auditor filters
    // for it by name.
    await recordAudit(req, {
      entity: 'user',
      entityId: user._id,
      entityLabel: user.name,
      action: isActive ? 'activate' : 'deactivate',
      changes: [{ field: 'isActive', label: 'Active', from: !isActive, to: isActive }]
    });

    res.json({
      success: true,
      message: `${user.name} ${isActive ? 'activated' : 'deactivated'}`,
      user: user.toJSON()
    });
  } catch (error) {
    console.error('[users] status change failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to update user status' });
  }
});

// POST /api/users/:id/reset-password — the admin sets a new password directly.
// The user's own forgot-password/OTP flow still works alongside this; this is
// the path for "they are locked out and need it fixed now".
router.post('/:id/reset-password', protect, requirePermission('users', 'update'), async (req, res) => {
  try {
    const { newPassword } = req.body || {};

    if (!newPassword) {
      return res.status(400).json({ success: false, error: 'New password is required' });
    }
    if (!validatePassword(newPassword)) {
      return res.status(400).json({ success: false, error: 'Password must be at least 8 characters' });
    }

    const user = await User.findOne({ _id: req.params.id, account: req.accountId });
    if (!user) return res.status(404).json({ success: false, error: 'User not found' });

    // Assigned and saved rather than updated in place so the pre-save hook
    // hashes it — a findOneAndUpdate would store the plaintext.
    user.password = newPassword;
    await user.save();

    // That it happened, by whom, and to whom — never the value.
    await recordAudit(req, {
      entity: 'user',
      entityId: user._id,
      entityLabel: user.name,
      action: 'password_reset'
    });

    res.json({ success: true, message: `Password reset for ${user.name}` });
  } catch (error) {
    console.error('[users] password reset failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to reset password' });
  }
});

// DELETE /api/users/:id — remove a staff seat.
//
// Nothing owned is deleted with them: every truck, trip and ledger entry is
// owned by the account, not by the seat that happened to create it, so removing
// a user takes away their login and leaves the account's data intact.
router.delete('/:id', protect, requirePermission('users', 'delete'), async (req, res) => {
  try {
    if (String(req.params.id) === String(req.accountId)) {
      return res.status(400).json({
        success: false,
        error: 'You cannot remove your own account'
      });
    }

    const user = await User.findOneAndDelete({ _id: req.params.id, account: req.accountId });
    if (!user) return res.status(404).json({ success: false, error: 'User not found' });

    await auditDelete(req, {
      entity: 'user',
      doc: user,
      label: user.name,
      fields: ['name', 'email', 'mobile', 'role', 'isActive'],
      summary: `${user.name} (${ROLE_LABELS[user.role] || user.role}) removed from the team`
    });

    res.json({ success: true, message: `${user.name} removed` });
  } catch (error) {
    console.error('[users] delete failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to remove user' });
  }
});

export default router;
