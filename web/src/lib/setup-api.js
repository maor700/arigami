// S2 — client for the just-in-time setup contract (SPEC-ARIGAMI-JIT-SETUP,
// "shared contracts"). One place that knows the REST routes S1 exposes:
//
//   GET  /__api/setup/capabilities        → { identity, capabilities:[…], audit:[…] }
//   POST /__api/setup/:capability         manual payload per manual.kind
//   POST /__api/setup/:id/skip            "Not now" on a pending card
//   POST /__api/setup/:id/report          { ok, detail?, evidence? } (agent/human)
//   POST /__api/setup/:id/mode            { mode:'auto'|'manual' } — card switch
//   POST /__api/setup/:id/start           consent click → server resolves the
//                                          tool call with {state:'auto'}
//   DELETE /__api/setup/:capability       Disconnect (identity / a provider)
//
// Chat event (kind:'setup') the card renders:
//   { requestId, capability, why, mode, autoCapable, identity:{email}|null,
//     manual:{kind,…}, state:'pending'|'auto'|'done'|'failed'|'skipped'|'timeout',
//     detail?, evidence?:'/__artifacts/<id>/', lines?:[string] }
// Live updates arrive as `setup-update {requestId, …patch}` (store.js patches
// the card in place, like screen-request-answer).
//
// Until S1 is merged the host may 404 on all of the above; every call here
// then falls back to the legacy endpoints the B3 wizard already uses (so the
// components stay testable on an old host), and `overview()` synthesizes the
// capability list from /onboarding/wizard + /whatsapp/status + /remote +
// /telemetry. The fallbacks are explicitly marked and drop out once S1 lands.
import { api } from './api.js';
import { getState, injectLocalChat, patchLocalChat } from './store.js';
import { manualFor, capFamily } from '../components/setup/registry.js';

const is404 = (e) => e?.status === 404;

// Legacy shape adapters — each returns {ok, detail, data} for a capability.
async function legacyOverview() {
  const [wiz, wa, remote, tele] = await Promise.all([
    api.get('/onboarding/wizard').catch(() => null),
    api.get('/whatsapp/status').catch(() => null),
    api.get('/remote').catch(() => null),
    api.get('/telemetry').catch(() => null),
  ]);
  const step = (id) => (wiz?.steps || []).find((s) => s.id === id);
  const caps = [];
  const push = (id, ok, detail, data) => caps.push({ id, ok: !!ok, detail: detail || '', data: data || {}, ...manualFor(id) });
  push('identity', false, '');
  push('claude', step('claude')?.status === 'ok', step('claude')?.detail, step('claude')?.data);
  push('git', step('git')?.status === 'ok', step('git')?.detail, { ...step('git')?.data, ghLogin: wiz?.ghLogin });
  push('whatsapp', wa?.status === 'connected', wa?.user || wa?.status, wa);
  push('composio', !!step('integrations')?.data?.composio, '', step('integrations')?.data);
  push('remote', !!remote?.serving, remote?.httpsUrl || remote?.reason, remote);
  push('telemetry', !!tele?.enabled, tele?.reason, tele);
  push('push', false, '', {});
  push('repo', (step('repo')?.data?.repos || []).length > 0, (step('repo')?.data?.repos || []).join(', '), step('repo')?.data);
  return { identity: null, capabilities: caps, audit: [], legacy: true };
}

// A2: `owner` = 'global' (default) or 'agent:<slug>' — the agent's connections,
// resolved agent-first (each capability says `resolvedFrom`).
const ownerQs = (owner) => (owner && owner !== 'global' ? `?owner=${encodeURIComponent(owner)}` : '');
export const ownerOfAgent = (slug) => (slug ? `agent:${slug}` : 'global');
export const agentOfOwner = (owner) => (typeof owner === 'string' && owner.startsWith('agent:') ? owner.slice(6) : null);

export async function overview({ owner = 'global' } = {}) {
  try {
    const r = await api.get(`/setup/capabilities${ownerQs(owner)}`);
    return {
      owner: r?.owner || 'global',
      identity: r?.identity || null,
      sharedIdentity: r?.sharedIdentity || null,
      capabilities: (r?.capabilities || []).map((c) => ({ ...manualFor(c.id), ...c })),
      audit: r?.audit || [],
    };
  } catch (e) {
    if (!is404(e)) throw e;
    return legacyOverview();
  }
}

// Manual connect for one capability. `payload` depends on manual.kind:
//   token   {token}            oauth  {action:'start'|'code'|'device', id?, code?}
//   qr      {}                 toggle {enable}      repo {entry}      takeover {email?}
export async function connect(capability, payload = {}) {
  try {
    return await api.post(`/setup/${encodeURIComponent(capability)}`, payload);
  } catch (e) {
    if (!is404(e)) throw e;
    return legacyConnect(capability, payload);
  }
}

async function legacyConnect(capability, p) {
  const fam = capFamily(capability);
  switch (fam) {
    case 'claude':
      if (p.token) return api.post('/onboarding/wizard/claude', { action: 'token', token: p.token, label: p.label || 'setup' });
      if (p.action === 'start') return api.post('/accounts/oauth/start', { label: p.label || 'setup' });
      if (p.action === 'code') return api.post('/accounts/oauth/code', { id: p.id, code: p.code });
      if (p.action === 'cancel') return api.post('/accounts/oauth/cancel', { id: p.id });
      break;
    case 'git':
      if (p.token) return api.post('/onboarding/wizard/git', { action: 'token', token: p.token });
      if (p.action === 'device') {
        const r = await api.post('/onboarding/wizard/git', { action: 'gh-login' });
        return { device: r?.ghLogin || null };
      }
      if (p.action === 'poll') {
        const v = await api.get('/onboarding/wizard');
        return { device: v?.ghLogin || null, ok: v?.steps?.find((s) => s.id === 'git')?.status === 'ok' };
      }
      break;
    case 'composio':
      if (p.token) return api.post('/onboarding/wizard/integrations', { action: 'composio-key', key: p.token });
      break;
    case 'whatsapp':
      if (p.action === 'poll') return api.get('/whatsapp/status');
      return api.post('/whatsapp/connect', {});
    case 'remote':
      return api.post('/remote', { enable: !!p.enable });
    case 'telemetry':
      return api.post('/onboarding/wizard/telemetry', { action: p.enable ? 'enable' : 'disable' });
    case 'repo':
      return api.post('/onboarding/repos', p.entry || p);
    default:
      break;
  }
  const err = new Error(`setup: no route for ${capability}`);
  err.status = 501;
  throw err;
}

export const skip = (id) => api.post(`/setup/${encodeURIComponent(id)}/skip`, {});
export const report = (id, body) => api.post(`/setup/${encodeURIComponent(id)}/report`, body);
export const setMode = (id, mode) => api.post(`/setup/${encodeURIComponent(id)}/mode`, { mode });
export const start = (id, mode = 'auto') => api.post(`/setup/${encodeURIComponent(id)}/start`, { mode });
export const disconnect = (capability, owner = 'global') => api.del(`/setup/${encodeURIComponent(capability)}${ownerQs(owner)}`);
// A2: the agent's own view / routine (GET /__api/agents/:slug/{connections,routine}).
export const agentConnections = (slug) => api.get(`/agents/${encodeURIComponent(slug)}/connections`);
export const agentRoutine = (slug) => api.get(`/agents/${encodeURIComponent(slug)}/routine`);

// Settings → Connections → "connect automatically" has no session to run the
// playbook in; spawn one whose first turn is the request_setup call. A2: for
// an agent's connection the session is born from the agent (its Chrome
// profile, its identity) so the playbook connects the agent, not the host.
export async function connectViaSession(capability, { agent = null } = {}) {
  return api.post('/sessions', {
    title: `Connect ${capability}`,
    ...(agent ? { agent } : {}),
    prompt: `Call request_setup({capability: ${JSON.stringify(capability)}, why: "the user asked to connect it from Settings", mode: "auto"}) and follow the matching connect-* skill. Stop after report_setup.`,
    permissionMode: 'bypassPermissions',
  });
}

/* ---------------- dev shim (no S1 host) ----------------------------------
 * In the browser console:  arigamiSetupDemo.card('composio:gmail', {why:'read your inbox'})
 * then  arigamiSetupDemo.patch({state:'auto', lines:['Opening Composio…']})
 * Everything stays in the local store — no server round-trip. Enabled only
 * when localStorage.arigamiSetupDemo === '1'. */
let seq = 0;
export function demoSetupEvent(sessionId, capability, extra = {}) {
  const requestId = `demo-${++seq}`;
  const ev = {
    kind: 'setup',
    ts: Date.now(),
    requestId,
    capability,
    why: extra.why || 'demo',
    autoCapable: manualFor(capability).autoCapable,
    identity: extra.identity === undefined ? null : extra.identity,
    mode: extra.mode || (extra.identity && manualFor(capability).autoCapable ? 'auto' : 'manual'),
    manual: manualFor(capability).manual,
    state: 'pending',
    ...extra,
  };
  injectLocalChat(sessionId, ev);
  return ev;
}
export function demoSetupPatch(sessionId, requestId, patch) {
  patchLocalChat(sessionId, 'setup', requestId, patch);
}
if (typeof window !== 'undefined') {
  try {
    if (localStorage.getItem('arigamiSetupDemo') === '1') {
      let last = null;
      const sidOf = (sid) => sid || last?.sessionId || getState().sessions.find((x) => !x.archived)?.id;
      window.arigamiSetupDemo = {
        card(capability, extra, sessionId) {
          const sid = sidOf(sessionId);
          last = { ...demoSetupEvent(sid, capability, extra), sessionId: sid };
          return last;
        },
        patch(patch, requestId = last?.requestId, sessionId) {
          demoSetupPatch(sidOf(sessionId), requestId, patch);
        },
      };
    }
  } catch { /* no storage */ }
}
