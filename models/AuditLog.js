import mongoose from 'mongoose';

// The entities an audit entry can be written against. These name the business
// object the user thinks they changed, not the Mongoose model that happened to
// be written — a driver's licence document is `driver_document`, not a second
// flavour of `driver`, because that is how it appears in the UI.
export const AUDIT_ENTITIES = [
  'truck',
  'driver',
  'trip',
  'billing_trip',
  'ledger_entry',
  'vehicle_document',
  'driver_document',
  'device',
  'share_link',
  'user',
  'company',
  'profile',
  'role_permission',
  'auth'
];

// What was done. `create`/`update`/`delete` cover the CRUD surface; the rest
// name the actions that are not a plain field edit and would otherwise show up
// as an indistinguishable `update`:
//   login / logout / login_failed — the authentication trail
//   password_change  — the user changed their own
//   password_reset   — an admin set someone else's
//   activate / deactivate — a seat or client account switched on or off
//   permission_change / permission_reset — the role matrix was edited
export const AUDIT_ACTIONS = [
  'create',
  'update',
  'delete',
  'login',
  'logout',
  'login_failed',
  'password_change',
  'password_reset',
  'activate',
  'deactivate',
  'permission_change',
  'permission_reset'
];

// One changed field: what it was, and what it became. Values are stored as
// Mixed because a field can be a string, a number, a date or a small object
// (an address, a bank block), and the log has to render whatever it was given
// without knowing the source schema.
//
// `_id: false` — these are display rows inside an entry, never addressed
// individually.
const changeSchema = new mongoose.Schema(
  {
    field: { type: String, required: true },   // dotted path, e.g. 'capacity.weightKg'
    label: { type: String, default: '' },      // human label, e.g. 'Capacity Weight (kg)'
    from: { type: mongoose.Schema.Types.Mixed, default: null },
    to: { type: mongoose.Schema.Types.Mixed, default: null }
  },
  { _id: false }
);

// An immutable record of one change: who, what, the old and new value, and
// when. Nothing in the application updates or deletes these rows — the routes
// only ever insert, and there is no PUT or DELETE on /api/audit — because a
// tamperable audit trail answers no question worth asking.
const auditLogSchema = new mongoose.Schema({
  // The account the change belongs to, which is what scopes every read. Set
  // from req.accountId, so a staff seat's action is filed under the company
  // rather than under the individual — matching how trucks, trips and ledger
  // entries are owned.
  //
  // Null only for platform-level events with no account behind them: a failed
  // login for an unknown email, or a Super Admin editing the role matrix.
  account: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
    index: true
  },

  // --- Who -----------------------------------------------------------------
  // The actor is denormalised rather than only referenced. A log entry has to
  // stay readable after the user is deleted from the roster, and "who changed
  // this?" answered with a dangling ObjectId is not an answer.
  actor: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
    index: true
  },
  actorName: { type: String, trim: true, default: '' },
  actorEmail: { type: String, trim: true, lowercase: true, default: '' },
  actorRole: { type: String, trim: true, default: '' },

  // --- What ----------------------------------------------------------------
  entity: {
    type: String,
    enum: AUDIT_ENTITIES,
    required: true,
    index: true
  },
  // The changed record's id. Kept loose (no ref) because it points into a
  // different collection depending on `entity`, and the row must survive that
  // record being deleted.
  entityId: {
    type: mongoose.Schema.Types.ObjectId,
    default: null,
    index: true
  },
  // How the record identifies itself to a person: a truck number, a driver
  // name, an invoice party. Frozen at write time so a later rename does not
  // rewrite history.
  entityLabel: { type: String, trim: true, default: '' },

  action: {
    type: String,
    enum: AUDIT_ACTIONS,
    required: true,
    index: true
  },

  // One line summarising the entry, composed when it is written. The list view
  // renders this directly rather than trying to reconstruct a sentence from
  // entity/action/changes at read time.
  summary: { type: String, trim: true, default: '' },

  // The old/new pairs. Empty for actions where the question does not apply —
  // a login, or a delete (where the whole record went).
  changes: { type: [changeSchema], default: [] },

  // --- Where from ----------------------------------------------------------
  // Enough to tell two sessions apart when the same login is used from an
  // office machine and a phone. Best-effort: behind a proxy the address is
  // whatever the forwarding header claimed.
  ipAddress: { type: String, trim: true, default: '' },
  userAgent: { type: String, trim: true, default: '' },

  // --- When ----------------------------------------------------------------
  createdAt: { type: Date, default: Date.now, index: true }
});

// The list view is always "this account, newest first", optionally narrowed by
// entity or actor. This compound index serves the common query and its
// filtered variants without a per-filter index each.
auditLogSchema.index({ account: 1, createdAt: -1 });
auditLogSchema.index({ account: 1, entity: 1, createdAt: -1 });
auditLogSchema.index({ account: 1, actor: 1, createdAt: -1 });

// "What happened to this truck?" — the history of one record, which the entity
// timeline endpoint reads.
auditLogSchema.index({ entity: 1, entityId: 1, createdAt: -1 });

export default mongoose.model('AuditLog', auditLogSchema);
