import express from 'express';
import Customer, { PAYMENT_TERMS, CUSTOMER_STATUSES } from '../models/Customer.js';
import TripOrder from '../models/TripOrder.js';
import { protect, requirePermission } from '../middleware/auth.js';
import { auditCreate, auditUpdate, auditDelete } from '../utils/audit.js';
import { ACTIVE_STATUSES } from '../utils/tripOrders.js';

const router = express.Router();

// Every customer belongs to the caller's account, exactly like trucks and
// drivers. Scoped on every query rather than filtered afterwards.
const ownedBy = (req) => ({ owner: req.accountId });

const str = (v) => String(v ?? '').trim();

// Builds the address subdocument from a form payload.
const cleanAddress = (input = {}) => ({
  line1: str(input.line1),
  line2: str(input.line2),
  city: str(input.city),
  state: str(input.state),
  pincode: str(input.pincode),
  country: str(input.country) || 'India'
});

// Contacts, with the primary flag reduced to at most one — the same rule
// Driver.isPrimary follows. The first one marked wins; the rest are cleared,
// so a payload with three primaries stores a coherent record rather than
// being rejected over something the UI can simply normalise.
const cleanContacts = (input) => {
  if (!Array.isArray(input)) return undefined;
  let primaryTaken = false;

  return input
    .map((c) => {
      const isPrimary = Boolean(c?.isPrimary) && !primaryTaken;
      if (isPrimary) primaryTaken = true;
      return {
        name: str(c?.name),
        designation: str(c?.designation),
        mobile: str(c?.mobile),
        email: str(c?.email).toLowerCase(),
        isPrimary
      };
    })
    // A row with nothing in it is what an untouched "add contact" line looks
    // like; storing it would leave blank rows on the customer forever.
    .filter((c) => c.name || c.mobile || c.email);
};

// A short code derived from the trading name when the operator did not supply
// one — "Acme Logistics Pvt Ltd" becomes "ACMELOGI". Uniqueness is settled by
// the caller, which appends a counter if this collides.
const deriveCode = (name) =>
  str(name)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 8) || 'CUST';

// Finds a code not already used in this account, starting from `base`.
const uniqueCode = async (accountId, base, excludeId = null) => {
  const root = base.slice(0, 8);
  for (let i = 0; i < 100; i++) {
    const candidate = i === 0 ? root : `${root.slice(0, 6)}${i}`;
    const clash = await Customer.findOne({
      owner: accountId,
      code: candidate,
      ...(excludeId ? { _id: { $ne: excludeId } } : {})
    }).select('_id');
    if (!clash) return candidate;
  }
  // Falls back to something guaranteed distinct rather than failing the save
  // over a cosmetic field.
  return `${root.slice(0, 4)}${Date.now().toString().slice(-4)}`;
};

const buildFields = (body = {}) => {
  const fields = {};
  if (body.name !== undefined) fields.name = str(body.name);
  if (body.legalName !== undefined) fields.legalName = str(body.legalName);
  if (body.gstin !== undefined) fields.gstin = str(body.gstin).toUpperCase();
  if (body.pan !== undefined) fields.pan = str(body.pan).toUpperCase();
  if (body.notes !== undefined) fields.notes = str(body.notes);

  if (body.paymentTerms !== undefined && PAYMENT_TERMS.includes(body.paymentTerms)) {
    fields.paymentTerms = body.paymentTerms;
  }
  if (body.status !== undefined && CUSTOMER_STATUSES.includes(body.status)) {
    fields.status = body.status;
  }
  if (body.creditLimit !== undefined) {
    const n = Number(body.creditLimit);
    fields.creditLimit = Number.isFinite(n) && n >= 0 ? n : null;
  }
  if (body.gstRate !== undefined) {
    const n = Number(body.gstRate);
    fields.gstRate = Number.isFinite(n) && n >= 0 && n <= 100 ? n : 0;
  }

  if (body.billingAddress !== undefined) fields.billingAddress = cleanAddress(body.billingAddress);
  if (body.shippingAddress !== undefined) {
    fields.shippingAddress = cleanAddress(body.shippingAddress);
  }

  const contacts = cleanContacts(body.contacts);
  if (contacts !== undefined) fields.contacts = contacts;

  return fields;
};

// The vocabulary the customer form renders from.
router.get('/options', protect, (req, res) => {
  res.json({ success: true, paymentTerms: PAYMENT_TERMS, statuses: CUSTOMER_STATUSES });
});

// GET /api/customers — the account's customers. `search` powers the picker on
// the trip form; `status` filters the master list.
router.get('/', protect, requirePermission('customers', 'read'), async (req, res) => {
  try {
    const query = ownedBy(req);

    if (req.query.status && CUSTOMER_STATUSES.includes(req.query.status)) {
      query.status = req.query.status;
    }

    const search = str(req.query.search);
    if (search) {
      // Escaped before it reaches the regex: a customer name legitimately
      // contains characters like "(" and "." that would otherwise be parsed as
      // pattern syntax and either throw or match the wrong rows.
      const safe = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const rx = new RegExp(safe, 'i');
      query.$or = [{ name: rx }, { legalName: rx }, { code: rx }, { gstin: rx }];
    }

    const customers = await Customer.find(query).sort({ name: 1 }).lean();
    res.json({ success: true, customers });
  } catch (error) {
    console.error('[customers] list failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to fetch customers' });
  }
});

// GET /api/customers/:id — one customer, with a small trip summary so the
// detail view can show the relationship rather than just the master record.
router.get('/:id', protect, requirePermission('customers', 'read'), async (req, res) => {
  try {
    const customer = await Customer.findOne({ _id: req.params.id, ...ownedBy(req) }).lean();
    if (!customer) return res.status(404).json({ success: false, error: 'Customer not found' });

    const [tripCount, activeCount, recentTrips] = await Promise.all([
      TripOrder.countDocuments({ owner: req.accountId, customer: customer._id }),
      TripOrder.countDocuments({
        owner: req.accountId,
        customer: customer._id,
        status: { $in: ACTIVE_STATUSES }
      }),
      TripOrder.find({ owner: req.accountId, customer: customer._id })
        .sort({ tripDate: -1 })
        .limit(10)
        .select('tripNumber tripDate status totals pickup.city destination.city')
        .lean()
    ]);

    res.json({
      success: true,
      customer,
      summary: { tripCount, activeCount },
      recentTrips
    });
  } catch (error) {
    console.error('[customers] fetch failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to fetch customer' });
  }
});

// POST /api/customers
router.post('/', protect, requirePermission('customers', 'create'), async (req, res) => {
  try {
    const fields = buildFields(req.body);

    if (!fields.name) {
      return res.status(400).json({ success: false, error: 'Customer name is required' });
    }

    const requested = str(req.body.code).toUpperCase();
    fields.code = await uniqueCode(req.accountId, requested || deriveCode(fields.name));

    const customer = await Customer.create({ ...fields, owner: req.accountId });

    await auditCreate(req, {
      entity: 'customer',
      doc: customer,
      label: customer.name,
      fields: ['name', 'legalName', 'code', 'gstin', 'pan', 'paymentTerms', 'creditLimit', 'status']
    });

    res.status(201).json({ success: true, customer });
  } catch (error) {
    console.error('[customers] create failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to create customer' });
  }
});

// PUT /api/customers/:id
router.put('/:id', protect, requirePermission('customers', 'update'), async (req, res) => {
  try {
    const existing = await Customer.findOne({ _id: req.params.id, ...ownedBy(req) });
    if (!existing) return res.status(404).json({ success: false, error: 'Customer not found' });

    const fields = buildFields(req.body);

    if (fields.name !== undefined && !fields.name) {
      return res.status(400).json({ success: false, error: 'Customer name is required' });
    }

    // Only re-derive the code when the operator actually sent one; an existing
    // customer keeps the code the office already prints on its paperwork.
    const requested = str(req.body.code).toUpperCase();
    if (requested && requested !== existing.code) {
      fields.code = await uniqueCode(req.accountId, requested, existing._id);
    }

    const customer = await Customer.findOneAndUpdate(
      { _id: req.params.id, ...ownedBy(req) },
      { $set: fields },
      { new: true, runValidators: true }
    );

    await auditUpdate(req, {
      entity: 'customer',
      before: existing,
      after: customer,
      fields,
      label: customer.name
    });

    res.json({ success: true, customer });
  } catch (error) {
    console.error('[customers] update failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to update customer' });
  }
});

// DELETE /api/customers/:id — refused while trips still point at the customer.
// Removing it would leave those trips with a dangling reference and no way to
// say who the job was for; the customer is marked Inactive instead.
router.delete('/:id', protect, requirePermission('customers', 'delete'), async (req, res) => {
  try {
    const inUse = await TripOrder.countDocuments({
      owner: req.accountId,
      customer: req.params.id
    });

    if (inUse > 0) {
      return res.status(409).json({
        success: false,
        error: `This customer is on ${inUse} trip${inUse === 1 ? '' : 's'} and cannot be deleted. Mark them Inactive instead.`
      });
    }

    const customer = await Customer.findOneAndDelete({ _id: req.params.id, ...ownedBy(req) });
    if (!customer) return res.status(404).json({ success: false, error: 'Customer not found' });

    await auditDelete(req, {
      entity: 'customer',
      doc: customer,
      label: customer.name,
      fields: ['name', 'legalName', 'code', 'gstin', 'pan', 'paymentTerms', 'status']
    });

    res.json({ success: true, message: 'Customer removed' });
  } catch (error) {
    console.error('[customers] delete failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to delete customer' });
  }
});

export default router;
