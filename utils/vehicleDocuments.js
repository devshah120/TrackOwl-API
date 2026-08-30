// Shared helpers for the two document collections — VehicleDocument (RC,
// insurance, PUC, fitness, permit, tax) and DriverDocument (licence, ID,
// training). The two models are deliberately separate, but the field shaping,
// the attachment guard and the expiry arithmetic are identical, so they live
// here rather than being written twice and drifting.

// Attachments ride along in the JSON body as data URIs. Base64 inflates by
// ~4/3, so this caps the stored string rather than the original file — roughly
// a 3 MB upload, matching the ledger receipt cap. The browser downscales images
// before sending; this is the backstop for anything that slips through.
export const MAX_ATTACHMENT_CHARS = 4 * 1024 * 1024;

// How far ahead a document counts as "expiring soon". One month is the window
// the office actually works to: an insurance renewal or a PUC retest is
// arranged within it, and it matches the truck-insurance alert that already
// exists in routes/notifications.js.
export const EXPIRY_WARN_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

// Whole days from now until `expiry`. Negative once it has passed. Returns null
// when there is no expiry to measure — an RC or an identity proof does not have
// one, and that is not the same as "expires today".
export const daysUntil = (expiry) => {
  if (!expiry) return null;
  const time = new Date(expiry).getTime();
  if (Number.isNaN(time)) return null;
  return Math.ceil((time - Date.now()) / DAY_MS);
};

// The three states the UI colours on, plus 'none' for a document that never
// expires. Kept here so the API can report it and the frontend does not have to
// re-derive the same thresholds.
export const expiryState = (expiry) => {
  const days = daysUntil(expiry);
  if (days === null) return 'none';
  if (days < 0) return 'expired';
  if (days <= EXPIRY_WARN_DAYS) return 'expiring';
  return 'valid';
};

// Builds a document-shaped update object from a form payload, including only
// the fields the caller actually sent — so a partial save never blanks the rest
// of the record. `types` is the model's enum, used to reject an unknown docType
// before Mongoose does, with a friendlier message.
//
// Absent vs. explicitly emptied are different edits, as in utils/drivers.js: a
// field the caller never sent is skipped by $set, one sent as ''/null becomes
// null so clearing a date on the form actually persists.
export const buildDocumentFields = (body, types) => {
  const fields = {};

  if (body.docType !== undefined) fields.docType = body.docType;
  if (body.documentNumber !== undefined) fields.documentNumber = String(body.documentNumber || '').trim();
  if (body.issuedBy !== undefined) fields.issuedBy = String(body.issuedBy || '').trim();
  if (body.notes !== undefined) fields.notes = String(body.notes || '').trim();
  if (body.issueDate !== undefined) fields.issueDate = body.issueDate || null;
  if (body.expiryDate !== undefined) fields.expiryDate = body.expiryDate || null;

  if (body.attachment !== undefined) {
    const a = body.attachment;
    fields.attachment = a && a.dataUrl
      ? {
          dataUrl: String(a.dataUrl),
          filename: String(a.filename || '').trim(),
          mimeType: String(a.mimeType || '').trim(),
          uploadedAt: new Date()
        }
      : {}; // attachment: null (or a blank one) removes the scan
  }

  return { fields, invalidType: fields.docType !== undefined && !types.includes(fields.docType) };
};

// Rejects an attachment that is not an uploaded file or is too large. Returns
// an error string, or null when the attachment is acceptable (or absent).
export const validateAttachment = (attachment) => {
  if (!attachment?.dataUrl) return null;
  if (!/^data:/.test(attachment.dataUrl)) {
    return 'The document copy must be an uploaded file';
  }
  if (attachment.dataUrl.length > MAX_ATTACHMENT_CHARS) {
    return 'That file is too large — please upload a document under 3 MB';
  }
  return null;
};

// Dates that make no sense together are caught before the save rather than
// showing up later as a document that expired before it was issued.
export const validateDates = (issueDate, expiryDate) => {
  if (!issueDate || !expiryDate) return null;
  if (new Date(expiryDate) < new Date(issueDate)) {
    return 'Expiry date cannot be before the issue date';
  }
  return null;
};
