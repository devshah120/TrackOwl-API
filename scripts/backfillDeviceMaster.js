// One-off migration for the device master: fill in the fields that existed
// only implicitly before it, so devices registered under the old flow show up
// correctly on the Device Master page instead of looking blank.
//
// Three things are backfilled, none of them guessed — each is derived from data
// already on the record:
//
//   1. `vehicle` — the fitment. Trucks already carry `Truck.device`, written by
//      scripts/assignDevicesToTrucks.js, but the device side of that pairing did
//      not exist until now. Without this every fitted device reads "Not fitted".
//   2. `deviceType` — 'hardware' when the uniqueId is an IMEI (15–17 digits),
//      'phone' otherwise. That is exactly the rule registerDevice() applies when
//      it decides which setup block to hand back, so it reproduces what the unit
//      was actually registered as. The model's default derives the same value on
//      read, so this is about writing it down once rather than re-deriving it
//      forever — reads are already correct without running this.
//   3. `imei` — for hardware, the IMEI *is* the uniqueId, so it is copied across
//      rather than left for someone to retype.
//
// Everything the migration cannot know — model, SIM, firmware, install date —
// is left empty for an operator to fill in through the UI. Safe to re-run: a
// device already carrying a value is never overwritten.
//
// Usage: node scripts/backfillDeviceMaster.js [--dry-run]
//   --dry-run  print what would change and exit without writing
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import Truck from '../models/Truck.js';
import Device from '../models/Device.js';

dotenv.config();

const dryRun = process.argv.includes('--dry-run');

// Same test registerDevice() uses to tell a hardware unit from a phone.
const isImei = (value) => /^\d{15,17}$/.test(String(value || ''));

const run = async () => {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/trackowl');

  // Read raw documents, not hydrated models: Mongoose applies the schema's
  // defaults on read, so a legacy record with no stored `deviceType` would come
  // back already reading 'hardware' and a phone would be silently mislabelled.
  // `.lean()` shows what is actually in the collection.
  const [devices, trucks] = await Promise.all([
    Device.find().lean(),
    Truck.find().select('number device').lean()
  ]);
  console.log(`Loaded ${devices.length} device(s) and ${trucks.length} truck(s).\n`);

  // device id → the truck already pointing at it.
  const truckByDevice = new Map();
  trucks.forEach((t) => {
    if (t.device) truckByDevice.set(String(t.device), t);
  });

  let changed = 0;

  for (const device of devices) {
    const updates = {};
    const notes = [];

    const truck = truckByDevice.get(String(device._id));
    if (truck && !device.vehicle) {
      updates.vehicle = truck._id;
      notes.push(`fitted to ${truck.number}`);
    }

    if (!device.deviceType) {
      updates.deviceType = isImei(device.uniqueId) ? 'hardware' : 'phone';
      notes.push(`type ${updates.deviceType}`);
    }

    const type = updates.deviceType || device.deviceType;
    if (type === 'hardware' && !device.imei && isImei(device.uniqueId)) {
      updates.imei = device.uniqueId;
      notes.push(`imei ${device.uniqueId}`);
    }

    if (!Object.keys(updates).length) {
      console.log(`  = "${device.name}" already complete`);
      continue;
    }

    console.log(`  ${dryRun ? '~' : '+'} "${device.name}": ${notes.join(', ')}`);
    if (!dryRun) await Device.updateOne({ _id: device._id }, { $set: updates });
    changed++;
  }

  console.log(`\n${dryRun ? 'Would update' : 'Updated'} ${changed} device(s).`);
  if (dryRun) console.log('Dry run — nothing was written.');

  await mongoose.disconnect();
};

run().catch(async (error) => {
  console.error('Backfill failed:', error.message);
  await mongoose.disconnect();
  process.exit(1);
});
