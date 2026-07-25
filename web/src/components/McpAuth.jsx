// MCP server health + auth for the /mcp panel. Status is derived from REAL
// availability, not the init-time snapshot: the session's live health map
// (claude.mcp — fed by the init event, live tool results, and per-session
// `claude mcp list` probes under the session's own account) wins, overlaid on
// the daemon's `claude mcp list` and the capability snapshot for names. Rows
// whose server dropped (degraded / needs-reconnect after an account switch)
// get a Reconnect action that restarts the session's claude proc in place —
// the same path as restart_session — which re-establishes the connections.
// Login drives `claude mcp login <name>` server-side (browser OAuth);
// claude.ai connectors apply on the next session.
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { confirmDialog } from '../lib/confirm.js';
import { restartSession } from '../lib/store.js';
import { Icon } from '../lib/icons.js';
import { faRotateRight } from '@fortawesome/free-solid-svg-icons';

const DOT = {
  connected: '#3C9A4E',
  'needs-auth': '#E08A2B',
  pending: '#C9A227',
  degraded: '#E08A2B',
  'needs-reconnect': '#B23B30',
  failed: '#B23B30',
  error: '#B23B30',
  unknown: '#9a9a9a',
};
// Statuses a proc restart actually fixes (vs needs-auth, which needs a login).
const RECONNECTABLE = new Set(['degraded', 'needs-reconnect', 'failed', 'error']);

export default function McpAuth({ session, sessionServers, cwd }) {
  const [fetched, setFetched] = useState(null);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [err, setErr] = useState('');
  const [flow, setFlow] = useState(null); // active login: { name, state, url, error }
  const restarting = session?.claude?.state === 'restarting';

  const load = useCallback(async (force) => {
    try {
      const q = new URLSearchParams();
      if (force) q.set('force', '1');
      if (cwd) q.set('cwd', cwd);
      const qs = q.toString();
      setFetched(await api.get(`/mcp/servers${qs ? `?${qs}` : ''}`));
    } catch (e) {
      setErr(e?.message || String(e));
    }
  }, [cwd]);

  // Trigger the per-session availability probe; the resulting health map
  // arrives through the session-updated broadcast (session.claude.mcp).
  const check = useCallback(async (force) => {
    if (!session?.id) return;
    setChecking(true);
    try {
      await api.post(`/sessions/${session.id}/mcp/check`, { force: !!force });
    } catch {
      /* probe failure just leaves the last verdicts in place */
    } finally {
      setChecking(false);
    }
  }, [session?.id]);

  useEffect(() => { load(false); check(false); }, [load, check]);

  // A reconnect just finished → re-probe so the rows settle to real verdicts
  // (the init event only reports again on the session's next turn).
  const prevRestarting = useRef(false);
  useEffect(() => {
    if (prevRestarting.current && !restarting) check(true);
    prevRestarting.current = restarting;
  }, [restarting, check]);

  // Names: union of the live health map, the session capability snapshot (the
  // complete set — it includes claude.ai connectors the daemon's `claude mcp
  // list` can't see) and the daemon list. Status precedence: live health (the
  // only account-aware, re-validated source) → daemon health check → snapshot.
  const health = session?.claude?.mcp?.servers || {};
  const daemonByName = Object.fromEntries((fetched || []).map((s) => [s.name, s]));
  const capsByName = Object.fromEntries((sessionServers || []).map((s) => [s.name, s]));
  const names = [...new Set([
    ...(sessionServers || []).map((s) => s.name),
    ...Object.keys(health),
    ...(fetched || []).map((s) => s.name),
  ])];
  const servers = names.length
    ? names.map((name) => {
        const h = health[name];
        const d = daemonByName[name];
        const c = capsByName[name];
        return {
          name,
          status: h?.status || d?.status || c?.status || 'unknown',
          statusText: h?.statusText || d?.statusText || c?.status || '',
        };
      })
    : fetched;

  // Poll an in-progress login until it settles, then refresh the list.
  useEffect(() => {
    if (!flow || ['done', 'error', 'idle'].includes(flow.state)) return undefined;
    let live = true;
    let t;
    const poll = async () => {
      try {
        const s = await api.get(`/mcp/login/status?name=${encodeURIComponent(flow.name)}`);
        if (!live) return;
        setFlow(s);
        if (s.state === 'done') { live = false; load(true); return; }
      } catch { /* keep polling */ }
      if (live) t = setTimeout(poll, 1500);
    };
    t = setTimeout(poll, 1000);
    return () => { live = false; clearTimeout(t); };
  }, [flow?.name, flow?.state, load]);

  const login = async (name) => {
    setBusy(true);
    setErr('');
    try {
      setFlow(await api.post('/mcp/login', { name, cwd }));
    } catch (e) {
      setErr(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  };

  const logout = async (name) => {
    const ok = await confirmDialog({
      title: `Sign out of "${name}"?`,
      body: 'Its OAuth credentials are cleared.',
      confirmLabel: 'Sign out',
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    setErr('');
    try {
      await api.post('/mcp/logout', { name, cwd });
      await load(true);
    } catch (e) {
      setErr(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!servers) return <p className="text-[12px] text-fgdim">Loading MCP servers…</p>;

  return (
    <div className="flex flex-col gap-2">
      {err && (
        <div className="rounded-md border border-[#B23B30]/40 bg-[#B23B30]/10 px-2.5 py-1.5 text-[11px] text-[#B23B30]">{err}</div>
      )}
      {servers.map((s) => {
        const active = flow && flow.name === s.name;
        // A just-succeeded login flips the row to connected immediately, before
        // the (static) session snapshot or the slow re-list catches up. A
        // restart in flight beats everything — every connection is being
        // re-established right now.
        const status = restarting ? 'pending' : active && flow.state === 'done' ? 'connected' : s.status;
        const statusText = restarting ? 'reconnecting…' : active && flow.state === 'done' ? 'connected' : s.statusText;
        return (
          <div key={s.name} className="rounded-md border border-hair bg-bg px-3 py-2">
            <div className="flex items-center gap-2.5">
              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: DOT[status] || DOT.unknown }} />
              <span className="min-w-0 flex-1 truncate">
                <span className="font-mono text-[11.5px] text-fg">{s.name}</span>
                <span className="ml-2 font-mono text-[9.5px] text-fgdim">{statusText}</span>
              </span>
              {RECONNECTABLE.has(status) && session && (
                <button
                  type="button"
                  disabled={busy || restarting}
                  onClick={() => restartSession(session)}
                  className="shrink-0 rounded-md border border-border px-2 py-0.5 text-[10.5px] text-fg hover:border-ink disabled:opacity-40"
                >
                  <Icon icon={faRotateRight} /> Reconnect
                </button>
              )}
              {status !== 'connected' && !RECONNECTABLE.has(status) && !restarting && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => login(s.name)}
                  className="shrink-0 rounded-md border border-border px-2 py-0.5 text-[10.5px] text-fg hover:border-ink disabled:opacity-40"
                >
                  🔓 Authenticate
                </button>
              )}
              {status === 'connected' && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => logout(s.name)}
                  className="shrink-0 rounded-md border border-border px-2 py-0.5 text-[10.5px] text-fgdim hover:border-[#B23B30] hover:text-[#B23B30] disabled:opacity-40"
                >
                  Sign out
                </button>
              )}
            </div>
            {active && (flow.state === 'starting' || flow.state === 'awaiting') && (
              <div className="mt-2 pl-5 text-[10.5px] text-fgdim">
                Opening your browser to authorize… complete it there.
                {flow.url && (
                  <a href={flow.url} target="_blank" rel="noreferrer" className="ml-1 text-[#2C6BD6] underline">
                    open link ↗
                  </a>
                )}
              </div>
            )}
            {active && flow.state === 'error' && (
              <div className="mt-2 pl-5 text-[10.5px] text-[#B23B30]">{flow.error || 'login failed'}</div>
            )}
            {active && flow.state === 'done' && (
              <div className="mt-2 pl-5 text-[10.5px] text-[#3C9A4E]">Authorized.</div>
            )}
          </div>
        );
      })}
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <button
          type="button"
          disabled={checking}
          onClick={() => { load(true); check(true); }}
          className="rounded-md border border-border px-2.5 py-1 text-[10.5px] text-fgdim hover:border-ink hover:text-fg disabled:opacity-40"
        >
          <Icon icon={faRotateRight} /> {checking ? 'Checking…' : 'Check now'}
        </button>
        <span className="text-[10px] text-fgdim">
          Status is re-checked live (per-server health check on this session's account).
          Reconnect restarts the session's claude process to re-establish dropped servers.
        </span>
      </div>
    </div>
  );
}
