import Invoice from '../models/Invoice.js';
import InvoiceSetting from '../models/InvoiceSetting.js';

// Every invoice figure is computed here and stored on the invoice. The UI and
// the PDF render these numbers; neither derives its own.
//
//   subtotal   Σ line amounts
//   taxable    subtotal − discount
//   tax        taxable × GST rate, split CGST/SGST (same state) or IGST
//   total      taxable + tax, rounded to the rupee (the round-off is shown);
//              under reverse charge the tax is shown but NOT added — the
//              customer pays it to the government, not to us
//   received   Σ payments
//   adjusted   Σ credit notes + TDS + write-offs
//   balance    total − received − adjusted      (the outstanding)

const money = (n) => Math.round((Number(n) || 0) * 100) / 100;

export const computeInvoiceTotals = (invoice) => {
  const lines = invoice.lines || [];
  const subtotal = money(lines.reduce((s, l) => s + (Number(l.amount) || 0), 0));
  const discount = Math.min(money(invoice.discount), subtotal);
  const taxable = money(subtotal - discount);

  const rate = Number(invoice.gst?.rate) || 0;
  const mode = invoice.gst?.mode || 'none';
  const tax = mode === 'none' ? 0 : money((taxable * rate) / 100);
  const cgst = mode === 'cgst_sgst' ? money(tax / 2) : 0;
  const sgst = mode === 'cgst_sgst' ? money(tax - cgst) : 0;
  const igst = mode === 'igst' ? tax : 0;

  const payable = invoice.gst?.reverseCharge ? taxable : taxable + tax;
  const total = Math.round(payable);
  const roundOff = money(total - payable);

  const received = money((invoice.payments || []).reduce((s, p) => s + (Number(p.amount) || 0), 0));
  const adjusted = money((invoice.adjustments || []).reduce((s, a) => s + (Number(a.amount) || 0), 0));
  const balance = money(total - received - adjusted);

  return { subtotal, taxable, cgst, sgst, igst, tax, roundOff, total, received, adjusted, balance };
};

// Status follows the money, except draft and cancelled, which are set by hand.
export const deriveStatus = (invoice) => {
  if (['draft', 'cancelled'].includes(invoice.status)) return invoice.status;
  const { total, received, adjusted, balance } = invoice.totals;
  if (total > 0 && balance <= 0.5) return 'paid';
  if (received + adjusted > 0) return 'partially_paid';
  return 'issued';
};

export const applyInvoiceTotals = (invoice) => {
  invoice.totals = computeInvoiceTotals(invoice);
  invoice.status = deriveStatus(invoice);
  return invoice;
};

const startOfToday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
};

// Overdue is derived, never stored: it changes with the calendar, not with any
// write, so a stored flag would be wrong by tomorrow.
export const isOverdue = (invoice, today = startOfToday()) =>
  ['issued', 'partially_paid'].includes(invoice.status) &&
  invoice.totals?.balance > 0.5 &&
  new Date(invoice.dueDate) < today;

export const daysOverdue = (invoice, today = startOfToday()) =>
  isOverdue(invoice, today) ? Math.floor((today - new Date(invoice.dueDate)) / 86400000) : 0;

// Indian financial year label for a date: 1 Apr 2026 – 31 Mar 2027 → "2026-27".
export const financialYear = (date = new Date()) => {
  const d = new Date(date);
  const startYear = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
};

export const getInvoiceSettings = async (owner) => {
  const existing = await InvoiceSetting.findOne({ owner }).lean();
  if (existing) return existing;
  try {
    return (await InvoiceSetting.create({ owner })).toObject();
  } catch (error) {
    if (error.code === 11000) return InvoiceSetting.findOne({ owner }).lean();
    throw error;
  }
};

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The part of the number before the sequence, e.g. "INV/2026-27/".
const seriesStem = (settings, date) => {
  const sep = settings.separator || '/';
  const parts = [settings.prefix || 'INV'];
  if (settings.useFinancialYear) parts.push(financialYear(date));
  return parts.join(sep) + sep;
};

// Same approach as services/tripNumber.js: read the highest number issued in
// this series, take the next, and let the unique index on (owner,
// invoiceNumber) refuse a collision, retrying on it.
const nextNumber = async (owner, settings, date) => {
  const stem = seriesStem(settings, date);
  const existing = await Invoice.find({ owner, invoiceNumber: new RegExp(`^${escapeRegex(stem)}\\d+$`) })
    .select('invoiceNumber')
    .lean();
  const highest = existing.reduce((max, inv) => {
    const n = Number(inv.invoiceNumber.slice(stem.length));
    return Number.isFinite(n) && n > max ? n : max;
  }, 0);
  const sequence = Math.max(highest + 1, settings.startFrom || 1);
  return `${stem}${String(sequence).padStart(settings.padding || 4, '0')}`;
};

export const previewInvoiceNumber = async (owner, date = new Date()) =>
  nextNumber(owner, await getInvoiceSettings(owner), date);

export const createWithInvoiceNumber = async (owner, date, create, { attempts = 5 } = {}) => {
  const settings = await getInvoiceSettings(owner);
  for (let attempt = 0; attempt < attempts; attempt++) {
    const number = await nextNumber(owner, settings, date);
    try {
      return await create(number);
    } catch (error) {
      const collision = error?.code === 11000 && JSON.stringify(error?.keyPattern || {}).includes('invoiceNumber');
      if (!collision || attempt === attempts - 1) throw error;
    }
  }
  throw new Error('Could not allocate an invoice number');
};

// Days of credit implied by a customer's payment terms ("Net 30" → 30).
export const dueDaysFromTerms = (terms, fallback) => {
  if (!terms) return fallback;
  const net = /^Net (\d+)$/.exec(terms);
  if (net) return Number(net[1]);
  if (terms === 'Advance' || terms === 'Cash on Delivery') return 0;
  return fallback;
};
