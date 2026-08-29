// Remote access toggle — drive Tailscale `serve` so the cockpit is reachable
// from your other tailnet devices (phone) over HTTPS. This is `serve` (private
// to YOUR tailnet, encrypted, real cert) — never `funnel` (which is public).
//
// One-way dependency: imports lib/config only. Shells out to the tailscale CLI;
// every failure is returned as a message for the UI rather than thrown.
import { cfg } from './lib/config.js';

const CANDIDATES = [
  'tailscale',
  // macOS
  '/opt/homebrew/bin/tailscale',
  '/usr/local/bin/tailscale',
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
  // Windows (the MSI installs outside PATH by default)
  'C:\\Program Files\\Tailscale\\tailscale.exe',
  'C:\\Program Files (x86)\\Tailscale\\tailscale.exe',
];

let cliPath = null;
function findCli() {
  if (cliPath) return cliPath;
  for (const c of CANDIDATES) {
    try {
      if (Bun.spawnSync([c, 'version']).exitCode === 0) { cliPath = c; return c; }
    } catch {}
  }
  return null;
}

function run(args) {
  const cli = findCli();
  if (!cli) return { ok: false, code: 127, out: '', err: 'tailscale CLI not found' };
  try {
    const r = Bun.spawnSync([cli, ...args]);
    return {
      ok: r.exitCode === 0,
      code: r.exitCode,
      out: new TextDecoder().decode(r.stdout),
      err: new TextDecoder().decode(r.stderr),
    };
  } catch (e) {
    return { ok: false, code: -1, out: '', err: e.message };
  }
}

// Does a `serve` mapping for our port currently exist?
function isServing() {
  const r = run(['serve', 'status']);
  return r.ok && new RegExp(`(^|\\D)${cfg.port}(\\D|$)`).test(r.out);
}

export function remoteStatus() {
  const cli = findCli();
  if (!cli) return { available: false, reason: 'Tailscale is not installed.' };
  const st = run(['status', '--json']);
  if (!st.ok) {
    return { available: true, loggedIn: false, reason: 'Tailscale is installed but not running — open the app and sign in.' };
  }
  let dns = null, backend = null;
  try {
    const j = JSON.parse(st.out);
    backend = j.BackendState;
    dns = (j.Self?.DNSName || '').replace(/\.$/, '');
  } catch {}
  if (backend !== 'Running') {
    return { available: true, loggedIn: false, reason: 'Tailscale is not connected — sign in to enable remote access.' };
  }
  const serving = isServing();
  return {
    available: true,
    loggedIn: true,
    hostname: dns,
    port: cfg.port,
    // Works the moment Tailscale is up on both devices — no serve, no cert
    // (the host binds all interfaces; the tailnet tunnel encrypts the hop).
    directUrl: dns ? `http://${dns}:${cfg.port}/__host/` : null,
    // The pretty HTTPS URL, only live once `serve` is on (needs HTTPS certs).
    serving,
    httpsUrl: dns && serving ? `https://${dns}/__host/` : null,
  };
}

export function setRemote(enable) {
  const cli = findCli();
  if (!cli) return { ok: false, error: 'Tailscale is not installed.' };
  if (enable) {
    // NOTE: `tailscale serve` can exit 0 while printing an actionable error and
    // creating no config (e.g. "Serve is not enabled on your tailnet" when the
    // tailnet hasn't enabled HTTPS). So we can't trust the exit code — verify by
    // re-reading serve status, and surface the CLI's own message on failure.
    let r = run(['serve', '--bg', String(cfg.port)]);
    if (!isServing()) r = run(['serve', '--bg', '--https=443', `http://127.0.0.1:${cfg.port}`]); // older-CLI form
    if (!isServing()) {
      const msg = [r.err, r.out].map((s) => (s || '').trim()).filter(Boolean).join(' — ');
      const hint = /not enabled|HTTPS|administrator|cert/i.test(msg)
        ? ' Enable HTTPS for your tailnet: Tailscale admin console → DNS → HTTPS Certificates → Enable, then retry.'
        : '';
      return { ok: false, error: (msg || 'Could not enable Tailscale serve.') + hint, ...remoteStatus() };
    }
  } else {
    run(['serve', 'reset']);
  }
  return { ok: true, ...remoteStatus() };
}

// ---- C3 §7.8: Tailscale Funnel for /__api/webhooks ONLY ---------------------------
// Funnel exposes a path to the public internet. The only path we ever mount is
// `/__api/webhooks` — every route under it authenticates itself (server/
// webhooks.ts: share-token / Slack / GitHub / custom HMAC), and the auth gate
// still 401s everything else, so `/__api/sessions` & co. never leave the
// tailnet. Off by default; toggled from Settings → Webhooks.
export const FUNNEL_PATH = '/__api/webhooks';

function funnelState() {
  const r = run(['funnel', 'status']);
  const on = r.ok && r.out.includes(FUNNEL_PATH);
  return { on, raw: r };
}

export function funnelStatus() {
  const base = remoteStatus();
  if (!base.available || !base.loggedIn) return { ...base, funnel: false, funnelUrl: null };
  const { on } = funnelState();
  return { ...base, funnel: on, funnelUrl: on && base.hostname ? `https://${base.hostname}${FUNNEL_PATH}` : null };
}

// After enabling, prove the path really lands on the host: a bare GET on the
// sms route must come back as OUR 401 JSON (not tailscale's 404/502). Tailscale
// versions differ on whether a mount path is stripped before proxying, so we
// try the target with and without the path and keep whichever answers.
async function funnelProbe(hostname) {
  if (!hostname) return false;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 8000);
    const r = await fetch(`https://${hostname}${FUNNEL_PATH}/sms`, { signal: ctl.signal, redirect: 'manual' });
    clearTimeout(t);
    if (r.status !== 401) return false;
    const j = await r.json().catch(() => null);
    return !!j && j.error === 'unauthorized';
  } catch {
    return false;
  }
}

export async function setFunnel(enable) {
  const cli = findCli();
  if (!cli) return { ok: false, error: 'Tailscale is not installed.' };
  if (!enable) {
    let r = run(['funnel', '--bg', `--set-path=${FUNNEL_PATH}`, 'off']);
    if (funnelState().on) r = run(['funnel', `--set-path=${FUNNEL_PATH}`, 'off']);
    if (funnelState().on) return { ok: false, error: [r.err, r.out].map((s) => (s || '').trim()).filter(Boolean).join(' — ') || 'Could not disable Funnel.', ...funnelStatus() };
    return { ok: true, ...funnelStatus() };
  }
  const base = remoteStatus();
  if (!base.loggedIn) return { ok: false, error: base.reason || 'Tailscale is not connected.', ...funnelStatus() };
  const loop = `http://127.0.0.1:${cfg.port}`; // tailscale's target, never shown to people
  const targets = [loop + FUNNEL_PATH, loop];
  let last = null;
  for (const target of targets) {
    last = run(['funnel', '--bg', `--set-path=${FUNNEL_PATH}`, target]);
    if (!funnelState().on) continue;
    if (await funnelProbe(base.hostname)) return { ok: true, verified: true, ...funnelStatus() };
    run(['funnel', '--bg', `--set-path=${FUNNEL_PATH}`, 'off']);
  }
  const msg = [last?.err, last?.out].map((s) => (s || '').trim()).filter(Boolean).join(' — ');
  const hint = /not enabled|funnel|administrator|ACL|nodeAttrs/i.test(msg)
    ? ' Enable Funnel for this node: Tailscale admin console → Access controls → nodeAttrs "funnel" (and HTTPS Certificates under DNS), then retry.'
    : ' The mount was created but the host did not answer through it — check `tailscale funnel status`.';
  return { ok: false, error: (msg || 'Could not enable Tailscale Funnel.') + hint, ...funnelStatus() };
}
