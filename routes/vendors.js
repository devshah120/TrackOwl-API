import express from 'express';
import mongoose from 'mongoose';
import Vendor, { VENDOR_CATEGORIES, VENDOR_CATEGORY_LABELS, VENDOR_STATUSES } from '../models/Vendor.js';
import VendorBill, {
  EXPENSE_HEADS,
  EXPENSE_HEAD_LABELS,
  PAYABLE_ONLY_HEADS,
  VENDOR_BILL_STATUSES,
  VENDOR_PAYMENT_MODES
} from '../models/VendorBill.js';
import Truck from '../models/Truck.js';
import { protect, requirePermission } from '../middleware/auth.js';
import { auditCreate, auditUpdate, auditDelete, recordAudit } from '../utils/audit.js';
import { validateDataUrl } from '../utils/tripOrderFields.js';

// Vendors and their bills — the payables side. On the `ledger` permission
// resource: the Accountant holds ledger:* and owns it, a Fleet Manager
// (ledger:read + create) can add a workshop bill but not delete one.

const router = express.Router();

const ownedBy = (req) => ({ owner: req.accountId });
const isId = (v) => mongoose.Types.ObjectId.isValid(v);
const money = (n) => Math.round((Number(n) || 0) * 100) / 100;
const str = (v) => String(v ?? '').trim();
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const dateOrNull = (v) => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

const startOfToday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
};

const applyBillTotals = (bill) => {
  bill.paid = money((bill.payments || []).reduce((s, p) => s + p.amount, 0));
  bill.balance = money(bill.total - bill.paid);
  if (bill.status !== 'cancelled') {
    bill.status = bill.balance <= 0.5 ? 'paid' : bill.paid > 0 ? 'partially_paid' : 'unpaid';
  }
  return bill;
};

const withDerived = (bill) => {
  const plain = bill.toObject ? bill.toObject() : bill;
  const overdue = ['unpaid', 'partially_paid'].includes(plain.status) && plain.balance > 0.5 && new Date(plain.dueDate) < startOfToday();
  const { attachment, ...rest } = plain;
  return { ...rest, overdue, hasAttachment: Boolean(attachment?.dataUrl) };
};

const vendorFields = (body = {}) => {
  const out = {};
  const set = (key, value) => {
    if (body[key] !== undefined) out[key] = value;
  };
  set('name', str(body.name));
  set('category', VENDOR_CATEGORIES.includes(body.category) ? body.category : 'other');
  set('contactName', str(body.contactName));
  set('mobile', str(body.mobile).replace(/[^\d+]/g, ''));
  set('email', str(body.email).toLowerCase());
  set('gstin', str(body.gstin).toUpperCase());
  set('pan', str(body.pan).toUpperCase());
  set('status', VENDOR_STATUSES.includes(body.status) ? body.status : 'Active');
  set('notes', str(body.notes));
  if (body.creditDays !== undefined) out.creditDays = Math.max(0, Math.min(365, Number(body.creditDays) || 0));
  if (body.address !== undefined) {
    const a = body.address || {};
    out.address = { line1: str(a.line1), city: str(a.city), state: str(a.state), pincode: str(a.pincode) };
  }
  if (body.bank !== undefined) {
    const b = body.bank || {};
    out.bank = { accountName: str(b.accountName), accountNumber: str(b.accountNumber), ifsc: str(b.ifsc).toUpperCase(), upi: str(b.upi) };
  }
  return out;
};

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

router.get('/options', protect, requirePermission('ledger', 'read'), (req, res) => {
  res.json({
    success: true,
    categories: VENDOR_CATEGORIES.map((value) => ({ value, label: VENDOR_CATEGORY_LABELS[value] })),
    statuses: VENDOR_STATUSES,
    expenseHeads: EXPENSE_HEADS.map((value) => ({
      value,
      label: EXPENSE_HEAD_LABELS[value],
      payableOnly: PAYABLE_ONLY_HEADS.includes(value)
    })),
    billStatuses: VENDOR_BILL_STATUSES,
    paymentModes: VENDOR_PAYMENT_MODES
  });
});

// ---------------------------------------------------------------------------
// Bills (declared before /:id so "bills" is not read as a vendor id)
// ---------------------------------------------------------------------------

router.get('/bills', protect, requirePermission('ledger', 'read'), async (req, res) => {
  try {
    const { vendor, status, head, from, to, truck } = req.query;
    const filter = { ...ownedBy(req) };
    if (isId(vendor)) filter.vendor = vendor;
    if (isId(truck)) filter.truck = truck;
    if (EXPENSE_HEADS.includes(head)) filter.expenseHead = head;
    if (status === 'outstanding') filter.status = { $in: ['unpaid', 'partially_paid'] };
    else if (status === 'overdue') {
      filter.status = { $in: ['unpaid', 'partially_paid'] };
      filter.dueDate = { $lt: startOfToday() };
    } else if (VENDOR_BILL_STATUSES.includes(status)) filter.status = status;
    if (from || to) {
      filter.billDate = {};
      if (dateOrNull(from)) filter.billDate.$gte = dateOrNull(from);
      if (dateOrNull(to)) {
        const end = new Date(to);
        end.setHours(23, 59, 59, 999);
        filter.billDate.$lte = end;
      }
    }
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 25));

    const [bills, total, sums] = await Promise.all([
      VendorBill.find(filter)
        .select('-attachment.dataUrl')
        .sort({ billDate: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate('vendor', 'name category')
        .populate('truck', 'number')
        .lean(),
      VendorBill.countDocuments(filter),
      VendorBill.aggregate([
        { $match: { ...filter, status: filter.status || { $ne: 'cancelled' } } },
        { $group: { _id: null, total: { $sum: '$total' }, paid: { $sum: '$paid' }, balance: { $sum: '$balance' } } }
      ])
    ]);

    res.json({
      success: true,
      bills: bills.map(withDerived),
      total,
      page,
      pages: Math.ceil(total / limit) || 1,
      sums: sums[0] ? { total: money(sums[0].total), paid: money(sums[0].paid), balance: money(sums[0].balance) } : { total: 0, paid: 0, balance: 0 }
    });
  } catch (error) {
    console.error('[vendors] bill list failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to load vendor bills' });
  }
});

const buildBill = async (req, body, vendor) => {
  const amount = money(body.amount);
  const gstAmount = money(body.gstAmount);
  if (!(amount > 0)) return { error: 'Enter the bill amount' };
  if (gstAmount < 0) return { error: 'GST cannot be negative' };
  const billDate = dateOrNull(body.billDate) || new Date();
  const dueDate = dateOrNull(body.dueDate) || new Date(billDate.getTime() + (vendor.creditDays || 0) * 86400000);
  if (dueDate < new Date(billDate.toDateString())) return { error: 'The due date cannot be before the bill date' };

  let truck = null;
  if (isId(body.truck)) {
    const owned = await Truck.findOne({ _id: body.truck, ...ownedBy(req) }).select('_id').lean();
    if (!owned) return { error: 'Vehicle not found' };
    truck = owned._id;
  }

  let attachment;
  if (body.attachment?.dataUrl) {
    const problem = validateDataUrl(body.attachment.dataUrl, { label: 'bill copy' });
    if (problem) return { error: problem };
    attachment = { dataUrl: String(body.attachment.dataUrl), filename: str(body.attachment.filename), mimeType: str(body.attachment.mimeType) };
  }

  return {
    fields: {
      billNumber: str(body.billNumber),
      billDate,
      dueDate,
      expenseHead: EXPENSE_HEADS.includes(body.expenseHead) ? body.expenseHead : 'other',
      description: str(body.description),
      truck,
      tripOrder: isId(body.tripOrder) ? body.tripOrder : null,
      amount,
      gstAmount,
      total: money(amount + gstAmount),
      notes: str(body.notes),
      ...(attachment ? { attachment } : {})
    }
  };
};

router.post('/bills', protect, requirePermission('ledger', 'create'), async (req, res) => {
  try {
    const body = req.body || {};
    const vendor = isId(body.vendor) && (await Vendor.findOne({ _id: body.vendor, ...ownedBy(req) }).lean());
    if (!vendor) return res.status(400).json({ success: false, error: 'Choose a vendor' });

    const { fields, error } = await buildBill(req, body, vendor);
    if (error) return res.status(400).json({ success: false, error });

    // The same bill number from the same vendor is almost always the same
    // paper entered twice.
    if (fields.billNumber) {
      const dup = await VendorBill.findOne({ ...ownedBy(req), vendor: vendor._id, billNumber: fields.billNumber, status: { $ne: 'cancelled' } }).select('_id').lean();
      if (dup && !body.confirmDuplicate) {
        return res.status(409).json({ success: false, duplicate: true, error: `Bill ${fields.billNumber} from ${vendor.name} is already recorded` });
      }
    }

    const bill = new VendorBill({ ...fields, owner: req.accountId, vendor: vendor._id, createdBy: req.user._id });
    applyBillTotals(bill);
    await bill.save();
    await auditCreate(req, {
      entity: 'vendor_bill',
      doc: bill,
      label: `${vendor.name}${bill.billNumber ? ` #${bill.billNumber}` : ''}`,
      fields: ['billNumber', 'billDate', 'dueDate', 'expenseHead', 'amount', 'gstAmount', 'total']
    });
    res.status(201).json({ success: true, message: 'Bill recorded', bill: withDerived(bill) });
  } catch (error) {
    if (error.name === 'ValidationError') return res.status(400).json({ success: false, error: error.message });
    console.error('[vendors] bill create failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to record bill' });
  }
});

router.put('/bills/:id', protect, requirePermission('ledger', 'update'), async (req, res) => {
  try {
    const bill = isId(req.params.id) && (await VendorBill.findOne({ _id: req.params.id, ...ownedBy(req) }));
    if (!bill) return res.status(404).json({ success: false, error: 'Bill not found' });
    if (bill.status === 'cancelled') return res.status(409).json({ success: false, error: 'A cancelled bill cannot be edited' });
    const vendor = await Vendor.findOne({ _id: bill.vendor, ...ownedBy(req) }).lean();
    const { fields, error } = await buildBill(req, { ...req.body, vendor: bill.vendor }, vendor || {});
    if (error) return res.status(400).json({ success: false, error });
    if (fields.total < bill.paid) {
      return res.status(400).json({ success: false, error: `₹${bill.paid} has already been paid — the bill total cannot be less than that` });
    }
    const before = bill.toObject();
    Object.assign(bill, fields, { updatedAt: new Date() });
    applyBillTotals(bill);
    await bill.save();
    await auditUpdate(req, { entity: 'vendor_bill', before, after: bill, fields, label: bill.billNumber || vendor?.name || 'Bill' });
    res.json({ success: true, message: 'Bill updated', bill: withDerived(bill) });
  } catch (error) {
    console.error('[vendors] bill update failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to update bill' });
  }
});

router.post('/bills/:id/payments', protect, requirePermission('ledger', 'update'), async (req, res) => {
  try {
    const bill = isId(req.params.id) && (await VendorBill.findOne({ _id: req.params.id, ...ownedBy(req) }));
    if (!bill) return res.status(404).json({ success: false, error: 'Bill not found' });
    if (bill.status === 'cancelled') return res.status(409).json({ success: false, error: 'A cancelled bill cannot be paid' });
    const body = req.body || {};
    const amount = money(body.amount);
    if (!(amount > 0)) return res.status(400).json({ success: false, error: 'Enter an amount greater than zero' });
    if (amount > bill.balance + 0.5) {
      return res.status(400).json({ success: false, error: `₹${amount} is more than the ₹${bill.balance} due on this bill` });
    }
    const reference = str(body.reference);
    const twin = bill.payments.find((p) => p.amount === amount && (p.reference || '') === reference && Date.now() - new Date(p.createdAt).getTime() < 120000);
    if (twin && !body.confirmDuplicate) {
      return res.status(409).json({ success: false, duplicate: true, error: `A payment of ₹${amount} was just recorded. Submit again only if this is a second payment.` });
    }
    bill.payments.push({
      date: dateOrNull(body.date) || new Date(),
      amount,
      mode: VENDOR_PAYMENT_MODES.includes(body.mode) ? body.mode : 'Bank Transfer',
      reference,
      notes: str(body.notes),
      createdBy: req.user._id
    });
    applyBillTotals(bill);
    bill.updatedAt = new Date();
    await bill.save();
    await recordAudit(req, {
      entity: 'vendor_bill',
      entityId: bill._id,
      action: 'update',
      label: bill.billNumber || 'Bill',
      summary: `Paid ₹${amount} against vendor bill ${bill.billNumber || ''} — balance ₹${bill.balance}`,
      changes: [{ field: 'paid', label: 'Paid', from: money(bill.paid - amount), to: bill.paid }]
    });
    res.status(201).json({ success: true, bill: withDerived(bill) });
  } catch (error) {
    console.error('[vendors] bill payment failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to record payment' });
  }
});

router.delete('/bills/:id/payments/:paymentId', protect, requirePermission('ledger', 'update'), async (req, res) => {
  try {
    const bill = isId(req.params.id) && (await VendorBill.findOne({ _id: req.params.id, ...ownedBy(req) }));
    if (!bill) return res.status(404).json({ success: false, error: 'Bill not found' });
    const payment = bill.payments.id(req.params.paymentId);
    if (!payment) return res.status(404).json({ success: false, error: 'Payment not found' });
    const { amount } = payment;
    payment.deleteOne();
    applyBillTotals(bill);
    bill.updatedAt = new Date();
    await bill.save();
    await recordAudit(req, {
      entity: 'vendor_bill',
      entityId: bill._id,
      action: 'update',
      label: bill.billNumber || 'Bill',
      summary: `Payment of ₹${amount} removed from vendor bill ${bill.billNumber || ''}`,
      changes: [{ field: 'payments', label: 'Payment', from: amount, to: null }]
    });
    res.json({ success: true, bill: withDerived(bill) });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to remove payment' });
  }
});

router.get('/bills/:id/attachment', protect, requirePermission('ledger', 'read'), async (req, res) => {
  const bill = isId(req.params.id) && (await VendorBill.findOne({ _id: req.params.id, ...ownedBy(req) }).select('attachment').lean());
  if (!bill?.attachment?.dataUrl) return res.status(404).json({ success: false, error: 'No bill copy attached' });
  res.json({ success: true, attachment: bill.attachment });
});

router.delete('/bills/:id', protect, requirePermission('ledger', 'delete'), async (req, res) => {
  try {
    const bill = isId(req.params.id) && (await VendorBill.findOne({ _id: req.params.id, ...ownedBy(req) }));
    if (!bill) return res.status(404).json({ success: false, error: 'Bill not found' });
    if (bill.payments.length) {
      return res.status(409).json({ success: false, error: 'Remove the payments recorded against this bill first' });
    }
    await VendorBill.deleteOne({ _id: bill._id });
    await auditDelete(req, { entity: 'vendor_bill', doc: bill, label: bill.billNumber || 'Bill', fields: ['billNumber', 'billDate', 'expenseHead', 'total'] });
    res.json({ success: true, message: 'Bill deleted' });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to delete bill' });
  }
});

// ---------------------------------------------------------------------------
// Vendors
// ---------------------------------------------------------------------------

router.get('/', protect, requirePermission('ledger', 'read'), async (req, res) => {
  try {
    const filter = { ...ownedBy(req) };
    if (VENDOR_CATEGORIES.includes(req.query.category)) filter.category = req.query.category;
    if (VENDOR_STATUSES.includes(req.query.status)) filter.status = req.query.status;
    if (req.query.q) filter.name = new RegExp(escapeRegex(req.query.q), 'i');

    const vendors = await Vendor.find(filter).sort({ name: 1 }).lean();
    // Outstanding per vendor in one aggregate rather than one query each.
    const balances = await VendorBill.aggregate([
      { $match: { owner: new mongoose.Types.ObjectId(String(req.accountId)), status: { $ne: 'cancelled' } } },
      { $group: { _id: '$vendor', billed: { $sum: '$total' }, paid: { $sum: '$paid' }, balance: { $sum: '$balance' }, bills: { $sum: 1 } } }
    ]);
    const byVendor = new Map(balances.map((b) => [String(b._id), b]));

    res.json({
      success: true,
      vendors: vendors.map((v) => {
        const b = byVendor.get(String(v._id));
        return { ...v, billed: money(b?.billed), paid: money(b?.paid), balance: money(b?.balance), bills: b?.bills || 0 };
      })
    });
  } catch (error) {
    console.error('[vendors] list failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to load vendors' });
  }
});

router.get('/:id', protect, requirePermission('ledger', 'read'), async (req, res) => {
  try {
    const vendor = isId(req.params.id) && (await Vendor.findOne({ _id: req.params.id, ...ownedBy(req) }).lean());
    if (!vendor) return res.status(404).json({ success: false, error: 'Vendor not found' });
    const bills = await VendorBill.find({ ...ownedBy(req), vendor: vendor._id })
      .select('-attachment.dataUrl')
      .sort({ billDate: -1 })
      .populate('truck', 'number')
      .lean();
    const live = bills.filter((b) => b.status !== 'cancelled');
    res.json({
      success: true,
      vendor,
      bills: bills.map(withDerived),
      totals: {
        billed: money(live.reduce((s, b) => s + b.total, 0)),
        paid: money(live.reduce((s, b) => s + b.paid, 0)),
        balance: money(live.reduce((s, b) => s + b.balance, 0))
      }
    });
  } catch (error) {
    console.error('[vendors] read failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to load vendor' });
  }
});

router.post('/', protect, requirePermission('ledger', 'create'), async (req, res) => {
  try {
    const fields = vendorFields(req.body);
    if (!fields.name) return res.status(400).json({ success: false, error: 'Vendor name is required' });
    const vendor = await Vendor.create({ ...fields, owner: req.accountId });
    await auditCreate(req, { entity: 'vendor', doc: vendor, label: vendor.name, fields: ['name', 'category', 'mobile', 'gstin', 'creditDays'] });
    res.status(201).json({ success: true, message: `${vendor.name} added`, vendor });
  } catch (error) {
    if (error.name === 'ValidationError') return res.status(400).json({ success: false, error: error.message });
    console.error('[vendors] create failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to add vendor' });
  }
});

router.put('/:id', protect, requirePermission('ledger', 'update'), async (req, res) => {
  try {
    const before = isId(req.params.id) && (await Vendor.findOne({ _id: req.params.id, ...ownedBy(req) }).lean());
    if (!before) return res.status(404).json({ success: false, error: 'Vendor not found' });
    const fields = vendorFields(req.body);
    if (fields.name === '') return res.status(400).json({ success: false, error: 'Vendor name cannot be empty' });
    const vendor = await Vendor.findOneAndUpdate({ _id: before._id, ...ownedBy(req) }, { $set: fields }, { new: true, runValidators: true });
    await auditUpdate(req, { entity: 'vendor', before, after: vendor, fields, label: vendor.name });
    res.json({ success: true, message: 'Vendor updated', vendor });
  } catch (error) {
    if (error.name === 'ValidationError') return res.status(400).json({ success: false, error: error.message });
    res.status(500).json({ success: false, error: 'Failed to update vendor' });
  }
});

router.delete('/:id', protect, requirePermission('ledger', 'delete'), async (req, res) => {
  try {
    const vendor = isId(req.params.id) && (await Vendor.findOne({ _id: req.params.id, ...ownedBy(req) }));
    if (!vendor) return res.status(404).json({ success: false, error: 'Vendor not found' });
    const bills = await VendorBill.countDocuments({ ...ownedBy(req), vendor: vendor._id });
    if (bills) {
      return res.status(409).json({ success: false, error: `${vendor.name} has ${bills} bill(s). Mark the vendor Inactive instead of deleting it.` });
    }
    await Vendor.deleteOne({ _id: vendor._id });
    await auditDelete(req, { entity: 'vendor', doc: vendor, label: vendor.name, fields: ['name', 'category'] });
    res.json({ success: true, message: `${vendor.name} deleted` });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to delete vendor' });
  }
});

export default router;
