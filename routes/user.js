import express from 'express';
import User from '../models/User.js';
import { protect } from '../middleware/auth.js';

const router = express.Router();

// The signature is stored as a data URI and later handed to PDFKit's image(),
// which only understands PNG and JPEG. Anything else — an SVG carrying script,
// a truncated payload, an oversized blob — is rejected here rather than at
// document-generation time, where it would break the download instead.
const MAX_SIGNATURE_BYTES = 400 * 1024;
const SIGNATURE_DATA_URI = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/;

const parseSignatureDataUrl = (value) => {
  const match = SIGNATURE_DATA_URI.exec(String(value || '').trim());
  if (!match) {
    return { error: 'Signature must be a PNG or JPEG image' };
  }

  const buffer = Buffer.from(match[2], 'base64');
  if (!buffer.length) {
    return { error: 'Signature image is empty or corrupt' };
  }
  if (buffer.length > MAX_SIGNATURE_BYTES) {
    return { error: 'Signature image must be under 400KB' };
  }

  // Confirm the bytes match the declared type — the header is not something a
  // caller can fake by relabelling the MIME prefix.
  const isPng = buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const isJpeg = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[buffer.length - 2] === 0xff;
  if (!(isPng || isJpeg)) {
    return { error: 'Signature image is not a valid PNG or JPEG' };
  }

  return { dataUrl: `data:image/${match[1]};base64,${match[2]}` };
};

// Get user profile
router.get('/profile', protect, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }
    res.json({
      success: true,
      user
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to fetch profile'
    });
  }
});

// Update user profile
router.put('/profile', protect, async (req, res) => {
  try {
    const { name, mobile, company, fleet, address, city, gstNumber, panNumber, bankDetails, signature } = req.body;
    const updates = {};

    if (name) updates.name = name.trim();
    if (mobile) updates.mobile = mobile.replace(/\D/g, '');
    if (company) updates.company = company.trim();
    if (fleet) updates.fleet = fleet;
    if (address !== undefined) updates.address = address.trim();
    if (city !== undefined) updates.city = city.trim();
    if (gstNumber !== undefined) updates.gstNumber = gstNumber.trim();
    if (panNumber !== undefined) updates.panNumber = panNumber.trim();
    if (bankDetails && typeof bankDetails === 'object') {
      updates.bankDetails = {
        accountName: String(bankDetails.accountName || '').trim(),
        accountNumber: String(bankDetails.accountNumber || '').trim(),
        bankName: String(bankDetails.bankName || '').trim(),
        ifscCode: String(bankDetails.ifscCode || '').trim(),
        branchName: String(bankDetails.branchName || '').trim()
      };
    }

    if (signature !== undefined) {
      if (signature === null || signature.dataUrl === '') {
        // Explicit removal — clears the mark but keeps the field present.
        updates.signature = { dataUrl: '', signatoryName: '', updatedAt: new Date() };
      } else if (typeof signature === 'object') {
        const parsed = parseSignatureDataUrl(signature.dataUrl);
        if (parsed.error) {
          return res.status(400).json({ success: false, error: parsed.error });
        }
        updates.signature = {
          dataUrl: parsed.dataUrl,
          signatoryName: String(signature.signatoryName || '').trim(),
          updatedAt: new Date()
        };
      }
    }

    const user = await User.findByIdAndUpdate(
      req.user.id,
      updates,
      { new: true, runValidators: true }
    );

    res.json({
      success: true,
      message: 'Profile updated successfully',
      user
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to update profile'
    });
  }
});

// Change password
router.post('/change-password', protect, async (req, res) => {
  try {
    const { currentPassword, newPassword, confirmPassword } = req.body;

    if (!currentPassword || !newPassword || !confirmPassword) {
      return res.status(400).json({
        success: false,
        error: 'All password fields are required'
      });
    }

    if (newPassword !== confirmPassword) {
      return res.status(400).json({
        success: false,
        error: 'New passwords do not match'
      });
    }

    if (newPassword.length < 8) {
      return res.status(400).json({
        success: false,
        error: 'New password must be at least 8 characters'
      });
    }

    const user = await User.findById(req.user.id).select('+password');

    const isPasswordValid = await user.matchPassword(currentPassword);
    if (!isPasswordValid) {
      return res.status(401).json({
        success: false,
        error: 'Current password is incorrect'
      });
    }

    user.password = newPassword;
    await user.save();

    res.json({
      success: true,
      message: 'Password changed successfully'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to change password'
    });
  }
});

export default router;
