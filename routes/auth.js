import express from 'express';
import jwt from 'jsonwebtoken';
import User from '../models/User.js';
import { validateEmail, validatePassword, validateMobile } from '../utils/validators.js';
import { protect } from '../middleware/auth.js';
import { ROLES } from '../utils/permissions.js';
import { sendOTPEmail } from '../services/emailService.js';

const router = express.Router();

const generateToken = (id) => {
  return jwt.sign({ id }, process.env.JWT_SECRET || 'secret', {
    expiresIn: '7d'
  });
};

// Generate OTP
const generateOTP = () => {
  return String(Math.floor(100000 + Math.random() * 900000));
};

// Store OTPs in memory (use Redis in production)
const otpStore = new Map();

// Register new user
router.post('/register', async (req, res) => {
  try {
    const { name, email, mobile, password, company, fleet } = req.body;

    // Validation
    if (!name || !email || !mobile || !password || !company || !fleet) {
      return res.status(400).json({
        success: false,
        error: 'All fields are required'
      });
    }

    if (!validateEmail(email)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid email format'
      });
    }

    if (!validatePassword(password)) {
      return res.status(400).json({
        success: false,
        error: 'Password must be at least 8 characters'
      });
    }

    if (!validateMobile(mobile)) {
      return res.status(400).json({
        success: false,
        error: 'Mobile must be a valid 10-digit number'
      });
    }

    // Check if user exists
    const existingUser = await User.findOne({ email: email.toLowerCase() });
    if (existingUser) {
      return res.status(409).json({
        success: false,
        error: 'Email already registered'
      });
    }

    // Create user
    const user = await User.create({
      name: name.trim(),
      email: email.toLowerCase(),
      mobile: mobile.replace(/\D/g, ''),
      password,
      company: company.trim(),
      fleet,
      // Self-registration always creates an account owner. Staff seats are
      // added from inside the account via POST /api/users, never here.
      role: ROLES.COMPANY_ADMIN
    });

    const token = generateToken(user._id);

    res.status(201).json({
      success: true,
      message: 'Account created successfully',
      token,
      user: user.toJSON()
    });
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Registration failed'
    });
  }
});

// Login user
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    // Validation
    if (!email || !password) {
      return res.status(400).json({
        success: false,
        error: 'Email and password are required'
      });
    }

    if (!validateEmail(email)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid email format'
      });
    }

    // Find user and select password field
    const user = await User.findOne({ email: email.toLowerCase() }).select('+password');

    if (!user) {
      return res.status(401).json({
        success: false,
        error: 'Invalid credentials'
      });
    }

    // Check password
    const isPasswordValid = await user.matchPassword(password);
    if (!isPasswordValid) {
      return res.status(401).json({
        success: false,
        error: 'Invalid credentials'
      });
    }

    // Check if user is active
    if (!user.isActive) {
      return res.status(403).json({
        success: false,
        error: 'Account is inactive'
      });
    }

    // A staff seat is only as live as the account it hangs off — if the owner
    // has been deactivated, nobody on that account gets in.
    if (user.account) {
      const owner = await User.findById(user.account).select('isActive');
      if (!owner || !owner.isActive) {
        return res.status(403).json({
          success: false,
          error: 'Account is inactive'
        });
      }
    }

    user.lastLoginAt = new Date();
    // Skips validation and the password re-hash — this touches one timestamp.
    await user.updateOne({ $set: { lastLoginAt: user.lastLoginAt } });

    const token = generateToken(user._id);

    res.json({
      success: true,
      message: 'Login successful',
      token,
      user: user.toJSON()
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({
      success: false,
      error: 'Login failed'
    });
  }
});

// Get current user profile
router.get('/me', protect, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    res.json({
      success: true,
      user
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to fetch user profile'
    });
  }
});

// Verify token
router.post('/verify', protect, (req, res) => {
  res.json({
    success: true,
    message: 'Token is valid',
    user: req.user.toJSON ? req.user.toJSON() : req.user
  });
});

// Forgot password - Send OTP
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({
        success: false,
        error: 'Email is required'
      });
    }

    if (!validateEmail(email)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid email format'
      });
    }

    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'No account found with this email'
      });
    }

    const otp = generateOTP();
    const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes

    // Store OTP
    otpStore.set(email.toLowerCase(), {
      otp,
      expiresAt,
      attempts: 0
    });

    // Send OTP via email
    await sendOTPEmail(user.email, user.name, otp);

    res.json({
      success: true,
      message: 'OTP sent to your email',
      maskedEmail: user.email.replace(/(.{2})(.*)(@.*)/, '$1****$3')
    });
  } catch (error) {
    console.error('Forgot password error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to send OTP'
    });
  }
});

// Verify OTP
router.post('/verify-otp', async (req, res) => {
  try {
    const { email, otp } = req.body;

    if (!email || !otp) {
      return res.status(400).json({
        success: false,
        error: 'Email and OTP are required'
      });
    }

    const storedOTP = otpStore.get(email.toLowerCase());
    if (!storedOTP) {
      return res.status(400).json({
        success: false,
        error: 'No OTP found. Please request a new one.'
      });
    }

    if (storedOTP.expiresAt < Date.now()) {
      otpStore.delete(email.toLowerCase());
      return res.status(400).json({
        success: false,
        error: 'OTP expired. Please request a new one.'
      });
    }

    if (storedOTP.otp !== otp) {
      storedOTP.attempts += 1;
      if (storedOTP.attempts >= 5) {
        otpStore.delete(email.toLowerCase());
        return res.status(400).json({
          success: false,
          error: 'Too many failed attempts. Please request a new OTP.'
        });
      }
      return res.status(400).json({
        success: false,
        error: 'Invalid OTP'
      });
    }

    // OTP verified - generate reset token
    const resetToken = jwt.sign(
      { email: email.toLowerCase() },
      process.env.JWT_SECRET || 'secret',
      { expiresIn: '15m' }
    );

    // Clear OTP after successful verification
    otpStore.delete(email.toLowerCase());

    res.json({
      success: true,
      message: 'OTP verified successfully',
      resetToken
    });
  } catch (error) {
    console.error('OTP verification error:', error);
    res.status(500).json({
      success: false,
      error: 'OTP verification failed'
    });
  }
});

// Reset password
router.post('/reset-password', async (req, res) => {
  try {
    const { resetToken, newPassword, confirmPassword } = req.body;

    if (!resetToken || !newPassword) {
      return res.status(400).json({
        success: false,
        error: 'Reset token and new password are required'
      });
    }

    if (newPassword !== confirmPassword) {
      return res.status(400).json({
        success: false,
        error: 'Passwords do not match'
      });
    }

    if (!validatePassword(newPassword)) {
      return res.status(400).json({
        success: false,
        error: 'Password must be at least 8 characters with uppercase and number'
      });
    }

    // Verify reset token
    let decoded;
    try {
      decoded = jwt.verify(resetToken, process.env.JWT_SECRET || 'secret');
    } catch (error) {
      return res.status(400).json({
        success: false,
        error: 'Invalid or expired reset token'
      });
    }

    const user = await User.findOne({ email: decoded.email });
    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }

    user.password = newPassword;
    await user.save();

    res.json({
      success: true,
      message: 'Password reset successfully'
    });
  } catch (error) {
    console.error('Reset password error:', error);
    res.status(500).json({
      success: false,
      error: 'Password reset failed'
    });
  }
});

export default router;
