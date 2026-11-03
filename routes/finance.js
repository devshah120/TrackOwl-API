import express from 'express';
import TripOrder from '../models/TripOrder.js';
import Invoice from '../models/Invoice.js';
import Truck from '../models/Truck.js';
import Notification from '../models/Notification.js';
import { protect, requirePermission, isDriverSeat } from '../middleware/auth.js';
import { hasPermission } from '../utils/permissions.js';
import { ACTIVE_STATUSES } from '../utils/tripOrders.js';
import { periodPnl, monthlyTrend, vehicleProfitability, tripProfitability, positions, cashFlow } from '../services/finance.js';
import { isOverdue, daysOverdue } from '../services/invoiceMath.js';
import { efficiencyRanking } from '../services/fuelReports.js';

// Finance & Expenses, and the business dashboard. Read-only views over the
// operational records; see services/finance.js for what each figure counts.
//
// On the `ledger` permission resource — the same seats that can read the
// Daily Ledger can read the P&L built partly from it.

const router = express.Router();

const parseRange = (req) => {
  const now = new Date();
  const from = req.query.from ? new Date(req.query.from) : new Date(now.getFullYear(), now.getMonth(), 1);
  const to = req.query.to ? new Date(req.query.to) : now;
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return null;
  from.setHours(0, 0, 0, 0);
  to.setHours(23, 59, 59, 999);
  return from <= to ? { from, to } : null;
};

const guard = (handler, label) => async (req, res) => {
  try {
    await handler(req, res);
  } catch (error) {
    console.error(`[finance] ${label} failed:`, error.message);
    res.status(500).json({ success: false, error: `Failed to build ${label}` });
  }
};

const withRange = (fn, label) =>
  guard(async (req, res) => {
    const range = parseRange(req);
    if (!range) return res.status(400).json({ success: false, error: 'Choose a valid date range' });
    res.json({ success: true, ...range, ...(await fn(req, range)) });
  }, label);

router.get('/pnl', protect, requirePermission('ledger', 'read'), withRange(async (req, { from, to }) => ({ pnl: await periodPnl(req.accountId, from, to) }), 'the P&L'));

router.get('/trend', protect, requirePermission('ledger', 'read'), guard(async (req, res) => {
  const months = [6, 12].includes(Number(req.query.months)) ? Number(req.query.months) : 6;
  res.json({ success: true, trend: await monthlyTrend(req.accountId, months) });
}, 'the trend'));

router.get('/vehicles', protect, requirePermission('ledger', 'read'), withRange(async (req, { from, to }) => ({ vehicles: await vehicleProfitability(req.accountId, from, to) }), 'vehicle profitability'));

router.get('/trips', protect, requirePermission('ledger', 'read'), withRange(async (req, { from, to }) => ({ trips: await tripProfitability(req.accountId, from, to) }), 'trip profitability'));

router.get('/positions', protect, requirePermission('ledger', 'read'), guard(async (req, res) => {
  res.json({ success: true, positions: await positions(req.accountId) });
}, 'the receivables position'));

router.get('/cashflow', protect, requirePermission('ledger', 'read'), withRange(async (req, { from, to }) => ({ cashflow: await cashFlow(req.accountId, from, to) }), 'the cash flow'));

// GET /api/finance/dashboard — everything the main dashboard shows, in one
// request. Each block is included only for a seat that may see it, so a Fleet
// Manager without finance access still gets a working dashboard.
router.get('/dashboard', protect, guard(async (req, res) => {
  const owner = req.accountId;
  const role = req.user.role;
  // A block is shown when the role may see it AND the plan includes it.
  const inPlan = (module) => !req.subscription || req.subscription.modules?.includes(module);
  const canFinance = hasPermission(role, 'ledger', 'read') && inPlan('finance');
  const canBilling = hasPermission(role, 'billing', 'read') && inPlan('gst_invoicing');
  const canTrips = hasPermission(role, 'trips', 'read') && inPlan('trip_management');
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const out = { success: true, generatedAt: now };

  const tripScope = { owner, ...(isDriverSeat(req) ? { driver: req.driverProfileId } : {}) };

  if (canTrips) {
    const [byStatus, monthCount, delayed, recent, truckCount, busyTrucks] = await Promise.all([
      TripOrder.aggregate([{ $match: tripScope }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
      TripOrder.countDocuments({ ...tripScope, tripDate: { $gte: monthStart }, status: { $ne: 'cancelled' } }),
      // Delayed: still on the road past the expected arrival, or not yet
      // dispatched past the planned pickup.
      TripOrder.countDocuments({
        ...tripScope,
        $or: [
          { status: { $in: ACTIVE_STATUSES }, destinationExpectedAt: { $ne: null, $lt: now } },
          { status: { $in: ['planned', 'assigned', 'ready'] }, pickupPlannedAt: { $ne: null, $lt: now } }
        ]
      }),
      TripOrder.find(tripScope)
        .sort({ tripDate: -1, createdAt: -1 })
        .limit(6)
        .select('tripNumber tripDate status vehicleNumber driverName pickup.city destination.city totals destinationExpectedAt')
        .lean(),
      Truck.countDocuments({ owner, status: { $ne: 'Inactive' } }),
      TripOrder.distinct('truck', { owner, status: { $in: ACTIVE_STATUSES }, truck: { $ne: null } })
    ]);
    const count = (statuses) => byStatus.filter((s) => statuses.includes(s._id)).reduce((n, s) => n + s.n, 0);
    out.trips = {
      thisMonth: monthCount,
      active: count(ACTIVE_STATUSES),
      status: {
        planned: count(['draft', 'planned', 'assigned', 'ready']),
        ongoing: count([...ACTIVE_STATUSES, 'delivered']),
        completed: count(['completed', 'closed']),
        awaitingSettlement: count(['completed', 'pending_settlement']),
        delayed,
        onHold: count(['on_hold']),
        cancelled: count(['cancelled'])
      },
      recent
    };
    out.utilisation = {
      vehicles: truckCount,
      onTripNow: busyTrucks.length,
      pct: truckCount ? Math.round((busyTrucks.length / truckCount) * 100) : 0
    };
  }

  if (canFinance) {
    const [month, trend, vehicles, pos] = await Promise.all([
      periodPnl(owner, monthStart, now),
      monthlyTrend(owner, Number(req.query.months) === 12 ? 12 : 6),
      vehicleProfitability(owner, monthStart, now),
      positions(owner)
    ]);
    out.finance = {
      monthRevenue: month.revenue.total,
      monthExpenses: Math.round((month.directCosts.total + month.overheads.total + month.financeCosts.total) * 100) / 100,
      monthNetProfit: month.netProfit,
      receivables: pos.receivables,
      overdueReceivables: pos.overdueReceivables,
      unbilledTrips: pos.unbilledTrips,
      trend,
      // Only vehicles that did something this month — an idle truck with no
      // revenue and no cost is not interesting on a dashboard.
      vehicles: vehicles.filter((v) => v.trips || v.costs).slice(0, 50)
    };
  }

  if (canBilling) {
    const overdue = await Invoice.find({
      owner,
      status: { $in: ['issued', 'partially_paid'] },
      dueDate: { $lt: new Date(now.toDateString()) },
      'totals.balance': { $gt: 0.5 }
    })
      .sort({ dueDate: 1 })
      .limit(6)
      .select('invoiceNumber billTo.name dueDate totals status')
      .lean();
    out.overdueInvoices = overdue.map((inv) => ({ ...inv, overdue: isOverdue(inv), daysOverdue: daysOverdue(inv) }));
  }

  // Fuel efficiency by vehicle (brief §2). Over 90 days rather than the
  // month: mileage is only measured full-tank to full-tank, and a single month
  // often holds too few of those per vehicle to say anything.
  if (hasPermission(role, 'fuel', 'read') && inPlan('fuel')) {
    const since = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
    const { vehicles, fleetAverages } = await efficiencyRanking({ accountId: owner, from: since, to: now });
    out.fuel = {
      since,
      fleetAverages,
      vehicles: vehicles.slice(0, 20).map((v) => ({
        truck: v.truck,
        number: v.vehicleNumber,
        fuelType: v.fuelType,
        kmPerUnit: v.kmPerUnit,
        costPerKm: v.costPerKm ?? null,
        vsFleetPct: v.vsFleetPct
      }))
    };
  }

  const alerts = await Notification.find({ owner, type: 'alert', acknowledgedAt: null })
    .sort({ createdAt: -1 })
    .limit(8)
    .select('title message severity category vehicle createdAt')
    .lean();
  out.alerts = alerts;

  res.json(out);
}, 'the dashboard'));

export default router;
