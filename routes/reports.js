import express from 'express';
import mongoose from 'mongoose';
import PDFDocument from 'pdfkit';
import TripOrder from '../models/TripOrder.js';
import Truck from '../models/Truck.js';
import Driver from '../models/Driver.js';
import Customer from '../models/Customer.js';
import FuelEntry from '../models/FuelEntry.js';
import ServiceRecord from '../models/ServiceRecord.js';
import RepairRequest from '../models/RepairRequest.js';
import VehicleDocument, { VEHICLE_DOCUMENT_LABELS } from '../models/VehicleDocument.js';
import DriverDocument, { DRIVER_DOCUMENT_LABELS } from '../models/DriverDocument.js';
import Invoice, { INVOICE_STATUS_LABELS } from '../models/Invoice.js';
import Device from '../models/Device.js';
import { protect, requirePermission } from '../middleware/auth.js';
import { hasPermission } from '../utils/permissions.js';
import { TRIP_STATUS_LABELS } from '../utils/tripOrders.js';
import { computeDriverAccount } from '../services/tripSettlement.js';
import { vehicleProfitability, tripProfitability } from '../services/finance.js';
import { isOverdue, daysOverdue } from '../services/invoiceMath.js';
import { buildXlsx } from '../utils/xlsx.js';

// Reports — one engine for every operational and financial report, with
// Excel (CSV) and PDF export.
//
// Each report is a builder returning { columns, rows, totals }. The JSON the
// screen renders and the file an export downloads come from the same call on
// the same filters, which is what makes the brief's rule hold: "exported
// totals must match on-screen filtered results."
//
// Each report also names the permission resource it reads, checked on top of
// reports:read, so a seat that cannot see invoices cannot export them either.

const router = express.Router();

const isId = (v) => mongoose.Types.ObjectId.isValid(v);
const oid = (v) => new mongoose.Types.ObjectId(String(v));
const money = (n) => Math.round((Number(n) || 0) * 100) / 100;
const MAX_ROWS = 5000;

const range = (q) => {
  const now = new Date();
  const from = q.from ? new Date(q.from) : new Date(now.getFullYear(), now.getMonth(), 1);
  const to = q.to ? new Date(q.to) : now;
  from.setHours(0, 0, 0, 0);
  to.setHours(23, 59, 59, 999);
  return { from, to };
};

const sumCol = (rows, key) => money(rows.reduce((s, r) => s + (Number(r[key]) || 0), 0));

const totalsFor = (columns, rows) => {
  const out = {};
  for (const c of columns) if (c.total) out[c.key] = sumCol(rows, c.key);
  return out;
};

const tripFilter = (req, from, to) => {
  const f = { owner: req.accountId, tripDate: { $gte: from, $lte: to } };
  if (isId(req.query.truck)) f.truck = req.query.truck;
  if (isId(req.query.driver)) f.driver = req.query.driver;
  if (isId(req.query.customer)) f.customer = req.query.customer;
  if (req.query.status) f.status = req.query.status;
  return f;
};

const revenueExTax = (lines = []) =>
  money(lines.reduce((s, l) => (l.category === 'tax' ? s : l.category === 'discount' ? s - l.amount : s + l.amount), 0));

const C = (key, label, type = 'text', extra = {}) => ({ key, label, type, ...extra });

const REPORTS = {
  trips: {
    title: 'Trip Report',
    resource: 'trips',
    filters: ['date', 'truck', 'driver', 'customer', 'status'],
    build: async (req) => {
      const { from, to } = range(req.query);
      const trips = await TripOrder.find(tripFilter(req, from, to))
        .sort({ tripDate: 1 })
        .limit(MAX_ROWS)
        .select('tripNumber tripDate status vehicleNumber driverName customer pickup.city destination.city actualKm revenue.category revenue.amount expenses.amount')
        .populate('customer', 'name')
        .lean();
      const columns = [
        C('tripNumber', 'Trip'),
        C('tripDate', 'Date', 'date'),
        C('status', 'Status'),
        C('customer', 'Customer'),
        C('vehicle', 'Vehicle'),
        C('driver', 'Driver'),
        C('route', 'Route'),
        C('km', 'KM', 'number', { total: true }),
        C('revenue', 'Revenue (ex-GST)', 'money', { total: true }),
        C('expenses', 'Expenses', 'money', { total: true }),
        C('contribution', 'Contribution', 'money', { total: true })
      ];
      const rows = trips.map((t) => {
        const revenue = revenueExTax(t.revenue);
        const expenses = money((t.expenses || []).reduce((s, e) => s + e.amount, 0));
        return {
          tripNumber: t.tripNumber,
          tripDate: t.tripDate,
          status: TRIP_STATUS_LABELS[t.status] || t.status,
          customer: t.customer?.name || '',
          vehicle: t.vehicleNumber,
          driver: t.driverName,
          route: [t.pickup?.city, t.destination?.city].filter(Boolean).join(' → '),
          km: t.actualKm ?? 0,
          revenue,
          expenses,
          contribution: money(revenue - expenses)
        };
      });
      return { columns, rows };
    }
  },

  'trips-by-day': {
    title: 'Daily Trip Summary',
    resource: 'trips',
    filters: ['date', 'truck', 'driver', 'customer'],
    build: async (req) => groupedTrips(req, '%Y-%m-%d', 'Day')
  },

  'trips-by-month': {
    title: 'Monthly Trip Summary',
    resource: 'trips',
    filters: ['date', 'truck', 'driver', 'customer'],
    build: async (req) => groupedTrips(req, '%Y-%m', 'Month')
  },

  'trip-profitability': {
    title: 'Trip-wise Profitability',
    resource: 'ledger',
    filters: ['date'],
    build: async (req) => {
      const { from, to } = range(req.query);
      const trips = await tripProfitability(req.accountId, from, to);
      const columns = [
        C('tripNumber', 'Trip'),
        C('tripDate', 'Date', 'date'),
        C('vehicleNumber', 'Vehicle'),
        C('route', 'Route'),
        C('km', 'KM', 'number', { total: true }),
        C('revenue', 'Revenue (ex-GST)', 'money', { total: true }),
        C('expenses', 'Trip expenses', 'money', { total: true }),
        C('contribution', 'Contribution', 'money', { total: true }),
        C('marginPct', 'Margin %', 'number'),
        C('perKm', 'Contribution / km', 'money')
      ];
      return { columns, rows: trips.slice(0, MAX_ROWS), note: 'Contribution = revenue excluding GST − direct trip expenses, before overheads.' };
    }
  },

  'vehicle-profitability': {
    title: 'Vehicle-wise Profitability',
    resource: 'ledger',
    filters: ['date'],
    build: async (req) => {
      const { from, to } = range(req.query);
      const rows = await vehicleProfitability(req.accountId, from, to);
      const columns = [
        C('number', 'Vehicle'),
        C('trips', 'Trips', 'number', { total: true }),
        C('km', 'KM', 'number', { total: true }),
        C('revenue', 'Revenue (ex-GST)', 'money', { total: true }),
        C('tripExpenses', 'Trip expenses', 'money', { total: true }),
        C('fuelNoTrip', 'Fuel (no trip)', 'money', { total: true }),
        C('maintenance', 'Maintenance', 'money', { total: true }),
        C('vehicleCosts', 'Insurance/permit/other', 'money', { total: true }),
        C('contribution', 'Contribution', 'money', { total: true }),
        C('costPerKm', 'Cost / km', 'money'),
        C('marginPct', 'Margin %', 'number')
      ];
      return { columns, rows, note: 'Overheads are not allocated to vehicles. Negative contribution = loss-making vehicle.' };
    }
  },

  drivers: {
    title: 'Driver Report',
    resource: 'drivers',
    filters: ['date', 'driver'],
    build: async (req) => {
      const { from, to } = range(req.query);
      const filter = { owner: req.accountId, tripDate: { $gte: from, $lte: to }, status: { $nin: ['draft'] }, driver: { $ne: null } };
      if (isId(req.query.driver)) filter.driver = req.query.driver;
      const [drivers, trips] = await Promise.all([
        Driver.find({ owner: req.accountId }).select('name mobile licenseExpiry status').lean(),
        TripOrder.find(filter).select('driver driverName actualKm status events.eventType expenses.category expenses.amount expenses.paidBy driverMoney.kind driverMoney.amount').lean()
      ]);
      const rows = new Map(drivers.map((d) => [String(d._id), {
        driver: d.name,
        mobile: d.mobile,
        licenceExpiry: d.licenseExpiry || null,
        status: d.status,
        trips: 0,
        km: 0,
        allowance: 0,
        advances: 0,
        balance: 0,
        incidents: 0
      }]));
      for (const t of trips) {
        const row = rows.get(String(t.driver));
        if (!row) continue;
        const acct = computeDriverAccount(t);
        row.trips += 1;
        row.km += Number(t.actualKm) || 0;
        row.allowance += acct.allowance;
        row.advances += acct.advances;
        row.balance += acct.balance;
        row.incidents += (t.events || []).filter((e) => ['overspeed', 'idle', 'route_deviation', 'unexpected_stop'].includes(e.eventType)).length;
      }
      const columns = [
        C('driver', 'Driver'),
        C('mobile', 'Mobile'),
        C('status', 'Status'),
        C('licenceExpiry', 'Licence expiry', 'date'),
        C('trips', 'Trips', 'number', { total: true }),
        C('km', 'KM', 'number', { total: true }),
        C('allowance', 'Allowance', 'money', { total: true }),
        C('advances', 'Advances', 'money', { total: true }),
        C('balance', 'Balance payable', 'money', { total: true }),
        C('incidents', 'Incidents', 'number', { total: true })
      ];
      const list = [...rows.values()]
        .filter((r) => !isId(req.query.driver) || r.trips)
        .map((r) => ({ ...r, km: Math.round(r.km), allowance: money(r.allowance), advances: money(r.advances), balance: money(r.balance) }));
      return { columns, rows: list, note: 'Balance = allowance + expenses paid by the driver − advances − settlement payments + recoveries. Positive = owed to the driver.' };
    }
  },

  fuel: {
    title: 'Fuel Consumption & Mileage',
    resource: 'fuel',
    filters: ['date', 'truck', 'driver'],
    build: async (req) => {
      const { from, to } = range(req.query);
      const f = { owner: req.accountId, filledAt: { $gte: from, $lte: to } };
      if (isId(req.query.truck)) f.truck = req.query.truck;
      if (isId(req.query.driver)) f.driver = req.query.driver;
      const entries = await FuelEntry.find(f)
        .sort({ filledAt: 1 })
        .limit(MAX_ROWS)
        .select('filledAt vehicleNumber driverName fuelType fillType quantity rate amount odometer station.name station.city efficiency isFlagged')
        .lean();
      const columns = [
        C('filledAt', 'Date', 'date'),
        C('vehicle', 'Vehicle'),
        C('driver', 'Driver'),
        C('station', 'Station'),
        C('fillType', 'Fill'),
        C('quantity', 'Litres', 'number', { total: true }),
        C('rate', 'Rate', 'money'),
        C('amount', 'Amount', 'money', { total: true }),
        C('odometer', 'Odometer', 'number'),
        C('distanceKm', 'Distance (km)', 'number', { total: true }),
        C('kmPerUnit', 'KM / L', 'number'),
        C('costPerKm', 'Cost / km', 'money'),
        C('flag', 'Flag')
      ];
      const rows = entries.map((e) => ({
        filledAt: e.filledAt,
        vehicle: e.vehicleNumber,
        driver: e.driverName,
        station: [e.station?.name, e.station?.city].filter(Boolean).join(', '),
        fillType: e.fillType,
        quantity: e.quantity,
        rate: e.rate,
        amount: e.amount,
        odometer: e.odometer,
        distanceKm: e.efficiency?.measured ? e.efficiency.distanceKm : null,
        kmPerUnit: e.efficiency?.measured ? e.efficiency.kmPerUnit : null,
        costPerKm: e.efficiency?.measured ? e.efficiency.costPerKm : null,
        flag: e.isFlagged ? 'Check' : ''
      }));
      return { columns, rows, note: 'Mileage is measured full-tank to full-tank; a partial fill shows no mileage of its own.' };
    }
  },

  maintenance: {
    title: 'Maintenance Report',
    resource: 'maintenance',
    filters: ['date', 'truck'],
    build: async (req) => {
      const { from, to } = range(req.query);
      const truck = isId(req.query.truck) ? { truck: oid(req.query.truck) } : {};
      const [services, repairs] = await Promise.all([
        ServiceRecord.find({ owner: req.accountId, servicedAt: { $gte: from, $lte: to }, ...truck }).select('servicedAt vehicleNumber serviceType workshop.name odometer partsTotal labourCost totalCost nextServiceDate nextServiceKm').lean(),
        RepairRequest.find({ owner: req.accountId, status: 'Completed', completedAt: { $gte: from, $lte: to }, ...truck }).select('completedAt vehicleNumber requestNumber issue workshop.name odometer partsTotal labourCost totalCost downtimeHours').lean()
      ]);
      const columns = [
        C('date', 'Date', 'date'),
        C('kind', 'Type'),
        C('vehicle', 'Vehicle'),
        C('work', 'Work'),
        C('workshop', 'Workshop'),
        C('odometer', 'Odometer', 'number'),
        C('parts', 'Parts', 'money', { total: true }),
        C('labour', 'Labour', 'money', { total: true }),
        C('total', 'Total', 'money', { total: true }),
        C('next', 'Next due')
      ];
      const rows = [
        ...services.map((s) => ({
          date: s.servicedAt,
          kind: 'Service',
          vehicle: s.vehicleNumber,
          work: s.serviceType,
          workshop: s.workshop?.name || '',
          odometer: s.odometer,
          parts: s.partsTotal || 0,
          labour: s.labourCost || 0,
          total: s.totalCost || 0,
          next: [s.nextServiceDate && new Date(s.nextServiceDate).toLocaleDateString('en-GB'), s.nextServiceKm && `${s.nextServiceKm} km`].filter(Boolean).join(' / ')
        })),
        ...repairs.map((r) => ({
          date: r.completedAt,
          kind: 'Repair',
          vehicle: r.vehicleNumber,
          work: `${r.requestNumber || ''} ${typeof r.issue === 'string' ? r.issue : r.issue?.title || ''}`.trim(),
          workshop: r.workshop?.name || '',
          odometer: r.odometer,
          parts: r.partsTotal || 0,
          labour: r.labourCost || 0,
          total: r.totalCost || 0,
          next: r.downtimeHours ? `${r.downtimeHours} h downtime` : ''
        }))
      ].sort((a, b) => new Date(a.date) - new Date(b.date));
      return { columns, rows };
    }
  },

  compliance: {
    title: 'Compliance & Document Expiry',
    resource: 'trucks',
    filters: ['truck'],
    build: async (req) => {
      const truck = isId(req.query.truck) ? { truck: req.query.truck } : {};
      const [vdocs, ddocs] = await Promise.all([
        VehicleDocument.find({ owner: req.accountId, ...truck }).select('truck docType documentNumber issueDate expiryDate').populate('truck', 'number').lean(),
        isId(req.query.truck) ? [] : DriverDocument.find({ owner: req.accountId }).select('driver docType documentNumber issueDate expiryDate').populate('driver', 'name').lean()
      ]);
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const statusOf = (expiry) => {
        if (!expiry) return { status: 'No expiry', days: null };
        const days = Math.ceil((new Date(expiry) - today) / 86400000);
        return { status: days < 0 ? 'Expired' : days <= 15 ? 'Expiring soon' : days <= 30 ? 'Upcoming' : 'Valid', days };
      };
      const columns = [
        C('subject', 'Vehicle / Driver'),
        C('document', 'Document'),
        C('number', 'Number'),
        C('issueDate', 'Issued', 'date'),
        C('expiryDate', 'Expires', 'date'),
        C('days', 'Days left', 'number'),
        C('status', 'Status')
      ];
      const rows = [
        ...vdocs.filter((d) => d.truck).map((d) => ({ subject: d.truck.number, document: VEHICLE_DOCUMENT_LABELS[d.docType] || d.docType, number: d.documentNumber, issueDate: d.issueDate, expiryDate: d.expiryDate, ...statusOf(d.expiryDate) })),
        ...ddocs.filter((d) => d.driver).map((d) => ({ subject: d.driver.name, document: DRIVER_DOCUMENT_LABELS[d.docType] || d.docType, number: d.documentNumber, issueDate: d.issueDate, expiryDate: d.expiryDate, ...statusOf(d.expiryDate) }))
      ].sort((a, b) => (a.days ?? 99999) - (b.days ?? 99999));
      return { columns, rows };
    }
  },

  invoices: {
    title: 'Invoice Register',
    resource: 'billing',
    filters: ['date', 'customer', 'invoiceStatus'],
    build: async (req) => {
      const { from, to } = range(req.query);
      const f = { owner: req.accountId, invoiceDate: { $gte: from, $lte: to } };
      if (isId(req.query.customer)) f.customer = req.query.customer;
      if (req.query.invoiceStatus === 'outstanding') f.status = { $in: ['issued', 'partially_paid'] };
      else if (req.query.invoiceStatus) f.status = req.query.invoiceStatus;
      else f.status = { $ne: 'cancelled' };
      const invoices = await Invoice.find(f).sort({ invoiceDate: 1 }).limit(MAX_ROWS).select('invoiceNumber invoiceDate dueDate billTo.name status totals').lean();
      const columns = [
        C('invoiceNumber', 'Invoice'),
        C('invoiceDate', 'Date', 'date'),
        C('customer', 'Customer'),
        C('dueDate', 'Due', 'date'),
        C('status', 'Status'),
        C('taxable', 'Taxable', 'money', { total: true }),
        C('tax', 'GST', 'money', { total: true }),
        C('total', 'Amount', 'money', { total: true }),
        C('received', 'Received', 'money', { total: true }),
        C('adjusted', 'Adjusted', 'money', { total: true }),
        C('balance', 'Balance', 'money', { total: true }),
        C('daysOverdue', 'Days overdue', 'number')
      ];
      const rows = invoices.map((i) => ({
        invoiceNumber: i.invoiceNumber,
        invoiceDate: i.invoiceDate,
        customer: i.billTo?.name,
        dueDate: i.dueDate,
        status: isOverdue(i) ? 'Overdue' : INVOICE_STATUS_LABELS[i.status],
        taxable: i.totals.taxable,
        tax: i.totals.tax,
        total: i.totals.total,
        received: i.totals.received,
        adjusted: i.totals.adjusted,
        balance: i.totals.balance,
        daysOverdue: daysOverdue(i) || null
      }));
      return { columns, rows };
    }
  },

  payments: {
    title: 'Payments Received',
    resource: 'billing',
    filters: ['date', 'customer'],
    build: async (req) => {
      const { from, to } = range(req.query);
      const match = { owner: oid(req.accountId) };
      if (isId(req.query.customer)) match.customer = oid(req.query.customer);
      const rows = await Invoice.aggregate([
        { $match: match },
        { $unwind: '$payments' },
        { $match: { 'payments.date': { $gte: from, $lte: to } } },
        { $sort: { 'payments.date': 1 } },
        { $limit: MAX_ROWS },
        {
          $project: {
            _id: 0,
            date: '$payments.date',
            invoiceNumber: 1,
            customer: '$billTo.name',
            mode: '$payments.mode',
            reference: '$payments.reference',
            amount: '$payments.amount'
          }
        }
      ]);
      const columns = [
        C('date', 'Date', 'date'),
        C('invoiceNumber', 'Invoice'),
        C('customer', 'Customer'),
        C('mode', 'Mode'),
        C('reference', 'Reference'),
        C('amount', 'Amount', 'money', { total: true })
      ];
      return { columns, rows };
    }
  },

  'customer-outstanding': {
    title: 'Customer Outstanding',
    resource: 'billing',
    filters: ['customer'],
    build: async (req) => {
      const match = { owner: oid(req.accountId), status: { $in: ['issued', 'partially_paid'] } };
      if (isId(req.query.customer)) match.customer = oid(req.query.customer);
      const [grouped, customers] = await Promise.all([
        Invoice.find(match).select('customer dueDate totals status').lean(),
        Customer.find({ owner: req.accountId }).select('name paymentTerms creditLimit').lean()
      ]);
      const byId = new Map(customers.map((c) => [String(c._id), c]));
      const rows = new Map();
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      for (const inv of grouped) {
        const key = String(inv.customer);
        const c = byId.get(key);
        const row = rows.get(key) || { customer: c?.name || '—', terms: c?.paymentTerms || '', creditLimit: c?.creditLimit ?? null, invoices: 0, billed: 0, received: 0, balance: 0, current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0 };
        const days = Math.floor((today - new Date(inv.dueDate)) / 86400000);
        const bucket = days <= 0 ? 'current' : days <= 30 ? 'd1_30' : days <= 60 ? 'd31_60' : days <= 90 ? 'd61_90' : 'd90_plus';
        row.invoices += 1;
        row.billed = money(row.billed + inv.totals.total);
        row.received = money(row.received + inv.totals.received + inv.totals.adjusted);
        row.balance = money(row.balance + inv.totals.balance);
        row[bucket] = money(row[bucket] + inv.totals.balance);
        rows.set(key, row);
      }
      const columns = [
        C('customer', 'Customer'),
        C('terms', 'Terms'),
        C('invoices', 'Invoices', 'number', { total: true }),
        C('billed', 'Billed', 'money', { total: true }),
        C('received', 'Received / adjusted', 'money', { total: true }),
        C('balance', 'Outstanding', 'money', { total: true }),
        C('current', 'Not due', 'money', { total: true }),
        C('d1_30', '1–30', 'money', { total: true }),
        C('d31_60', '31–60', 'money', { total: true }),
        C('d61_90', '61–90', 'money', { total: true }),
        C('d90_plus', '90+', 'money', { total: true })
      ];
      return { columns, rows: [...rows.values()].sort((a, b) => b.balance - a.balance) };
    }
  },

  utilisation: {
    title: 'Vehicle Utilisation',
    resource: 'trucks',
    filters: ['date', 'truck'],
    build: async (req) => {
      const { from, to } = range(req.query);
      const periodDays = Math.max(1, Math.round((to - from) / 86400000));
      const truckFilter = { owner: req.accountId, ...(isId(req.query.truck) ? { _id: req.query.truck } : {}) };
      const [trucks, trips] = await Promise.all([
        Truck.find(truckFilter).select('number status').lean(),
        TripOrder.find({ owner: req.accountId, status: { $nin: ['draft', 'cancelled'] }, 'start.at': { $ne: null, $lte: to }, $or: [{ 'end.at': null }, { 'end.at': { $gte: from } }] })
          .select('truck start.at end.at actualKm')
          .lean()
      ]);
      const rows = new Map(trucks.map((t) => [String(t._id), { vehicle: t.number, status: t.status, trips: 0, km: 0, daysOnTrip: 0 }]));
      for (const t of trips) {
        const row = t.truck && rows.get(String(t.truck));
        if (!row) continue;
        const s = Math.max(new Date(t.start.at).getTime(), from.getTime());
        const e = Math.min(t.end?.at ? new Date(t.end.at).getTime() : Date.now(), to.getTime());
        row.trips += 1;
        row.km += Number(t.actualKm) || 0;
        row.daysOnTrip += Math.max(0, (e - s) / 86400000);
      }
      const columns = [
        C('vehicle', 'Vehicle'),
        C('status', 'Status'),
        C('trips', 'Trips', 'number', { total: true }),
        C('km', 'KM', 'number', { total: true }),
        C('daysOnTrip', 'Days on trip', 'number', { total: true }),
        C('utilisationPct', 'Utilisation %', 'number')
      ];
      const list = [...rows.values()].map((r) => ({
        ...r,
        km: Math.round(r.km),
        daysOnTrip: Math.round(r.daysOnTrip * 10) / 10,
        utilisationPct: Math.min(100, Math.round((r.daysOnTrip / periodDays) * 100))
      }));
      return { columns, rows: list.sort((a, b) => b.utilisationPct - a.utilisationPct), note: `Utilisation = days on a started trip ÷ ${periodDays} days in the period.` };
    }
  },

  devices: {
    title: 'GPS Device Status',
    resource: 'tracking',
    filters: [],
    build: async (req) => {
      const devices = await Device.find({ owner: req.accountId })
        .select('name uniqueId imei model deviceType sim.number sim.provider vehicle lastSeenAt lastPosition lifecycleStatus ingestStats')
        .populate('vehicle', 'number')
        .lean();
      const now = Date.now();
      const columns = [
        C('device', 'Device'),
        C('imei', 'IMEI / ID'),
        C('model', 'Model'),
        C('vehicle', 'Vehicle'),
        C('sim', 'SIM'),
        C('status', 'Status'),
        C('lastSeen', 'Last communication', 'datetime'),
        C('minutesSilent', 'Minutes silent', 'number'),
        C('rejected', 'Rejected fixes', 'number', { total: true }),
        C('lifecycle', 'Lifecycle')
      ];
      const rows = devices.map((d) => {
        const silent = d.lastSeenAt ? Math.round((now - new Date(d.lastSeenAt).getTime()) / 60000) : null;
        return {
          device: d.name,
          imei: d.imei || d.uniqueId,
          model: d.model || d.deviceType,
          vehicle: d.vehicle?.number || '',
          sim: [d.sim?.number, d.sim?.provider].filter(Boolean).join(' · '),
          status: silent === null ? 'Never connected' : silent > 2 ? 'Offline' : d.lastPosition?.speed > 3 ? 'Moving' : 'Online',
          lastSeen: d.lastSeenAt || null,
          minutesSilent: silent,
          rejected: d.ingestStats?.rejected || 0,
          lifecycle: d.lifecycleStatus
        };
      });
      return { columns, rows: rows.sort((a, b) => (b.minutesSilent ?? 1e9) - (a.minutesSilent ?? 1e9)) };
    }
  }
};

async function groupedTrips(req, format, label) {
  const { from, to } = range(req.query);
  const match = { owner: oid(req.accountId), tripDate: { $gte: from, $lte: to }, status: { $nin: ['draft', 'cancelled'] } };
  for (const k of ['truck', 'driver', 'customer']) if (isId(req.query[k])) match[k] = oid(req.query[k]);
  const trips = await TripOrder.find(match).select('tripDate actualKm revenue.category revenue.amount expenses.amount').lean();
  const tz = 'Asia/Kolkata';
  const keyOf = (d) => {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
    return format === '%Y-%m' ? parts.slice(0, 7) : parts;
  };
  const rows = new Map();
  for (const t of trips) {
    const key = keyOf(new Date(t.tripDate));
    const row = rows.get(key) || { period: key, trips: 0, km: 0, revenue: 0, expenses: 0, contribution: 0 };
    const revenue = revenueExTax(t.revenue);
    const expenses = (t.expenses || []).reduce((s, e) => s + e.amount, 0);
    row.trips += 1;
    row.km += Number(t.actualKm) || 0;
    row.revenue = money(row.revenue + revenue);
    row.expenses = money(row.expenses + expenses);
    row.contribution = money(row.revenue - row.expenses);
    rows.set(key, row);
  }
  const columns = [
    C('period', label),
    C('trips', 'Trips', 'number', { total: true }),
    C('km', 'KM', 'number', { total: true }),
    C('revenue', 'Revenue (ex-GST)', 'money', { total: true }),
    C('expenses', 'Expenses', 'money', { total: true }),
    C('contribution', 'Contribution', 'money', { total: true })
  ];
  return { columns, rows: [...rows.values()].map((r) => ({ ...r, km: Math.round(r.km) })).sort((a, b) => a.period.localeCompare(b.period)) };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const cellText = (value, type) => {
  if (value === null || value === undefined || value === '') return '';
  if (type === 'date') return new Date(value).toLocaleDateString('en-GB');
  if (type === 'datetime') return new Date(value).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata' });
  if (type === 'money') return Number(value).toFixed(2);
  return String(value);
};

const toCsv = (report) => {
  const esc = (s) => {
    const v = String(s ?? '');
    return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  };
  const lines = [report.columns.map((c) => esc(c.label)).join(',')];
  for (const row of report.rows) lines.push(report.columns.map((c) => esc(cellText(row[c.key], c.type))).join(','));
  if (Object.keys(report.totals).length) {
    lines.push(report.columns.map((c, i) => esc(i === 0 ? 'TOTAL' : c.key in report.totals ? cellText(report.totals[c.key], c.type) : '')).join(','));
  }
  // The BOM makes Excel open the file as UTF-8, so ₹ and → survive.
  return '﻿' + lines.join('\r\n');
};

const toPdf = (res, report, filename) => {
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 28 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}.pdf"`);
  doc.pipe(res);

  const width = doc.page.width - 56;
  const colW = width / report.columns.length;
  const clean = (s) => String(s).replace(/₹/g, 'Rs').replace(/→/g, '>').replace(/[–—]/g, '-');

  const header = () => {
    doc.font('Helvetica-Bold').fontSize(13).text(report.title, 28, 28);
    doc.font('Helvetica').fontSize(8).fillColor('#555').text(clean(report.subtitle), 28, doc.y + 2);
    doc.fillColor('#000');
    let y = doc.y + 8;
    doc.rect(28, y, width, 16).fill('#eef2ff');
    doc.fillColor('#000').font('Helvetica-Bold').fontSize(7);
    report.columns.forEach((c, i) => doc.text(clean(c.label), 30 + i * colW, y + 5, { width: colW - 4, align: c.type === 'text' || c.type === 'date' ? 'left' : 'right', lineBreak: false, ellipsis: true }));
    return y + 18;
  };

  let y = header();
  const drawRow = (row, bold = false) => {
    if (y > doc.page.height - 40) {
      doc.addPage();
      y = header();
    }
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(7);
    report.columns.forEach((c, i) =>
      doc.text(clean(cellText(row[c.key], c.type)), 30 + i * colW, y, { width: colW - 4, align: c.type === 'text' || c.type === 'date' ? 'left' : 'right', lineBreak: false, ellipsis: true })
    );
    y += 12;
  };
  report.rows.forEach((r) => drawRow(r));
  if (Object.keys(report.totals).length) {
    doc.moveTo(28, y).lineTo(28 + width, y).stroke();
    y += 3;
    drawRow({ ...report.totals, [report.columns[0].key]: 'TOTAL' }, true);
  }
  if (report.note) doc.font('Helvetica-Oblique').fontSize(7).fillColor('#555').text(clean(report.note), 28, y + 8, { width });
  doc.end();
};

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

router.get('/', protect, requirePermission('reports', 'read'), (req, res) => {
  res.json({
    success: true,
    reports: Object.entries(REPORTS)
      .filter(([, r]) => hasPermission(req.user.role, r.resource, 'read'))
      .map(([key, r]) => ({ key, title: r.title, filters: r.filters, resource: r.resource }))
  });
});

router.get('/:key', protect, requirePermission('reports', 'read'), async (req, res) => {
  const def = REPORTS[req.params.key];
  if (!def) return res.status(404).json({ success: false, error: 'Unknown report' });
  if (!hasPermission(req.user.role, def.resource, 'read')) {
    return res.status(403).json({ success: false, error: `Your role does not permit this report (${def.resource}:read)` });
  }
  try {
    const built = await def.build(req);
    const { from, to } = range(req.query);
    const report = {
      key: req.params.key,
      title: def.title,
      subtitle: def.filters.includes('date')
        ? `${from.toLocaleDateString('en-GB')} – ${to.toLocaleDateString('en-GB')} · ${built.rows.length} row(s)`
        : `As of ${new Date().toLocaleDateString('en-GB')} · ${built.rows.length} row(s)`,
      columns: built.columns,
      rows: built.rows,
      totals: totalsFor(built.columns, built.rows),
      note: built.note || '',
      truncated: built.rows.length >= MAX_ROWS
    };

    const format = String(req.query.format || 'json');
    // Downloading takes the data out of the account, so it is its own grant.
    if (format !== 'json' && !hasPermission(req.user.role, 'reports', 'export')) {
      return res.status(403).json({ success: false, error: 'Your role can view reports but not export them (reports:export)' });
    }
    const filename = `${def.title.replace(/[^\w]+/g, '-')}-${new Date().toISOString().slice(0, 10)}`;
    if (format === 'xlsx') {
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}.xlsx"`);
      return res.send(buildXlsx(report));
    }
    if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}.csv"`);
      return res.send(toCsv(report));
    }
    if (format === 'pdf') return toPdf(res, report, filename);
    res.json({ success: true, report });
  } catch (error) {
    console.error(`[reports] ${req.params.key} failed:`, error.message);
    if (res.headersSent) return res.end();
    res.status(500).json({ success: false, error: 'Failed to build the report' });
  }
});

export default router;
