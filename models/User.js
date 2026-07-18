import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

const userSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Name is required'],
    trim: true,
    minlength: [2, 'Name must be at least 2 characters']
  },
  email: {
    type: String,
    required: [true, 'Email is required'],
    unique: true,
    lowercase: true,
    match: [/^\w+([\.-]?\w+)*@\w+([\.-]?\w+)*(\.\w{2,3})+$/, 'Please provide a valid email']
  },
  mobile: {
    type: String,
    required: [true, 'Mobile number is required'],
    match: [/^\d{10}$/, 'Mobile must be a valid 10-digit number']
  },
  password: {
    type: String,
    required: [true, 'Password is required'],
    minlength: [8, 'Password must be at least 8 characters'],
    select: false
  },
  company: {
    type: String,
    required: [true, 'Company name is required'],
    trim: true
  },
  fleet: {
    type: String,
    enum: ['1–5 trucks', '6–20 trucks', '21–50 trucks', '50+ trucks'],
    required: [true, 'Fleet size is required']
  },
  address: { type: String, trim: true, default: '' },
  city: { type: String, trim: true, default: '' },
  gstNumber: { type: String, trim: true, default: '' },
  panNumber: { type: String, trim: true, default: '' },
  bankDetails: {
    type: {
      accountName: { type: String, trim: true, default: '' },
      accountNumber: { type: String, trim: true, default: '' },
      bankName: { type: String, trim: true, default: '' },
      ifscCode: { type: String, trim: true, default: '' },
      branchName: { type: String, trim: true, default: '' }
    },
    default: () => ({}),
    _id: false
  },
  role: {
    type: String,
    enum: ['admin', 'client'],
    default: 'client'
  },
  isActive: {
    type: Boolean,
    default: true
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

// Hash password before saving
userSchema.pre('save', async function(next) {
  if (!this.isModified('password')) return next();

  try {
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (err) {
    next(err);
  }
});

// Method to compare passwords
userSchema.methods.matchPassword = async function(enteredPassword) {
  return await bcrypt.compare(enteredPassword, this.password);
};

// Remove password from response
userSchema.methods.toJSON = function() {
  const obj = this.toObject();
  delete obj.password;
  return obj;
};

export default mongoose.model('User', userSchema);
