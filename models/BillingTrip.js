import mongoose from 'mongoose';

// A freight/billing record for a trip: party, LR/bill references, and payment
// status. Distinct from Trip.js (route-planning, origin/destination/device) —
// "truck" here is the plain truck number string, not a Truck ref, matching
// how the UI has always modeled it; avoids a populate/broken-reference risk
// if a truck is later renamed or deleted.
const billingTripSchema = new mongoose.Schema({
  owner: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  truck: { type: String, required: true, trim: true },
  lr: { type: String, trim: true, default: '' },
  bill: { type: String, trim: true, default: '' },
  partyName: { type: String, required: true, trim: true },
  status: {
    type: String,
    enum: ['Paid', 'Partial', 'Pending'],
    default: 'Pending'
  },
  amount: { type: Number, required: true, min: 0 },
  date: { type: Date, required: true },

  // --- Lorry Receipt / Tax Invoice detail ---
  // Everything below is optional: records created before these fields existed
  // stay valid, and the PDF generators leave the matching box blank.
  fromLocation: { type: String, trim: true, default: '' },
  toLocation: { type: String, trim: true, default: '' },

  // Coordinates behind fromLocation/toLocation, captured when the trip is
  // created from the map. The printed documents still use the plain strings
  // above — these exist so the same trip can be drawn as a road route and
  // matched against live GPS. Optional: a trip typed in by hand has no
  // coordinates and simply won't appear on the Trip Routes map.
  originPlace: {
    type: {
      name: { type: String, trim: true, default: '' },
      lat: { type: Number },
      lng: { type: Number }
    },
    default: undefined,
    _id: false
  },
  destinationPlace: {
    type: {
      name: { type: String, trim: true, default: '' },
      lat: { type: Number },
      lng: { type: Number }
    },
    default: undefined,
    _id: false
  },

  // Intermediate stops between originPlace and destinationPlace, in travel
  // order. Mirrors Trip.js's `stops` so the same route can be redrawn here.
  stops: {
    type: [
      {
        name: { type: String, trim: true, default: '' },
        lat: { type: Number },
        lng: { type: Number }
      }
    ],
    default: undefined
  },

  // The route/tracking record created alongside this billing trip, and the GPS
  // device it follows. Set when the trip is created through the wizard with a
  // vehicle that has a tracker; null for paperwork-only trips.
  tripRoute: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Trip',
    default: null
  },
  device: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Device',
    default: null
  },

  // Consignor = supplier (sends the goods), consignee = buyer (receives them).
  // partyName above stays the consignee for the trips table's "Party" column.
  consignor: {
    type: {
      name: { type: String, trim: true, default: '' },
      gst: { type: String, trim: true, default: '' },
      address: { type: String, trim: true, default: '' },
      contact: { type: String, trim: true, default: '' }
    },
    default: () => ({}),
    _id: false
  },
  consignee: {
    type: {
      name: { type: String, trim: true, default: '' },
      gst: { type: String, trim: true, default: '' },
      address: { type: String, trim: true, default: '' },
      contact: { type: String, trim: true, default: '' }
    },
    default: () => ({}),
    _id: false
  },

  goods: {
    type: {
      description: { type: String, trim: true, default: '' },
      quantity: { type: Number, default: 0 },
      // Packaging unit for `quantity` (Boxes, Bags, Kg...). Weight is a mass
      // and carries its own unit, so the two are never conflated on the LR.
      unit: { type: String, trim: true, default: '' },
      weight: { type: Number, default: 0 },
      weightUnit: { type: String, trim: true, default: 'Kg' },
      declaredValue: { type: Number, default: 0 },
      freightRate: { type: Number, default: 0 }
    },
    default: () => ({}),
    _id: false
  },

  // Who settles the GST on this consignment — printed as a tick in the
  // "GST TAX PAYABLE BY" block of the LR.
  gstPayableBy: {
    type: String,
    enum: ['Consignor', 'Consignee', 'Transporter'],
    default: 'Consignee'
  },
  lrCharges: { type: Number, default: 0 },
  invoiceNo: { type: String, trim: true, default: '' },

  // GST percentage applied to the freight on the tax invoice. Stored per trip
  // because the rate can differ by consignment and by client.
  gstRate: { type: Number, default: 0, min: 0, max: 100 },

  // Reference boxes across the top of the tax invoice. Free text — they hold
  // the counterparty's own document numbers, which follow no fixed format.
  references: {
    type: {
      deliveryNote: { type: String, trim: true, default: '' },
      paymentTerms: { type: String, trim: true, default: '' },
      supplierRef: { type: String, trim: true, default: '' },
      otherRef: { type: String, trim: true, default: '' },
      buyerOrderNo: { type: String, trim: true, default: '' },
      buyerOrderDate: { type: String, trim: true, default: '' },
      despatchDocNo: { type: String, trim: true, default: '' },
      deliveryNoteDate: { type: String, trim: true, default: '' },
      despatchedThrough: { type: String, trim: true, default: '' },
      destination: { type: String, trim: true, default: '' },
      termsOfDelivery: { type: String, trim: true, default: '' }
    },
    default: () => ({}),
    _id: false
  },

  driver: {
    type: {
      name: { type: String, trim: true, default: '' },
      mobile: { type: String, trim: true, default: '' },
      licenseNumber: { type: String, trim: true, default: '' }
    },
    default: () => ({}),
    _id: false
  },

  payment: {
    type: {
      method: { type: String, trim: true, default: '' },
      advance: { type: Number, default: 0 },
      balance: { type: Number, default: 0 },
      notes: { type: String, trim: true, default: '' }
    },
    default: () => ({}),
    _id: false
  },

  loadingDate: { type: Date },
  deliveryDate: { type: Date },
  documents: {
    type: {
      tax: { type: Boolean, default: false },
      lr: { type: Boolean, default: false },
      goods: { type: Boolean, default: false }
    },
    default: () => ({ tax: false, lr: false, goods: false }),
    _id: false
  },

  createdAt: { type: Date, default: Date.now }
});

export default mongoose.model('BillingTrip', billingTripSchema);
