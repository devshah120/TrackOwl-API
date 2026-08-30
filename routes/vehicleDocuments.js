import express from 'express';
import VehicleDocument, {
  VEHICLE_DOCUMENT_TYPES,
  VEHICLE_DOCUMENT_LABELS
} from '../models/VehicleDocument.js';
import Truck from '../models/Truck.js';
import { protect, requirePermission } from '../middleware/auth.js';
import { auditCreate, auditUpdate, auditDelete } from '../utils/audit.js';
import {
  buildDocumentFields,
  validateAttachment,
  validateDates,
  expiryState,
  EXPIRY_WARN_DAYS
} from '../utils/vehicleDocuments.js';

const router = express.Router();

const ownedBy = (req) => ({ owner: req.accountId });

// Confirms a truck belongs to the caller before a document is filed against it,
// so a client cannot attach paperwork to someone else's vehicle by guessing an
// id. Mirrors resolveTruck in routes/drivers.js.
const ownsTruck = async (req, truckId) => {
  if (!truckId) return false;
  const truck = await Truck.findOne({ _id: truckId, ...ownedBy(req) }).select('_id');
  return Boolean(truck);
};

// The list views show the truck number, so the ref is resolved on the way out.
const withTruck = (query) => query.populate('truck', 'number model');

// Documents come back with their expiry state pre-computed, so the table does
// not have to re-derive the same thresholds the alert scan uses.
const decorate = (doc) => {
  const json = typeof doc.toJSON === 'function' ? doc.toJSON() : doc;
  return {
    ...json,
    expiryState: expiryState(json.expiryDate),
    // The list omits the data URI, so this is how a caller knows a scan exists
    // without downloading it.
    hasAttachment: Boolean(json.attachment?.filename)
  };
};

// GET /api/vehicle-documents/options — the paperwork vocabulary, so the form's
// dropdown is driven by the same list the model validates against.
router.get('/options', protect, requirePermission('trucks', 'read'), (req, res) => {
  res.json({
    success: true,
    options: {
      types: VEHICLE_DOCUMENT_TYPES,
      labels: VEHICLE_DOCUMENT_LABELS,
      warnDays: EXPIRY_WARN_DAYS
    }
  });
});

// GET /api/vehicle-documents — the caller's vehicle documents.
// `?truck=<id>` narrows to one vehicle (what the truck editor asks for);
// `?docType=` and `?state=expired|expiring|valid` filter the list.
//
// Attachments are excluded here: a data URI per row would bloat the response
// well past what the table needs. The client fetches one via GET
// /:id/attachment when the user actually opens it.
router.get('/', protect, requirePermission('trucks', 'read'), async (req, res) => {
  try {
    const query = ownedBy(req);
    if (req.query.truck) query.truck = req.query.truck;
    if (req.query.docType && VEHICLE_DOCUMENT_TYPES.includes(req.query.docType)) {
      query.docType = req.query.docType;
    }

    const documents = await withTruck(
      VehicleDocument.find(query).select('-attachment.dataUrl').sort({ expiryDate: 1, createdAt: -1 })
    );

    // Filtered after the fetch rather than in the query: the state is a
    // function of "now" against three thresholds, and expressing that as a
    // date range per state would duplicate the arithmetic in utils.
    const decorated = documents.map(decorate);
    const state = req.query.state;
    const filtered = state && state !== 'all'
      ? decorated.filter((d) => d.expiryState === state)
      : decorated;

    res.json({ success: true, documents: filtered });
  } catch (error) {
    console.error('[vehicle-documents] list failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to fetch vehicle documents' });
  }
});

// GET /api/vehicle-documents/:id/attachment — the stored scan for one document.
router.get('/:id/attachment', protect, requirePermission('trucks', 'read'), async (req, res) => {
  try {
    const doc = await VehicleDocument.findOne({ _id: req.params.id, ...ownedBy(req) }).select('attachment');
    if (!doc) return res.status(404).json({ success: false, error: 'Document not found' });
    if (!doc.attachment?.dataUrl) {
      return res.status(404).json({ success: false, error: 'No file attached to this document' });
    }
    res.json({ success: true, attachment: doc.attachment });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to fetch document file' });
  }
});

// How a document names itself in the audit trail: the kind of paperwork and
// what it belongs to, since a bare document id means nothing to a reader.
const documentLabel = (doc) =>
  `${VEHICLE_DOCUMENT_LABELS[doc?.docType] || doc?.docType || 'Document'}${doc?.documentNumber ? ` ${doc.documentNumber}` : ''}`;

// POST /api/vehicle-documents — file one document against one of the caller's
// trucks.
router.post('/', protect, requirePermission('trucks', 'create'), async (req, res) => {
  try {
    const body = req.body || {};
    const { fields, invalidType } = buildDocumentFields(body, VEHICLE_DOCUMENT_TYPES);

    if (!fields.docType) {
      return res.status(400).json({ success: false, error: 'Document type is required' });
    }
    if (invalidType) {
      return res.status(400).json({ success: false, error: `Unknown document type: ${fields.docType}` });
    }
    if (!(await ownsTruck(req, body.truck))) {
      return res.status(404).json({ success: false, error: 'Truck not found' });
    }

    const invalid = validateAttachment(fields.attachment) || validateDates(fields.issueDate, fields.expiryDate);
    if (invalid) return res.status(400).json({ success: false, error: invalid });

    const created = await VehicleDocument.create({
      ...fields,
      truck: body.truck,
      owner: req.accountId
    });
    const document = await withTruck(
      VehicleDocument.findById(created._id).select('-attachment.dataUrl')
    );

    await auditCreate(req, {
      entity: 'vehicle_document',
      doc: created,
      label: documentLabel(created),
      fields: ['docType', 'documentNumber', 'issueDate', 'expiryDate', 'issuedBy', 'notes', 'attachment', 'truck']
    });

    res.status(201).json({ success: true, document: decorate(document) });
  } catch (error) {
    if (error.name === 'ValidationError') {
      return res.status(400).json({ success: false, error: error.message });
    }
    console.error('[vehicle-documents] create failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to save vehicle document' });
  }
});

// PUT /api/vehicle-documents/:id — update one of the caller's documents.
router.put('/:id', protect, requirePermission('trucks', 'update'), async (req, res) => {
  try {
    const body = req.body || {};
    const { fields, invalidType } = buildDocumentFields(body, VEHICLE_DOCUMENT_TYPES);
    if (invalidType) {
      return res.status(400).json({ success: false, error: `Unknown document type: ${fields.docType}` });
    }

    // `truck` is only touched when the caller actually sent it, so a plain
    // detail edit does not risk re-homing the document.
    if (body.truck !== undefined) {
      if (!(await ownsTruck(req, body.truck))) {
        return res.status(404).json({ success: false, error: 'Truck not found' });
      }
      fields.truck = body.truck;
    }

    // Dates are cross-checked against what is already stored, so sending only a
    // new expiry still gets validated against the saved issue date.
    // The whole record bar the attachment blob: this read is both the date
    // cross-check and the "before" side of the audit diff.
    const current = await VehicleDocument.findOne({ _id: req.params.id, ...ownedBy(req) })
      .select('-attachment.dataUrl');
    if (!current) return res.status(404).json({ success: false, error: 'Document not found' });

    const issueDate = fields.issueDate !== undefined ? fields.issueDate : current.issueDate;
    const expiryDate = fields.expiryDate !== undefined ? fields.expiryDate : current.expiryDate;

    const invalid = validateAttachment(fields.attachment) || validateDates(issueDate, expiryDate);
    if (invalid) return res.status(400).json({ success: false, error: invalid });

    const document = await withTruck(
      VehicleDocument.findOneAndUpdate(
        { _id: req.params.id, ...ownedBy(req) },
        { $set: fields },
        { new: true, runValidators: true, projection: '-attachment.dataUrl' }
      )
    );
    if (!document) return res.status(404).json({ success: false, error: 'Document not found' });

    await auditUpdate(req, {
      entity: 'vehicle_document',
      before: current,
      after: document,
      fields,
      label: documentLabel(document)
    });

    res.json({ success: true, document: decorate(document) });
  } catch (error) {
    if (error.name === 'ValidationError') {
      return res.status(400).json({ success: false, error: error.message });
    }
    console.error('[vehicle-documents] update failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to update vehicle document' });
  }
});

// DELETE /api/vehicle-documents/:id — remove one of the caller's documents.
router.delete('/:id', protect, requirePermission('trucks', 'delete'), async (req, res) => {
  try {
    const document = await VehicleDocument.findOneAndDelete(
      { _id: req.params.id, ...ownedBy(req) },
      { projection: '-attachment.dataUrl' }
    );
    if (!document) return res.status(404).json({ success: false, error: 'Document not found' });

    await auditDelete(req, {
      entity: 'vehicle_document',
      doc: document,
      label: documentLabel(document),
      fields: ['docType', 'documentNumber', 'issueDate', 'expiryDate', 'issuedBy', 'notes', 'attachment', 'truck']
    });

    res.json({ success: true, message: 'Document removed' });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to delete vehicle document' });
  }
});

export default router;
