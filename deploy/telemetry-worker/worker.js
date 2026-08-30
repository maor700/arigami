// Arigami telemetry collector — a minimal Cloudflare Worker.
// Accepts the opt-in payload from server/telemetry.ts (docs/TELEMETRY.md),
// validates its shape, and stores it:
//   - Analytics Engine dataset `TELEMETRY` (one data point per event), and/or
//   - KV namespace `TELEMETRY_KV` (last payload per instance id, 90-day TTL).
// Both bindings are optional; whichever is bound is written. Nothing else is
// logged — no IPs, no headers, no user agents.

const MAX_BODY = 64 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const WORD = /^[a-z0-9_-]{1,40}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const EVENTS = new Set([
  'install', 'first_session', 'first_pm_tree', 'first_request_screen', 'first_proposal_applied',
  'first_artifact_published', 'first_share_link', 'first_cron', 'onboarding_step', 'onboarding_done',
]);
const SESSIONS = new Set(['0', '1', '2-5', '6+']);

function validate(p) {
  if (!p || typeof p !== 'object') return 'not an object';
  if (p.v !== 1) return 'unsupported schema version';
  if (!UUID.test(p.id)) return 'bad id';
  if (!ISO.test(p.sentAt)) return 'bad sentAt';
  if (typeof p.version !== 'string' || p.version.length > 40) return 'bad version';
  if (p.commit != null && !/^[0-9a-f]{4,40}$/.test(p.commit)) return 'bad commit';
  if (!WORD.test(p.os) || !WORD.test(p.arch)) return 'bad os/arch';
  if (typeof p.docker !== 'boolean') return 'bad docker';
  if (!SESSIONS.has(p.sessions)) return 'bad sessions';
  if (!Array.isArray(p.events) || p.events.length > 500) return 'bad events';
  for (const e of p.events) {
    if (!e || !EVENTS.has(e.name) || !ISO.test(e.at)) return 'bad event';
    if (e.step != null && !WORD.test(e.step)) return 'bad step';
    if (e.status != null && !WORD.test(e.status)) return 'bad status';
  }
  return null;
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (request.method === 'GET' && url.pathname === '/') return new Response('arigami telemetry collector — POST /v1/events\n', { headers: CORS });
    if (request.method !== 'POST' || url.pathname !== '/v1/events') return new Response('not found', { status: 404, headers: CORS });

    const len = Number(request.headers.get('content-length') || 0);
    if (len > MAX_BODY) return new Response('too large', { status: 413, headers: CORS });
    let payload;
    try {
      payload = await request.json();
    } catch {
      return new Response('bad json', { status: 400, headers: CORS });
    }
    const err = validate(payload);
    if (err) return new Response(err, { status: 400, headers: CORS });

    const day = payload.sentAt.slice(0, 10);
    if (env.TELEMETRY) {
      // One ping row per payload (so active instances can be counted) …
      env.TELEMETRY.writeDataPoint({
        indexes: [payload.id],
        blobs: ['ping', payload.version, payload.os, payload.arch, payload.sessions, day],
        doubles: [payload.docker ? 1 : 0, payload.events.length],
      });
      // … and one row per funnel milestone.
      for (const e of payload.events) {
        env.TELEMETRY.writeDataPoint({
          indexes: [payload.id],
          blobs: [e.name, payload.version, payload.os, e.step || '', e.status || '', e.at.slice(0, 10)],
          doubles: [1],
        });
      }
    }
    if (env.TELEMETRY_KV) {
      await env.TELEMETRY_KV.put(`instance:${payload.id}`, JSON.stringify({ ...payload, events: payload.events.slice(-50) }), {
        expirationTtl: 90 * 24 * 3600,
      });
    }
    return new Response(null, { status: 204, headers: CORS });
  },
};
