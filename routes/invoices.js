import express from 'express';
import mongoose from 'mongoose';
import Invoice, {
  INVOICE_STATUSES,
  INVOICE_STATUS_LABELS,
  INVOICE_LINE_KINDS,
  GST_MODES,
  ADJUSTMENT_KINDS,
  ADJUSTMENT_LABELS,
  RECEIPT_MODES
} from '../models/Invoice.js';
import InvoiceSetting from '../models/InvoiceSetting.js';
import Customer from '../models/Customer.js';
import Company from '../models/Company.js';
import User from '../models/User.js';
import TripOrder from '../models/TripOrder.js';
import { protect, requirePermission } from '../middleware/auth.js';
import { hasPermission } from '../utils/permissions.js';
import { auditCreate, auditUpdate, auditDelete, recordAudit } from '../utils/audit.js';
import { validateDataUrl } from '../utils/tripOrderFields.js';
import {
  applyInvoiceTotals,
  isOverdue,
  daysOverdue,
  getInvoiceSettings,
  previewInvoiceNumber,
  createWithInvoiceNumber,
  dueDaysFromTerms
} from '../services/invoiceMath.js';
import { profileForDocuments } from '../utils/company.js';
import { streamPdf } from '../utils/pdf.js';
import { drawInvoice } from '../utils/invoicePdf.js';
import { emitEvent } from '../services/webhooks.js';

// Invoices & Payments — the receivables ledger. Sits on the `billing`
// permission resource with the existing LR/invoice paperwork, so the
// Accountant role (billing:*) owns it and a Fleet Manager (billing:read) can
// see what is outstanding without changing it.

const router = express.Router();

const ownedBy = (req) => ({ owner: req.accountId });
const isId = (v) => mongoose.Types.ObjectId.isValid(v);
const money = (n) => Math.round((Number(n) || 0) * 100) / 100;
const str = (v) => String(v ?? '').trim();

const dateOrNull = (v) => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

const addDays = (date, days) => {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
};

const startOfDay = (d) => {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
};

// Payment receipts and line detail are not needed by the list; the receipt
// image in particular can be megabytes.
const LIST_FIELDS = '-payments.receipt.dataUrl';

const withDerived = (invoice) => {
  const plain = invoice.toObject ? invoice.toObject() : invoice;
  return {
    ...plain,
    overdue: isOverdue(plain),
    daysOverdue: daysOverdue(plain),
    statusLabel: isOverdue(plain) ? 'Overdue' : INVOICE_STATUS_LABELS[plain.status],
    payments: (plain.payments || []).map((p) => ({
      ...p,
      hasReceipt: Boolean(p.receipt?.dataUrl),
      receipt: { filename: p.receipt?.filename || '', mimeType: p.receipt?.mimeType || '' }
    }))
  };
};

const formatAddress = (a = {}) =>
  [a.line1, a.line2, a.city, a.state, a.pincode].map((x) => str(x)).filter(Boolean).join(', ');

// GST mode from where the two parties are: same state → CGST + SGST, different
// states → IGST. When either state is unknown the intra-state split is the
// safer default — the operator can switch it on the form.
const defaultGstMode = (companyState, customerState) => {
  const a = str(companyState).toLowerCase();
  const b = str(customerState).toLowerCase();
  return a && b && a !== b ? 'igst' : 'cgst_sgst';
};

// Trips already billed by a live invoice, optionally ignoring one invoice (the
// one being edited, so its own lines do not block it).
const billedTripIds = async (owner, tripIds, exceptInvoiceId = null) => {
  if (!tripIds.length) return new Set();
  const filter = { owner, status: { $ne: 'cancelled' }, 'lines.tripOrder': { $in: tripIds } };
  if (exceptInvoiceId) filter._id = { $ne: exceptInvoiceId };
  const invoices = await Invoice.find(filter).select('lines.tripOrder invoiceNumber').lean();
  const out = new Map();
  for (const inv of invoices) {
    for (const line of inv.lines) if (line.tripOrder) out.set(String(line.tripOrder), inv.invoiceNumber);
  }
  return out;
};

// Validates and normalises the lines, discount and GST from a request.
// Returns { fields } or { error }.
const buildInvoiceFields = async (req, body, { customer, invoiceId = null }) => {
  const lines = [];
  for (const [i, raw] of (Array.isArray(body.lines) ? body.lines : []).entries()) {
    const quantity = raw.quantity === undefined || raw.quantity === '' ? 1 : Number(raw.quantity);
    const rate = Number(raw.rate);
    if (!Number.isFinite(quantity) || quantity < 0) return { error: `Line ${i + 1}: quantity must be zero or more` };
    if (!Number.isFinite(rate) || rate < 0) return { error: `Line ${i + 1}: rate must be zero or more` };
    const amount = money(quantity * rate);
    lines.push({
      kind: INVOICE_LINE_KINDS.includes(raw.kind) ? raw.kind : 'freight',
      description: str(raw.description),
      tripOrder: isId(raw.tripOrder) ? new mongoose.Types.ObjectId(raw.tripOrder) : null,
      tripNumber: str(raw.tripNumber),
      vehicleNumber: str(raw.vehicleNumber).toUpperCase(),
      lrNumber: str(raw.lrNumber),
      route: str(raw.route),
      sac: str(raw.sac),
      quantity,
      rate,
      amount
    });
  }
  if (!lines.length) return { error: 'Add at least one line to the invoice' };
  if (lines.every((l) => l.amount === 0)) return { error: 'The invoice lines add up to zero' };

  // Trips: must be the caller's, for this customer, and not already billed.
  const tripIds = [...new Set(lines.filter((l) => l.tripOrder).map((l) => String(l.tripOrder)))];
  if (tripIds.length) {
    const trips = await TripOrder.find({ _id: { $in: tripIds }, owner: req.accountId })
      .select('tripNumber customer vehicleNumber consignment.lrNumber pickup.city destination.city')
      .lean();
    const byId = new Map(trips.map((t) => [String(t._id), t]));
    for (const id of tripIds) {
      const trip = byId.get(id);
      if (!trip) return { error: 'One of the trips on this invoice was not found' };
      if (trip.customer && String(trip.customer) !== String(customer._id)) {
        return { error: `Trip ${trip.tripNumber} belongs to a different customer` };
      }
    }
    const billed = await billedTripIds(req.accountId, tripIds.map((id) => new mongoose.Types.ObjectId(id)), invoiceId);
    for (const [id, number] of billed) {
      return { error: `Trip ${byId.get(id)?.tripNumber || ''} is already billed on invoice ${number}` };
    }
    // Fill the printed trip details from the trip itself.
    for (const line of lines) {
      const trip = line.tripOrder && byId.get(String(line.tripOrder));
      if (!trip) continue;
      line.tripNumber = trip.tripNumber;
      line.vehicleNumber = line.vehicleNumber || trip.vehicleNumber || '';
      line.lrNumber = line.lrNumber || trip.consignment?.lrNumber || '';
      line.route = line.route || [trip.pickup?.city, trip.destination?.city].filter(Boolean).join(' → ');
    }
  }

  const discount = money(body.discount);
  if (discount < 0) return { error: 'Discount cannot be negative' };

  const rate = Number(body.gst?.rate ?? 0);
  if (!Number.isFinite(rate) || rate < 0 || rate > 28) return { error: 'GST rate must be between 0 and 28%' };
  const mode = GST_MODES.includes(body.gst?.mode) ? body.gst.mode : rate > 0 ? 'cgst_sgst' : 'none';

  return {
    fields: {
      lines,
      discount,
      gst: { rate: mode === 'none' ? 0 : rate, mode, reverseCharge: Boolean(body.gst?.reverseCharge) },
      notes: str(body.notes),
      terms: str(body.terms),
      placeOfSupply: str(body.placeOfSupply) || customer.billingAddress?.state || ''
    }
  };
};

// ---------------------------------------------------------------------------
// Vocabulary and settings
// ---------------------------------------------------------------------------

router.get('/options', protect, requirePermission('billing', 'read'), async (req, res) => {
  try {
    const [settings, nextNumber] = await Promise.all([
      getInvoiceSettings(req.accountId),
      previewInvoiceNumber(req.accountId)
    ]);
    res.json({
      success: true,
      statuses: INVOICE_STATUSES.map((value) => ({ value, label: INVOICE_STATUS_LABELS[value] })),
      lineKinds: INVOICE_LINE_KINDS,
      gstModes: GST_MODES,
      receiptModes: RECEIPT_MODES,
      adjustmentKinds: ADJUSTMENT_KINDS.map((value) => ({ value, label: ADJUSTMENT_LABELS[value] })),
      settings,
      nextNumber
    });
  } catch (error) {
    console.error('[invoices] options failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to load invoice options' });
  }
});

router.put('/settings', protect, requirePermission('billing', 'update'), async (req, res) => {
  try {
    const body = req.body || {};
    const updates = {};
    if (body.prefix !== undefined) {
      const prefix = str(body.prefix).toUpperCase();
      if (!/^[A-Z0-9]{1,10}$/.test(prefix)) {
        return res.status(400).json({ success: false, error: 'Prefix must be 1–10 letters or digits' });
      }
      updates.prefix = prefix;
    }
    if (body.useFinancialYear !== undefined) updates.useFinancialYear = Boolean(body.useFinancialYear);
    if (body.separator !== undefined) updates.separator = body.separator === '-' ? '-' : '/';
    if (body.defaultReverseCharge !== undefined) updates.defaultReverseCharge = Boolean(body.defaultReverseCharge);
    if (body.defaultSac !== undefined) updates.defaultSac = str(body.defaultSac);
    if (body.terms !== undefined) updates.terms = str(body.terms);
    const bounded = (key, min, max, label) => {
      if (body[key] === undefined) return null;
      const n = Number(body[key]);
      if (!Number.isFinite(n) || n < min || n > max) return `${label} must be between ${min} and ${max}`;
      updates[key] = Math.round(n * 100) / 100;
      return null;
    };
    const problem =
      bounded('padding', 1, 8, 'Number padding') ||
      bounded('startFrom', 1, 10000000, 'Starting number') ||
      bounded('defaultDueDays', 0, 365, 'Default due days') ||
      bounded('defaultGstRate', 0, 28, 'Default GST rate');
    if (problem) return res.status(400).json({ success: false, error: problem });

    const before = await getInvoiceSettings(req.accountId);
    const settings = await InvoiceSetting.findOneAndUpdate(
      ownedBy(req),
      { $set: { ...updates, updatedAt: new Date(), updatedBy: req.user._id } },
      { new: true }
    ).lean();
    await auditUpdate(req, { entity: 'invoice_setting', before, after: settings, fields: updates, label: 'Invoice series' });

    res.json({ success: true, message: 'Invoice settings saved', settings, nextNumber: await previewInvoiceNumber(req.accountId) });
  } catch (error) {
    console.error('[invoices] settings save failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to save invoice settings' });
  }
});

// GET /api/invoices/billable-trips?customer=<id> — the customer's finished
// trips not yet on a live invoice, each with the invoice lines its revenue
// would become. Tax lines are left out: GST is computed by the invoice.
router.get('/billable-trips', protect, requirePermission('billing', 'read'), async (req, res) => {
  try {
    if (!isId(req.query.customer)) return res.status(400).json({ success: false, error: 'Choose a customer' });

    const trips = await TripOrder.find({
      owner: req.accountId,
      customer: req.query.customer,
      status: { $in: ['delivered', 'completed', 'pending_settlement', 'closed'] }
    })
      .sort({ tripDate: 1 })
      .select('tripNumber tripDate status vehicleNumber consignment.lrNumber pickup.city destination.city revenue totals')
      .lean();

    const billed = await billedTripIds(req.accountId, trips.map((t) => t._id));
    const kindFor = (category) =>
      ['freight', 'loading', 'unloading', 'detention'].includes(category) ? category : 'other';

    const rows = trips
      .filter((t) => !billed.has(String(t._id)))
      .map((t) => {
        const route = [t.pickup?.city, t.destination?.city].filter(Boolean).join(' → ');
        const lines = (t.revenue || [])
          .filter((r) => !['tax', 'discount'].includes(r.category))
          .map((r) => ({
            kind: kindFor(r.category),
            description: r.description || `${r.category[0].toUpperCase()}${r.category.slice(1).replace('_', ' ')} — ${route}`,
            tripOrder: t._id,
            tripNumber: t.tripNumber,
            vehicleNumber: t.vehicleNumber,
            lrNumber: t.consignment?.lrNumber || '',
            route,
            quantity: 1,
            rate: r.amount,
            amount: r.amount
          }));
        const discount = money((t.revenue || []).filter((r) => r.category === 'discount').reduce((s, r) => s + r.amount, 0));
        return {
          _id: t._id,
          tripNumber: t.tripNumber,
          tripDate: t.tripDate,
          status: t.status,
          vehicleNumber: t.vehicleNumber,
          route,
          lines,
          discount,
          amount: money(lines.reduce((s, l) => s + l.amount, 0) - discount)
        };
      });

    res.json({ success: true, trips: rows });
  } catch (error) {
    console.error('[invoices] billable trips failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to load billable trips' });
  }
});

// ---------------------------------------------------------------------------
// Reports: summary and ageing
// ---------------------------------------------------------------------------

// GET /api/invoices/ageing — outstanding per customer, bucketed by how long
// past due. Built from the invoices' stored balances, so the total equals the
// sum of balances on the invoice list.
router.get('/ageing', protect, requirePermission('billing', 'read'), async (req, res) => {
  try {
    const today = startOfDay(new Date());
    const invoices = await Invoice.find({
      ...ownedBy(req),
      status: { $in: ['issued', 'partially_paid'] },
      'totals.balance': { $gt: 0.5 }
    })
      .select('customer billTo.name invoiceNumber invoiceDate dueDate totals status')
      .populate('customer', 'name')
      .lean();

    const BUCKETS = ['current', 'd1_30', 'd31_60', 'd61_90', 'd90_plus'];
    const bucketFor = (days) =>
      days <= 0 ? 'current' : days <= 30 ? 'd1_30' : days <= 60 ? 'd31_60' : days <= 90 ? 'd61_90' : 'd90_plus';

    const byCustomer = new Map();
    const totals = Object.fromEntries([...BUCKETS, 'total'].map((b) => [b, 0]));
    for (const inv of invoices) {
      const days = Math.floor((today - startOfDay(inv.dueDate)) / 86400000);
      const bucket = bucketFor(days);
      const key = String(inv.customer?._id || inv.customer);
      const row =
        byCustomer.get(key) ||
        { customer: key, name: inv.customer?.name || inv.billTo?.name || '—', invoices: 0, ...Object.fromEntries([...BUCKETS, 'total'].map((b) => [b, 0])) };
      row[bucket] = money(row[bucket] + inv.totals.balance);
      row.total = money(row.total + inv.totals.balance);
      row.invoices += 1;
      row.oldestDays = Math.max(row.oldestDays || 0, days);
      byCustomer.set(key, row);
      totals[bucket] = money(totals[bucket] + inv.totals.balance);
      totals.total = money(totals.total + inv.totals.balance);
    }

    res.json({
      success: true,
      buckets: [
        { key: 'current', label: 'Not yet due' },
        { key: 'd1_30', label: '1–30 days' },
        { key: 'd31_60', label: '31–60 days' },
        { key: 'd61_90', label: '61–90 days' },
        { key: 'd90_plus', label: '90+ days' }
      ],
      customers: [...byCustomer.values()].sort((a, b) => b.total - a.total),
      totals
    });
  } catch (error) {
    console.error('[invoices] ageing failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to build the ageing report' });
  }
});

// ---------------------------------------------------------------------------
// List and read
// ---------------------------------------------------------------------------

const buildListFilter = (req) => {
  const { status, customer, from, to, q } = req.query;
  const filter = { ...ownedBy(req) };
  const today = startOfDay(new Date());
  if (status === 'overdue') {
    filter.status = { $in: ['issued', 'partially_paid'] };
    filter.dueDate = { $lt: today };
    filter['totals.balance'] = { $gt: 0.5 };
  } else if (status === 'outstanding') {
    filter.status = { $in: ['issued', 'partially_paid'] };
  } else if (INVOICE_STATUSES.includes(status)) {
    filter.status = status;
  }
  if (isId(customer)) filter.customer = customer;
  if (from || to) {
    filter.invoiceDate = {};
    if (dateOrNull(from)) filter.invoiceDate.$gte = startOfDay(from);
    if (dateOrNull(to)) {
      const end = new Date(to);
      end.setHours(23, 59, 59, 999);
      filter.invoiceDate.$lte = end;
    }
  }
  if (q) {
    const escaped = String(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(escaped, 'i');
    filter.$or = [{ invoiceNumber: re }, { 'billTo.name': re }, { 'lines.tripNumber': re }, { 'lines.vehicleNumber': re }];
  }
  return filter;
};

router.get('/', protect, requirePermission('billing', 'read'), async (req, res) => {
  try {
    const filter = buildListFilter(req);
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 25));

    const [invoices, total, sums] = await Promise.all([
      Invoice.find(filter)
        .select(LIST_FIELDS)
        .sort({ invoiceDate: -1, invoiceNumber: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate('customer', 'name')
        .lean(),
      Invoice.countDocuments(filter),
      // Totals over the whole filtered set, not just this page — the figure an
      // export of the same filter will also show.
      Invoice.aggregate([
        { $match: { ...filter, status: filter.status || { $ne: 'cancelled' } } },
        {
          $group: {
            _id: null,
            amount: { $sum: '$totals.total' },
            received: { $sum: '$totals.received' },
            adjusted: { $sum: '$totals.adjusted' },
            balance: { $sum: '$totals.balance' }
          }
        }
      ])
    ]);

    res.json({
      success: true,
      invoices: invoices.map(withDerived),
      total,
      page,
      pages: Math.ceil(total / limit) || 1,
      sums: sums[0] ? { amount: money(sums[0].amount), received: money(sums[0].received), adjusted: money(sums[0].adjusted), balance: money(sums[0].balance) } : { amount: 0, received: 0, adjusted: 0, balance: 0 }
    });
  } catch (error) {
    console.error('[invoices] list failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to load invoices' });
  }
});

router.get('/:id', protect, requirePermission('billing', 'read'), async (req, res) => {
  try {
    if (!isId(req.params.id)) return res.status(404).json({ success: false, error: 'Invoice not found' });
    const invoice = await Invoice.findOne({ _id: req.params.id, ...ownedBy(req) })
      .populate('customer', 'name gstin paymentTerms billingAddress')
      .lean();
    if (!invoice) return res.status(404).json({ success: false, error: 'Invoice not found' });
    res.json({ success: true, invoice: withDerived(invoice) });
  } catch (error) {
    console.error('[invoices] read failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to load invoice' });
  }
});

// ---------------------------------------------------------------------------
// Create, edit, issue, cancel, delete
// ---------------------------------------------------------------------------

router.post('/', protect, requirePermission('billing', 'create'), async (req, res) => {
  try {
    const body = req.body || {};
    if (!isId(body.customer)) return res.status(400).json({ success: false, error: 'Choose a customer' });
    const customer = await Customer.findOne({ _id: body.customer, ...ownedBy(req) }).lean();
    if (!customer) return res.status(404).json({ success: false, error: 'Customer not found' });

    const { fields, error } = await buildInvoiceFields(req, body, { customer });
    if (error) return res.status(400).json({ success: false, error });

    const settings = await getInvoiceSettings(req.accountId);
    const invoiceDate = dateOrNull(body.invoiceDate) || new Date();
    const dueDate =
      dateOrNull(body.dueDate) || addDays(invoiceDate, dueDaysFromTerms(customer.paymentTerms, settings.defaultDueDays));
    if (dueDate < startOfDay(invoiceDate)) {
      return res.status(400).json({ success: false, error: 'The due date cannot be before the invoice date' });
    }

    const company = await Company.findOne({ owner: req.accountId }).select('address.state').lean();
    if (!body.gst?.mode && fields.gst.rate > 0) {
      fields.gst.mode = defaultGstMode(company?.address?.state, customer.billingAddress?.state);
    }

    const contact = (customer.contacts || []).find((c) => c.isPrimary) || customer.contacts?.[0];
    const invoice = await createWithInvoiceNumber(req.accountId, invoiceDate, (invoiceNumber) => {
      const doc = new Invoice({
        ...fields,
        owner: req.accountId,
        invoiceNumber,
        invoiceDate,
        dueDate,
        customer: customer._id,
        billTo: {
          name: customer.legalName || customer.name,
          gstin: customer.gstin || '',
          address: formatAddress(customer.billingAddress),
          state: customer.billingAddress?.state || '',
          contact: [contact?.name, contact?.mobile].filter(Boolean).join(' · ')
        },
        terms: fields.terms || settings.terms,
        status: body.status === 'draft' ? 'draft' : 'issued',
        createdBy: req.user._id
      });
      applyInvoiceTotals(doc);
      return doc.save();
    });

    await auditCreate(req, {
      entity: 'invoice',
      doc: invoice,
      label: invoice.invoiceNumber,
      fields: ['invoiceNumber', 'invoiceDate', 'dueDate', 'billTo.name', 'totals.total', 'status'],
      summary: `Invoice ${invoice.invoiceNumber} raised for ${invoice.billTo.name}: ₹${invoice.totals.total}`
    });

    emitEvent(req.accountId, 'invoice.created', {
      id: String(invoice._id),
      invoiceNumber: invoice.invoiceNumber,
      status: invoice.status,
      customer: invoice.billTo.name,
      customerGstin: invoice.billTo.gstin,
      invoiceDate: invoice.invoiceDate,
      dueDate: invoice.dueDate,
      totals: invoice.totals,
      trips: invoice.lines.filter((l) => l.tripNumber).map((l) => l.tripNumber)
    });
    res.status(201).json({ success: true, message: `Invoice ${invoice.invoiceNumber} created`, invoice: withDerived(invoice) });
  } catch (error) {
    if (error.name === 'ValidationError') return res.status(400).json({ success: false, error: error.message });
    console.error('[invoices] create failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to create invoice' });
  }
});

// PUT /api/invoices/:id — edit lines, dates, GST. Refused once money has been
// received against it: changing the amount of an invoice the customer has
// already part-paid is a credit note, not an edit.
router.put('/:id', protect, requirePermission('billing', 'update'), async (req, res) => {
  try {
    if (!isId(req.params.id)) return res.status(404).json({ success: false, error: 'Invoice not found' });
    const invoice = await Invoice.findOne({ _id: req.params.id, ...ownedBy(req) });
    if (!invoice) return res.status(404).json({ success: false, error: 'Invoice not found' });
    if (invoice.status === 'cancelled') return res.status(409).json({ success: false, error: 'A cancelled invoice cannot be edited' });
    if (invoice.payments.length || invoice.adjustments.length) {
      return res.status(409).json({
        success: false,
        error: 'Payments or adjustments are recorded against this invoice. Record a credit note instead of editing it.'
      });
    }

    const customer = await Customer.findOne({ _id: invoice.customer, ...ownedBy(req) }).lean();
    if (!customer) return res.status(404).json({ success: false, error: 'Customer not found' });

    const body = req.body || {};
    const { fields, error } = await buildInvoiceFields(req, body, { customer, invoiceId: invoice._id });
    if (error) return res.status(400).json({ success: false, error });

    const before = invoice.toObject();
    Object.assign(invoice, fields);
    if (dateOrNull(body.invoiceDate)) invoice.invoiceDate = dateOrNull(body.invoiceDate);
    if (dateOrNull(body.dueDate)) invoice.dueDate = dateOrNull(body.dueDate);
    if (invoice.dueDate < startOfDay(invoice.invoiceDate)) {
      return res.status(400).json({ success: false, error: 'The due date cannot be before the invoice date' });
    }
    invoice.updatedAt = new Date();
    applyInvoiceTotals(invoice);
    await invoice.save();

    await auditUpdate(req, {
      entity: 'invoice',
      before,
      after: invoice,
      fields: { invoiceDate: 1, dueDate: 1, discount: 1, 'gst.rate': 1, 'gst.mode': 1, 'gst.reverseCharge': 1, 'totals.total': 1, notes: 1 },
      label: invoice.invoiceNumber
    });

    res.json({ success: true, message: 'Invoice updated', invoice: withDerived(invoice) });
  } catch (error) {
    if (error.name === 'ValidationError') return res.status(400).json({ success: false, error: error.message });
    console.error('[invoices] update failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to update invoice' });
  }
});

router.post('/:id/issue', protect, requirePermission('billing', 'update'), async (req, res) => {
  try {
    const invoice = isId(req.params.id) && (await Invoice.findOne({ _id: req.params.id, ...ownedBy(req) }));
    if (!invoice) return res.status(404).json({ success: false, error: 'Invoice not found' });
    if (invoice.status !== 'draft') return res.status(409).json({ success: false, error: 'Only a draft can be issued' });
    invoice.status = 'issued';
    applyInvoiceTotals(invoice);
    invoice.updatedAt = new Date();
    await invoice.save();
    await recordAudit(req, {
      entity: 'invoice',
      entityId: invoice._id,
      action: 'update',
      label: invoice.invoiceNumber,
      summary: `Invoice ${invoice.invoiceNumber} issued`,
      changes: [{ field: 'status', label: 'Status', from: 'Draft', to: INVOICE_STATUS_LABELS[invoice.status] }]
    });
    res.json({ success: true, invoice: withDerived(invoice) });
  } catch (error) {
    console.error('[invoices] issue failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to issue invoice' });
  }
});

// POST /api/invoices/:id/cancel — void an invoice. Its number is kept (a GST
// series must not have gaps) and its trips become billable again.
router.post('/:id/cancel', protect, requirePermission('billing', 'approve'), async (req, res) => {
  try {
    const invoice = isId(req.params.id) && (await Invoice.findOne({ _id: req.params.id, ...ownedBy(req) }));
    if (!invoice) return res.status(404).json({ success: false, error: 'Invoice not found' });
    if (invoice.status === 'cancelled') return res.status(409).json({ success: false, error: 'Already cancelled' });
    if (invoice.payments.length) {
      return res.status(409).json({ success: false, error: 'Remove the recorded payments before cancelling, or issue a credit note' });
    }
    const reason = str(req.body?.reason);
    if (reason.length < 3) return res.status(400).json({ success: false, error: 'Give a reason for cancelling' });

    const from = INVOICE_STATUS_LABELS[invoice.status];
    invoice.status = 'cancelled';
    invoice.cancelledAt = new Date();
    invoice.cancelReason = reason;
    invoice.updatedAt = new Date();
    await invoice.save();
    await recordAudit(req, {
      entity: 'invoice',
      entityId: invoice._id,
      action: 'update',
      label: invoice.invoiceNumber,
      summary: `Invoice ${invoice.invoiceNumber} cancelled: ${reason}`,
      changes: [{ field: 'status', label: 'Status', from, to: 'Cancelled' }]
    });
    res.json({ success: true, invoice: withDerived(invoice) });
  } catch (error) {
    console.error('[invoices] cancel failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to cancel invoice' });
  }
});

// Only a draft may be deleted; an issued number has been seen by a customer.
router.delete('/:id', protect, requirePermission('billing', 'delete'), async (req, res) => {
  try {
    const invoice = isId(req.params.id) && (await Invoice.findOne({ _id: req.params.id, ...ownedBy(req) }));
    if (!invoice) return res.status(404).json({ success: false, error: 'Invoice not found' });
    if (invoice.status !== 'draft') {
      return res.status(409).json({ success: false, error: 'Only a draft can be deleted. Cancel an issued invoice instead.' });
    }
    await Invoice.deleteOne({ _id: invoice._id });
    await auditDelete(req, { entity: 'invoice', doc: invoice, label: invoice.invoiceNumber, fields: ['invoiceNumber', 'billTo.name', 'totals.total'] });
    res.json({ success: true, message: `Draft ${invoice.invoiceNumber} deleted` });
  } catch (error) {
    console.error('[invoices] delete failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to delete invoice' });
  }
});

// ---------------------------------------------------------------------------
// Payments and adjustments
// ---------------------------------------------------------------------------

router.post('/:id/payments', protect, requirePermission('billing', 'update'), async (req, res) => {
  try {
    const invoice = isId(req.params.id) && (await Invoice.findOne({ _id: req.params.id, ...ownedBy(req) }));
    if (!invoice) return res.status(404).json({ success: false, error: 'Invoice not found' });
    if (['draft', 'cancelled'].includes(invoice.status)) {
      return res.status(409).json({ success: false, error: `A ${invoice.status} invoice cannot take payments` });
    }

    const body = req.body || {};
    const amount = money(body.amount);
    if (!(amount > 0)) return res.status(400).json({ success: false, error: 'Enter an amount greater than zero' });
    if (amount > invoice.totals.balance + 0.5) {
      return res.status(400).json({
        success: false,
        error: `₹${amount} is more than the ₹${invoice.totals.balance} still due on this invoice`
      });
    }
    const date = dateOrNull(body.date) || new Date();
    const reference = str(body.reference);

    const twin = invoice.payments.find(
      (p) => p.amount === amount && (p.reference || '') === reference && Date.now() - new Date(p.createdAt).getTime() < 2 * 60 * 1000
    );
    if (twin && !body.confirmDuplicate) {
      return res.status(409).json({
        success: false,
        duplicate: true,
        error: `A payment of ₹${amount}${reference ? ` (ref ${reference})` : ''} was just recorded. Submit again only if this is a second payment.`
      });
    }

    const receipt = body.receipt?.dataUrl ? body.receipt : null;
    if (receipt) {
      const problem = validateDataUrl(receipt.dataUrl, { label: 'receipt' });
      if (problem) return res.status(400).json({ success: false, error: problem });
    }

    const before = { received: invoice.totals.received, balance: invoice.totals.balance };
    invoice.payments.push({
      date,
      amount,
      mode: RECEIPT_MODES.includes(body.mode) ? body.mode : 'Bank Transfer',
      reference,
      notes: str(body.notes),
      receipt: receipt
        ? { dataUrl: String(receipt.dataUrl), filename: str(receipt.filename), mimeType: str(receipt.mimeType) }
        : {},
      createdBy: req.user._id,
      createdByName: req.user.name || ''
    });
    applyInvoiceTotals(invoice);
    invoice.updatedAt = new Date();
    await invoice.save();

    await recordAudit(req, {
      entity: 'invoice',
      entityId: invoice._id,
      action: 'update',
      label: invoice.invoiceNumber,
      summary: `Payment of ₹${amount} received on invoice ${invoice.invoiceNumber} — balance ₹${invoice.totals.balance}`,
      changes: [
        { field: 'totals.received', label: 'Received', from: before.received, to: invoice.totals.received },
        { field: 'totals.balance', label: 'Balance', from: before.balance, to: invoice.totals.balance }
      ]
    });

    emitEvent(req.accountId, 'invoice.payment_received', {
      id: String(invoice._id),
      invoiceNumber: invoice.invoiceNumber,
      customer: invoice.billTo.name,
      amount,
      date,
      mode: invoice.payments[invoice.payments.length - 1].mode,
      reference,
      balance: invoice.totals.balance,
      status: invoice.status
    });
    res.status(201).json({ success: true, invoice: withDerived(invoice) });
  } catch (error) {
    if (error.name === 'ValidationError') return res.status(400).json({ success: false, error: error.message });
    console.error('[invoices] payment failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to record payment' });
  }
});

router.delete('/:id/payments/:paymentId', protect, requirePermission('billing', 'update'), async (req, res) => {
  try {
    const invoice = isId(req.params.id) && (await Invoice.findOne({ _id: req.params.id, ...ownedBy(req) }));
    if (!invoice) return res.status(404).json({ success: false, error: 'Invoice not found' });
    const payment = invoice.payments.id(req.params.paymentId);
    if (!payment) return res.status(404).json({ success: false, error: 'Payment not found' });
    const { amount } = payment;
    payment.deleteOne();
    applyInvoiceTotals(invoice);
    invoice.updatedAt = new Date();
    await invoice.save();
    await recordAudit(req, {
      entity: 'invoice',
      entityId: invoice._id,
      action: 'update',
      label: invoice.invoiceNumber,
      summary: `Payment of ₹${amount} removed from invoice ${invoice.invoiceNumber}`,
      changes: [{ field: 'payments', label: 'Payment', from: amount, to: null }]
    });
    res.json({ success: true, invoice: withDerived(invoice) });
  } catch (error) {
    console.error('[invoices] payment delete failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to remove payment' });
  }
});

router.get('/:id/payments/:paymentId/receipt', protect, requirePermission('billing', 'read'), async (req, res) => {
  try {
    const invoice = isId(req.params.id) && (await Invoice.findOne({ _id: req.params.id, ...ownedBy(req) }).lean());
    const payment = invoice?.payments?.find((p) => String(p._id) === req.params.paymentId);
    if (!payment?.receipt?.dataUrl) return res.status(404).json({ success: false, error: 'Receipt not found' });
    res.json({ success: true, receipt: payment.receipt });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to load receipt' });
  }
});

router.post('/:id/adjustments', protect, requirePermission('billing', 'update'), async (req, res) => {
  try {
    const invoice = isId(req.params.id) && (await Invoice.findOne({ _id: req.params.id, ...ownedBy(req) }));
    if (!invoice) return res.status(404).json({ success: false, error: 'Invoice not found' });
    if (['draft', 'cancelled'].includes(invoice.status)) {
      return res.status(409).json({ success: false, error: `A ${invoice.status} invoice cannot be adjusted` });
    }
    const body = req.body || {};
    if (!ADJUSTMENT_KINDS.includes(body.kind)) return res.status(400).json({ success: false, error: 'Choose credit note, TDS or write-off' });
    // Writing a balance off is a sign-off, not data entry.
    if (body.kind === 'write_off' && !hasPermission(req.user.role, 'billing', 'approve')) {
      return res.status(403).json({ success: false, error: 'Writing off a balance needs the billing:approve permission' });
    }
    const amount = money(body.amount);
    if (!(amount > 0)) return res.status(400).json({ success: false, error: 'Enter an amount greater than zero' });
    if (amount > invoice.totals.balance + 0.5) {
      return res.status(400).json({ success: false, error: `₹${amount} is more than the ₹${invoice.totals.balance} outstanding` });
    }

    invoice.adjustments.push({
      kind: body.kind,
      date: dateOrNull(body.date) || new Date(),
      amount,
      reference: str(body.reference),
      notes: str(body.notes),
      createdBy: req.user._id
    });
    applyInvoiceTotals(invoice);
    invoice.updatedAt = new Date();
    await invoice.save();
    await recordAudit(req, {
      entity: 'invoice',
      entityId: invoice._id,
      action: 'update',
      label: invoice.invoiceNumber,
      summary: `${ADJUSTMENT_LABELS[body.kind]} of ₹${amount} on invoice ${invoice.invoiceNumber} — balance ₹${invoice.totals.balance}`,
      changes: [{ field: 'totals.adjusted', label: 'Adjusted', from: null, to: invoice.totals.adjusted }]
    });
    res.status(201).json({ success: true, invoice: withDerived(invoice) });
  } catch (error) {
    console.error('[invoices] adjustment failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to record adjustment' });
  }
});

router.delete('/:id/adjustments/:adjId', protect, requirePermission('billing', 'update'), async (req, res) => {
  try {
    const invoice = isId(req.params.id) && (await Invoice.findOne({ _id: req.params.id, ...ownedBy(req) }));
    if (!invoice) return res.status(404).json({ success: false, error: 'Invoice not found' });
    const adj = invoice.adjustments.id(req.params.adjId);
    if (!adj) return res.status(404).json({ success: false, error: 'Adjustment not found' });
    const { kind, amount } = adj;
    adj.deleteOne();
    applyInvoiceTotals(invoice);
    invoice.updatedAt = new Date();
    await invoice.save();
    await recordAudit(req, {
      entity: 'invoice',
      entityId: invoice._id,
      action: 'update',
      label: invoice.invoiceNumber,
      summary: `${ADJUSTMENT_LABELS[kind]} of ₹${amount} removed from invoice ${invoice.invoiceNumber}`,
      changes: [{ field: 'adjustments', label: ADJUSTMENT_LABELS[kind], from: amount, to: null }]
    });
    res.json({ success: true, invoice: withDerived(invoice) });
  } catch (error) {
    console.error('[invoices] adjustment delete failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to remove adjustment' });
  }
});

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

router.get('/:id/pdf', protect, requirePermission('billing', 'read'), async (req, res) => {
  try {
    const invoice = isId(req.params.id) && (await Invoice.findOne({ _id: req.params.id, ...ownedBy(req) }).lean());
    if (!invoice) return res.status(404).json({ success: false, error: 'Invoice not found' });

    // The document carries the account's company details, whichever staff
    // seat downloads it — so resolve the profile from the account owner.
    const accountOwner = (await User.findById(req.accountId)) || req.user;
    const profile = await profileForDocuments(accountOwner);
    const filename = `Invoice-${invoice.invoiceNumber.replace(/[^\w.-]+/g, '-')}.pdf`;
    streamPdf(res, filename, (doc) => drawInvoice(doc, invoice, profile));
  } catch (error) {
    console.error('[invoices] pdf failed:', error.message);
    if (res.headersSent) return res.end();
    res.status(500).json({ success: false, error: 'Failed to generate the invoice PDF' });
  }
});

export default router;
