import mongoose from 'mongoose';
import { BASELINE_MODES, DEFAULT_SETTINGS } from '../utils/fuel.js';

// The per-account thresholds behind M3-F06's "configurable outliers".
//
// One row per account, created lazily the first time the settings are read or
// saved. An account with no row is not misconfigured — it simply uses the
// shipped defaults from utils/fuel.js, so flagging works on day one without
// anyone visiting a settings screen.
//
// These are deliberately not on Company: the company master is the entity that
// appears on invoices, and burying a tuning knob for the fuel module in it
// would make both harder to reason about.
const fuelSettingSchema = new mongoose.Schema({
  owner: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    unique: true,
    index: true
  },

  // What a vehicle's mileage is judged against — its own history, or the
  // fleet average for the same fuel type. See BASELINE_MODES.
  baselineMode: {
    type: String,
    enum: BASELINE_MODES,
    default: DEFAULT_SETTINGS.baselineMode
  },

  // Percent below the baseline before an entry is flagged as low. Capped at 90
  // rather than 100: a threshold of 100% could never trigger, since mileage
  // cannot fall below zero, and offering it would be offering a setting that
  // silently turns the check off.
  lowEfficiencyPct: {
    type: Number,
    min: [1, 'Threshold must be at least 1%'],
    max: [90, 'Threshold cannot exceed 90%'],
    default: DEFAULT_SETTINGS.lowEfficiencyPct
  },

  // Percent above the baseline before an entry is flagged as implausibly good.
  // Allowed to go higher than the low threshold because good mileage has no
  // upper bound the way bad mileage has a floor.
  highEfficiencyPct: {
    type: Number,
    min: [1, 'Threshold must be at least 1%'],
    max: [500, 'Threshold cannot exceed 500%'],
    default: DEFAULT_SETTINGS.highEfficiencyPct
  },

  // Prior measured fillings a vehicle needs before it is judged at all.
  // Minimum 2: a baseline built from a single measurement is that measurement,
  // and comparing a number against itself is not a test.
  minSamples: {
    type: Number,
    min: [2, 'At least 2 samples are needed for a baseline'],
    max: [50, 'More than 50 samples makes the baseline slow to react'],
    default: DEFAULT_SETTINGS.minSamples
  },

  // How far back the baseline looks. A mileage average reaching back years
  // describes a different vehicle.
  baselineWindowDays: {
    type: Number,
    min: [7, 'The window must be at least a week'],
    max: [1095, 'The window cannot exceed three years'],
    default: DEFAULT_SETTINGS.baselineWindowDays
  },

  // Percent off the recent median rate before the price paid is called
  // unusual.
  rateOutlierPct: {
    type: Number,
    min: [1, 'Threshold must be at least 1%'],
    max: [200, 'Threshold cannot exceed 200%'],
    default: DEFAULT_SETTINGS.rateOutlierPct
  },

  // A single filling larger than this many units is a suspected slipped
  // decimal point.
  maxQuantityPerFill: {
    type: Number,
    min: [1, 'The cap must be at least 1 unit'],
    max: [100000, 'That cap is implausibly large'],
    default: DEFAULT_SETTINGS.maxQuantityPerFill
  },

  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

fuelSettingSchema.pre('save', function (next) {
  this.updatedAt = new Date();
  next();
});

// The account's thresholds, falling back to the shipped defaults.
//
// Returns a plain object rather than a document: callers only read these, and
// handing back a document invites a stray save from the efficiency service,
// which has no business writing settings.
export const settingsFor = async (accountId) => {
  try {
    const row = await mongoose.model('FuelSetting').findOne({ owner: accountId }).lean();
    if (!row) return { ...DEFAULT_SETTINGS };
    return {
      baselineMode: row.baselineMode ?? DEFAULT_SETTINGS.baselineMode,
      lowEfficiencyPct: row.lowEfficiencyPct ?? DEFAULT_SETTINGS.lowEfficiencyPct,
      highEfficiencyPct: row.highEfficiencyPct ?? DEFAULT_SETTINGS.highEfficiencyPct,
      minSamples: row.minSamples ?? DEFAULT_SETTINGS.minSamples,
      baselineWindowDays: row.baselineWindowDays ?? DEFAULT_SETTINGS.baselineWindowDays,
      rateOutlierPct: row.rateOutlierPct ?? DEFAULT_SETTINGS.rateOutlierPct,
      maxQuantityPerFill: row.maxQuantityPerFill ?? DEFAULT_SETTINGS.maxQuantityPerFill
    };
  } catch (error) {
    // A settings read must never take fuel entry down: falling back to the
    // defaults flags the same way the platform ships, which is the safe answer.
    console.error('[fuel] settings lookup failed:', error.message);
    return { ...DEFAULT_SETTINGS };
  }
};

export default mongoose.model('FuelSetting', fuelSettingSchema);
