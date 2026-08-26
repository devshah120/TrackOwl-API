import express from 'express';
import User from '../models/User.js';
import { protect } from '../middleware/auth.js';
import { parseImageDataUrl } from '../utils/images.js';

const router = express.Router();

// The signature rides through the same PNG/JPEG check as the company logo —
// PDFKit's image() understands nothing else, and a bad payload is better
// caught here than mid-download.
const MAX_SIGNATURE_BYTES = 400 * 1024;

const parseSignatureDataUrl = (value) =>
  parseImageDataUrl(value, { label: 'Signature', maxBytes: MAX_SIGNATURE_BYTES });

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
