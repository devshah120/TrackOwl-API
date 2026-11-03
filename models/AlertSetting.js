import mongoose from 'mongoose';

// Per-account switches and thresholds for the GPS alert engine
// (services/gpsAlerts.js). One document per account, created with defaults on
// first read — same pattern as FuelSetting and MaintenanceSetting.
//
// Ignition alerts default to off: every start and stop of every truck is a lot
// of bell, and most offices only want it for specific investigations. The rest
// default on with thresholds that suit Indian highway operation.

const alertSettingSchema = new mongoose.Schema({
  owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },

  overspeed: {
    enabled: { type: Boolean, default: true },
    limitKmh: { type: Number, min: 10, max: 200, default: 80 }
  },

  ignition: {
    enabled: { type: Boolean, default: false }
  },

  // Engine running, vehicle standing still.
  idle: {
    enabled: { type: Boolean, default: true },
    minutes: { type: Number, min: 1, max: 600, default: 20 }
  },

  // Movement inside a window when the fleet should be parked — the classic
  // "truck taken out at 2 a.m." alert. Off until the office sets its hours,
  // because there is no default curfew that fits every operator.
  afterHours: {
    enabled: { type: Boolean, default: false },
    // "HH:MM" in the account's time zone. A window that wraps midnight
    // (22:00 → 05:00) is the normal case and is handled.
    from: { type: String, default: '22:00' },
    to: { type: String, default: '05:00' },
    minSpeedKmh: { type: Number, min: 1, max: 60, default: 10 }
  },

  geofence: {
    enabled: { type: Boolean, default: true }
  },

  // Off the planned road route of the vehicle's active trip (the OSRM line on
  // its linked GPS route) by more than `thresholdM` for `minMinutes`. Waiting
  // a few minutes is what separates a detour from a fuel stop beside the road.
  routeDeviation: {
    enabled: { type: Boolean, default: true },
    thresholdM: { type: Number, min: 200, max: 20000, default: 1000 },
    minMinutes: { type: Number, min: 0, max: 120, default: 3 }
  },

  // Email delivery of new alerts, sent by the background scheduler as one
  // digest per run rather than one mail per alert.
  email: {
    enabled: { type: Boolean, default: false },
    recipients: { type: [String], default: [] },
    // Only alerts at or above this severity are mailed.
    minSeverity: { type: String, enum: ['critical', 'warning', 'info'], default: 'critical' }
  },

  // Document expiry reminders (insurance, PUC, fitness, permit, tax, licence).
  // One bell entry per stage a document passes through — 30, 15 and 7 days out
  // and on the day — then one more when it lapses. Each stage fires once.
  compliance: {
    reminderDays: { type: [Number], default: () => [30, 15, 7, 0] }
  },

  // Put due and overdue services, tyres and batteries in the bell as well as on
  // the Maintenance → Reminders screen.
  maintenanceInBell: { type: Boolean, default: true },

  // Also write alerts onto the vehicle's active trip timeline, so the trip
  // record shows the overspeed or the geofence arrival in context.
  logToTrip: { type: Boolean, default: true },

  timezone: { type: String, default: 'Asia/Kolkata' },

  updatedAt: { type: Date, default: Date.now },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
});

export default mongoose.model('AlertSetting', alertSettingSchema);
