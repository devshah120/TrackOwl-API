// One-off CLI helper: link each truck to the GPS device fitted to it, by
// setting Truck.device.
//
// The pairing cannot be derived from the data — a device's name ("FMB920") and
// a truck's number ("44478") have no reliable relationship — so it is stated
// explicitly in PAIRS below rather than inferred. Edit that list to re-run this
// for a different fleet.
//
// Safe to re-run: a truck already pointing at the right device is left alone,
// and the script refuses to move a device that is already fitted to a different
// truck unless --force is passed.
//
// Usage: node scripts/assignDevicesToTrucks.js [--dry-run] [--force]
//   --dry-run  print what would change and exit without writing
//   --force    reassign a device even if it is already linked to another truck
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import Truck from '../models/Truck.js';
import Device from '../models/Device.js';

dotenv.config();

// device name (as shown under Live Tracking) → truck number (as shown under
// Fleet Oversight). Matched case-insensitively, ignoring spaces and dashes.
const PAIRS = [
  { device: 'FMB920', truck: '359' },
  { device: 'My Truck', truck: '44478' },
  { device: 'Dipesh', truck: 'MK-AS-1233' },
];

const dryRun = process.argv.includes('--dry-run');
const force = process.argv.includes('--force');

// Truck numbers are stored uppercase and can carry dashes or spaces that the
// operator types inconsistently, so compare on a stripped form.
const norm = (v) => String(v ?? '').replace(/[\s-]/g, '').toUpperCase();

const run = async () => {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/trackowl');

  // Load everything up front so a bad pairing is reported before anything is
  // written, rather than leaving the fleet half-linked.
  const [trucks, devices] = await Promise.all([Truck.find(), Device.find()]);

  console.log(`Loaded ${trucks.length} truck(s) and ${devices.length} device(s).\n`);

  const resolved = [];
  const problems = [];

  for (const pair of PAIRS) {
    const device = devices.find((d) => norm(d.name) === norm(pair.device));
    const truck = trucks.find((t) => norm(t.number) === norm(pair.truck));

    if (!device) {
      problems.push(`No device named "${pair.device}".`);
      continue;
    }
    if (!truck) {
      problems.push(`No truck numbered "${pair.truck}".`);
      continue;
    }

    // A device belongs to one fleet and a truck to another only if the data is
    // already inconsistent; linking across owners would leak one client's
    // vehicle into another's map, so refuse it outright.
    if (device.owner && truck.owner && String(device.owner) !== String(truck.owner)) {
      problems.push(
        `"${device.name}" and truck ${truck.number} belong to different accounts — refusing to link.`
      );
      continue;
    }

    const heldBy = trucks.find(
      (t) => t.device && String(t.device) === String(device._id) && String(t._id) !== String(truck._id)
    );
    if (heldBy && !force) {
      problems.push(
        `"${device.name}" is already fitted to truck ${heldBy.number}. Re-run with --force to move it.`
      );
      continue;
    }

    resolved.push({ device, truck, heldBy });
  }

  if (problems.length) {
    console.error('Could not resolve every pairing:');
    problems.forEach((p) => console.error(`  ! ${p}`));
    console.error('\nNothing was written.');
    await mongoose.disconnect();
    process.exit(1);
  }

  let linked = 0;
  let unchanged = 0;

  for (const { device, truck, heldBy } of resolved) {
    if (truck.device && String(truck.device) === String(device._id)) {
      console.log(`  = ${truck.number} already linked to "${device.name}"`);
      unchanged++;
      continue;
    }

    const note = heldBy ? ` (moved from ${heldBy.number})` : '';
    console.log(`  ${dryRun ? '~' : '+'} ${truck.number} → "${device.name}"${note}`);

    if (!dryRun) {
      // Clear the old holder first so the one-truck-one-tracker rule holds
      // even mid-run.
      if (heldBy) await Truck.updateOne({ _id: heldBy._id }, { $set: { device: null } });
      await Truck.updateOne({ _id: truck._id }, { $set: { device: device._id } });
    }
    linked++;
  }

  console.log(
    `\n${dryRun ? 'Would link' : 'Linked'} ${linked} truck(s); ${unchanged} already correct.`
  );
  if (dryRun) console.log('Dry run — nothing was written.');

  await mongoose.disconnect();
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
