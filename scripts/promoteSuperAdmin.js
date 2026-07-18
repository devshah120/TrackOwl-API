// One-off CLI helper: promote an existing account to superadmin.
// Usage: node scripts/promoteSuperAdmin.js someone@example.com
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import User from '../models/User.js';

dotenv.config();

const email = process.argv[2];
if (!email) {
  console.error('Usage: node scripts/promoteSuperAdmin.js <email>');
  process.exit(1);
}

const run = async () => {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/trackowl');

  const user = await User.findOneAndUpdate(
    { email: email.toLowerCase() },
    { $set: { role: 'superadmin' } },
    { new: true }
  );

  if (!user) {
    console.error(`No account found for ${email}`);
    process.exitCode = 1;
  } else {
    console.log(`${user.email} is now superadmin`);
  }

  await mongoose.disconnect();
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
