// One-off CLI helper: create a Company master for each existing user from the
// company details already held on their User profile. Run once after deploying
// the Company Master change so existing accounts open Settings to a filled-in
// form rather than a blank one.
//
// Safe to re-run — a user who already has a Company row is skipped, so an
// interrupted run can simply be started again.
//
// Usage: node scripts/seedCompanies.js [--dry]
//   --dry  report what would be created without writing anything
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import User from '../models/User.js';
import Company from '../models/Company.js';

dotenv.config();

const dry = process.argv.includes('--dry');

// The old profile stored GSTIN/PAN as free text, so values that predate the
// Company schema's format checks would fail validation. Rather than refuse to
// migrate the whole record, drop the field and let the user re-enter it.
const GSTIN_PATTERN = /^[0-3][0-9][A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
const PAN_PATTERN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

const clean = (value, pattern) => {
  const v = String(value || '').trim().toUpperCase();
  return pattern.test(v) ? v : '';
};

const run = async () => {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/trackowl');

  const users = await User.find({});
  console.log(`Found ${users.length} user(s).`);

  let created = 0;
  let skipped = 0;
  let dropped = 0;

  for (const user of users) {
    const already = await Company.countDocuments({ owner: user._id });
    if (already > 0) {
      skipped++;
      continue;
    }

    const name = String(user.company || '').trim();
    if (name.length < 2) {
      // Nothing usable to seed from — the user fills the master in themselves.
      console.log(`  - ${user.email}: no company name on profile, skipping`);
      skipped++;
      continue;
    }

    const gstin = clean(user.gstNumber, GSTIN_PATTERN);
    const pan = clean(user.panNumber, PAN_PATTERN);
    if ((user.gstNumber && !gstin) || (user.panNumber && !pan)) dropped++;

    const doc = {
      owner: user._id,
      name,
      legalName: '',
      gstin,
      pan,
      address: {
        line1: String(user.address || '').trim(),
        city: String(user.city || '').trim(),
        country: 'India'
      },
      // The account holder becomes the primary contact — the only contact
      // details the old profile carried.
      contacts: [{
        name: String(user.name || '').trim() || name,
        designation: '',
        phone: String(user.mobile || '').replace(/\D/g, ''),
        email: String(user.email || '').trim().toLowerCase(),
        isPrimary: true
      }],
      timezone: 'Asia/Kolkata',
      status: user.isActive === false ? 'inactive' : 'active'
    };

    if (dry) {
      console.log(`  would create: ${name} (${user.email})`);
      created++;
      continue;
    }

    try {
      await Company.create(doc);
      created++;
    } catch (err) {
      console.error(`  ! ${user.email}: ${err.message}`);
    }
  }

  console.log(`${dry ? 'Would create' : 'Created'} ${created} company record(s); skipped ${skipped}.`);
  if (dropped) {
    console.log(`${dropped} record(s) had a malformed GSTIN/PAN that was left blank for re-entry.`);
  }

  await mongoose.disconnect();
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
