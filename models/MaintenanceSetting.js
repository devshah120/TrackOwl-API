import mongoose from 'mongoose';
import { DEFAULT_SETTINGS } from '../utils/maintenance.js';

// The per-account thresholds behind M3-M10's "configurable reminders".
//
// One row per account, created lazily the first time the settings are read or
// saved. An account with no row is not misconfigured — it simply uses the
// shipped defaults from utils/maintenance.js, so reminders work on day one
// without anyone visiting a settings screen. Same arrangement as
// models/FuelSetting.js, and for the same reasons.
const maintenanceSettingSchema = new mongoose.Schema({
  owner: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    unique: true,
    index: true
  },

  // --- Service reminders --------------------------------------------------

  // Days before a date-based service is due that it starts showing as upcoming.
  // Floored at 1 rather than 0: a window of zero would only ever announce a
  // service on the day it fell due, which is not a reminder.
  serviceDueDays: {
    type: Number,
    min: [1, 'The reminder window must be at least a day'],
    max: [365, 'A reminder more than a year ahead is not a reminder'],
    default: DEFAULT_SETTINGS.serviceDueDays
  },

  // Kilometres before a distance-based service is due, likewise.
  serviceDueKm: {
    type: Number,
    min: [50, 'The reminder window must be at least 50 km'],
    max: [50000, 'That window is wider than most service intervals'],
    default: DEFAULT_SETTINGS.serviceDueKm
  },

  // How long an overdue service keeps being counted on the dashboard. It stays
  // on the record either way — this only decides what the tile counts, so a
  // service abandoned two years ago does not sit in the overdue count forever.
  overdueGraceDays: {
    type: Number,
    min: [1, 'The grace period must be at least a day'],
    max: [730, 'The grace period cannot exceed two years'],
    default: DEFAULT_SETTINGS.overdueGraceDays
  },

  // --- Tyre and battery reminders ----------------------------------------

  // Tread depth at which a tyre is called due for replacement. The common
  // legal minimum is 1.6mm, so the floor here is set at it: warning *below*
  // the legal limit would be warning too late to be useful.
  tyreMinTreadMm: {
    type: Number,
    min: [1.6, 'Below 1.6mm is already past the legal minimum'],
    max: [10, 'A new tyre has around 8mm of tread'],
    default: DEFAULT_SETTINGS.tyreMinTreadMm
  },

  // Age at which a battery is flagged regardless of how it is reading.
  batteryLifeMonths: {
    type: Number,
    min: [6, 'Six months is the shortest useful battery life'],
    max: [120, 'Ten years is longer than any commercial battery lasts'],
    default: DEFAULT_SETTINGS.batteryLifeMonths
  },

  // Days before a warranty expires that it is worth surfacing — a failing
  // battery still inside warranty is a claim, not a purchase.
  warrantyWarnDays: {
    type: Number,
    min: [1, 'The warning must be at least a day ahead'],
    max: [180, 'Six months of warning is more than anyone acts on'],
    default: DEFAULT_SETTINGS.warrantyWarnDays
  },

  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

maintenanceSettingSchema.pre('save', function (next) {
  this.updatedAt = new Date();
  next();
});

// The account's thresholds, falling back to the shipped defaults.
//
// Returns a plain object rather than a document, exactly as settingsFor does in
// models/FuelSetting.js: callers only read these, and handing back a document
// invites a stray save from the reminder service, which has no business
// writing settings.
export const settingsFor = async (accountId) => {
  try {
    const row = await mongoose.model('MaintenanceSetting').findOne({ owner: accountId }).lean();
    if (!row) return { ...DEFAULT_SETTINGS };
    return {
      serviceDueDays: row.serviceDueDays ?? DEFAULT_SETTINGS.serviceDueDays,
      serviceDueKm: row.serviceDueKm ?? DEFAULT_SETTINGS.serviceDueKm,
      overdueGraceDays: row.overdueGraceDays ?? DEFAULT_SETTINGS.overdueGraceDays,
      tyreMinTreadMm: row.tyreMinTreadMm ?? DEFAULT_SETTINGS.tyreMinTreadMm,
      batteryLifeMonths: row.batteryLifeMonths ?? DEFAULT_SETTINGS.batteryLifeMonths,
      warrantyWarnDays: row.warrantyWarnDays ?? DEFAULT_SETTINGS.warrantyWarnDays
    };
  } catch (error) {
    // A settings read must never take the maintenance screens down: falling
    // back to the defaults reminds the same way the platform ships, which is
    // the safe answer.
    console.error('[maintenance] settings lookup failed:', error.message);
    return { ...DEFAULT_SETTINGS };
  }
};

export default mongoose.model('MaintenanceSetting', maintenanceSettingSchema);
