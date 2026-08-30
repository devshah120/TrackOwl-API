import AuditLog, { AUDIT_ENTITIES, AUDIT_ACTIONS } from '../models/AuditLog.js';
import { ROLE_LABELS } from './permissions.js';

// The write side of the audit trail. Routes call `recordAudit` (or one of the
// thin wrappers at the bottom) after a change has actually succeeded; this
// module works out which fields moved and files one row.
//
// Two rules hold everywhere in here:
//
//   1. Logging never fails the request. An audit write that throws must not
//      turn a successful truck edit into a 500 — the change already happened,
//      and rolling it back to keep the log tidy would be the wrong trade. Every
//      entry point swallows its own errors to the console.
//
//   2. Nothing sensitive is stored. Passwords, token hashes and base64 blobs
//      never reach the `changes` array; see REDACTED_FIELDS and the value
//      summariser below.
//
// Two mutating endpoints deliberately write no entry:
//
//   POST /api/notifications/:id/read and /read-all — dismissing an alert is not
//     a change to the business record it describes, and logging it would bury
//     the entries that matter under one row per bell click.
//
//   POST /api/traccar/forward — the GPS ingest firehose. A tracker reports every
//     few seconds, so an entry per fix would outgrow every other collection
//     combined and slow the ingest path it sits on. Where the vehicle went is
//     already answered, in full, by the Position collection.

// --------------------------------------------------------------------------
// Field presentation
// --------------------------------------------------------------------------

// Human labels for the fields that show up in a diff. Keyed by the dotted path
// as it appears in the update object, so nested paths ('capacity.weightKg')
// read properly instead of falling back to the raw key.
//
// A path with no entry here is prettified by `humanise` rather than dropped —
// a new field added to a model still shows up in the log, just with a
// mechanically derived label until someone names it here.
const FIELD_LABELS = {
  // Truck
  number: 'Vehicle Number',
  model: 'Model',
  registrationDate: 'Registration Date',
  insuranceExpiry: 'Insurance Expiry',
  vehicleType: 'Vehicle Type',
  make: 'Make',
  manufactureYear: 'Manufacture Year',
  fuelType: 'Fuel Type',
  odometer: 'Odometer (km)',
  status: 'Status',
  currentRoute: 'Current Route',
  'capacity.weightKg': 'Capacity Weight (kg)',
  'capacity.volumeM3': 'Capacity Volume (m³)',
  'capacity.bodyType': 'Body Type',
  'purchase.date': 'Purchase Date',
  'purchase.price': 'Purchase Price',
  'purchase.vendor': 'Purchase Vendor',
  'purchase.financedBy': 'Financed By',
  device: 'Fitted Device',

  // Driver
  name: 'Name',
  mobile: 'Mobile',
  licenseNumber: 'Licence Number',
  licenseExpiry: 'Licence Expiry',
  salary: 'Salary',
  isPrimary: 'Primary Driver',
  truck: 'Assigned Truck',
  joiningDate: 'Joining Date',

  // Trip
  origin: 'From',
  destination: 'To',
  stops: 'Stops',
  note: 'Note',
  distanceKm: 'Distance (km)',
  durationMin: 'Duration (min)',
  startedAt: 'Started At',
  completedAt: 'Completed At',

  // Ledger
  date: 'Date',
  type: 'Type',
  category: 'Category',
  description: 'Description',
  amount: 'Amount',
  paymentMethod: 'Payment Method',
  reference: 'Reference',
  receipt: 'Receipt',

  // Billing
  partyName: 'Party Name',
  lr: 'LR Number',
  bill: 'Bill Number',
  from: 'From',
  to: 'To',
  goods: 'Goods',
  weight: 'Weight',
  rate: 'Rate',
  advance: 'Advance',
  balance: 'Balance',

  // Documents
  documentType: 'Document Type',
  documentNumber: 'Document Number',
  issueDate: 'Issue Date',
  expiryDate: 'Expiry Date',
  issuingAuthority: 'Issuing Authority',
  file: 'Attached File',

  // User / profile
  email: 'Email',
  role: 'Role',
  isActive: 'Active',
  company: 'Company',
  fleet: 'Fleet Size',
  address: 'Address',
  city: 'City',
  gstNumber: 'GST Number',
  panNumber: 'PAN Number',
  signature: 'Signature',
  'bankDetails.accountName': 'Bank Account Name',
  'bankDetails.accountNumber': 'Bank Account Number',
  'bankDetails.bankName': 'Bank Name',
  'bankDetails.ifscCode': 'IFSC Code',
  'bankDetails.branchName': 'Branch Name',

  // Device
  uniqueId: 'Device Identifier',
  lifecycleStatus: 'Lifecycle Status',
  vehicle: 'Fitted To',

  // Role matrix
  grants: 'Permissions'
};

// Turns an unlabelled path into something readable: 'contactPerson' becomes
// 'Contact Person', 'purchase.vendor' becomes 'Purchase Vendor'. The fallback
// for any field nobody has named yet.
const humanise = (path) =>
  String(path)
    .split('.')
    .map((part) =>
      part
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/[_-]+/g, ' ')
        .replace(/^./, (c) => c.toUpperCase())
    )
    .join(' ');

export const labelFor = (path) => FIELD_LABELS[path] || humanise(path);

// Fields whose value must never be written to the log. The change is still
// recorded — knowing a password was changed is the point — but the values are
// replaced with a marker rather than stored.
const REDACTED_FIELDS = new Set([
  'password',
  'newPassword',
  'currentPassword',
  'confirmPassword',
  'token',
  'tokenHash',
  'otp',
  'otpHash',
  'resetToken'
]);

// Fields that hold a base64 blob (a signature, a logo, a scanned receipt).
// Storing the data URI would put megabytes in every log row and tell the reader
// nothing they could not get from "the signature changed", so these are
// summarised down to whether something is there.
const BLOB_FIELDS = new Set([
  'signature',
  'signature.dataUrl',
  'logo',
  'logo.dataUrl',
  'receipt',
  'receipt.dataUrl',
  'file',
  'file.dataUrl',
  'dataUrl'
]);

const isBlobPath = (path) =>
  BLOB_FIELDS.has(path) || /(^|\.)(dataUrl|logo|signature|receipt)$/.test(path);

// --------------------------------------------------------------------------
// Value normalising
// --------------------------------------------------------------------------

// Reduces a stored value to something small, comparable and safe to display.
//
// Dates become ISO strings so a Date and the string it round-tripped through
// compare equal instead of showing as a spurious change; ObjectIds become
// strings for the same reason. Long strings are truncated, arrays are counted,
// and objects keep only the fields a person would recognise (a place has a
// name, a receipt has a filename).
const summariseValue = (value, path = '') => {
  if (value === undefined || value === null) return null;

  if (isBlobPath(path)) {
    // Either it is there or it is not — the bytes are never useful in a log.
    const present =
      typeof value === 'string'
        ? value.length > 0
        : Boolean(value && (value.dataUrl || value.filename));
    return present ? '[file]' : '(none)';
  }

  if (value instanceof Date) return value.toISOString();

  if (typeof value === 'string') {
    // A data URI that reached here without a matching path — truncating it
    // rather than storing it keeps the row small either way.
    if (value.startsWith('data:')) return '[file]';
    return value.length > 500 ? `${value.slice(0, 500)}…` : value;
  }

  if (typeof value === 'number' || typeof value === 'boolean') return value;

  // A Mongoose ObjectId, or anything else that only stringifies usefully.
  if (value?._bsontype === 'ObjectID' || value?.constructor?.name === 'ObjectId') {
    return String(value);
  }

  if (Array.isArray(value)) {
    // Short lists of simple values are worth showing in full; anything longer
    // is reported by its size, which is the part that actually changed.
    if (value.length <= 5 && value.every((v) => typeof v === 'string' || typeof v === 'number')) {
      return value.join(', ');
    }
    // A list of places (trip stops) reads best as its names.
    if (value.length && value.every((v) => v && typeof v === 'object' && 'name' in v)) {
      const names = value.map((v) => v.name).filter(Boolean);
      if (names.length <= 5) return names.join(' → ');
    }
    return `${value.length} item${value.length === 1 ? '' : 's'}`;
  }

  if (typeof value === 'object') {
    // A place ({ name, lat, lng }) is identified by its name.
    if (typeof value.name === 'string' && value.name) return value.name;
    if (typeof value.filename === 'string' && value.filename) return value.filename;

    // Anything else: keep it, but bounded. A bank block or an address is small
    // and worth showing; a document with fifty keys is not.
    const plain = {};
    for (const [k, v] of Object.entries(value)) {
      if (REDACTED_FIELDS.has(k)) continue;
      if (isBlobPath(k)) continue;
      if (v === undefined || v === null || v === '') continue;
      if (typeof v === 'object' && !(v instanceof Date)) continue;
      plain[k] = v instanceof Date ? v.toISOString() : v;
      if (Object.keys(plain).length >= 8) break;
    }
    return Object.keys(plain).length ? plain : null;
  }

  return String(value);
};

// Are two summarised values the same? Compared after normalising so that a
// Date and its ISO string, or 0 and '0', do not register as an edit — a form
// that round-trips a field untouched must not produce a log entry saying it
// changed.
const sameValue = (a, b) => {
  if (a === b) return true;
  if (a === null || a === undefined) return b === null || b === undefined || b === '';
  if (b === null || b === undefined) return a === '';
  if (typeof a === 'object' || typeof b === 'object') {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return String(a) === String(b);
};

// Reads a dotted path out of a document. `diffDocuments` needs this because the
// update objects the routes build use dotted paths for nested fields
// ('capacity.weightKg') while the document itself is nested.
const readPath = (source, path) => {
  if (!source) return undefined;
  const doc = typeof source.toObject === 'function' ? source.toObject() : source;
  return path.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), doc);
};

// --------------------------------------------------------------------------
// Diffing
// --------------------------------------------------------------------------

// Compares a record before and after an update and returns one row per field
// that actually moved.
//
// `fields` is the update object the route built — it names exactly the paths
// the request intended to touch, which is what keeps the diff honest. Comparing
// two whole documents instead would surface Mongoose's own churn (`__v`,
// re-serialised subdocuments) as changes the user never made.
export const diffDocuments = (before, after, fields) => {
  const paths = fields
    ? Object.keys(fields)
    : // No update object (a model-level save): fall back to the union of both
      // sides' own keys, minus the bookkeeping ones.
      [...new Set([...Object.keys(before || {}), ...Object.keys(after || {})])];

  const changes = [];

  for (const path of paths) {
    if (path === '_id' || path === '__v' || path === 'updatedAt' || path === 'owner') continue;

    const rawFrom = readPath(before, path);
    const rawTo = readPath(after, path);

    if (REDACTED_FIELDS.has(path) || REDACTED_FIELDS.has(path.split('.').pop())) {
      // Record that it changed without recording what it became.
      changes.push({ field: path, label: labelFor(path), from: '[redacted]', to: '[redacted]' });
      continue;
    }

    const from = summariseValue(rawFrom, path);
    const to = summariseValue(rawTo, path);

    if (sameValue(from, to)) continue;

    changes.push({ field: path, label: labelFor(path), from, to });
  }

  return changes;
};

// The field list for a newly created record, as `null → value` rows. Gives a
// create the same shape as an update, so the log's detail view has one
// renderer rather than two.
export const snapshotFields = (doc, allow) => {
  const plain = typeof doc?.toObject === 'function' ? doc.toObject() : doc || {};
  const skip = new Set(['_id', '__v', 'owner', 'account', 'createdAt', 'updatedAt']);

  const rows = [];
  for (const [key, value] of Object.entries(plain)) {
    if (skip.has(key)) continue;
    if (allow && !allow.includes(key)) continue;
    if (REDACTED_FIELDS.has(key)) continue;
    if (value === undefined || value === null || value === '') continue;

    const to = summariseValue(value, key);
    if (to === null || to === '') continue;

    rows.push({ field: key, label: labelFor(key), from: null, to });
  }
  return rows;
};

// --------------------------------------------------------------------------
// Summary lines
// --------------------------------------------------------------------------

// How each entity names itself in a sentence.
const ENTITY_LABELS = {
  truck: 'Truck',
  driver: 'Driver',
  trip: 'Trip',
  billing_trip: 'Billing trip',
  ledger_entry: 'Ledger entry',
  vehicle_document: 'Vehicle document',
  driver_document: 'Driver document',
  device: 'Device',
  share_link: 'Tracking link',
  user: 'User',
  company: 'Company',
  profile: 'Profile',
  role_permission: 'Role permissions',
  auth: 'Account'
};

export const entityLabel = (entity) => ENTITY_LABELS[entity] || humanise(entity);

// The one-line description stored on the row. Built here rather than in each
// route so the phrasing stays consistent across twenty-odd call sites, and so a
// route only has to supply its own wording when the default would be wrong.
const buildSummary = ({ entity, action, entityLabel: label, changes = [] }) => {
  const noun = entityLabel(entity);
  const named = label ? `${noun} ${label}` : noun;

  switch (action) {
    case 'create':
      return `${named} created`;
    case 'delete':
      return `${named} deleted`;
    case 'activate':
      return `${named} activated`;
    case 'deactivate':
      return `${named} deactivated`;
    case 'login':
      return 'Signed in';
    case 'logout':
      return 'Signed out';
    case 'login_failed':
      return 'Failed sign-in attempt';
    case 'password_change':
      return 'Password changed';
    case 'password_reset':
      return `Password reset for ${label || 'a user'}`;
    case 'permission_change':
      return `${label || 'Role'} permissions updated`;
    case 'permission_reset':
      return `${label || 'Role'} permissions reset to defaults`;
    case 'update':
    default: {
      if (!changes.length) return `${named} updated`;
      // Name the fields when there are few enough to read; past that, a count
      // is more useful than a wrapped list.
      const names = changes.map((c) => c.label || c.field);
      if (names.length <= 3) return `${named} — changed ${names.join(', ')}`;
      return `${named} — ${names.length} fields changed`;
    }
  }
};

// --------------------------------------------------------------------------
// Writing
// --------------------------------------------------------------------------

// The caller's address, preferring the proxy header because the deployment sits
// behind one — req.ip there is the proxy, which is the same for everybody and
// so tells the reader nothing.
const clientIp = (req) => {
  const forwarded = req?.headers?.['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded) return forwarded.split(',')[0].trim();
  return req?.ip || req?.socket?.remoteAddress || '';
};

// The main entry point. Everything else in this file is in service of this.
//
//   await recordAudit(req, {
//     entity: 'truck',
//     entityId: truck._id,
//     entityLabel: truck.number,
//     action: 'update',
//     changes: diffDocuments(before, truck, fields)
//   });
//
// Awaiting it is optional — it resolves to the created row or to null, and
// never rejects. Most routes await it so the write is ordered before the
// response, but a route on a hot path can safely leave it floating.
export const recordAudit = async (req, entry = {}) => {
  try {
    const {
      entity,
      entityId = null,
      entityLabel: label = '',
      action,
      changes = [],
      summary,
      // Overrides for the account and actor, used by the paths where they are
      // not the authenticated caller: a login (no req.user yet), a Super Admin
      // acting on a client's data, or a failed sign-in with no user at all.
      account,
      actor
    } = entry;

    if (!AUDIT_ENTITIES.includes(entity)) {
      console.error(`[audit] refusing to log unknown entity "${entity}"`);
      return null;
    }
    if (!AUDIT_ACTIONS.includes(action)) {
      console.error(`[audit] refusing to log unknown action "${action}"`);
      return null;
    }

    const user = actor || req?.user || null;

    // An update that changed nothing is not worth a row. The form posts every
    // field on every save, so without this a "Save" on an untouched record
    // would fill the log with entries reporting no change.
    if (action === 'update' && changes.length === 0) return null;

    return await AuditLog.create({
      account: account !== undefined ? account : req?.accountId || null,
      actor: user?._id || null,
      actorName: user?.name || '',
      actorEmail: user?.email || '',
      actorRole: user?.role || '',
      entity,
      entityId,
      entityLabel: label ? String(label).slice(0, 200) : '',
      action,
      summary: summary || buildSummary({ entity, action, entityLabel: label, changes }),
      changes,
      ipAddress: clientIp(req),
      userAgent: String(req?.headers?.['user-agent'] || '').slice(0, 300)
    });
  } catch (error) {
    // Rule 1: the change already succeeded. Losing its log line is bad, but
    // failing the request the user just completed is worse.
    console.error('[audit] failed to record entry:', error.message);
    return null;
  }
};

// --------------------------------------------------------------------------
// Convenience wrappers
// --------------------------------------------------------------------------
// The three shapes that cover almost every call site. They exist so a route
// reads as one line rather than five, and so the create/delete snapshot rules
// are applied the same way everywhere.

// Each wrapper passes `account` and `actor` straight through, so a Super Admin
// route can file its entry against the client it acted on rather than against
// the operator's own id. Left undefined by an ordinary route, `recordAudit`
// falls back to req.accountId and req.user as usual.

// A record was created. `fields` optionally narrows which of its fields are
// snapshotted — worth passing on a model with many defaulted fields nobody set.
export const auditCreate = (req, { entity, doc, label, fields, summary, account, actor }) =>
  recordAudit(req, {
    entity,
    entityId: doc?._id || null,
    entityLabel: label,
    action: 'create',
    changes: snapshotFields(doc, fields),
    summary,
    account,
    actor
  });

// A record was updated. Pass the document as it was before and as it is now,
// plus the update object the route built.
export const auditUpdate = (req, { entity, before, after, fields, label, summary, account, actor }) =>
  recordAudit(req, {
    entity,
    entityId: after?._id || before?._id || null,
    entityLabel: label,
    action: 'update',
    changes: diffDocuments(before, after, fields),
    summary,
    account,
    actor
  });

// A record was deleted. The whole record is gone, so its fields are snapshotted
// as `value → null`: this row is the only remaining copy of what was removed.
export const auditDelete = (req, { entity, doc, label, fields, summary, account, actor }) =>
  recordAudit(req, {
    entity,
    entityId: doc?._id || null,
    entityLabel: label,
    action: 'delete',
    changes: snapshotFields(doc, fields).map((c) => ({ ...c, from: c.to, to: null })),
    summary,
    account,
    actor
  });

// The role label for an actor, for display. Falls back to the raw role so an
// entry written under a role that has since been removed still reads.
export const actorRoleLabel = (role) => ROLE_LABELS[role] || humanise(role || '');
