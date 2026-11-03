import crypto from 'crypto';
import { computeExpenses, computeActualKm } from './tripFinance.js';

// Trip settlement: the close-out that turns a delivered trip into a final,
// locked record. Every figure is computed here, server-side, for the same
// reason services/tripFinance.js gives — a number the browser derives is one
// nobody can audit.
//
// Definitions (brief, Appendix B — agreed definitions shown on screen):
//
//   Revenue (ex-tax)   revenue lines net of discount, EXCLUDING the `tax`
//                      category. GST collected is owed to the government,
//                      not earned, so it is reported beside revenue rather
//                      than inside it.
//   Trip expenses      every expense line on the trip. A fuel bill entered in
//                      the fuel register appears here exactly once, as the
//                      line services/fuelTripSync.js maintains for it.
//   Contribution       revenue (ex-tax) − trip expenses. Before any overhead
//                      allocation (office, salaries, EMI, depreciation): it
//                      is what this trip contributed, not a net profit.
//
//   Driver allowance   expense lines in the `driver_allowance` category.
//   Paid by driver     other expense lines whose "Paid by" is the driver
//                      (the word "driver", or the driver's own name) — money
//                      the driver spent out of pocket or out of the advance.
//   Advances           office → driver payments on this trip.
//   Balance            allowance + paid by driver − advances
//                      − settlement payments + recoveries.
//                      Positive: the office owes the driver.
//                      Negative: the driver holds unspent advance.

const money = (n) => Math.round((Number(n) || 0) * 100) / 100;

const sum = (lines, pick = (l) => l.amount) => money(lines.reduce((s, l) => s + (Number(pick(l)) || 0), 0));

const isDriverPaid = (line, driverName) => {
  const by = String(line.paidBy || '').trim().toLowerCase();
  if (!by) return false;
  if (by === 'driver' || by.startsWith('driver ')) return true;
  return Boolean(driverName) && by === String(driverName).trim().toLowerCase();
};

// The driver's side of the trip.
export const computeDriverAccount = (trip = {}) => {
  const expenses = trip.expenses || [];
  const money_ = trip.driverMoney || [];

  const allowance = sum(expenses.filter((e) => e.category === 'driver_allowance'));
  const paidByDriver = sum(
    expenses.filter((e) => e.category !== 'driver_allowance' && isDriverPaid(e, trip.driverName))
  );
  const advances = sum(money_.filter((m) => m.kind === 'advance'));
  const settlementPayments = sum(money_.filter((m) => m.kind === 'settlement_payment'));
  const recoveries = sum(money_.filter((m) => m.kind === 'recovery'));

  const balance = money(allowance + paidByDriver - advances - settlementPayments + recoveries);

  return {
    allowance,
    paidByDriver,
    advances,
    settlementPayments,
    recoveries,
    balance,
    // Said in words so the UI and the export never have to interpret the sign.
    balanceDirection: balance > 0 ? 'payable_to_driver' : balance < 0 ? 'receivable_from_driver' : 'settled'
  };
};

export const computeSettlement = (trip = {}) => {
  const revenueLines = trip.revenue || [];
  const grossBilled = money(
    revenueLines.reduce((s, l) => (l.category === 'discount' ? s - (Number(l.amount) || 0) : s + (Number(l.amount) || 0)), 0)
  );
  const taxCollected = sum(revenueLines.filter((l) => l.category === 'tax'));
  const revenueExTax = money(grossBilled - taxCollected);
  const expenses = computeExpenses(trip.expenses);
  const contribution = money(revenueExTax - expenses);

  const expensesByCategory = {};
  for (const line of trip.expenses || []) {
    expensesByCategory[line.category] = money((expensesByCategory[line.category] || 0) + (Number(line.amount) || 0));
  }

  const actualKm = trip.actualKm ?? computeActualKm(trip.start, trip.end);

  return {
    revenueExTax,
    taxCollected,
    grossBilled,
    expenses,
    expensesByCategory,
    contribution,
    contributionPerKm: actualKm > 0 ? money(contribution / actualKm) : null,
    marginPct: revenueExTax > 0 ? money((contribution / revenueExTax) * 100) : null,
    actualKm: Number.isFinite(actualKm) ? actualKm : null,
    distanceSource: Number.isFinite(trip.start?.odometer) && Number.isFinite(trip.end?.odometer)
      ? { method: 'odometer', from: trip.start.odometer, to: trip.end.odometer, corrected: (trip.readingCorrections || []).length > 0 }
      : { method: 'none' },
    driver: computeDriverAccount(trip),
    basis: 'Contribution = revenue excluding GST − direct trip expenses, before overhead allocation.'
  };
};

// A fingerprint of everything a review signs off on. Recomputed at close: if
// it differs from the one stored at review, something changed after the
// review and it is no longer valid.
export const settlementSignature = (trip = {}) => {
  const lines = (arr, keys) => (arr || []).map((l) => keys.map((k) => String(l[k] ?? '')).join('|')).sort();
  const payload = JSON.stringify({
    r: lines(trip.revenue, ['_id', 'category', 'amount']),
    e: lines(trip.expenses, ['_id', 'category', 'amount', 'paidBy']),
    d: lines(trip.driverMoney, ['_id', 'kind', 'amount']),
    s: trip.start?.odometer ?? null,
    f: trip.end?.odometer ?? null
  });
  return crypto.createHash('sha1').update(payload).digest('hex');
};

const hasPod = (trip) =>
  Boolean(trip.pod?.capturedAt || trip.pod?.receiverName || trip.pod?.signature) ||
  (trip.documents || []).some((d) => d.docType === 'pod');

// What must be true before a trip can close. Each check carries a key (for the
// override record), a label, and whether it passed — the UI renders the list
// as-is.
export const closeChecks = (trip = {}) => {
  const reviewed = Boolean(trip.settlement?.reviewedAt);
  const reviewCurrent = reviewed && trip.settlement.reviewedSignature === settlementSignature(trip);

  return [
    {
      key: 'status',
      label: 'Trip is completed and in settlement',
      ok: ['completed', 'pending_settlement'].includes(trip.status)
    },
    {
      key: 'end_reading',
      label: 'Start and end odometer recorded',
      ok: Number.isFinite(trip.start?.odometer) && Number.isFinite(trip.end?.odometer)
    },
    {
      key: 'revenue',
      label: 'Customer revenue entered',
      ok: (trip.revenue || []).some((l) => l.category !== 'discount' && l.category !== 'tax' && l.amount > 0)
    },
    { key: 'pod', label: 'Proof of delivery captured', ok: hasPod(trip) },
    {
      key: 'review',
      label: reviewed && !reviewCurrent ? 'Settlement re-reviewed after the latest changes' : 'Settlement reviewed',
      ok: reviewCurrent
    }
  ];
};
