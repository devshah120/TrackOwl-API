import express from 'express';
import BillingTrip from '../models/BillingTrip.js';
import Notification from '../models/Notification.js';
import { protect } from '../middleware/auth.js';
import { streamPdf } from '../utils/pdf.js';
import { drawLorryReceipt, drawTaxInvoice, drawGoodsDeclaration } from '../utils/documents.js';

const router = express.Router();

const ownedBy = (req) => ({ owner: req.user._id });

const str = (v) => String(v ?? '').trim();
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

// Nested blocks are rebuilt wholesale rather than merged key-by-key, so a PUT
// that omits a sub-field clears it — matching how the edit form submits the
// whole party/goods block at once.
const partyFields = (p = {}) => ({
  name: str(p.name),
  gst: str(p.gst),
  address: str(p.address),
  contact: str(p.contact)
});

const buildBillingFields = (body) => {
  const fields = {};
  if (body.truck !== undefined) fields.truck = str(body.truck);
  if (body.lr !== undefined) fields.lr = str(body.lr);
  if (body.bill !== undefined) fields.bill = str(body.bill);
  if (body.partyName !== undefined) fields.partyName = str(body.partyName);
  if (body.status !== undefined) fields.status = body.status;
  if (body.amount !== undefined) fields.amount = Number(body.amount);
  if (body.date !== undefined) fields.date = body.date;
  if (body.documents && typeof body.documents === 'object') {
    fields.documents = {
      tax: Boolean(body.documents.tax),
      lr: Boolean(body.documents.lr),
      goods: Boolean(body.documents.goods)
    };
  }

  if (body.fromLocation !== undefined) fields.fromLocation = str(body.fromLocation);
  if (body.toLocation !== undefined) fields.toLocation = str(body.toLocation);
  if (body.invoiceNo !== undefined) fields.invoiceNo = str(body.invoiceNo);
  if (body.gstPayableBy !== undefined) fields.gstPayableBy = body.gstPayableBy;
  if (body.lrCharges !== undefined) fields.lrCharges = num(body.lrCharges);
  if (body.gstRate !== undefined) fields.gstRate = num(body.gstRate);
  if (body.references && typeof body.references === 'object') {
    const r = body.references;
    fields.references = {
      deliveryNote: str(r.deliveryNote),
      paymentTerms: str(r.paymentTerms),
      supplierRef: str(r.supplierRef),
      otherRef: str(r.otherRef),
      buyerOrderNo: str(r.buyerOrderNo),
      buyerOrderDate: str(r.buyerOrderDate),
      despatchDocNo: str(r.despatchDocNo),
      deliveryNoteDate: str(r.deliveryNoteDate),
      despatchedThrough: str(r.despatchedThrough),
      destination: str(r.destination),
      termsOfDelivery: str(r.termsOfDelivery)
    };
  }
  if (body.loadingDate !== undefined) fields.loadingDate = body.loadingDate || undefined;
  if (body.deliveryDate !== undefined) fields.deliveryDate = body.deliveryDate || undefined;

  if (body.consignor && typeof body.consignor === 'object') {
    fields.consignor = partyFields(body.consignor);
  }
  if (body.consignee && typeof body.consignee === 'object') {
    fields.consignee = partyFields(body.consignee);
  }
  if (body.goods && typeof body.goods === 'object') {
    fields.goods = {
      description: str(body.goods.description),
      quantity: num(body.goods.quantity),
      unit: str(body.goods.unit),
      weight: num(body.goods.weight),
      weightUnit: str(body.goods.weightUnit) || 'Kg',
      declaredValue: num(body.goods.declaredValue),
      freightRate: num(body.goods.freightRate)
    };
  }
  if (body.driver && typeof body.driver === 'object') {
    fields.driver = {
      name: str(body.driver.name),
      mobile: str(body.driver.mobile),
      licenseNumber: str(body.driver.licenseNumber)
    };
  }
  if (body.payment && typeof body.payment === 'object') {
    fields.payment = {
      method: str(body.payment.method),
      advance: num(body.payment.advance),
      balance: num(body.payment.balance),
      notes: str(body.payment.notes)
    };
  }

  return fields;
};

// GET /api/billing-trips — the caller's billing trips, newest first.
router.get('/', protect, async (req, res) => {
  try {
    const billingTrips = await BillingTrip.find(ownedBy(req)).sort({ date: -1 });
    res.json({ success: true, billingTrips });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to fetch billing trips' });
  }
});

// POST /api/billing-trips — create a billing trip for the caller.
router.post('/', protect, async (req, res) => {
  try {
    const fields = buildBillingFields(req.body || {});
    if (!fields.truck || !fields.partyName || !fields.date || !Number.isFinite(fields.amount)) {
      return res.status(400).json({ success: false, error: 'Truck, party name, date, and amount are required' });
    }

    const billingTrip = await BillingTrip.create({ ...fields, owner: req.user._id });

    Notification.create({
      owner: req.user._id,
      type: 'event',
      title: 'Trip Added',
      message: `Trip for ${billingTrip.partyName} (${billingTrip.truck}) added — ₹${billingTrip.amount.toLocaleString()}`,
      vehicle: billingTrip.truck
    }).catch((err) => console.error('[billing] notification failed:', err.message));

    res.status(201).json({ success: true, billingTrip });
  } catch (error) {
    console.error('[billing] create failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to create billing trip' });
  }
});

// PUT /api/billing-trips/:id — full update (edit modal + payment recording).
router.put('/:id', protect, async (req, res) => {
  try {
    const fields = buildBillingFields(req.body || {});
    const before = await BillingTrip.findOne({ _id: req.params.id, ...ownedBy(req) }).select('status');
    if (!before) return res.status(404).json({ success: false, error: 'Billing trip not found' });

    const billingTrip = await BillingTrip.findOneAndUpdate(
      { _id: req.params.id, ...ownedBy(req) },
      { $set: fields },
      { new: true, runValidators: true }
    );

    if (fields.status === 'Paid' && before.status !== 'Paid') {
      Notification.create({
        owner: req.user._id,
        type: 'event',
        title: 'Trip Completed',
        message: `Payment recorded for ${billingTrip.partyName} (${billingTrip.truck}) — ₹${billingTrip.amount.toLocaleString()}`,
        vehicle: billingTrip.truck
      }).catch((err) => console.error('[billing] notification failed:', err.message));
    }

    res.json({ success: true, billingTrip });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to update billing trip' });
  }
});

// GET /api/billing-trips/:id/documents/:kind.pdf — render one of the three
// documents for a trip. Auth rides in the query string rather than a header
// because the browser navigates to this URL directly to trigger the download.
const DOCUMENTS = {
  lr: { draw: drawLorryReceipt, prefix: 'Lorry-Receipt' },
  invoice: { draw: drawTaxInvoice, prefix: 'Tax-Invoice' },
  goods: { draw: drawGoodsDeclaration, prefix: 'Goods-Declaration' }
};

router.get('/:id/documents/:kind', protect, async (req, res) => {
  const kind = String(req.params.kind).replace(/\.pdf$/, '');
  const document = DOCUMENTS[kind];
  if (!document) {
    return res.status(404).json({ success: false, error: 'Unknown document type' });
  }

  try {
    const trip = await BillingTrip.findOne({ _id: req.params.id, ...ownedBy(req) });
    if (!trip) return res.status(404).json({ success: false, error: 'Billing trip not found' });

    // Slashes in an LR number would break the Content-Disposition filename.
    const ref = String(trip.lr || trip.bill || trip._id).replace(/[^\w.-]+/g, '-');
    streamPdf(res, `${document.prefix}-${ref}.pdf`, (doc) => {
      document.draw(doc, trip.toObject(), req.user);
    });
  } catch (error) {
    console.error('[billing] document render failed:', error.message);
    // A failure mid-stream cannot be turned into JSON — headers are already out.
    if (res.headersSent) return res.end();
    res.status(500).json({ success: false, error: 'Failed to generate document' });
  }
});

// DELETE /api/billing-trips/:id — remove one of the caller's billing trips.
router.delete('/:id', protect, async (req, res) => {
  try {
    const billingTrip = await BillingTrip.findOneAndDelete({ _id: req.params.id, ...ownedBy(req) });
    if (!billingTrip) return res.status(404).json({ success: false, error: 'Billing trip not found' });
    res.json({ success: true, message: 'Billing trip removed' });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to delete billing trip' });
  }
});

export default router;
