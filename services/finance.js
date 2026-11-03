import mongoose from 'mongoose';
import TripOrder from '../models/TripOrder.js';
import FuelEntry from '../models/FuelEntry.js';
import ServiceRecord from '../models/ServiceRecord.js';
import RepairRequest from '../models/RepairRequest.js';
import LedgerEntry from '../models/LedgerEntry.js';
import VendorBill, { PAYABLE_ONLY_HEADS, EXPENSE_HEAD_LABELS } from '../models/VendorBill.js';
import Invoice from '../models/Invoice.js';
import Truck from '../models/Truck.js';
import { computeDriverAccount } from './tripSettlement.js';

// The Finance view: P&L, vehicle profitability, the monthly trend and the
// receivables/payables position. Every figure is assembled from the records
// the operational modules already keep, never from a copy, so each line
// reconciles with the screen it came from.
//
// The rule that keeps it honest is that every cost is counted from exactly
// one source:
//
//   Trip expenses        TripOrder.expenses (includes the fuel bills the fuel
//                        register attached to a trip — fuelTripSync)
//   Fuel, no trip        FuelEntry with no trip expense line (tripExpenseId
//                        null) — fuel the trip lines have not already counted
//   Maintenance          ServiceRecord.totalCost by service date, plus
//                        RepairRequest.totalCost of COMPLETED repairs by
//                        completion date (the same basis as the maintenance
//                        reports)
//   Hired vehicles and   VendorBill, by bill date, ex-GST, for heads that no
//   overheads            other module costs (see VendorBill.PAYABLE_ONLY_HEADS)
//   Overheads, finance   LedgerEntry, in the overhead / finance categories
//                        only. Ledger rows for Trip, Fuel, Toll and
//                        Maintenance are cash records of costs already
//                        counted above, and are left to the cash view.
//
//   Revenue              TripOrder.revenue by trip date, net of discount,
//                        EXCLUDING GST (collected for the government, not
//                        earned), on every trip not draft or cancelled. Plus
//                        ledger income in the "Other" category.
//
// EMI principal and GST payments are cash, not cost: they reduce a loan and a
// tax liability. They appear in the cash view only. Overhead is not
// allocated to vehicles — vehicle profitability is a contribution figure.

const money = (n) => Math.round((Number(n) || 0) * 100) / 100;
const oid = (v) => new mongoose.Types.ObjectId(String(v));

const LEDGER_OVERHEADS = ['Salary', 'Office', 'Insurance', 'Permit & Tax', 'Other'];
const LEDGER_FINANCE = ['EMI Interest', 'Depreciation'];
const LEDGER_CASH_ONLY = ['Trip', 'Fuel', 'Toll', 'Maintenance', 'EMI Principal', 'GST'];

const between = (from, to) => ({ $gte: from, $lte: to });

const revenueExTax = (lines = []) =>
  money(
    lines.reduce((s, l) => {
      if (l.category === 'tax') return s;
      return l.category === 'discount' ? s - (Number(l.amount) || 0) : s + (Number(l.amount) || 0);
    }, 0)
  );

const sumLines = (lines = []) => money(lines.reduce((s, l) => s + (Number(l.amount) || 0), 0));

const loadTrips = (owner, from, to) =>
  TripOrder.find({ owner, tripDate: between(from, to), status: { $nin: ['draft', 'cancelled'] } })
    .select('tripNumber tripDate status truck vehicleNumber customer driver driverName actualKm revenue.category revenue.amount expenses.category expenses.amount expenses.paidBy driverMoney.kind driverMoney.amount pickup.city destination.city')
    .lean();

// Everything for one period, grouped the way the P&L reads.
export const periodPnl = async (owner, from, to) => {
  const accountId = oid(owner);
  const [trips, standaloneFuel, services, repairs, ledger, bills] = await Promise.all([
    loadTrips(owner, from, to),
    FuelEntry.aggregate([
      { $match: { owner: accountId, filledAt: between(from, to), tripExpenseId: null } },
      { $group: { _id: null, amount: { $sum: '$amount' }, litres: { $sum: '$quantity' } } }
    ]),
    ServiceRecord.aggregate([
      { $match: { owner: accountId, servicedAt: between(from, to) } },
      { $group: { _id: null, total: { $sum: '$totalCost' } } }
    ]),
    RepairRequest.aggregate([
      { $match: { owner: accountId, status: 'Completed', completedAt: between(from, to) } },
      { $group: { _id: null, total: { $sum: '$totalCost' } } }
    ]),
    LedgerEntry.aggregate([
      { $match: { owner: accountId, date: between(from, to) } },
      { $group: { _id: { type: '$type', category: '$category' }, amount: { $sum: '$amount' } } }
    ]),
    VendorBill.aggregate([
      { $match: { owner: accountId, billDate: between(from, to), status: { $ne: 'cancelled' } } },
      { $group: { _id: '$expenseHead', amount: { $sum: '$amount' } } }
    ])
  ]);

  // --- Revenue ---
  const tripRevenue = money(trips.reduce((s, t) => s + revenueExTax(t.revenue), 0));
  const gstOnTrips = money(trips.reduce((s, t) => s + sumLines((t.revenue || []).filter((l) => l.category === 'tax')), 0));
  const ledgerRow = (type, category) => ledger.find((r) => r._id.type === type && r._id.category === category)?.amount || 0;
  const otherIncome = money(ledgerRow('income', 'Other'));

  // --- Direct costs ---
  const tripExpenseByCategory = {};
  for (const t of trips) {
    for (const e of t.expenses || []) {
      tripExpenseByCategory[e.category] = money((tripExpenseByCategory[e.category] || 0) + (Number(e.amount) || 0));
    }
  }
  const tripExpenses = money(Object.values(tripExpenseByCategory).reduce((s, v) => s + v, 0));
  const fuelNoTrip = money(standaloneFuel[0]?.amount);
  const maintenance = money((services[0]?.total || 0) + (repairs[0]?.total || 0));
  const billHead = (head) => money(bills.find((b) => b._id === head)?.amount);
  const hiredVehicles = billHead('hired_vehicle');
  const directCosts = money(tripExpenses + fuelNoTrip + maintenance + hiredVehicles);

  // --- Overheads ---
  const overheadLines = [];
  for (const cat of LEDGER_OVERHEADS) {
    const amount = money(ledgerRow('expense', cat));
    if (amount) overheadLines.push({ key: `ledger:${cat}`, label: cat, source: 'Daily Ledger', amount });
  }
  for (const b of bills) {
    if (PAYABLE_ONLY_HEADS.includes(b._id) || b._id === 'hired_vehicle') continue;
    if (b.amount) overheadLines.push({ key: `bill:${b._id}`, label: EXPENSE_HEAD_LABELS[b._id] || b._id, source: 'Vendor bills', amount: money(b.amount) });
  }
  const overheads = money(overheadLines.reduce((s, l) => s + l.amount, 0));

  const financeLines = LEDGER_FINANCE.map((cat) => ({ key: `ledger:${cat}`, label: cat, source: 'Daily Ledger', amount: money(ledgerRow('expense', cat)) })).filter((l) => l.amount);
  const financeCosts = money(financeLines.reduce((s, l) => s + l.amount, 0));

  const revenue = money(tripRevenue + otherIncome);
  const grossContribution = money(revenue - directCosts);
  const operatingProfit = money(grossContribution - overheads);
  const netProfit = money(operatingProfit - financeCosts);

  // Ledger rows the P&L leaves to the cash view, listed so nobody wonders
  // where they went.
  const excludedLedger = LEDGER_CASH_ONLY.map((cat) => ({
    category: cat,
    income: money(ledgerRow('income', cat)),
    expense: money(ledgerRow('expense', cat))
  })).filter((r) => r.income || r.expense);

  return {
    period: { from, to },
    revenue: { tripRevenue, otherIncome, total: revenue, gstCollectedExcluded: gstOnTrips, trips: trips.length },
    directCosts: {
      tripExpenses,
      tripExpenseByCategory,
      fuelNoTrip,
      maintenance,
      hiredVehicles,
      total: directCosts
    },
    grossContribution,
    overheads: { lines: overheadLines, total: overheads },
    operatingProfit,
    financeCosts: { lines: financeLines, total: financeCosts },
    netProfit,
    marginPct: revenue > 0 ? money((netProfit / revenue) * 100) : null,
    excludedLedger,
    basis: [
      'Revenue is trip revenue by trip date, net of discounts and excluding GST, plus "Other" ledger income.',
      'Fuel bills linked to a trip are counted once, inside trip expenses; fuel with no trip is shown separately.',
      'Maintenance is service records by service date plus completed repairs by completion date.',
      'Ledger entries for Trip, Fuel, Toll and Maintenance are cash records of costs already counted, so they are excluded here.',
      'EMI principal and GST payments are balance-sheet movements, not expenses, and are excluded.',
      'Vendor bills count only for heads no other module costs (hired vehicles and overheads), excluding input GST.'
    ]
  };
};

// Revenue, total cost and profit per calendar month, oldest first — the
// dashboard's trend chart. Each month is a full periodPnl, so the chart and
// the P&L for that month always agree.
export const monthlyTrend = async (owner, months = 6) => {
  const now = new Date();
  const ranges = [];
  for (let i = months - 1; i >= 0; i--) {
    const start = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const end = new Date(now.getFullYear(), now.getMonth() - i + 1, 0, 23, 59, 59, 999);
    ranges.push({ start, end });
  }
  const results = await Promise.all(ranges.map(({ start, end }) => periodPnl(owner, start, end)));
  return results.map((p, i) => ({
    month: ranges[i].start.toLocaleString('en-IN', { month: 'short', year: '2-digit' }),
    monthStart: ranges[i].start,
    revenue: p.revenue.total,
    expenses: money(p.directCosts.total + p.overheads.total + p.financeCosts.total),
    profit: p.netProfit
  }));
};

// Contribution per vehicle for a period. Overheads are NOT allocated; this is
// what each truck earned over its own direct costs.
export const vehicleProfitability = async (owner, from, to) => {
  const accountId = oid(owner);
  const [trucks, trips, fuel, services, repairs, bills, ledger] = await Promise.all([
    Truck.find({ owner }).select('number model status').lean(),
    loadTrips(owner, from, to),
    FuelEntry.aggregate([
      { $match: { owner: accountId, filledAt: between(from, to), tripExpenseId: null } },
      { $group: { _id: '$truck', amount: { $sum: '$amount' } } }
    ]),
    ServiceRecord.aggregate([
      { $match: { owner: accountId, servicedAt: between(from, to) } },
      { $group: { _id: '$truck', total: { $sum: '$totalCost' } } }
    ]),
    RepairRequest.aggregate([
      { $match: { owner: accountId, status: 'Completed', completedAt: between(from, to) } },
      { $group: { _id: '$truck', total: { $sum: '$totalCost' } } }
    ]),
    VendorBill.aggregate([
      {
        $match: {
          owner: accountId,
          billDate: between(from, to),
          status: { $ne: 'cancelled' },
          truck: { $ne: null },
          expenseHead: { $nin: PAYABLE_ONLY_HEADS }
        }
      },
      { $group: { _id: '$truck', amount: { $sum: '$amount' } } }
    ]),
    LedgerEntry.aggregate([
      { $match: { owner: accountId, date: between(from, to), type: 'expense', truck: { $ne: null }, category: { $in: ['Insurance', 'Permit & Tax', 'Other'] } } },
      { $group: { _id: '$truck', amount: { $sum: '$amount' } } }
    ])
  ]);

  const rows = new Map(
    trucks.map((t) => [
      String(t._id),
      { truck: t._id, number: t.number, model: t.model || '', status: t.status, trips: 0, km: 0, revenue: 0, tripExpenses: 0, fuelNoTrip: 0, maintenance: 0, vehicleCosts: 0 }
    ])
  );
  const rowFor = (id) => rows.get(String(id));

  for (const t of trips) {
    const row = t.truck && rowFor(t.truck);
    if (!row) continue;
    row.trips += 1;
    row.km += Number(t.actualKm) || 0;
    row.revenue += revenueExTax(t.revenue);
    row.tripExpenses += sumLines(t.expenses);
  }
  for (const f of fuel) if (rowFor(f._id)) rowFor(f._id).fuelNoTrip += f.amount;
  for (const s of services) if (rowFor(s._id)) rowFor(s._id).maintenance += s.total;
  for (const r of repairs) if (rowFor(r._id)) rowFor(r._id).maintenance += r.total;
  for (const b of bills) if (rowFor(b._id)) rowFor(b._id).vehicleCosts += b.amount;
  for (const l of ledger) if (rowFor(l._id)) rowFor(l._id).vehicleCosts += l.amount;

  const out = [...rows.values()].map((r) => {
    const costs = r.tripExpenses + r.fuelNoTrip + r.maintenance + r.vehicleCosts;
    const contribution = r.revenue - costs;
    return {
      ...r,
      km: Math.round(r.km),
      revenue: money(r.revenue),
      tripExpenses: money(r.tripExpenses),
      fuelNoTrip: money(r.fuelNoTrip),
      maintenance: money(r.maintenance),
      vehicleCosts: money(r.vehicleCosts),
      costs: money(costs),
      contribution: money(contribution),
      marginPct: r.revenue > 0 ? money((contribution / r.revenue) * 100) : null,
      costPerKm: r.km > 0 ? money(costs / r.km) : null,
      contributionPerKm: r.km > 0 ? money(contribution / r.km) : null,
      lossMaking: contribution < 0
    };
  });
  return out.sort((a, b) => b.contribution - a.contribution);
};

// Contribution per trip for a period: the trip-wise profitability report.
export const tripProfitability = async (owner, from, to) => {
  const trips = await loadTrips(owner, from, to);
  return trips
    .map((t) => {
      const revenue = revenueExTax(t.revenue);
      const expenses = sumLines(t.expenses);
      const contribution = money(revenue - expenses);
      return {
        _id: t._id,
        tripNumber: t.tripNumber,
        tripDate: t.tripDate,
        status: t.status,
        vehicleNumber: t.vehicleNumber,
        driverName: t.driverName,
        route: [t.pickup?.city, t.destination?.city].filter(Boolean).join(' → '),
        km: t.actualKm ?? null,
        revenue,
        expenses,
        contribution,
        marginPct: revenue > 0 ? money((contribution / revenue) * 100) : null,
        perKm: t.actualKm > 0 ? money(contribution / t.actualKm) : null
      };
    })
    .sort((a, b) => new Date(b.tripDate) - new Date(a.tripDate));
};

// Money owed both ways, as of now.
export const positions = async (owner) => {
  const accountId = oid(owner);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const [recv, overdue, pay, payOverdue, trips] = await Promise.all([
    Invoice.aggregate([
      { $match: { owner: accountId, status: { $in: ['issued', 'partially_paid'] } } },
      { $group: { _id: null, balance: { $sum: '$totals.balance' }, count: { $sum: 1 } } }
    ]),
    Invoice.aggregate([
      { $match: { owner: accountId, status: { $in: ['issued', 'partially_paid'] }, dueDate: { $lt: today }, 'totals.balance': { $gt: 0.5 } } },
      { $group: { _id: null, balance: { $sum: '$totals.balance' }, count: { $sum: 1 } } }
    ]),
    VendorBill.aggregate([
      { $match: { owner: accountId, status: { $in: ['unpaid', 'partially_paid'] } } },
      { $group: { _id: null, balance: { $sum: '$balance' }, count: { $sum: 1 } } }
    ]),
    VendorBill.aggregate([
      { $match: { owner: accountId, status: { $in: ['unpaid', 'partially_paid'] }, dueDate: { $lt: today } } },
      { $group: { _id: null, balance: { $sum: '$balance' }, count: { $sum: 1 } } }
    ]),
    TripOrder.find({ owner, driver: { $ne: null }, status: { $ne: 'draft' }, 'driverMoney.0': { $exists: true } })
      .select('expenses.category expenses.amount expenses.paidBy driverName driverMoney.kind driverMoney.amount')
      .lean()
  ]);

  // Driver balances: only trips where money has actually moved, so a trip with
  // an allowance line but no advance yet does not inflate what is "owed".
  let payableToDrivers = 0;
  let heldByDrivers = 0;
  for (const t of trips) {
    const { balance } = computeDriverAccount(t);
    if (balance > 0) payableToDrivers += balance;
    else heldByDrivers += -balance;
  }

  // Customer invoices that do not exist yet: finished trips not on any live
  // invoice. The "unbilled revenue" a transporter most often forgets.
  const billed = await Invoice.distinct('lines.tripOrder', { owner: accountId, status: { $ne: 'cancelled' } });
  const unbilled = await TripOrder.find({
    owner,
    status: { $in: ['delivered', 'completed', 'pending_settlement', 'closed'] },
    _id: { $nin: billed.filter(Boolean) }
  })
    .select('revenue.category revenue.amount')
    .lean();

  return {
    receivables: { balance: money(recv[0]?.balance), invoices: recv[0]?.count || 0 },
    overdueReceivables: { balance: money(overdue[0]?.balance), invoices: overdue[0]?.count || 0 },
    payables: { balance: money(pay[0]?.balance), bills: pay[0]?.count || 0 },
    overduePayables: { balance: money(payOverdue[0]?.balance), bills: payOverdue[0]?.count || 0 },
    drivers: { payable: money(payableToDrivers), heldAsAdvance: money(heldByDrivers) },
    unbilledTrips: { count: unbilled.length, amount: money(unbilled.reduce((s, t) => s + revenueExTax(t.revenue), 0)) }
  };
};

// Cash in and out for a period, by source. Kept separate from the P&L by
// design (brief §8: "separate cash flow from accounting profit").
export const cashFlow = async (owner, from, to) => {
  const accountId = oid(owner);
  const [receipts, vendorPaid, ledger] = await Promise.all([
    Invoice.aggregate([
      { $match: { owner: accountId } },
      { $unwind: '$payments' },
      { $match: { 'payments.date': between(from, to) } },
      { $group: { _id: null, amount: { $sum: '$payments.amount' } } }
    ]),
    VendorBill.aggregate([
      { $match: { owner: accountId } },
      { $unwind: '$payments' },
      { $match: { 'payments.date': between(from, to) } },
      { $group: { _id: null, amount: { $sum: '$payments.amount' } } }
    ]),
    LedgerEntry.aggregate([
      { $match: { owner: accountId, date: between(from, to) } },
      { $group: { _id: '$type', amount: { $sum: '$amount' } } }
    ])
  ]);
  const inflow = { customerReceipts: money(receipts[0]?.amount), ledgerIncome: money(ledger.find((l) => l._id === 'income')?.amount) };
  const outflow = { vendorPayments: money(vendorPaid[0]?.amount), ledgerExpenses: money(ledger.find((l) => l._id === 'expense')?.amount) };
  const totalIn = money(inflow.customerReceipts + inflow.ledgerIncome);
  const totalOut = money(outflow.vendorPayments + outflow.ledgerExpenses);
  return {
    inflow,
    outflow,
    totalIn,
    totalOut,
    net: money(totalIn - totalOut),
    note: 'Record each receipt or payment in one place only — an invoice payment that is also typed into the Daily Ledger is counted twice here.'
  };
};
