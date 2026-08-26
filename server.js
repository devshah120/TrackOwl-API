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
import ledgerRoutes from './routes/ledger.js';
import billingRoutes from './routes/billing.js';
import notificationRoutes from './routes/notifications.js';
import adminRoutes from './routes/admin.js';
import geoRoutes from './routes/geo.js';
import historyRoutes from './routes/history.js';
import companyRoutes from './routes/companies.js';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
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
  .then(() => console.log('✓ MongoDB connected'))
  .catch((err) => console.log('✗ MongoDB connection error:', err));

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/user', userRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/traccar', traccarRoutes);
app.use('/api/track', trackRoutes);
app.use('/api/trips', tripRoutes);
app.use('/api/trucks', truckRoutes);
app.use('/api/drivers', driverRoutes);
app.use('/api/ledger', ledgerRoutes);
app.use('/api/billing-trips', billingRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/history', historyRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/geo', geoRoutes);
app.use('/api/companies', companyRoutes);

// Public tracking page. The token is validated by /api/track/public/:token,
// which the page itself calls — this only serves the map shell.
app.get('/track/:token', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'track.html'));
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'TrackOwl Backend is running' });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
