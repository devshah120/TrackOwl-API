import express from 'express';
import DriverDocument, {
  DRIVER_DOCUMENT_TYPES,
  DRIVER_DOCUMENT_LABELS
} from '../models/DriverDocument.js';
import Driver from '../models/Driver.js';
import { protect, requirePermission } from '../middleware/auth.js';
import {
  buildDocumentFields,
  validateAttachment,
  validateDates,
  expiryState,
  EXPIRY_WARN_DAYS
} from '../utils/vehicleDocuments.js';

const router = express.Router();

const ownedBy = (req) => ({ owner: req.accountId });

// Confirms a driver belongs to the caller before paperwork is filed against
// them, so a client cannot attach documents to another account's driver by
// guessing an id.
const ownsDriver = async (req, driverId) => {
  if (!driverId) return false;
  const driver = await Driver.findOne({ _id: driverId, ...ownedBy(req) }).select('_id');
  return Boolean(driver);
};

// The list views show the driver's name, so the ref is resolved on the way out.
const withDriver = (query) => query.populate('driver', 'name mobile');

const decorate = (doc) => {
  const json = typeof doc.toJSON === 'function' ? doc.toJSON() : doc;
  return {
    ...json,
    expiryState: expiryState(json.expiryDate),
    hasAttachment: Boolean(json.attachment?.filename)
  };
};

// GET /api/driver-documents/options — the driver paperwork vocabulary.
router.get('/options', protect, requirePermission('drivers', 'read'), (req, res) => {
  res.json({
    success: true,
    options: {
      types: DRIVER_DOCUMENT_TYPES,
      labels: DRIVER_DOCUMENT_LABELS,
      warnDays: EXPIRY_WARN_DAYS
    }
  });
});

// GET /api/driver-documents — the caller's driver documents.
// `?driver=<id>` narrows to one driver (what the driver editor asks for);
// `?docType=` and `?state=expired|expiring|valid` filter the list.
//
// Attachments are excluded, as in the vehicle route: the client fetches one via
// GET /:id/attachment only when the user opens it.
router.get('/', protect, requirePermission('drivers', 'read'), async (req, res) => {
  try {
    const query = ownedBy(req);
    if (req.query.driver) query.driver = req.query.driver;
    if (req.query.docType && DRIVER_DOCUMENT_TYPES.includes(req.query.docType)) {
      query.docType = req.query.docType;
    }

    const documents = await withDriver(
      DriverDocument.find(query).select('-attachment.dataUrl').sort({ expiryDate: 1, createdAt: -1 })
    );

    const decorated = documents.map(decorate);
    const state = req.query.state;
    const filtered = state && state !== 'all'
      ? decorated.filter((d) => d.expiryState === state)
      : decorated;

    res.json({ success: true, documents: filtered });
  } catch (error) {
    console.error('[driver-documents] list failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to fetch driver documents' });
  }
});

// GET /api/driver-documents/:id/attachment — the stored scan for one document.
router.get('/:id/attachment', protect, requirePermission('drivers', 'read'), async (req, res) => {
  try {
    const doc = await DriverDocument.findOne({ _id: req.params.id, ...ownedBy(req) }).select('attachment');
    if (!doc) return res.status(404).json({ success: false, error: 'Document not found' });
    if (!doc.attachment?.dataUrl) {
      return res.status(404).json({ success: false, error: 'No file attached to this document' });
    }
    res.json({ success: true, attachment: doc.attachment });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to fetch document file' });
  }
});

// POST /api/driver-documents — file one document against one of the caller's
// drivers.
router.post('/', protect, requirePermission('drivers', 'create'), async (req, res) => {
  try {
    const body = req.body || {};
    const { fields, invalidType } = buildDocumentFields(body, DRIVER_DOCUMENT_TYPES);

    if (!fields.docType) {
      return res.status(400).json({ success: false, error: 'Document type is required' });
    }
    if (invalidType) {
      return res.status(400).json({ success: false, error: `Unknown document type: ${fields.docType}` });
    }
    if (!(await ownsDriver(req, body.driver))) {
      return res.status(404).json({ success: false, error: 'Driver not found' });
    }

    const invalid = validateAttachment(fields.attachment) || validateDates(fields.issueDate, fields.expiryDate);
    if (invalid) return res.status(400).json({ success: false, error: invalid });

    const created = await DriverDocument.create({
      ...fields,
      driver: body.driver,
      owner: req.accountId
    });
    const document = await withDriver(
      DriverDocument.findById(created._id).select('-attachment.dataUrl')
    );

    res.status(201).json({ success: true, document: decorate(document) });
  } catch (error) {
    if (error.name === 'ValidationError') {
      return res.status(400).json({ success: false, error: error.message });
    }
    console.error('[driver-documents] create failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to save driver document' });
  }
});

// PUT /api/driver-documents/:id — update one of the caller's documents.
router.put('/:id', protect, requirePermission('drivers', 'update'), async (req, res) => {
  try {
    const body = req.body || {};
    const { fields, invalidType } = buildDocumentFields(body, DRIVER_DOCUMENT_TYPES);
    if (invalidType) {
      return res.status(400).json({ success: false, error: `Unknown document type: ${fields.docType}` });
    }

    if (body.driver !== undefined) {
      if (!(await ownsDriver(req, body.driver))) {
        return res.status(404).json({ success: false, error: 'Driver not found' });
      }
      fields.driver = body.driver;
    }

    const current = await DriverDocument.findOne({ _id: req.params.id, ...ownedBy(req) })
      .select('issueDate expiryDate');
    if (!current) return res.status(404).json({ success: false, error: 'Document not found' });

    const issueDate = fields.issueDate !== undefined ? fields.issueDate : current.issueDate;
    const expiryDate = fields.expiryDate !== undefined ? fields.expiryDate : current.expiryDate;

    const invalid = validateAttachment(fields.attachment) || validateDates(issueDate, expiryDate);
    if (invalid) return res.status(400).json({ success: false, error: invalid });

    const document = await withDriver(
      DriverDocument.findOneAndUpdate(
        { _id: req.params.id, ...ownedBy(req) },
        { $set: fields },
        { new: true, runValidators: true, projection: '-attachment.dataUrl' }
      )
    );
    if (!document) return res.status(404).json({ success: false, error: 'Document not found' });

    res.json({ success: true, document: decorate(document) });
  } catch (error) {
    if (error.name === 'ValidationError') {
      return res.status(400).json({ success: false, error: error.message });
    }
    console.error('[driver-documents] update failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to update driver document' });
  }
});

// DELETE /api/driver-documents/:id — remove one of the caller's documents.
router.delete('/:id', protect, requirePermission('drivers', 'delete'), async (req, res) => {
  try {
    const document = await DriverDocument.findOneAndDelete({ _id: req.params.id, ...ownedBy(req) });
    if (!document) return res.status(404).json({ success: false, error: 'Document not found' });
    res.json({ success: true, message: 'Document removed' });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to delete driver document' });
  }
});

export default router;
