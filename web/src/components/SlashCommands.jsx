// Slash-command discoverability for the chat input.
//
// Real Claude Code slash commands (e.g. /usage, /context, /compact, plugin
// skills like your-plugin:ticket) already work — they're sent as the text of a
// user message and the CLI executes them (pass-through). What was missing is
// *discovery*: this module surfaces the command surface the running `claude`
// reports in its stream-json `init` event (session.claude.capabilities) as a
// "/" autocomplete palette, plus a Capabilities panel for the inspect-style
// commands the CLI keeps interactive (/mcp, /skills) and can't stream back.
import { useEffect, useState } from 'react';
import { useStore } from '../lib/store.js';
import { UsageBar } from './Usage.jsx';
import McpAuth from './McpAuth.jsx';
import { Icon } from '../lib/icons.js';
import { faXmark } from '@fortawesome/free-solid-svg-icons';

// Open the global Accounts page (optionally straight into the add/auth flow).
const openAccounts = (add) =>
  window.dispatchEvent(new CustomEvent('host:open-accounts', { detail: { add: !!add } }));

// Host-rendered "inspect" commands — NOT sent to claude; they open the panel.
export const INSPECT_COMMANDS = [
  { name: 'usage', desc: 'Account usage — session & weekly, per account', host: true, tab: 'usage' },
  { name: 'status', desc: 'Account status — active account & this session', host: true, tab: 'usage' },
  { name: 'mcp', desc: 'MCP servers, connection status & account auth', host: true, tab: 'mcp' },
  { name: 'skills', desc: 'Available skills', host: true, tab: 'skills' },
  { name: 'tools', desc: 'Available tools', host: true, tab: 'tools' },
  { name: 'agents', desc: 'Available subagents', host: true, tab: 'agents' },
  { name: 'commands', desc: 'Browse every slash command', host: true, tab: 'commands' },
  { name: 'capabilities', desc: 'Model, version & permission mode', host: true, tab: 'info' },
];

// Build the filtered, ranked palette for a `/query`. `commands` are the rich
// objects {name, description, argumentHint} from the initialize handshake.
// Host inspect commands sort first; then prefix matches; then alphabetical.
export function buildSlashItems(query, commands) {
  const q = (query || '').toLowerCase();
  const claude = (commands || []).map((c) => ({
    name: c.name,
    desc: c.description,
    argumentHint: c.argumentHint,
    host: false,
  }));
  const all = [...INSPECT_COMMANDS, ...claude];
  const filtered = q ? all.filter((c) => c.name.toLowerCase().includes(q)) : all;
  filtered.sort((a, b) => {
    const ap = a.name.toLowerCase().startsWith(q) ? 0 : 1;
    const bp = b.name.toLowerCase().startsWith(q) ? 0 : 1;
    if (ap !== bp) return ap - bp;
    if (a.host !== b.host) return a.host ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return filtered.slice(0, 60);
}

const nsOf = (name) => {
  const i = name.indexOf(':');
  return i >= 0 ? name.slice(0, i) : '(built-in)';
};
function groupByNs(names) {
  const groups = {};
  for (const n of [...names].sort()) (groups[nsOf(n)] ||= []).push(n);
  return groups;
}

/* ---------- the "/" autocomplete palette ---------------------------------- */

export function SlashPalette({ items, active, onPick, onHover }) {
  if (!items.length) return null;
  return (
    <div className="absolute bottom-full left-0 mb-1.5 max-h-72 w-[420px] max-w-[92vw] overflow-y-auto rounded-[10px] border-[1.5px] border-ink bg-panel py-1 shadow-[3px_3px_0_rgba(0,0,0,0.18)] thin-scroll">
      <div className="px-3 pt-1 pb-1.5 text-[9.5px] font-bold tracking-wide text-fgdim uppercase">
        Slash commands · ↑↓ navigate · ↵ select · esc dismiss
      </div>
      {items.map((it, i) => (
        <button
          key={(it.host ? 'h:' : 'c:') + it.name}
          type="button"
          onMouseDown={(e) => { e.preventDefault(); onPick(it); }}
          onMouseEnter={() => onHover(i)}
          className={`flex w-full items-baseline gap-2 px-3 py-1.5 text-left ${
            i === active ? 'bg-chip' : ''
          }`}
        >
          <span className="font-mono text-[11.5px] font-bold text-fg">/{it.name}</span>
          {it.host ? (
            <span className="rounded-full bg-brand/30 px-1.5 text-[8.5px] font-bold text-fgdim">host</span>
          ) : (
            it.name.includes(':') && (
              <span className="rounded-full border border-hair px-1.5 text-[8.5px] text-fgdim">
                {nsOf(it.name)}
              </span>
            )
          )}
          {it.desc && <span className="truncate text-[10.5px] text-fgdim">{it.desc}</span>}
        </button>
      ))}
    </div>
  );
}

/* ---------- the Capabilities panel (modal) -------------------------------- */

const MCP_STATUS = {
  connected: '#3C9A4E',
  pending: '#C9A227',
  'needs-auth': '#E08A2B',
  failed: '#B23B30',
  error: '#B23B30',
};

const TABS = [
  ['usage', 'Usage'],
  ['mcp', 'MCP'],
  ['skills', 'Skills'],
  ['tools', 'Tools'],
  ['agents', 'Agents'],
  ['commands', 'Commands'],
  ['info', 'Info'],
];

// The full usage object for an account: live per-account broadcast, else the
// compact lastUsage snapshot from the accounts list, else nothing.
function accountUsageOf(a, accountUsage) {
  const u = accountUsage?.[a.id];
  if (u?.available) return u;
  const lu = a.lastUsage;
  if (lu && !lu.reason) return { available: true, session: { pct: lu.session }, week: { pct: lu.week } };
  return null;
}

// `/usage` + `/status` tab: which account this session runs on, plus every
// account's session/week meters. Reads the accounts store directly.
function AccountsUsageTab({ session, accounts, accountUsage }) {
  const list = accounts?.accounts || [];
  const activeId = accounts?.activeId;
  const sessAccId = session?.claude?.accountId || activeId;
  const labelOf = (id) => list.find((a) => a.id === id)?.label || 'active account';
  if (!list.length) return <Pending />;
  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-md border border-hair bg-bg px-3 py-2 text-[11.5px] text-fgdim">
        This session runs on <span className="font-bold text-fg">{labelOf(sessAccId)}</span>
        {sessAccId === activeId ? ' · the active account' : ' · pinned'}
      </div>
      {list.map((a) => {
        const u = accountUsageOf(a, accountUsage);
        return (
          <div key={a.id} className="rounded-md border border-hair bg-bg px-3 py-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-[11.5px] font-bold text-fg">{a.label}</span>
              {a.active && <span className="rounded-full bg-ink px-1.5 py-0.5 text-[9px] font-bold text-panel">active</span>}
              {(a.email || a.plan) && (
                <span className="text-[10px] text-fgdim">{[a.email, a.plan].filter(Boolean).join(' · ')}</span>
              )}
            </div>
            {u?.available && (u.session || u.week) ? (
              <div className="mt-1">
                <UsageBar label="Session (5h)" win={u.session} sub />
                <UsageBar label="Week" win={u.week} sub />
              </div>
            ) : (
              <div className="mt-1 font-mono text-[10px] text-fgdim">usage unavailable</div>
            )}
          </div>
        );
      })}
      <button
        type="button"
        onClick={() => openAccounts(false)}
        className="self-start rounded-md border border-border px-2.5 py-1 text-[11px] text-fgdim hover:border-ink hover:text-fg"
      >
        Manage accounts →
      </button>
    </div>
  );
}

function Pills({ names, onPick }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {names.map((n) => (
        <button
          key={n}
          type="button"
          onClick={onPick ? () => onPick(n) : undefined}
          className={`rounded-md border border-hair bg-bg px-2 py-1 font-mono text-[10.5px] text-fg ${
            onPick ? 'cursor-pointer hover:border-ink hover:bg-chip' : 'cursor-default'
          }`}
        >
          {n}
        </button>
      ))}
    </div>
  );
}

function Grouped({ names, onPick }) {
  const groups = groupByNs(names);
  const order = Object.keys(groups).sort((a, b) =>
    a === '(built-in)' ? -1 : b === '(built-in)' ? 1 : a.localeCompare(b)
  );
  return (
    <div className="flex flex-col gap-3.5">
      {order.map((ns) => (
        <div key={ns}>
          <div className="mb-1.5 text-[9.5px] font-bold tracking-wide text-fgdim uppercase">
            {ns} · {groups[ns].length}
          </div>
          <Pills names={groups[ns]} onPick={onPick} />
        </div>
      ))}
    </div>
  );
}

// Commands/agents that carry a description: name (clickable) + dimmed description.
function DescList({ items, onPick }) {
  const groups = {};
  for (const it of items) (groups[nsOf(it.name)] ||= []).push(it);
  const order = Object.keys(groups).sort((a, b) =>
    a === '(built-in)' ? -1 : b === '(built-in)' ? 1 : a.localeCompare(b)
  );
  return (
    <div className="flex flex-col gap-3.5">
      {order.map((ns) => (
        <div key={ns}>
          <div className="mb-1 text-[9.5px] font-bold tracking-wide text-fgdim uppercase">
            {ns} · {groups[ns].length}
          </div>
          <div className="flex flex-col">
            {groups[ns].map((it) => (
              <button
                key={it.name}
                type="button"
                onClick={onPick ? () => onPick(it.name) : undefined}
                className={`flex flex-col gap-0.5 rounded-md px-2 py-1.5 text-left ${
                  onPick ? 'cursor-pointer hover:bg-chip' : 'cursor-default'
                }`}
              >
                <span className="font-mono text-[11px] font-bold text-fg">
                  /{it.name}
                  {it.argumentHint && (
                    <span className="ml-1.5 font-normal text-fgdim">{it.argumentHint}</span>
                  )}
                </span>
                {it.description && (
                  <span className="text-[10.5px] leading-snug text-fgdim">{it.description}</span>
                )}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

const Pending = () => (
  <p className="text-[12px] text-fgdim">
    Loads after Claude Code processes its first message in this session.
  </p>
);

export function CapabilitiesPanel({ capabilities, session, initialTab = 'commands', onClose, onPickCommand }) {
  const caps = capabilities || {};
  return (
    <CapBody caps={caps} session={session} initialTab={initialTab} onClose={onClose} onPickCommand={onPickCommand} />
  );
}

function CapBody({ caps, session, initialTab, onClose, onPickCommand }) {
  const [tab, setTab] = useState(initialTab);
  const { accounts, accountUsage } = useStore();
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  // Normalize agents (strings from init, objects from initialize) to {name,…}.
  const agents = (caps.agents || []).map((a) => (typeof a === 'string' ? { name: a } : a));
  const started = !!(caps.commands?.length || caps.slashCommands?.length || caps.mcpServers?.length);
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-3 md:p-6"
      onMouseDown={onClose}
    >
      <div
        className="flex max-h-[80vh] w-[680px] max-w-full flex-col overflow-hidden rounded-[12px] border-[1.5px] border-ink bg-panel shadow-[4px_4px_0_rgba(0,0,0,0.25)]"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-hair px-4 py-3">
          <span className="font-mono text-[13px] font-bold text-fg">Claude Code capabilities</span>
          {caps.model && (
            <span className="rounded-full border border-hair px-2 py-0.5 font-mono text-[10px] text-fgdim">
              {caps.model}
            </span>
          )}
          <button
            type="button"
            onClick={onClose}
            className="ml-auto flex h-7 w-7 cursor-pointer items-center justify-center rounded-md border border-hair text-fgdim hover:border-ink hover:text-fg"
          >
            <Icon icon={faXmark} />
          </button>
        </div>

        <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-hair px-3 pt-2 [scrollbar-width:none]">
          {TABS.map(([id, label]) => {
            const count = {
              mcp: caps.mcpServers?.length,
              skills: caps.skills?.length,
              tools: caps.tools?.length,
              agents: agents.length || undefined,
              commands: caps.commands?.length || caps.slashCommands?.length,
            }[id];
            return (
              <button
                key={id}
                type="button"
                onClick={() => setTab(id)}
                className={`shrink-0 cursor-pointer rounded-t-md px-3 py-1.5 text-[11.5px] ${
                  tab === id
                    ? 'border-b-2 border-ink font-bold text-fg'
                    : 'text-fgdim hover:text-fg'
                }`}
              >
                {label}
                {count != null && <span className="ml-1 text-[9.5px] text-fgdim">{count}</span>}
              </button>
            );
          })}
        </div>

        <div className="thin-scroll min-h-0 flex-1 overflow-y-auto px-4 py-4 text-fg">
          {!started && (
            <p className="mb-3 text-[12px] text-fgdim">
              Claude Code hasn't started for this session yet — send a message to start it.
            </p>
          )}

          {tab === 'usage' && (
            <AccountsUsageTab session={session} accounts={accounts} accountUsage={accountUsage} />
          )}

          {tab === 'mcp' && (
            <McpAuth session={session} sessionServers={caps.mcpServers} cwd={session?.metadata?.worktree || session?.cwd} />
          )}

          {tab === 'skills' &&
            (caps.skills?.length ? (
              <Grouped names={caps.skills} onPick={(n) => onPickCommand?.(n)} />
            ) : (
              <Pending />
            ))}

          {tab === 'tools' && (caps.tools?.length ? <Pills names={caps.tools} /> : <Pending />)}

          {tab === 'agents' &&
            (agents.length ? <DescList items={agents} /> : <Pending />)}

          {tab === 'commands' &&
            (caps.commands?.length ? (
              <DescList items={caps.commands} onPick={(n) => onPickCommand?.(n)} />
            ) : caps.slashCommands?.length ? (
              <Grouped names={caps.slashCommands} onPick={(n) => onPickCommand?.(n)} />
            ) : (
              <Pending />
            ))}

          {tab === 'info' && (
            <dl className="grid grid-cols-[140px_1fr] gap-y-2 text-[12px]">
              {[
                ['Model', caps.model],
                ['Version', caps.version],
                ['Permission mode', caps.permissionMode],
                ['Account', caps.account?.email],
                ['Organization', caps.account?.organization],
                ['Plan', caps.account?.subscriptionType],
                ['MCP servers', caps.mcpServers?.length],
                ['Tools', caps.tools?.length],
                ['Skills', caps.skills?.length],
                ['Commands', caps.commands?.length || caps.slashCommands?.length],
              ].map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="text-fgdim">{k}</dt>
                  <dd className="font-mono text-fg">{v ?? '—'}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>

        <div className="border-t border-hair px-4 py-2 text-[10px] text-fgdim">
          Type <span className="font-mono text-fg">/</span> in the chat for autocomplete · click a
          command to insert it
        </div>
      </div>
    </div>
  );
}
