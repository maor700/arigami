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
import { t, useT } from '../lib/i18n.js';
import { engineLabel, normalizeEngine } from '../lib/engines.js';
import { providerForEngine, providerOf, windowLabel, snapshotUsage } from '../lib/providers.js';
import { UsageBar } from './Usage.jsx';
import McpAuth from './McpAuth.jsx';
import { AgentAvatar } from './AgentCard.jsx';
import { Icon } from '../lib/icons.js';
import { faXmark } from '@fortawesome/free-solid-svg-icons';

// Open the global Accounts page (optionally straight into the add/auth flow).
const openAccounts = (add) =>
  window.dispatchEvent(new CustomEvent('host:open-accounts', { detail: { add: !!add } }));

// Host-rendered "inspect" commands — NOT sent to claude; they open the panel.
export const INSPECT_COMMANDS = [
  { name: 'usage', descKey: 'dialogs.cmdUsageDesc', host: true, tab: 'usage' },
  { name: 'status', descKey: 'dialogs.cmdStatusDesc', host: true, tab: 'usage' },
  { name: 'mcp', descKey: 'dialogs.cmdMcpDesc', host: true, tab: 'mcp' },
  { name: 'skills', descKey: 'dialogs.cmdSkillsDesc', host: true, tab: 'skills' },
  { name: 'tools', descKey: 'dialogs.cmdToolsDesc', host: true, tab: 'tools' },
  { name: 'agents', descKey: 'dialogs.cmdAgentsDesc', host: true, tab: 'agents' },
  { name: 'commands', descKey: 'dialogs.cmdCommandsDesc', host: true, tab: 'commands' },
  { name: 'capabilities', descKey: 'dialogs.cmdCapabilitiesDesc', host: true, tab: 'info' },
];

// Build the filtered, ranked palette for a `/query`. `commands` are the rich
// objects {name, description, argumentHint} from the initialize handshake.
// A4/UX2: `extra` = the host agent commands (/team, /as, /agent new, /adopt) + the skills
// that declare `slash:` (/plan, /review, …) — see lib/composer.js. Host
// commands sort first; then prefix matches; then alphabetical.
export function buildSlashItems(query, commands, extra = []) {
  const q = (query || '').toLowerCase();
  const claude = (commands || []).map((c) => ({
    name: c.name,
    desc: c.description,
    argumentHint: c.argumentHint,
    host: false,
  }));
  const host = INSPECT_COMMANDS.map((c) => ({ ...c, desc: t(c.descKey) }));
  const all = [...host, ...(extra || []), ...claude];
  const filtered = q ? all.filter((c) => c.name.toLowerCase().includes(q)) : all;
  filtered.sort((a, b) => {
    const ap = a.name.toLowerCase().startsWith(q) ? 0 : 1;
    const bp = b.name.toLowerCase().startsWith(q) ? 0 : 1;
    if (ap !== bp) return ap - bp;
    if (a.host !== b.host) return a.host ? -1 : 1;
    if (!!a.skill !== !!b.skill) return a.skill ? -1 : 1;
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
  const t = useT();
  if (!items.length) return null;
  return (
    <div className="absolute bottom-full left-0 mb-1.5 max-h-72 w-[420px] max-w-[92vw] overflow-y-auto rounded-[10px] border-[1.5px] border-ink bg-panel py-1 shadow-[3px_3px_0_rgba(0,0,0,0.18)] thin-scroll">
      <div className="px-3 pt-1 pb-1.5 text-[11px] md:text-[9.5px] font-bold tracking-wide text-fgdim uppercase">
        {t('dialogs.slashCommandsHint')}
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
          <span className="font-mono text-[11.5px] font-bold text-fg">/{it.name}{it.argumentHint && it.host ? <span className="ms-1 font-normal text-fgdim">{it.argumentHint}</span> : null}</span>
          {it.host ? (
            <span className="rounded-full bg-brand/30 px-1.5 text-[8.5px] font-bold text-fgdim">host</span>
          ) : it.skill ? (
            <span data-slash-skill={it.skill} className="rounded-full border border-hair px-1.5 text-[8.5px] text-fgdim">{it.command}</span>
          ) : (
            it.name.includes(':') && (
              <span className="rounded-full border border-hair px-1.5 text-[8.5px] text-fgdim">
                {nsOf(it.name)}
              </span>
            )
          )}
          {it.desc && <span className="truncate text-[11.5px] md:text-[10.5px] text-fgdim">{it.desc}</span>}
        </button>
      ))}
    </div>
  );
}

/* ---------- A4: the "@" mention palette ----------------------------------- */

// Same shell as the slash palette (bottom sheet-ish, ≤92vw so it fits a phone).
export function MentionPalette({ items, active, onPick, onHover }) {
  const t = useT();
  if (!items.length) return null;
  return (
    <div data-mention-palette className="absolute bottom-full left-0 mb-1.5 max-h-72 w-[360px] max-w-[92vw] overflow-y-auto rounded-[10px] border-[1.5px] border-ink bg-panel py-1 shadow-[3px_3px_0_rgba(0,0,0,0.18)] thin-scroll">
      <div className="px-3 pt-1 pb-1.5 text-[11px] md:text-[9.5px] font-bold tracking-wide text-fgdim uppercase">{t('dialogs.mentionHint')}</div>
      {items.map((a, i) => (
        <button
          key={a.slug}
          type="button"
          data-mention-item={a.slug}
          onMouseDown={(e) => { e.preventDefault(); onPick(a); }}
          onMouseEnter={() => onHover(i)}
          className={`flex w-full items-center gap-2 px-3 py-1.5 text-left ${i === active ? 'bg-chip' : ''}`}
        >
          <AgentAvatar agent={a} size={18} />
          <span className="font-mono text-[11.5px] font-bold text-fg">@{a.slug}</span>
          <span className="truncate text-[11.5px] md:text-[10.5px] text-fgdim">{a.name}{a.skills?.length ? ` · ${a.skills.join(', ')}` : ''}</span>
        </button>
      ))}
    </div>
  );
}

/* ---------- A4: /team — the agents + their status (modal) ------------------ */

// Status per agent, the same reading the Rail's team section uses: working when
// any live session of the agent is mid-turn, else its active session count.
export function teamRows(agents, sessions) {
  const byAgent = new Map();
  for (const s of sessions || []) {
    if (s.archived || !s.metadata?.agent) continue;
    (byAgent.get(s.metadata.agent) || byAgent.set(s.metadata.agent, []).get(s.metadata.agent)).push(s);
  }
  return (agents || []).map((a) => {
    const mine = byAgent.get(a.slug) || [];
    // UX1: `sessions` counts WORK sessions — the home chat is the agent's own
    // surface, not a job it is running.
    return { agent: a, sessions: mine.filter((s) => !s.metadata?.agentHome).length, working: mine.some((s) => s.claude?.state === 'working') };
  });
}

export function TeamPanel({ agents, sessions, onClose, onMention }) {
  const t = useT();
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  const rows = teamRows(agents, sessions);
  // UX1: both doors lead to the agent surface — Home is a tab of it, not a session.
  const openHome = (a) => {
    window.dispatchEvent(new CustomEvent('host:open-agent', { detail: { slug: a.slug, tab: 'home' } }));
    onClose();
  };
  const openPage = (a) => {
    window.dispatchEvent(new CustomEvent('host:open-agent', { detail: { slug: a.slug, tab: 'persona' } }));
    onClose();
  };
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-3 sm:items-center md:p-6" onMouseDown={onClose}>
      <div data-team-panel className="flex max-h-[80vh] w-[520px] max-w-full flex-col overflow-hidden rounded-[12px] border-[1.5px] border-ink bg-panel shadow-[4px_4px_0_rgba(0,0,0,0.25)]" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 border-b border-hair px-4 py-3">
          <span className="font-mono text-[13px] font-bold text-fg">{t('dialogs.teamTitle')}</span>
          <span className="font-mono text-[11.5px] md:text-[10px] text-fgdim">{rows.length}</span>
          <button type="button" onClick={onClose} className="ml-auto flex h-7 w-7 cursor-pointer items-center justify-center rounded-md border border-hair text-fgdim hover:border-ink hover:text-fg">
            <Icon icon={faXmark} />
          </button>
        </div>
        <div className="thin-scroll min-h-0 flex-1 overflow-y-auto px-3 py-3">
          {rows.length === 0 && <p className="px-1 text-[12px] text-fgdim">{t('rail.teamEmpty')}</p>}
          {rows.map(({ agent: a, sessions: n, working }) => (
            <div key={a.slug} data-team-row={a.slug} className="flex items-center gap-2.5 rounded-md px-2 py-2 hover:bg-chip">
              <AgentAvatar agent={a} size={22} />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="truncate font-mono text-[11.5px] font-bold text-fg">{a.name}</span>
                  <span className="font-mono text-[11.5px] md:text-[10px] text-fgdim">@{a.slug}</span>
                  {working ? (
                    <span className="flex items-center gap-1 font-mono text-[11px] md:text-[9px] tracking-wide text-[#ce8324]"><span className="host-spinner h-[11px] w-[11px]" /> {t('rail.teamWorking')}</span>
                  ) : (
                    <span className="flex items-center gap-1 font-mono text-[11px] md:text-[9px] text-fgdim">
                      <span className="h-[7px] w-[7px] rounded-full" style={{ background: n ? a.color : '#c4c4c4' }} />
                      {n === 0 ? t('rail.teamIdle') : n === 1 ? t('rail.teamSession') : t('rail.teamSessions', { n })}
                    </span>
                  )}
                </span>
                {a.skills?.length > 0 && <span className="block truncate text-[11.5px] md:text-[10px] text-fgdim">{a.skills.join(' · ')}</span>}
              </span>
              <button type="button" title={t('dialogs.teamMention')} onClick={() => { onMention?.(a); onClose(); }} className="cursor-pointer rounded-md border border-hair px-1.5 py-0.5 font-mono text-[11.5px] md:text-[10px] text-fgdim hover:border-ink hover:text-fg">@</button>
              <button type="button" onClick={() => openHome(a)} className="cursor-pointer rounded-md border border-hair px-1.5 py-0.5 text-[11.5px] md:text-[10px] text-fgdim hover:border-ink hover:text-fg">{t('rail.teamHomeChat')}</button>
              <button type="button" onClick={() => openPage(a)} className="hidden cursor-pointer rounded-md border border-hair px-1.5 py-0.5 text-[11.5px] md:text-[10px] text-fgdim hover:border-ink hover:text-fg sm:block">{t('rail.teamOpenPage')}</button>
            </div>
          ))}
        </div>
        <div className="border-t border-hair px-4 py-2 text-[11.5px] md:text-[10px] text-fgdim">{t('dialogs.teamFooter')}</div>
      </div>
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
  // 'usage' = Claude subscription meters + which Claude ACCOUNT this session
  // runs on. Both are properties of the claude CLI's auth, not of a session in
  // general — a Codex session has neither, so the tab is dropped for it rather
  // than shown reading someone else's quota. tabsFor() below.
  ['usage', 'dialogs.tabUsage'],
  ['mcp', null], // MCP — product noun, not translated
  ['skills', 'dialogs.tabSkills'],
  ['tools', 'dialogs.tabTools'],
  ['agents', 'dialogs.tabAgents'],
  ['commands', 'dialogs.tabCommands'],
  ['info', 'dialogs.tabInfo'],
];

/** TABS minus the ones that only make sense for the claude engine. */
function tabsFor(engine) {
  return normalizeEngine(engine) === 'claude' ? TABS : TABS.filter(([id]) => id !== 'usage');
}

// The full usage object for an account: live per-account broadcast, else the
// compact lastUsage snapshot from the accounts list, else nothing.
function accountUsageOf(a, accountUsage) {
  const u = accountUsage?.[a.id];
  if (u?.available) return u;
  const snap = snapshotUsage(a);
  return snap?.available ? snap : null;
}

// `/usage` + `/status` tab: which account this session runs on, plus every
// account's session/week meters. Reads the accounts store directly.
function AccountsUsageTab({ session, accounts, accountUsage }) {
  const t = useT();
  // Only the accounts of the provider this session's engine consumes — a
  // codex session's /status must not list Claude logins as candidates.
  const provider = providerForEngine(session?.engine);
  const list = (accounts?.accounts || []).filter((a) => providerOf(a) === provider);
  const activeId = accounts?.activeIds?.[provider] ?? (provider === 'claude' ? accounts?.activeId : null);
  const sessAccId = session?.claude?.accountId || activeId;
  const labelOf = (id) => list.find((a) => a.id === id)?.label || t('dialogs.activeAccount');
  if (!list.length) return <Pending engine={engineLabel(session?.engine)} />;
  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-md border border-hair bg-bg px-3 py-2 text-[11.5px] text-fgdim">
        {t('dialogs.thisSessionRunsOn')} <span className="font-bold text-fg">{labelOf(sessAccId)}</span>
        {sessAccId === activeId ? t('dialogs.activeAccountSuffix') : t('dialogs.pinnedSuffix')}
      </div>
      {list.map((a) => {
        const u = accountUsageOf(a, accountUsage);
        return (
          <div key={a.id} className="rounded-md border border-hair bg-bg px-3 py-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-[11.5px] font-bold text-fg">{a.label}</span>
              {a.active && <span className="rounded-full bg-fg px-1.5 py-0.5 text-[11px] md:text-[9px] font-bold text-bg">{t('dialogs.active')}</span>}
              {(a.email || a.plan) && (
                <span className="text-[11.5px] md:text-[10px] text-fgdim">{[a.email, a.plan].filter(Boolean).join(' · ')}</span>
              )}
            </div>
            {u?.available && (u.session || u.week) ? (
              <div className="mt-1">
                <UsageBar label={provider === 'claude' ? t('dialogs.sessionWindow5h') : windowLabel(t, provider, 'session', u.session)} win={u.session} sub />
                <UsageBar label={provider === 'claude' ? t('dialogs.week') : windowLabel(t, provider, 'week', u.week)} win={u.week} sub />
              </div>
            ) : (
              <div className="mt-1 font-mono text-[11.5px] md:text-[10px] text-fgdim">{t('dialogs.usageUnavailableShort')}</div>
            )}
          </div>
        );
      })}
      <button
        type="button"
        onClick={() => openAccounts(false)}
        className="self-start rounded-md border border-border px-2.5 py-1 text-[11px] text-fgdim hover:border-ink hover:text-fg"
      >
        {t('dialogs.manageAccounts')} →
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
          className={`rounded-md border border-hair bg-bg px-2 py-1 font-mono text-[11.5px] md:text-[10.5px] text-fg ${
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
          <div className="mb-1.5 text-[11px] md:text-[9.5px] font-bold tracking-wide text-fgdim uppercase">
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
          <div className="mb-1 text-[11px] md:text-[9.5px] font-bold tracking-wide text-fgdim uppercase">
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
                  <span className="text-[11.5px] md:text-[10.5px] leading-snug text-fgdim">{it.description}</span>
                )}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

const Pending = ({ engine }) => (
  <p className="text-[12px] text-fgdim">
    {t('dialogs.loadsAfterFirstMessage', { engine })}
  </p>
);

export function CapabilitiesPanel({ capabilities, session, initialTab = 'commands', onClose, onPickCommand }) {
  const caps = capabilities || {};
  return (
    <CapBody caps={caps} session={session} initialTab={initialTab} onClose={onClose} onPickCommand={onPickCommand} />
  );
}

function CapBody({ caps, session, initialTab, onClose, onPickCommand }) {
  const t = useT();
  // Every "…Code" string in this panel describes the ENGINE behind the session.
  const engine = engineLabel(session?.engine);
  const tabs = tabsFor(session?.engine);
  // `/usage` on a Codex session would otherwise open a tab that no longer
  // exists and render an empty panel.
  const [tab, setTab] = useState(tabs.some(([id]) => id === initialTab) ? initialTab : 'info');
  const { accounts, accountUsage } = useStore();
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  // Normalize agents (strings from init, objects from initialize) to {name,…}.
  const agents = (caps.agents || []).map((a) => (typeof a === 'string' ? { name: a } : a));
  const started = !!(caps.commands?.length || caps.slashCommands?.length || caps.mcpServers?.length || caps.counts?.commands);
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
          <span className="font-mono text-[13px] font-bold text-fg">{t('dialogs.claudeCodeCapabilities', { engine })}</span>
          {caps.model && (
            <span className="rounded-full border border-hair px-2 py-0.5 font-mono text-[11.5px] md:text-[10px] text-fgdim">
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
          {tabs.map(([id, labelKey]) => {
            const label = labelKey ? t(labelKey) : 'MCP';
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
                {count != null && <span className="ml-1 text-[11px] md:text-[9.5px] text-fgdim">{count}</span>}
              </button>
            );
          })}
        </div>

        <div className="thin-scroll min-h-0 flex-1 overflow-y-auto px-4 py-4 text-fg">
          {!started && (
            <p className="mb-3 text-[12px] text-fgdim">
              {t('dialogs.claudeCodeNotStarted', { engine })}
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
              <Pending engine={engine} />
            ))}

          {tab === 'tools' && (caps.tools?.length ? <Pills names={caps.tools} /> : <Pending engine={engine} />)}

          {tab === 'agents' &&
            (agents.length ? <DescList items={agents} /> : <Pending engine={engine} />)}

          {tab === 'commands' &&
            (caps.commands?.length ? (
              <DescList items={caps.commands} onPick={(n) => onPickCommand?.(n)} />
            ) : caps.slashCommands?.length ? (
              <Grouped names={caps.slashCommands} onPick={(n) => onPickCommand?.(n)} />
            ) : (
              <Pending engine={engine} />
            ))}

          {tab === 'info' && (
            <dl className="grid grid-cols-[140px_1fr] gap-y-2 text-[12px]">
              {[
                [t('dialogs.infoModel'), caps.model],
                [t('dialogs.infoVersion'), caps.version],
                [t('dialogs.infoPermissionMode'), caps.permissionMode],
                [t('dialogs.infoAccount'), caps.account?.email],
                [t('dialogs.infoOrganization'), caps.account?.organization],
                [t('dialogs.infoPlan'), caps.account?.subscriptionType],
                [t('dialogs.infoMcpServers'), caps.mcpServers?.length],
                [t('dialogs.infoTools'), caps.tools?.length],
                [t('dialogs.infoSkills'), caps.skills?.length],
                [t('dialogs.infoCommands'), caps.commands?.length || caps.slashCommands?.length],
              ].map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="text-fgdim">{k}</dt>
                  <dd className="font-mono text-fg">{v ?? '—'}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>

        <div className="border-t border-hair px-4 py-2 text-[11.5px] md:text-[10px] text-fgdim">
          {t('dialogs.slashFooterBefore')} <span className="font-mono text-fg">/</span> {t('dialogs.slashFooterAfter')}
        </div>
      </div>
    </div>
  );
}
