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
// Additive, one-time changes to stored rows when a new action is introduced.
//
// A role's grants live in the database once seeded, so a new default does not
// reach it. When an action is split out of an existing one — `export` out of
// "anyone who can read reports could download them" — every row that had the
// old ability is given the new grant once, so nobody loses a capability they
// had the day before. The id is stamped on the row so an admin who then
// removes the grant is not overridden on the next restart.
const GRANT_MIGRATIONS = [
  {
    id: '2026-11-reports-export',
    applies: (row) => !['viewer', 'driver'].includes(row.role),
    grant: 'reports:export',
    when: (grants) => grants.some((g) => ['reports:read', 'reports:*', 'reports:manage', '*:*', '*:read'].includes(g))
  }
];

const applyGrantMigrations = async () => {
  const rows = await RolePermission.find();
  let changed = 0;
  for (const row of rows) {
    const pending = GRANT_MIGRATIONS.filter((m) => !row.appliedMigrations?.includes(m.id) && m.applies(row));
    if (!pending.length) continue;
    const grants = [...row.grants];
    for (const m of pending) {
      const covered = grants.some((g) => g === m.grant || g === `${m.grant.split(':')[0]}:*` || g === '*:*');
      if (!covered && m.when(grants)) grants.push(m.grant);
    }
    await RolePermission.updateOne(
      { _id: row._id },
      { $set: { grants }, $addToSet: { appliedMigrations: { $each: pending.map((m) => m.id) } } }
    );
    changed += 1;
  }
  return changed;
};

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
    await applyGrantMigrations();
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
