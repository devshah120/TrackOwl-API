// One-off CLI helper: remap the old three-value truck status onto the vehicle
// master's six-value set. Run once after deploying the vehicle master change.
//
//   Running -> In Transit   (the old "on the road" state)
//   Stopped -> Offline      (parked with no telemetry; not the same as retired)
//   Idle    -> Idle         (unchanged, left alone)
//
// Safe to re-run — only documents still holding an old value are touched, so
// an interrupted run can simply be started again. Statuses set by hand after
// the migration are never overwritten.
//
// Usage: node scripts/migrateVehicleStatus.js [--dry-run]
//   --dry-run  report what would change without writing
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import Truck from '../models/Truck.js';

dotenv.config();

const dryRun = process.argv.includes('--dry-run');

// Old value -> new value. Anything already in the new set is absent here and
// so is skipped by the query below.
const STATUS_MAP = {
  Running: 'In Transit',
  Stopped: 'Offline'
};

const run = async () => {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/trackowl');

  let total = 0;

  for (const [from, to] of Object.entries(STATUS_MAP)) {
    // strictQuery/enum validation does not apply to a raw filter, so the old
    // values are still matchable even though the schema no longer allows them.
    const count = await Truck.countDocuments({ status: from });
    if (!count) {
      console.log(`  ${from}: none found.`);
      continue;
    }

    if (dryRun) {
      console.log(`  ${from} -> ${to}: ${count} truck(s) would be updated.`);
    } else {
      const res = await Truck.updateMany({ status: from }, { $set: { status: to } });
      console.log(`  ${from} -> ${to}: ${res.modifiedCount} truck(s) updated.`);
    }
    total += count;
  }

  // Anything left outside the new set predates the enum entirely (or was
  // written by hand). Report it rather than guessing at an intended meaning.
  const stray = await Truck.find({
    status: { $nin: [...Object.values(STATUS_MAP), 'Active', 'Idle', 'In Transit', 'Maintenance', 'Offline', 'Inactive'] }
  }).select('number status');

  for (const t of stray) {
    console.warn(`  ! ${t.number}: unrecognised status "${t.status}" — left as-is, set it from the UI.`);
  }

  console.log(dryRun ? `\nDry run: ${total} truck(s) would change.` : `\nRemapped ${total} truck(s).`);

  await mongoose.disconnect();
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
