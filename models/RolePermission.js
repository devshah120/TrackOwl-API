import mongoose from 'mongoose';
import { EDITABLE_ROLES, isValidGrant } from '../utils/permissions.js';

// One row per editable role, holding what that role is allowed to do on this
// platform. The matrix is global rather than per-account: a Super Admin defines
// what "Fleet Manager" means once, and every customer's Fleet Manager gets it.
//
// Only the four staff roles live here. super_admin and company_admin are fixed
// in code (see LOCKED_ROLES) so that a bad edit can never leave the platform
// with nobody able to reach the editor and undo it.
//
// The runtime does not read this collection per request — `loadRolePermissions`
// pulls it into the in-memory cache in utils/permissions.js at boot and after
// each save. This is the durable copy.
const rolePermissionSchema = new mongoose.Schema({
  role: {
    type: String,
    required: true,
    unique: true,
    index: true,
    enum: {
      values: EDITABLE_ROLES,
      message: 'Only staff roles can be customised; super_admin and company_admin are fixed'
    }
  },

  // `resource:action` strings, e.g. 'trucks:read' or 'ledger:*'. Validated
  // against the known resources and actions so a stored grant can never be one
  // that `hasPermission` would silently fail to match.
  grants: {
    type: [String],
    default: [],
    validate: {
      validator: (list) => Array.isArray(list) && list.every(isValidGrant),
      message: 'Every grant must be "resource:action", using known resource and action names'
    }
  },

  // Who last changed this role, and when. The matrix is a security control, so
  // it is worth being able to answer "who widened the Driver role?".
  updatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  updatedAt: { type: Date, default: Date.now }
});

rolePermissionSchema.pre('save', function (next) {
  this.updatedAt = new Date();
  next();
});

export default mongoose.model('RolePermission', rolePermissionSchema);
