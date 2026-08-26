import express from 'express';
import Company from '../models/Company.js';
import { protect, requirePermission } from '../middleware/auth.js';
import { parseImageDataUrl } from '../utils/images.js';

const router = express.Router();

// Scoped to the account, not the caller: a Fleet Manager and the admin who
// added them read and write the same company master.
const ownedBy = (req) => ({ owner: req.accountId });

// Logos print at the top of every document, so they can afford a little more
// room than a signature mark.
const MAX_LOGO_BYTES = 500 * 1024;

// A permissive check — the full IANA list is not worth shipping, but a value
// the runtime cannot resolve would silently break every rendered timestamp.
const isValidTimezone = (tz) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

const readContacts = (value) => {
  if (!Array.isArray(value)) return undefined;
  return value
    .map((c) => ({
      name: String(c?.name || '').trim(),
      designation: String(c?.designation || '').trim(),
      phone: String(c?.phone || '').replace(/\D/g, ''),
      email: String(c?.email || '').trim().toLowerCase(),
      isPrimary: Boolean(c?.isPrimary)
    }))
    // Blank rows are what an untouched "add another contact" field looks like;
    // drop them rather than failing the whole save on a required-name error.
    .filter((c) => c.name || c.phone || c.email);
};

// Builds a Company-shaped update from the request body, including only fields
// that were actually sent so a partial save never blanks the rest.
// Returns { fields } or { error } for the caller to surface as a 400.
const buildCompanyFields = (body) => {
  const fields = {};

  if (body.name !== undefined) fields.name = String(body.name).trim();
  if (body.legalName !== undefined) fields.legalName = String(body.legalName).trim();
  if (body.gstin !== undefined) fields.gstin = String(body.gstin).trim().toUpperCase();
  if (body.pan !== undefined) fields.pan = String(body.pan).trim().toUpperCase();

  if (body.address && typeof body.address === 'object') {
    fields.address = {
      line1: String(body.address.line1 || '').trim(),
      line2: String(body.address.line2 || '').trim(),
      city: String(body.address.city || '').trim(),
      state: String(body.address.state || '').trim(),
      pincode: String(body.address.pincode || '').replace(/\D/g, ''),
      country: String(body.address.country || 'India').trim()
    };
  }

  const contacts = readContacts(body.contacts);
  if (contacts !== undefined) fields.contacts = contacts;

  if (body.timezone !== undefined) {
    const tz = String(body.timezone).trim();
    if (!tz || !isValidTimezone(tz)) {
      return { error: 'Timezone must be a valid IANA zone name, e.g. Asia/Kolkata' };
    }
    fields.timezone = tz;
  }

  if (body.status !== undefined) {
    const status = String(body.status).trim().toLowerCase();
    if (!['active', 'inactive'].includes(status)) {
      return { error: 'Status must be either active or inactive' };
    }
    fields.status = status;
  }

  if (body.logo !== undefined) {
    if (body.logo === null || body.logo?.dataUrl === '') {
      // Explicit removal — clears the image but keeps the field present.
      fields.logo = { dataUrl: '', updatedAt: new Date() };
    } else if (typeof body.logo === 'object') {
      const parsed = parseImageDataUrl(body.logo.dataUrl, { label: 'Logo', maxBytes: MAX_LOGO_BYTES });
      if (parsed.error) return { error: parsed.error };
      fields.logo = { dataUrl: parsed.dataUrl, updatedAt: new Date() };
    }
  }

  return { fields };
};

// GET /api/companies — the caller's company master. Returns company: null
// rather than 404 when none exists yet, so the Settings page can render an
// empty form instead of treating a first-time account as an error.
router.get('/', protect, requirePermission('company', 'read'), async (req, res) => {
  try {
    const company = await Company.findOne(ownedBy(req));
    res.json({ success: true, company });
  } catch (error) {
    console.error('[companies] fetch failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to fetch company' });
  }
});

// POST /api/companies — create the caller's company master. One per account:
// if it already exists this is a conflict, not a second record.
router.post('/', protect, requirePermission('company', 'create'), async (req, res) => {
  try {
    const existing = await Company.findOne(ownedBy(req));
    if (existing) {
      return res.status(409).json({
        success: false,
        error: 'Company already exists for this account. Use PUT to update it.'
      });
    }

    const { fields, error } = buildCompanyFields(req.body || {});
    if (error) return res.status(400).json({ success: false, error });
    if (!fields.name) {
      return res.status(400).json({ success: false, error: 'Company name is required' });
    }

    const company = await Company.create({ ...fields, owner: req.accountId });
    res.status(201).json({ success: true, company });
  } catch (error) {
    if (error.name === 'ValidationError') {
      return res.status(400).json({ success: false, error: error.message });
    }
    // The unique index on owner is the last line of defence against two
    // concurrent first-time saves racing past the check above.
    if (error.code === 11000) {
      return res.status(409).json({ success: false, error: 'Company already exists for this account' });
    }
    console.error('[companies] create failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to create company' });
  }
});

// PUT /api/companies — update the caller's company master, creating it on the
// first save so the Settings form does not have to know which verb it needs.
router.put('/', protect, requirePermission('company', 'update'), async (req, res) => {
  try {
    const { fields, error } = buildCompanyFields(req.body || {});
    if (error) return res.status(400).json({ success: false, error });

    let company = await Company.findOne(ownedBy(req));

    if (!company) {
      if (!fields.name) {
        return res.status(400).json({ success: false, error: 'Company name is required' });
      }
      company = new Company({ ...fields, owner: req.accountId });
    } else {
      if (fields.name === '') {
        return res.status(400).json({ success: false, error: 'Company name is required' });
      }
      // Assigned rather than passed to findOneAndUpdate so the pre-validate
      // primary-contact hook and the subdocument validators both run.
      Object.assign(company, fields);
    }

    await company.save();
    res.json({ success: true, message: 'Company saved successfully', company });
  } catch (error) {
    if (error.name === 'ValidationError') {
      return res.status(400).json({ success: false, error: error.message });
    }
    console.error('[companies] update failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to save company' });
  }
});

// DELETE /api/companies — remove the caller's company master. Documents fall
// back to the User profile afterwards, so this never leaves them unrenderable.
router.delete('/', protect, requirePermission('company', 'delete'), async (req, res) => {
  try {
    const company = await Company.findOneAndDelete(ownedBy(req));
    if (!company) return res.status(404).json({ success: false, error: 'Company not found' });
    res.json({ success: true, message: 'Company removed' });
  } catch (error) {
    console.error('[companies] delete failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to delete company' });
  }
});

export default router;
