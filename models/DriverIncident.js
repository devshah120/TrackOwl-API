import mongoose from 'mongoose';

// Something recorded against a driver (brief §6 "incident/violation records"):
// a traffic challan, an accident, damage to the vehicle or the load, a
// customer complaint. Distinct from the GPS-detected trip events (overspeed,
// idling, deviation), which are observations; these are the office's record
// of what happened and what it cost.
//
// A fine can be marked recoverable from the driver. That amount is shown on
// the driver profile as "to recover" — it is deliberately not folded into a
// trip settlement, because a challan often arrives weeks after the trip closed.

export const INCIDENT_TYPES = ['traffic_challan', 'accident', 'vehicle_damage', 'cargo_damage', 'theft', 'customer_complaint', 'late_delivery', 'rash_driving', 'other'];

export const INCIDENT_TYPE_LABELS = {
  traffic_challan: 'Traffic challan / fine',
  accident: 'Accident',
  vehicle_damage: 'Vehicle damage',
  cargo_damage: 'Cargo damage / shortage',
  theft: 'Theft',
  customer_complaint: 'Customer complaint',
  late_delivery: 'Late delivery',
  rash_driving: 'Rash driving reported',
  other: 'Other'
};

export const INCIDENT_SEVERITIES = ['minor', 'major', 'critical'];

const incidentSchema = new mongoose.Schema({
  owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  driver: { type: mongoose.Schema.Types.ObjectId, ref: 'Driver', required: true, index: true },
  truck: { type: mongoose.Schema.Types.ObjectId, ref: 'Truck', default: null },
  tripOrder: { type: mongoose.Schema.Types.ObjectId, ref: 'TripOrder', default: null },

  type: { type: String, enum: INCIDENT_TYPES, required: true },
  severity: { type: String, enum: INCIDENT_SEVERITIES, default: 'minor' },
  occurredAt: { type: Date, required: true },
  location: { type: String, trim: true, default: '' },
  description: { type: String, trim: true, default: '' },
  reference: { type: String, trim: true, default: '' }, // challan / FIR / claim number

  fineAmount: { type: Number, min: 0, default: 0 },
  // Of the fine, how much the driver is to bear.
  recoverableAmount: { type: Number, min: 0, default: 0 },
  recoveredAmount: { type: Number, min: 0, default: 0 },

  status: { type: String, enum: ['open', 'resolved'], default: 'open' },
  resolution: { type: String, trim: true, default: '' },

  attachment: {
    dataUrl: { type: String, default: '' },
    filename: { type: String, trim: true, default: '' },
    mimeType: { type: String, trim: true, default: '' }
  },

  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  createdAt: { type: Date, default: Date.now }
});

incidentSchema.index({ owner: 1, driver: 1, occurredAt: -1 });

export default mongoose.model('DriverIncident', incidentSchema);
