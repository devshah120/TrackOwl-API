// One-off CLI helper: copy each truck's embedded `driver` into the Driver
// collection, marked primary. Run once after deploying the multi-driver change.
// Safe to re-run — a truck that already has Driver rows is skipped, so an
// interrupted run can simply be started again.
//
// Usage: node scripts/migrateDrivers.js [--prune]
//   --prune  also clears the old embedded truck.driver field once copied
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import Truck from '../models/Truck.js';
import Driver from '../models/Driver.js';

dotenv.config();

const prune = process.argv.includes('--prune');

const run = async () => {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/trackowl');

  const trucks = await Truck.find({ 'driver.name': { $exists: true, $ne: '' } });
  console.log(`Found ${trucks.length} truck(s) with an embedded driver.`);

  let created = 0;
  let skipped = 0;

  for (const truck of trucks) {
    const already = await Driver.countDocuments({ truck: truck._id });
    if (already > 0) {
      skipped++;
      continue;
    }

    const d = truck.driver;
    // The old embedded schema required a 10-digit mobile, but records predating
    // that check can still carry junk. Strip to digits and skip anything the
    // Driver model would reject rather than aborting the whole run.
    const mobile = String(d.mobile || '').replace(/\D/g, '');
    if (!/^\d{10}$/.test(mobile)) {
      console.warn(`  ! ${truck.number}: driver "${d.name}" has an invalid mobile (${d.mobile}) — skipped`);
      skipped++;
      continue;
    }

    await Driver.create({
      owner: truck.owner,
      truck: truck._id,
      name: d.name,
      mobile,
      licenseNumber: d.licenseNumber || '',
      licenseExpiry: d.licenseExpiry,
      salary: d.salary,
      isPrimary: true
    });
    created++;

    if (prune) await Truck.updateOne({ _id: truck._id }, { $unset: { driver: '' } });
  }

  console.log(`Migrated ${created} driver(s); skipped ${skipped}.`);
  if (created && !prune) {
    console.log('Embedded truck.driver left in place. Re-run with --prune to clear it.');
  }

  await mongoose.disconnect();
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
