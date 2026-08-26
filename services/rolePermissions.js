import RolePermission from '../models/RolePermission.js';
import {
  EDITABLE_ROLES,
  DEFAULT_GRANTS,
  setRolePermissions
} from '../utils/permissions.js';

// Bridges the RolePermission collection and the in-memory matrix that
// `hasPermission` reads on every guarded request.
//
// Called once at boot and again after each save. If it never runs — or fails —
// the cache stays empty and `grantsFor` falls back to DEFAULT_GRANTS, so the
// platform behaves exactly as the hardcoded version did. That is the point of
// the fallback: a database problem must not hand out permissions nobody
// intended, in either direction.

// Creates a row for any editable role that does not have one yet, seeded from
// the shipped defaults. Runs on every boot so a role added in a later release
// appears in the matrix without a separate migration step.
const seedMissingRoles = async () => {
  const existing = await RolePermission.find().select('role');
  const have = new Set(existing.map((r) => r.role));
  const missing = EDITABLE_ROLES.filter((role) => !have.has(role));

  if (!missing.length) return 0;

  await RolePermission.insertMany(
    missing.map((role) => ({ role, grants: DEFAULT_GRANTS[role] || [] })),
    // One role racing in from a parallel boot is not a failure — the unique
    // index rejects the duplicate and the rest still insert.
    { ordered: false }
  ).catch((err) => {
    if (err.code !== 11000) throw err;
  });

  return missing.length;
};

// Reads the collection into the runtime cache. Returns the matrix it loaded.
export const loadRolePermissions = async () => {
  const rows = await RolePermission.find();
  const byRole = {};
  rows.forEach((row) => {
    byRole[row.role] = row.grants;
  });
  setRolePermissions(byRole);
  return byRole;
};

// Boot path: seed anything missing, then load. Failures are logged rather than
// thrown — the server should still come up and serve the shipped defaults
// rather than refuse to start over a permissions read.
export const initRolePermissions = async () => {
  try {
    const seeded = await seedMissingRoles();
    const matrix = await loadRolePermissions();
    console.log(
      `✓ Role permissions loaded (${Object.keys(matrix).length} roles` +
        (seeded ? `, ${seeded} seeded from defaults` : '') +
        ')'
    );
    return matrix;
  } catch (error) {
    console.error('✗ Role permissions failed to load, using built-in defaults:', error.message);
    return null;
  }
};
