import crypto from 'crypto';
import dns from 'dns/promises';
import net from 'net';
import Webhook from '../models/Webhook.js';

// Outbound webhook delivery. `emitEvent` is called from the routes and the
// scheduler; it never throws and never blocks the request that caused the
// event — delivery happens after the response, best-effort, with one retry.

const MAX_FAILURES = 20;
const TIMEOUT_MS = 8000;

// A webhook URL is supplied by a customer, and the server will fetch it. Left
// unchecked that is a way to make the server call its own private network
// (the database, the Traccar admin port, a cloud metadata endpoint). So the
// target must be http(s) and resolve only to public addresses.
const isPrivateAddress = (ip) => {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224
    );
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith('::ffff:')) return isPrivateAddress(v6.slice(7));
  return v6 === '::1' || v6 === '::' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80');
};

export const checkWebhookUrl = async (raw) => {
  let url;
  try {
    url = new URL(String(raw || '').trim());
  } catch {
    return 'Enter a full URL, e.g. https://example.com/hooks/trackowl';
  }
  if (!['https:', 'http:'].includes(url.protocol)) return 'The URL must start with https://';
  if (url.username || url.password) return 'Put credentials in the receiver, not in the URL';
  try {
    const addresses = net.isIP(url.hostname) ? [{ address: url.hostname }] : await dns.lookup(url.hostname, { all: true });
    if (!addresses.length) return 'That host name does not resolve';
    if (addresses.some((a) => isPrivateAddress(a.address))) return 'Webhooks must point at a public address';
  } catch {
    return 'That host name does not resolve';
  }
  return null;
};

export const newSecret = () => `whsec_${crypto.randomBytes(24).toString('hex')}`;

const sign = (secret, body) => `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;

const post = async (hook, event, body) => {
  // Re-checked at send time: DNS can be repointed after the hook was saved.
  const problem = await checkWebhookUrl(hook.url);
  if (problem) return { ok: false, status: null, error: problem };
  try {
    const res = await fetch(hook.url, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'TrackOwl-Webhooks/1.0',
        'X-TrackOwl-Event': event,
        'X-TrackOwl-Delivery': crypto.randomUUID(),
        'X-TrackOwl-Signature': sign(hook.secret, body)
      },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    return { ok: res.status >= 200 && res.status < 300, status: res.status, error: res.ok ? '' : `HTTP ${res.status}` };
  } catch (error) {
    return { ok: false, status: null, error: error.name === 'TimeoutError' ? 'Timed out' : error.message };
  }
};

export const deliver = async (hook, event, data) => {
  const body = JSON.stringify({ event, occurredAt: new Date().toISOString(), data });
  let result = await post(hook, event, body);
  if (!result.ok && (result.status === null || result.status >= 500)) {
    await new Promise((r) => setTimeout(r, 2000));
    result = await post(hook, event, body);
  }
  const failures = result.ok ? 0 : (hook.failures || 0) + 1;
  await Webhook.updateOne(
    { _id: hook._id },
    {
      $set: {
        lastDeliveredAt: new Date(),
        lastStatus: result.status,
        lastError: result.error.slice(0, 300),
        failures,
        ...(failures >= MAX_FAILURES ? { active: false } : {})
      }
    }
  ).catch(() => {});
  return result;
};

/**
 * Fire an event at every active webhook of the account subscribed to it.
 * Returns immediately; delivery runs in the background.
 */
export const emitEvent = (owner, event, data) => {
  if (!owner) return;
  setImmediate(async () => {
    try {
      const hooks = await Webhook.find({ owner, active: true, events: event }).lean();
      await Promise.all(hooks.map((hook) => deliver(hook, event, data)));
    } catch (error) {
      console.error(`[webhooks] ${event} dispatch failed:`, error.message);
    }
  });
};
