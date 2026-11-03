import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import path from 'path';
import { fileURLToPath } from 'url';
import authRoutes from './routes/auth.js';
import userRoutes from './routes/user.js';
import usersRoutes from './routes/users.js';
import traccarRoutes from './routes/traccar.js';
import trackRoutes from './routes/track.js';
import tripRoutes from './routes/trips.js';
import truckRoutes from './routes/trucks.js';
import driverRoutes from './routes/drivers.js';
import vehicleDocumentRoutes from './routes/vehicleDocuments.js';
import driverDocumentRoutes from './routes/driverDocuments.js';
import ledgerRoutes from './routes/ledger.js';
import billingRoutes from './routes/billing.js';
import notificationRoutes from './routes/notifications.js';
import adminRoutes from './routes/admin.js';
import geoRoutes from './routes/geo.js';
import historyRoutes from './routes/history.js';
import companyRoutes from './routes/companies.js';
import auditRoutes from './routes/audit.js';
import customerRoutes from './routes/customers.js';
import tripOrderRoutes from './routes/tripOrders.js';
import fuelRoutes from './routes/fuel.js';
import maintenanceRoutes from './routes/maintenance.js';
import componentRoutes from './routes/components.js';
import alertRoutes from './routes/alerts.js';
import invoiceRoutes from './routes/invoices.js';
import vendorRoutes from './routes/vendors.js';
import financeRoutes from './routes/finance.js';
import reportRoutes from './routes/reports.js';
import integrationRoutes from './routes/integrations.js';
import { startScheduler, schedulerStatus } from './services/scheduler.js';
import { startRetention, lastRun as retentionLastRun } from './services/retention.js';
import Position from './models/Position.js';
import { loginLimiter, recoveryLimiter, registerLimiter, securityHeaders } from './middleware/security.js';
import { initRolePermissions } from './services/rolePermissions.js';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 5000;

// The API sits behind nginx on the same host (deploy/trackowl-https.conf), so
// the client's address arrives in X-Forwarded-For. Trusting only the loopback
// hop means that header is believed from nginx and ignored from anyone who
// reaches the port directly — it cannot be forged to dodge the rate limiter.
app.set('trust proxy', 'loopback');
app.disable('x-powered-by');

if (!process.env.JWT_SECRET) {
  console.warn('⚠ JWT_SECRET is not set — sessions are signed with an insecure default. Set it in .env before launch.');
}

// Middleware
app.use(securityHeaders);
// Trips can carry a long OSRM routePolyline (thousands of [lat, lng] points), so
// raise the body limit above the 100kb default to avoid PayloadTooLargeError.
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));
// CORS_ORIGIN accepts a comma-separated list so the deployed frontend and a
// local `npm run dev` session can both reach the API.
const allowedOrigins = (process.env.CORS_ORIGIN || 'http://localhost:5173')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    // No origin: same-origin navigations, curl, and the Traccar forwarder.
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error(`Origin not allowed by CORS: ${origin}`));
  },
  credentials: true
}));

// Static assets for the public tracking page (truck-icon.png, etc).
app.use(express.static(path.join(__dirname, 'public')));

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/trackowl')
  .then(async () => {
    console.log('✓ MongoDB connected');
    // Pull the role permission matrix into memory before serving traffic. If
    // this fails the guards fall back to the built-in defaults rather than
    // denying everything, so a permissions read never takes the API down.
    await initRolePermissions();
    // Background jobs (condition alerts, email digests, webhooks) need the
    // database, so they start only once it is connected.
    startScheduler();
  })
  .catch((err) => console.log('✗ MongoDB connection error:', err));

// Brute-force protection on the endpoints that take a password or an OTP.
// Mounted ahead of the auth router so a throttled request never reaches it.
app.use('/api/auth/login', loginLimiter);
app.use(['/api/auth/forgot-password', '/api/auth/verify-otp', '/api/auth/reset-password'], recoveryLimiter);
app.use('/api/auth/register', registerLimiter);

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/user', userRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/traccar', traccarRoutes);
app.use('/api/track', trackRoutes);
app.use('/api/trips', tripRoutes);
app.use('/api/trucks', truckRoutes);
app.use('/api/drivers', driverRoutes);
app.use('/api/vehicle-documents', vehicleDocumentRoutes);
app.use('/api/driver-documents', driverDocumentRoutes);
app.use('/api/ledger', ledgerRoutes);
app.use('/api/billing-trips', billingRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/history', historyRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/geo', geoRoutes);
app.use('/api/companies', companyRoutes);
app.use('/api/audit', auditRoutes);
// Trip Management: the customer master and the operational trip. Distinct from
// /api/trips (the GPS route record) and /api/billing-trips (the LR/invoice
// paperwork), both of which this module links to rather than replaces.
app.use('/api/customers', customerRoutes);
app.use('/api/trip-orders', tripOrderRoutes);
// Fuel Management: the fuelling register, its efficiency figures and its
// reports. Vehicle-centric — a fuel entry needs a vehicle but not a trip — and
// where one names a trip, it maintains that trip's fuel expense line.
app.use('/api/fuel', fuelRoutes);
// Maintenance Management: scheduled services, repair requests and their
// workflow, plus the reminder engine and the cost reports. Vehicle-centric like
// fuel — a service belongs to a vehicle and to no trip — and it moves a
// vehicle's own status to Maintenance while a repair holds it off the road.
app.use('/api/maintenance', maintenanceRoutes);
// The tyre and battery masters that maintenance tracks. Split out because these
// are asset registers with a fit/remove/scrap lifecycle rather than job cards,
// though both sit behind the same `maintenance` permission resource.
app.use('/api/components', componentRoutes);
// Alerts & Notifications: GPS alert settings, geofences, and the alert history.
app.use('/api/alerts', alertRoutes);
// Invoices & Payments, Vendors, Finance and Reports — the business layer over
// the operational records above. Each reads trips, fuel and maintenance as its
// source rather than keeping a copy, so totals reconcile with those screens.
app.use('/api/invoices', invoiceRoutes);
app.use('/api/vendors', vendorRoutes);
app.use('/api/finance', financeRoutes);
app.use('/api/reports', reportRoutes);
// Integrations: outbound webhooks to other systems (Company Admin only).
app.use('/api/integrations', integrationRoutes);

// Public tracking page. The token is validated by /api/track/public/:token,
// which the page itself calls — this only serves the map shell.
app.get('/track/:token', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'track.html'));
});

// Health check
// Health check. Reports the database connection and how long since the last
// GPS packet arrived, so an uptime monitor can alert on "API up but GPS
// ingestion silently stopped" — the failure that matters most for a tracking
// product. 503 when the database is down, so a plain HTTP check catches it.
app.get('/api/health', async (req, res) => {
  const dbUp = mongoose.connection.readyState === 1;
  let lastGpsAt = null;
  if (dbUp) {
    try {
      const latest = await Position.findOne().sort({ _id: -1 }).select('serverTime').lean();
      lastGpsAt = latest?.serverTime || null;
    } catch {
      lastGpsAt = null;
    }
  }
  const scheduler = schedulerStatus();
  const healthy = dbUp && !scheduler.stale;
  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'ok' : 'degraded',
    message: 'TrackOwl Backend is running',
    database: dbUp ? 'connected' : 'disconnected',
    uptimeSeconds: Math.round(process.uptime()),
    lastGpsAt,
    gpsSilentSeconds: lastGpsAt ? Math.round((Date.now() - new Date(lastGpsAt).getTime()) / 1000) : null,
    // Background jobs (brief §14 "background-job monitoring"): when each last
    // finished and whether it errored. A monitor should alert when
    // `scheduler.stale` is true — the jobs have stopped running.
    scheduler,
    retention: retentionLastRun
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Error handler
app.use((err, req, res, next) => {
  // A body over the size limit or malformed JSON is the client's mistake, and
  // says so, rather than a 500 that reads like the server fell over.
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ success: false, error: 'The upload is too large' });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ success: false, error: 'The request body is not valid JSON' });
  }
  console.error(`[error] ${req.method} ${req.originalUrl}:`, err.stack || err.message);
  res.status(500).json({ success: false, error: 'Internal server error' });
});

// Log what would otherwise kill the process silently. An unhandled rejection
// in a fire-and-forget side effect (an alert, an audit row) should be visible
// in the logs, not crash the API.
process.on('unhandledRejection', (reason) => {
  console.error('[process] unhandled rejection:', reason?.stack || reason);
});

// Retention and archival for GPS history and uploaded documents — both
// opt-in by environment variable; see services/retention.js.
startRetention();

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
