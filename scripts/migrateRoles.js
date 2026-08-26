// One-off migration: move the two-role model onto the six-role one.
//
//   superadmin -> super_admin
//   client     -> company_admin   (and, being an account owner, account: null)
//
// Idempotent — rows already carrying a new-model role are left untouched, so
// re-running after a partial failure is safe. Writes go through the driver
// rather than through Mongoose validation, because the old values are no
// longer in the schema enum and would be rejected on the way in.
//
// Usage: node scripts/migrateRoles.js [--dry-run]
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { ROLES, ROLE_VALUES } from '../utils/permissions.js';

dotenv.config();

const LEGACY = {
  superadmin: ROLES.SUPER_ADMIN,
  client: ROLES.COMPANY_ADMIN
};

const dryRun = process.argv.includes('--dry-run');

const run = async () => {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/trackowl');
  const users = mongoose.connection.collection('users');

  const total = await users.countDocuments();
  console.log(`${total} user(s) in the database${dryRun ? '  (dry run — nothing will be written)' : ''}`);

  for (const [oldRole, newRole] of Object.entries(LEGACY)) {
    const count = await users.countDocuments({ role: oldRole });
    if (!count) {
      console.log(`  ${oldRole}: none to migrate`);
      continue;
    }

    if (dryRun) {
      console.log(`  ${oldRole} -> ${newRole}: ${count} would be updated`);
      continue;
    }

    const res = await users.updateMany({ role: oldRole }, { $set: { role: newRole } });
    console.log(`  ${oldRole} -> ${newRole}: ${res.modifiedCount} updated`);
  }

  // Every pre-existing row is an account owner, so `account` must be null for
  // them — a missing field would otherwise leave `accountId` undefined on the
  // first read and scope their queries to nothing.
  const missingAccount = await users.countDocuments({ account: { $exists: false } });
  if (missingAccount) {
    if (dryRun) {
      console.log(`  account field: ${missingAccount} row(s) would be backfilled to null`);
    } else {
      const res = await users.updateMany(
        { account: { $exists: false } },
        { $set: { account: null, createdBy: null, lastLoginAt: null } }
      );
      console.log(`  account field: ${res.modifiedCount} row(s) backfilled to null`);
    }
  }

  // Anything left on a role the new model does not know about would fail every
  // permission check silently, so surface it rather than leaving it buried.
  const stragglers = await users
    .find({ role: { $nin: ROLE_VALUES } })
    .project({ email: 1, role: 1 })
    .toArray();

  if (stragglers.length) {
    console.log('\n⚠ Users on an unrecognised role — fix these by hand:');
    stragglers.forEach((u) => console.log(`   ${u.email}: ${u.role}`));
    process.exitCode = 1;
  } else {
    console.log('\n✓ Every user is on a valid role');
  }

  await mongoose.disconnect();
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
