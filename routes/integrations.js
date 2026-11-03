import express from 'express';
import mongoose from 'mongoose';
import Webhook, { WEBHOOK_EVENTS, WEBHOOK_EVENT_LABELS } from '../models/Webhook.js';
import { protect, requireCompanyAdmin } from '../middleware/auth.js';
import { auditCreate, auditUpdate, auditDelete } from '../utils/audit.js';
import { checkWebhookUrl, newSecret, deliver } from '../services/webhooks.js';

// Integrations: the account's outbound webhooks. Company Admin only — a
// webhook sends the account's data to a third party, which is the account
// owner's decision, not a staff seat's.

const router = express.Router();
const ownedBy = (req) => ({ owner: req.accountId });
const isId = (v) => mongoose.Types.ObjectId.isValid(v);

// The secret is shown once, on creation (and on rotation). Lists show only
// its tail so the admin can tell hooks apart.
const present = (hook, { revealSecret = false } = {}) => {
  const h = hook.toObject ? hook.toObject() : { ...hook };
  if (!revealSecret) h.secret = `••••${String(h.secret).slice(-4)}`;
  return h;
};

const cleanEvents = (events) => [...new Set((Array.isArray(events) ? events : []).filter((e) => WEBHOOK_EVENTS.includes(e)))];

router.get('/webhooks/options', protect, requireCompanyAdmin, (req, res) => {
  res.json({ success: true, events: WEBHOOK_EVENTS.map((value) => ({ value, label: WEBHOOK_EVENT_LABELS[value] })) });
});

router.get('/webhooks', protect, requireCompanyAdmin, async (req, res) => {
  try {
    const hooks = await Webhook.find(ownedBy(req)).sort({ createdAt: -1 }).lean();
    res.json({ success: true, webhooks: hooks.map((h) => present(h)) });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to load webhooks' });
  }
});

router.post('/webhooks', protect, requireCompanyAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    const name = String(body.name || '').trim();
    if (!name) return res.status(400).json({ success: false, error: 'Give the webhook a name' });
    const urlProblem = await checkWebhookUrl(body.url);
    if (urlProblem) return res.status(400).json({ success: false, error: urlProblem });
    const events = cleanEvents(body.events);
    if (!events.length) return res.status(400).json({ success: false, error: 'Choose at least one event' });

    const hook = await Webhook.create({ owner: req.accountId, name, url: String(body.url).trim(), events, secret: newSecret(), createdBy: req.user._id });
    await auditCreate(req, { entity: 'webhook', doc: hook, label: name, fields: ['name', 'url', 'events', 'active'] });
    res.status(201).json({ success: true, message: 'Webhook created — copy the signing secret now, it is not shown again', webhook: present(hook, { revealSecret: true }) });
  } catch (error) {
    console.error('[integrations] create failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to create webhook' });
  }
});

router.put('/webhooks/:id', protect, requireCompanyAdmin, async (req, res) => {
  try {
    const before = isId(req.params.id) && (await Webhook.findOne({ _id: req.params.id, ...ownedBy(req) }).lean());
    if (!before) return res.status(404).json({ success: false, error: 'Webhook not found' });
    const body = req.body || {};
    const updates = {};
    if (body.name !== undefined) {
      updates.name = String(body.name).trim();
      if (!updates.name) return res.status(400).json({ success: false, error: 'Name cannot be empty' });
    }
    if (body.url !== undefined) {
      const problem = await checkWebhookUrl(body.url);
      if (problem) return res.status(400).json({ success: false, error: problem });
      updates.url = String(body.url).trim();
    }
    if (body.events !== undefined) {
      updates.events = cleanEvents(body.events);
      if (!updates.events.length) return res.status(400).json({ success: false, error: 'Choose at least one event' });
    }
    if (body.active !== undefined) {
      updates.active = Boolean(body.active);
      // Turning a hook back on is the admin saying it is fixed.
      if (updates.active) updates.failures = 0;
    }
    let revealed = false;
    if (body.rotateSecret) {
      updates.secret = newSecret();
      revealed = true;
    }
    const hook = await Webhook.findOneAndUpdate({ _id: before._id, ...ownedBy(req) }, { $set: updates }, { new: true });
    await auditUpdate(req, { entity: 'webhook', before, after: hook, fields: { name: 1, url: 1, events: 1, active: 1 }, label: hook.name, summary: revealed ? `Webhook ${hook.name} signing secret rotated` : undefined });
    res.json({ success: true, webhook: present(hook, { revealSecret: revealed }) });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to update webhook' });
  }
});

router.delete('/webhooks/:id', protect, requireCompanyAdmin, async (req, res) => {
  try {
    const hook = isId(req.params.id) && (await Webhook.findOneAndDelete({ _id: req.params.id, ...ownedBy(req) }));
    if (!hook) return res.status(404).json({ success: false, error: 'Webhook not found' });
    await auditDelete(req, { entity: 'webhook', doc: hook, label: hook.name, fields: ['name', 'url', 'events'] });
    res.json({ success: true, message: `Webhook ${hook.name} deleted` });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to delete webhook' });
  }
});

// POST /api/integrations/webhooks/:id/test — send a sample event now and
// report what the receiver answered.
router.post('/webhooks/:id/test', protect, requireCompanyAdmin, async (req, res) => {
  try {
    const hook = isId(req.params.id) && (await Webhook.findOne({ _id: req.params.id, ...ownedBy(req) }).lean());
    if (!hook) return res.status(404).json({ success: false, error: 'Webhook not found' });
    const result = await deliver(hook, 'test.ping', { message: 'TrackOwl test delivery', webhook: hook.name });
    res.json({ success: true, result });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Test delivery failed' });
  }
});

export default router;
