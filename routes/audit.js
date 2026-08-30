import express from 'express';
import AuditLog, { AUDIT_ENTITIES, AUDIT_ACTIONS } from '../models/AuditLog.js';
import User from '../models/User.js';
import { protect, requirePermission } from '../middleware/auth.js';
import { entityLabel } from '../utils/audit.js';
import { ROLE_LABELS } from '../utils/permissions.js';

const router = express.Router();

// Read-only by design. There is no POST, PUT or DELETE on this router and there
// should never be one: entries are written by utils/audit.js as a side effect of
// the change they describe, and a trail an operator can edit is not evidence of
// anything. Retention trimming, if it is ever needed, belongs in a maintenance
// script rather than behind an HTTP verb.

// The audit trail describes an account's own activity, so it is scoped the same
// way every other collection is. A Super Admin reads across accounts through
// /api/admin/audit instead.
const ownedBy = (req) => ({ account: req.accountId });

// Display names for the actions. Kept here rather than in the model because
// they are presentation, and the model's enum is the thing that must not drift.
const ACTION_LABELS = {
  create: 'Created',
  update: 'Updated',
  delete: 'Deleted',
  login: 'Signed in',
  logout: 'Signed out',
  login_failed: 'Failed sign-in',
  password_change: 'Password changed',
  password_reset: 'Password reset',
  activate: 'Activated',
  deactivate: 'Deactivated',
  permission_change: 'Permissions changed',
  permission_reset: 'Permissions reset'
};

// Page size. Generous enough that the common "show me today" never paginates,
// capped so a client asking for everything cannot pull an account's entire
// history into one response.
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

// Turns the query string into a Mongo filter, ignoring anything unrecognised
// rather than erroring — a stale bookmark with a since-removed entity should
// show an unfiltered list, not a 400.
const buildFilter = (req, scope) => {
  const filter = { ...scope };

  if (req.query.entity && AUDIT_ENTITIES.includes(req.query.entity)) {
    filter.entity = req.query.entity;
  }
  if (req.query.action && AUDIT_ACTIONS.includes(req.query.action)) {
    filter.action = req.query.action;
  }
  if (req.query.actor && /^[0-9a-fA-F]{24}$/.test(req.query.actor)) {
    filter.actor = req.query.actor;
  }
  if (req.query.entityId && /^[0-9a-fA-F]{24}$/.test(req.query.entityId)) {
    filter.entityId = req.query.entityId;
  }

  // Date range. `to` is pushed to the end of its day so a single-day filter
  // (from = to = today) returns that day rather than nothing.
  const range = {};
  const from = req.query.from ? new Date(req.query.from) : null;
  const to = req.query.to ? new Date(req.query.to) : null;
  if (from && !Number.isNaN(from.getTime())) range.$gte = from;
  if (to && !Number.isNaN(to.getTime())) {
    to.setHours(23, 59, 59, 999);
    range.$lte = to;
  }
  if (Object.keys(range).length) filter.createdAt = range;

  // Free-text search across the parts a person would type: what was changed,
  // who changed it, and the one-line summary. Escaped before it becomes a
  // regex so a stray '(' in the box is a character to find, not a syntax error.
  const search = String(req.query.search || '').trim();
  if (search) {
    const safe = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rx = new RegExp(safe, 'i');
    filter.$or = [
      { entityLabel: rx },
      { summary: rx },
      { actorName: rx },
      { actorEmail: rx }
    ];
  }

  return filter;
};

const readPaging = (req) => {
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(req.query.limit) || DEFAULT_LIMIT));
  const page = Math.max(1, Number(req.query.page) || 1);
  return { limit, page, skip: (page - 1) * limit };
};

// The shared list handler. Both the account view and the platform-wide admin
// view run the same query against a different scope, so they share this rather
// than keeping two copies of the filter and paging logic in step.
const listEntries = async (req, res, scope) => {
  const filter = buildFilter(req, scope);
  const { limit, page, skip } = readPaging(req);

  // Count alongside the page so the UI can render "showing 1–50 of 812" and
  // know whether a next page exists, rather than inferring it from a short page.
  const [entries, total] = await Promise.all([
    AuditLog.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    AuditLog.countDocuments(filter)
  ]);

  res.json({
    success: true,
    entries,
    page,
    limit,
    total,
    hasMore: skip + entries.length < total
  });
};

// GET /api/audit/options — the vocabularies the filter bar is built from: the
// entity and action lists with their labels, and the people who actually appear
// in this account's trail.
//
// The actor list is derived from the log itself rather than from the roster, so
// a user who has since been removed is still selectable — their entries did not
// disappear with them, and filtering to them is exactly what an investigation
// needs.
router.get('/options', protect, requirePermission('reports', 'read'), async (req, res) => {
  try {
    const actorIds = await AuditLog.distinct('actor', ownedBy(req));
    const known = actorIds.filter(Boolean);

    // Names come from the roster where the user still exists, and from the
    // denormalised copy on their entries where they do not.
    const [users, fallbacks] = await Promise.all([
      User.find({ _id: { $in: known } }).select('name email role').lean(),
      AuditLog.aggregate([
        { $match: { ...ownedBy(req), actor: { $in: known } } },
        { $group: { _id: '$actor', name: { $last: '$actorName' }, email: { $last: '$actorEmail' } } }
      ])
    ]);

    const byId = new Map(users.map((u) => [String(u._id), u]));
    const actors = fallbacks.map((f) => {
      const live = byId.get(String(f._id));
      return {
        id: String(f._id),
        name: live?.name || f.name || 'Unknown user',
        email: live?.email || f.email || '',
        role: live?.role || '',
        // Flags a seat that no longer exists, so the picker can say so instead
        // of showing a name that is no longer on the team.
        removed: !live
      };
    }).sort((a, b) => a.name.localeCompare(b.name));

    res.json({
      success: true,
      options: {
        entities: AUDIT_ENTITIES.map((e) => ({ value: e, label: entityLabel(e) })),
        actions: AUDIT_ACTIONS.map((a) => ({ value: a, label: ACTION_LABELS[a] || a })),
        actors,
        roleLabels: ROLE_LABELS
      }
    });
  } catch (error) {
    console.error('[audit] options failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to load audit filters' });
  }
});

// GET /api/audit/stats — headline counts for the strip above the table: how
// much activity there has been, and where it came from.
//
// Computed server-side because the answer spans the whole trail, not the page
// the client is holding — counting the visible rows would report "12 changes
// today" when it means "12 on this page".
router.get('/stats', protect, requirePermission('reports', 'read'), async (req, res) => {
  try {
    const scope = ownedBy(req);
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const [total, today, week, byAction, byEntity] = await Promise.all([
      AuditLog.countDocuments(scope),
      AuditLog.countDocuments({ ...scope, createdAt: { $gte: dayAgo } }),
      AuditLog.countDocuments({ ...scope, createdAt: { $gte: weekAgo } }),
      AuditLog.aggregate([
        { $match: scope },
        { $group: { _id: '$action', count: { $sum: 1 } } },
        { $sort: { count: -1 } }
      ]),
      AuditLog.aggregate([
        { $match: scope },
        { $group: { _id: '$entity', count: { $sum: 1 } } },
        { $sort: { count: -1 } }
      ])
    ]);

    res.json({
      success: true,
      stats: {
        total,
        today,
        week,
        byAction: byAction.map((r) => ({ action: r._id, label: ACTION_LABELS[r._id] || r._id, count: r.count })),
        byEntity: byEntity.map((r) => ({ entity: r._id, label: entityLabel(r._id), count: r.count }))
      }
    });
  } catch (error) {
    console.error('[audit] stats failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to load audit summary' });
  }
});

// GET /api/audit/export — the filtered trail as CSV, for handing to an auditor
// or keeping outside the system.
//
// Streams the same filter the table is showing rather than everything, so what
// is exported is what was on screen. Capped well above a page but short of
// unbounded: a spreadsheet is not the right home for a hundred thousand rows,
// and building one in memory would be a way to take the API down.
const EXPORT_LIMIT = 5000;

router.get('/export', protect, requirePermission('reports', 'read'), async (req, res) => {
  try {
    const filter = buildFilter(req, ownedBy(req));
    const entries = await AuditLog.find(filter).sort({ createdAt: -1 }).limit(EXPORT_LIMIT).lean();

    // Excel reads a leading '=', '+', '-' or '@' as a formula, so a value
    // starting with one is prefixed with a quote. Quotes are doubled and the
    // whole field wrapped, which is the CSV escape for embedded commas and
    // newlines both.
    const cell = (value) => {
      if (value === null || value === undefined) return '""';
      let text = typeof value === 'object' ? JSON.stringify(value) : String(value);
      if (/^[=+\-@]/.test(text)) text = `'${text}`;
      return `"${text.replace(/"/g, '""')}"`;
    };

    const header = [
      'Date/Time', 'User', 'Email', 'Role', 'Action', 'Entity', 'Record',
      'Field', 'Old Value', 'New Value', 'Summary', 'IP Address'
    ];

    const rows = [header.map(cell).join(',')];

    for (const entry of entries) {
      const base = [
        new Date(entry.createdAt).toISOString(),
        entry.actorName || '',
        entry.actorEmail || '',
        ROLE_LABELS[entry.actorRole] || entry.actorRole || '',
        ACTION_LABELS[entry.action] || entry.action,
        entityLabel(entry.entity),
        entry.entityLabel || ''
      ];

      if (!entry.changes?.length) {
        // An action with no field diff (a login, a delete of an empty record)
        // still gets its row — with the field columns blank.
        rows.push([...base, '', '', '', entry.summary || '', entry.ipAddress || ''].map(cell).join(','));
        continue;
      }

      // One line per changed field. A spreadsheet cannot usefully hold a nested
      // list in a cell, and "which field changed" is the column an auditor
      // sorts and filters on.
      for (const change of entry.changes) {
        rows.push(
          [
            ...base,
            change.label || change.field,
            change.from,
            change.to,
            entry.summary || '',
            entry.ipAddress || ''
          ].map(cell).join(',')
        );
      }
    }

    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="audit-log-${stamp}.csv"`);
    // The BOM is what makes Excel open a UTF-8 CSV as UTF-8 rather than as the
    // system codepage, which otherwise mangles the ₹ in a ledger amount.
    res.send(`﻿${rows.join('\r\n')}`);
  } catch (error) {
    console.error('[audit] export failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to export audit log' });
  }
});

// GET /api/audit/entity/:entity/:id — the history of one record, oldest change
// last. Drives the "History" panel on a truck or a trip: everything that has
// happened to this one thing, without the reader having to filter the whole
// account's trail down to it.
router.get('/entity/:entity/:id', protect, requirePermission('reports', 'read'), async (req, res) => {
  try {
    const { entity, id } = req.params;
    if (!AUDIT_ENTITIES.includes(entity)) {
      return res.status(404).json({ success: false, error: 'Unknown entity type' });
    }
    if (!/^[0-9a-fA-F]{24}$/.test(id)) {
      return res.status(400).json({ success: false, error: 'Invalid record id' });
    }

    const entries = await AuditLog.find({ ...ownedBy(req), entity, entityId: id })
      .sort({ createdAt: -1 })
      .limit(MAX_LIMIT)
      .lean();

    res.json({ success: true, entries });
  } catch (error) {
    console.error('[audit] entity history failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to load record history' });
  }
});

// GET /api/audit — the account's trail, newest first, filtered by the query
// string. The main list.
router.get('/', protect, requirePermission('reports', 'read'), async (req, res) => {
  try {
    await listEntries(req, res, ownedBy(req));
  } catch (error) {
    console.error('[audit] list failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to load audit log' });
  }
});

// Exported so the admin router can reuse the list and filter behaviour for its
// platform-wide view instead of reimplementing it.
export { listEntries, buildFilter, ACTION_LABELS };

export default router;
