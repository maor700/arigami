// The **agent surface** (#/agents/<slug>[/<tab>]) — a PLACE, not a session.
//
// UX1: clicking a Team row lands here, not in "just another session". The
// surface owns the agent's home chat (the Home tab — the DM, embedded), so a
// home chat is no longer a rail row at all; work sessions born from the agent
// stay in the Sessions section and link back here (SessionView BornFromChip).
// Its own header treatment — big avatar, persona line, live status, budget bar,
// the agent's color washed over the chrome — is what keeps it from reading as a
// work session.
//
//   home         UX1: the agent's home chat, embedded (GET /__api/agents/:slug/home)
//   persona      identity fields + the persona textarea → PATCH /__api/agents/:slug
//   memory       the agent's MEMORY.md + journal (memory namespace agents/<slug>/…)
//   connections  A2: the agent's own connections + browser profile (settings/AgentConnections.jsx)
//   routine      A2: cron jobs born from the agent + its listeners (RoutineList.jsx)
//   activity     A3: the agent's activity ledger with cost (today / 7d / 30d)
//                (+ episodes, collapsed) — GET /__api/agents/:slug/activity?range=
//   runs         UX1: every session born from the agent, with state and cost
import { useEffect, useId, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { Icon } from '../lib/icons.js';
import { useT } from '../lib/i18n.js';
import { useModels } from '../lib/models.js';
import { useStore, loadChat } from '../lib/store.js';
import { relTime } from '../lib/time.js';
import { errText } from '../lib/errors.js';
import { toastError, toastSuccess } from '../lib/toast.js';
import { AgentAvatar, TOOL_FAMILIES } from './AgentCard.jsx';
import { EngineToggle, agentModelOptions } from './EngineToggle.jsx';
import { engineLabel } from '../lib/engines.js';
import { fmtTokens, fmtCost } from './settings/Budgets.jsx';
import AgentConnectionsPanel from './settings/AgentConnections.jsx';
import RoutinePanel, { untilTime, nextCronFor } from './RoutineList.jsx';
import SessionView from './SessionView.jsx';
import { deleteAgent } from './DelegatedLine.jsx';
import { Overlay } from './Dialogs.jsx';
import { INPUT } from './settings/shared.jsx';
import { Button } from './ui/button.jsx';
import { Input, Textarea } from './ui/input.jsx';
import { Checkbox } from './ui/checkbox.jsx';
import { DialogTitle } from './ui/dialog.jsx';
import { Popover, PopoverTrigger, PopoverContent } from './ui/popover.jsx';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from './ui/dropdown-menu.jsx';
import { Tip } from './ui/tooltip.jsx';
import InstructionLayer from './settings/InstructionLayer.jsx';
import { faXmark, faIdBadge, faBrain, faListCheck, faLink, faClock, faComments, faTrash, faCaretDown, faCaretRight, faDiagramProject, faEllipsis, faBars, faCircleInfo } from '@fortawesome/free-solid-svg-icons';

export const TABS = ['home', 'persona', 'memory', 'connections', 'routine', 'activity', 'runs'];
const ICONS = { home: faComments, persona: faIdBadge, memory: faBrain, connections: faLink, routine: faClock, activity: faListCheck, runs: faDiagramProject };

const input = `${INPUT} w-full`;
const lbl = 'mb-1.5 block text-sm font-medium text-fg';
const hint = 'mt-1.5 text-xs text-fgdim';
const card = 'rounded-lg border border-hair p-4';
const cbRow = 'flex cursor-pointer items-center gap-2 text-sm text-fg coarse:min-h-11';

// A labelled checkbox (ui Checkbox, Radix) — `mono` for ids/paths.
function CheckRow({ checked, onChange, mono, children }) {
  return (
    <label className={`${cbRow} ${mono ? 'text-xs' : ''}`}>
      <Checkbox checked={checked} onCheckedChange={onChange} />
      <span className={mono ? 'font-mono' : undefined} dir={mono ? 'ltr' : undefined}>{children}</span>
    </label>
  );
}

function PersonaTab({ agent, onSaved, onDeleted, onOpenHome, isNew }) {
  const uid = useId();
  const t = useT();
  const { models } = useModels();
  const [skillNames, setSkillNames] = useState([]);
  const [form, setForm] = useState({
    name: agent.name, slug: agent.slug || '', emoji: agent.emoji, color: agent.color, engine: agent.engine || '', model: agent.model || '', persona: agent.persona || '',
    skills: agent.skills || [], tools: agent.tools || [], budget: agent.budget?.tokensPerDay ? String(agent.budget.tokensPerDay) : '',
    domains: (agent.domains || []).join(', '), autoApprove: agent.autoApprove || [], prompts: agent.prompts || null,
  });
  const [busy, setBusy] = useState(false);
  // Advanced (model/budget/tools/skills) opens only when something is already set there.
  const [advanced, setAdvanced] = useState(!!(agent.engine || agent.model || agent.budget?.tokensPerDay || agent.tools?.length || agent.skills?.length || agent.domains?.length || agent.autoApprove?.length || (agent.prompts && Object.keys(agent.prompts).length)));
  useEffect(() => { api.get('/skills').then((r) => setSkillNames((r?.skills || []).map((s) => s.name))).catch(() => {}); }, []);
  const set = (k) => (e) => setForm((c) => ({ ...c, [k]: e.target.value }));
  const toggle = (k, v) => setForm((c) => ({ ...c, [k]: c[k].includes(v) ? c[k].filter((x) => x !== v) : [...c[k], v] }));
  const save = async () => {
    setBusy(true);
    try {
      const body = {
        name: form.name.trim(), emoji: form.emoji.trim() || '🤖', color: form.color, engine: form.engine || null, model: form.model || null, persona: form.persona,
        skills: form.skills, tools: form.tools, budget: Number(form.budget) > 0 ? { tokensPerDay: Number(form.budget) } : null,
        domains: form.domains.split(',').map((d) => d.trim()).filter(Boolean), autoApprove: form.autoApprove, prompts: form.prompts,
      };
      const a = isNew
        ? await api.post('/agents', { ...body, slug: form.slug.trim() || undefined })
        : await api.patch(`/agents/${agent.slug}`, body);
      toastSuccess(t(isNew ? 'agent.page.createdToast' : 'agent.page.saved'));
      onSaved?.(a);
    } catch (e) {
      toastError(t('agent.page.saveFailed', { err: e?.body?.error || e?.message || e }));
    } finally {
      setBusy(false);
    }
  };
  const cancelDraft = () => onDeleted?.();
  return (
    <div className="flex flex-col gap-4">
      <section className={card}>
        <div className="mb-3 text-xs font-medium text-fgdim">{t('agent.page.identity')}</div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div><label htmlFor={`${uid}-name`} className={lbl}>{t('agent.card.name')}</label><Input id={`${uid}-name`} dir="auto" value={form.name} onChange={set('name')} /></div>
          <div className="grid grid-cols-[64px_1fr] gap-2">
            <div><label htmlFor={`${uid}-emoji`} className={lbl}>{t('agent.card.emoji')}</label><Input id={`${uid}-emoji`} value={form.emoji} onChange={set('emoji')} className="text-center" /></div>
            <div><label htmlFor={`${uid}-color`} className={lbl}>{t('agent.card.color')}</label><input id={`${uid}-color`} type="color" value={form.color} onChange={set('color')} className="h-8 w-full cursor-pointer rounded-md border border-input bg-background p-0.5 coarse:h-11" /></div>
          </div>
          {isNew && (
            <div className="sm:col-span-2">
              <label htmlFor={`${uid}-slug`} className={lbl}>{t('agent.card.slug')}</label>
              <Input id={`${uid}-slug`} data-agent-field="slug" dir="ltr" value={form.slug} onChange={set('slug')} placeholder="marketing-lead" className="font-mono" />
            </div>
          )}
        </div>
      </section>
      <section className={card}>
        <label htmlFor={`${uid}-persona`} className={lbl}>{t('agent.card.persona')}</label>
        <Textarea id={`${uid}-persona`} dir="auto" rows={10} value={form.persona} onChange={set('persona')} className="font-mono text-xs" />
      </section>
      <button type="button" onClick={() => setAdvanced((v) => !v)} className="flex cursor-pointer items-center gap-1.5 text-xs font-medium text-fgdim hover:text-fg coarse:min-h-11" aria-expanded={advanced}>
        <Icon icon={advanced ? faCaretDown : faCaretRight} /> {t('agent.card.advanced')}
      </button>
      {advanced && (
      <section className={card}>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {/* the model list below is this engine's catalog; switching engines drops a model the new one lacks */}
          <EngineToggle
            data-agent-field="engine"
            className="sm:col-span-2"
            label={t('agent.card.engine')}
            options={{ engine: form.engine, model: form.model }}
            onChange={(o) => setForm((c) => ({ ...c, engine: o.engine || '', model: o.model || '' }))}
          />
          <div>
            <label htmlFor={`${uid}-model`} className={lbl}>{t('agent.card.model')}</label>
            <select id={`${uid}-model`} data-agent-field="model" value={form.model} onChange={set('model')} className={input}>
              <option value="">{t('agent.card.modelDefault')}</option>
              {agentModelOptions(form.engine, models, form.model).map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
          </div>
          <div><label htmlFor={`${uid}-budget`} className={lbl}>{t('agent.card.budget')}</label><Input id={`${uid}-budget`} type="number" min="0" dir="ltr" value={form.budget} onChange={set('budget')} placeholder={t('agent.card.budgetNone')} className="tabular-nums" /></div>
          <div className="sm:col-span-2">
            <label className={lbl}>{t('agent.card.tools')}</label>
            <div className="flex flex-wrap gap-x-4 gap-y-1.5">
              {TOOL_FAMILIES.map((id) => (
                <CheckRow key={id} checked={form.tools.includes(id)} onChange={() => toggle('tools', id)}>{t(`agent.tool.${id}`)}</CheckRow>
              ))}
              {form.tools.filter((x) => !TOOL_FAMILIES.includes(x)).map((x) => (
                <CheckRow key={x} mono checked onChange={() => toggle('tools', x)}>{x}</CheckRow>
              ))}
            </div>
            <div className={hint}>{t('agent.card.toolsHint')}</div>
          </div>
          <div className="sm:col-span-2">
            <label htmlFor={`${uid}-domains`} className={lbl}>{t('agent.card.domains')}</label>
            <Input id={`${uid}-domains`} dir="ltr" value={form.domains} onChange={set('domains')} placeholder="example.com, *.notion.so" className="font-mono" />
            <div className={hint}>{t('agent.card.domainsHint')}</div>
          </div>
          <div className="sm:col-span-2">
            <label className={lbl}>{t('agent.card.autoApprove')}</label>
            {form.autoApprove.length === 0 ? <span className="text-xs text-fgdim">{t('agent.card.autoApproveNone')}</span> : (
              <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                {form.autoApprove.map((k) => (
                  <CheckRow key={k} mono checked onChange={() => toggle('autoApprove', k)}>{k}</CheckRow>
                ))}
              </div>
            )}
          </div>
          <div className="sm:col-span-2">
            <label className={lbl}>{t('agent.card.skills')}</label>
            {skillNames.length === 0 ? <span className="text-xs text-fgdim">{t('agent.card.noSkills')}</span> : (
              <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                {skillNames.map((n) => (
                  <CheckRow key={n} mono checked={form.skills.includes(n)} onChange={() => toggle('skills', n)}>{n}</CheckRow>
                ))}
              </div>
            )}
          </div>
        </div>
        {!isNew && (
          <div className="mt-4">
            <InstructionLayer scope="agent" value={form.prompts} onChange={(prompts) => setForm((c) => ({ ...c, prompts }))} />
          </div>
        )}
      </section>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" data-agent-save onClick={save} disabled={busy || !form.name.trim()}>{t(isNew ? 'agent.page.create' : 'agent.page.save')}</Button>
        {!isNew && <Button onClick={onOpenHome}><Icon icon={faComments} /> {t('agent.page.openHome')}</Button>}
        {isNew && <Button data-agent-discard onClick={cancelDraft} className="ms-auto">{t('agent.page.cancel')}</Button>}
      </div>
    </div>
  );
}

function MemoryTab({ agent }) {
  const t = useT();
  const [files, setFiles] = useState(null);
  const [selected, setSelected] = useState(null);
  const [content, setContent] = useState('');
  const memPath = `agents/${agent.slug}/MEMORY.md`;
  const load = () => api.get(`/memory?agent=${encodeURIComponent(agent.slug)}`).then((r) => setFiles(r.files || [])).catch(() => setFiles([]));
  useEffect(() => { load(); setSelected(memPath); }, [agent.slug]);
  useEffect(() => {
    if (!selected) return;
    api.get(`/memory/get?path=${encodeURIComponent(selected)}`).then((r) => setContent(r.content || '')).catch(() => setContent(''));
  }, [selected]);
  if (files === null) return <div className="text-xs text-fgdim">{t('dialogs.loading')}</div>;
  const journal = files.filter((f) => f.path !== memPath);
  return (
    <div className="flex flex-col gap-3">
      <div className="text-xs text-fgdim">{t('agent.page.memoryHint')}</div>
      <div className={card}>
        <div className="mb-2 flex flex-wrap items-center gap-2 text-xs font-medium text-fgdim">
          <button type="button" onClick={() => setSelected(memPath)} className={`cursor-pointer rounded-md px-1.5 py-0.5 coarse:min-h-11 ${selected === memPath ? 'bg-muted text-fg' : ''}`}>{t('agent.page.memoryDoc')}</button>
          <span>·</span>
          <span>{t('agent.page.journal')} · {journal.length}</span>
          {journal.map((f) => (
            <button key={f.path} type="button" onClick={() => setSelected(f.path)} className={`cursor-pointer rounded-md px-1.5 py-0.5 coarse:min-h-11 ${selected === f.path ? 'bg-muted text-fg' : ''}`}>{f.path.split('/').pop()}</button>
          ))}
        </div>
        <pre dir="auto" className="thin-scroll max-h-[420px] min-h-[80px] overflow-auto whitespace-pre-wrap break-words rounded-md border border-hair bg-bg p-2 font-mono text-xs leading-relaxed text-fg">
          {content || (selected === memPath ? t('brain.docEmpty') : t('agent.page.journalEmpty'))}
        </pre>
      </div>
    </div>
  );
}

const RANGES = ['today', '7d', '30d'];
const KIND_TONE = { session: 'text-fgdim', turn: 'text-fg', action: 'text-warn', artifact: 'text-ok', policy: 'text-danger', budget: 'text-danger' };

// A3: one ledger line — time · kind · what · tokens/cost.
export function ActivityRow({ e, onOpenSession }) {
  const t = useT();
  const when = new Date(e.ts);
  const hhmm = `${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`;
  const day = `${String(when.getDate()).padStart(2, '0')}.${String(when.getMonth() + 1).padStart(2, '0')}`;
  let what = e.detail || '';
  if (e.kind === 'action') what = `${e.auto ? t('agent.activity.auto') : t('agent.activity.byHuman')}${e.actionKind ? ` · ${e.actionKind}` : ''}${e.value ? ` → ${e.value}` : ''}${e.detail ? ` — ${e.detail}` : ''}`;
  if (e.kind === 'policy') what = e.reason || e.detail || '';
  if (e.kind === 'turn') what = e.model || '';
  return (
    <div data-activity-kind={e.kind} className="flex items-baseline gap-2 border-b border-hair py-1 text-xs last:border-b-0">
      <span className="w-[76px] shrink-0 font-mono text-xs text-fgdim" dir="ltr">{day} {hhmm}</span>
      <span className={`w-[72px] shrink-0 text-xs font-medium ${KIND_TONE[e.kind] || 'text-fg'}`}>{t(`agent.activity.kind.${e.kind}`)}</span>
      <span dir="auto" className="min-w-0 flex-1 truncate text-fg">
        {e.sessionId ? <button type="button" onClick={() => onOpenSession?.(e.sessionId)} className="cursor-pointer font-mono text-xs text-fgdim underline coarse:min-h-11">{String(e.sessionId).slice(5, 11)}</button> : null}
        {e.sessionId && what ? ' · ' : ''}{what}
      </span>
      {e.kind === 'turn' && <span className="shrink-0 text-xs text-fgdim tabular-nums" dir="ltr">{fmtTokens(e.tokens)} · {fmtCost(e.costUsd, t)}</span>}
    </div>
  );
}

export function ActivityTotals({ totals, budget }) {
  const t = useT();
  const at = budget?.resetsAt ? new Date(budget.resetsAt) : null;
  const hhmm = at ? `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}` : '';
  const cells = [
    ['tokens', fmtTokens(totals?.tokens)], ['cost', fmtCost(totals?.costUsd, t)], ['turns', totals?.turns ?? 0], ['runs', totals?.sessions ?? 0],
    ['actions', totals?.actions ?? 0], ['artifacts', totals?.artifacts ?? 0], ['denied', totals?.denied ?? 0],
  ];
  return (
    <div data-activity-totals className="grid grid-cols-4 gap-2 sm:grid-cols-7">
      {cells.map(([k, v]) => (
        <div key={k} className="rounded-md border border-hair px-2 py-1.5">
          <div className="text-xs text-fgdim">{t(`agent.activity.${k}`)}</div>
          <div className={`text-sm font-medium tabular-nums ${k === 'denied' && v ? 'text-danger' : 'text-fg'}`} dir="ltr">{v}</div>
        </div>
      ))}
      <div data-activity-budget className="col-span-4 rounded-md border border-hair px-2 py-1.5 sm:col-span-7">
        <span className="text-xs text-fgdim">{t('agent.activity.budget')} · </span>
        {budget?.cap ? (
          <span className={`text-xs tabular-nums ${budget.exceeded ? 'font-medium text-danger' : 'text-fg'}`} dir="ltr">
            {fmtTokens(budget.usedTokens)} / {fmtTokens(budget.cap)} ({Math.min(100, Math.round((budget.usedTokens / budget.cap) * 100))}%)
            {budget.exceeded ? ` — ${t('agent.activity.budgetExceeded', { at: hhmm })}` : ''}
          </span>
        ) : <span className="text-xs text-fgdim">{t('agent.activity.budgetNone')}</span>}
      </div>
    </div>
  );
}

function ActivityTab({ agent, onOpenSession }) {
  const t = useT();
  const [range, setRange] = useState('today');
  const [data, setData] = useState(null);
  const [showEp, setShowEp] = useState(false);
  const [ep, setEp] = useState(null);
  const [epText, setEpText] = useState('');
  useEffect(() => {
    let stop = false;
    api.get(`/agents/${agent.slug}/activity?range=${range}`).then((d) => { if (!stop) setData(d); }).catch(() => { if (!stop) setData({ sessions: [], episodes: [], entries: [], totals: null, budget: null }); });
    return () => { stop = true; };
  }, [agent.slug, range, agent.updatedAt]);
  useEffect(() => {
    if (!ep) return;
    api.get(`/memory/get?path=${encodeURIComponent(ep)}`).then((r) => setEpText(r.content || '')).catch(() => setEpText(''));
  }, [ep]);
  if (!data) return <div className="text-xs text-fgdim">{t('dialogs.loading')}</div>;
  const entries = data.entries || [];
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-1.5">
        {RANGES.map((r) => (
          <button key={r} type="button" data-range={r} aria-pressed={range === r} onClick={() => setRange(r)} className={`cursor-pointer rounded-md px-3 py-1 text-xs font-medium coarse:min-h-11 ${range === r ? 'bg-muted text-fg shadow-[0_0_0_1px_var(--hb-hair)]' : 'text-fgdim hover:text-fg'}`}>{t(`agent.activity.range.${r}`)}</button>
        ))}
      </div>
      <ActivityTotals totals={data.totals} budget={data.budget} />
      <div className={card}>
        <div className="mb-2 text-xs font-medium text-fgdim">{t('agent.activity.ledger')} · {entries.length}</div>
        {entries.length === 0 && <div className="text-xs text-fgdim">{t('agent.activity.empty')}</div>}
        <div className="thin-scroll max-h-[420px] overflow-y-auto">
          {entries.map((e, i) => <ActivityRow key={`${e.ts}-${i}`} e={e} onOpenSession={onOpenSession} />)}
        </div>
      </div>
      <button type="button" onClick={() => setShowEp((v) => !v)} className="flex cursor-pointer items-center gap-1.5 text-xs font-medium text-fgdim hover:text-fg">
        <Icon icon={showEp ? faCaretDown : faCaretRight} /> {showEp ? t('agent.activity.hideEpisodes') : t('agent.activity.showEpisodes')} · {data.episodes.length}
      </button>
      {showEp && (
      <div className="rounded-lg border border-hair p-3">
        <div className="mb-2 text-xs font-medium text-fgdim">{t('agent.page.episodes')} · {data.episodes.length}</div>
        {data.episodes.length === 0 && <div className="text-xs text-fgdim">{t('agent.page.noEpisodes')}</div>}
        {data.episodes.length > 0 && (
          <div className="flex gap-3">
            <div className="thin-scroll flex max-h-[260px] w-[200px] shrink-0 flex-col gap-0.5 overflow-y-auto">
              {data.episodes.map((e) => (
                <button key={e.path} type="button" onClick={() => setEp(e.path)} className={`truncate rounded-md px-2 py-1 text-start font-mono text-xs coarse:min-h-11 ${ep === e.path ? 'bg-muted text-fg' : 'text-fgdim hover:bg-muted'}`}>
                  {e.path.split('/').pop()}
                </button>
              ))}
            </div>
            <pre dir="auto" className="thin-scroll min-w-0 flex-1 overflow-auto whitespace-pre-wrap break-words rounded-md border border-hair bg-bg p-2 font-mono text-xs leading-relaxed text-fg">{epText}</pre>
          </div>
        )}
      </div>
      )}
    </div>
  );
}

/**
 * UX1 — the **Home** tab: the agent's home chat, embedded. Opening the tab is
 * what get-or-creates the home session (`GET /__api/agents/:slug/home`, the same
 * call the rail row used to make), so the DM keeps its transcript, its ledger
 * and its id — it just stopped being a rail row.
 */
function HomeTab({ agent, onOpenSession }) {
  const t = useT();
  const { sessions, chats, chatLoaded } = useStore();
  const [home, setHome] = useState(null); // the wire session from /home (until the store has it)
  const [err, setErr] = useState('');
  const [addTabOpen, setAddTabOpen] = useState(false); // the TabBar's "+" popover (App owns it for work sessions)
  useEffect(() => {
    let stop = false;
    setErr('');
    api.get(`/agents/${encodeURIComponent(agent.slug)}/home`)
      .then((r) => {
        if (stop || !r?.session?.id) return;
        setHome(r.session);
        loadChat(r.session.id);
      })
      .catch((e) => { if (!stop) setErr(errText(e)); });
    return () => { stop = true; };
  }, [agent.slug]);
  const id = home?.id || agent.homeSessionId || null;
  const session = (id && (sessions || []).find((s) => s.id === id)) || home;
  if (err) return <div data-home-error className="px-4 py-5 text-sm text-danger">{t('agent.surface.homeFailed', { err })}</div>;
  if (!session) return <div className="px-4 py-5 text-xs text-fgdim">{t('agent.surface.homeOpening')}</div>;
  // AGENT-PAGE: the home chat gets the SAME tab row a work session has (desktop,
  // artifacts, url tabs the agent opens) — SessionView in `homeAgent` mode
  // renders AgentHomeChat in the session pane and the shared TabBar above it.
  return (
    <SessionView
      session={session}
      homeAgent={agent}
      events={chats[session.id] || []}
      chatLoading={!chatLoaded[session.id] && !(chats[session.id]?.length)}
      addTabOpen={addTabOpen}
      setAddTabOpen={setAddTabOpen}
      onOpenSession={onOpenSession}
    />
  );
}

/**
 * UX1 — the **Runs** tab: every session born from this agent (the work it did),
 * with its state and what it cost. The home chat is not a run — it is the tab
 * next door.
 */
export function RunsList({ sessions, onOpenSession }) {
  const t = useT();
  const runs = (sessions || []).filter((s) => !s.home);
  return (
    <div data-agent-runs className="flex flex-col gap-3">
      <div className="text-xs text-fgdim">{t('agent.oneLiner')}</div>
      <div className="rounded-lg border border-hair p-3">
        <div className="mb-2 text-xs font-medium text-fgdim">{t('agent.runs.title')} · {runs.length}</div>
        {runs.length === 0 && <div className="text-xs text-fgdim">{t('agent.runs.empty', { oneLiner: t('agent.oneLiner') })}</div>}
        {runs.map((s) => (
          <button key={s.id} type="button" data-agent-run={s.id} onClick={() => onOpenSession(s.id)} className={`flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-start hover:bg-muted coarse:min-h-11 ${s.archived ? 'opacity-60' : ''}`}>
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: s.claudeState === 'working' ? 'var(--hb-warn)' : 'var(--color-fgdim)' }} />
            <span dir="auto" className="min-w-0 flex-1 truncate text-sm font-medium text-fg">{s.title}</span>
            {s.archived && <span className="shrink-0 rounded-sm bg-muted px-1.5 py-px text-2xs text-fgdim">{t('agent.runs.archived')}</span>}
            <span className="shrink-0 text-xs text-fgdim tabular-nums" dir="ltr">{fmtTokens(s.tokens)} · {fmtCost(s.costUsd, t)}</span>
            <span className="shrink-0 text-xs text-fgdim">{[s.status, relTime(s.updatedAt)].filter(Boolean).join(' · ')}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** The container — the agent's sessions come from the activity endpoint. */
export function RunsTab({ agent, onOpenSession }) {
  const t = useT();
  const [data, setData] = useState(null);
  useEffect(() => {
    let stop = false;
    // limit=1 — the ledger rows belong to the Activity tab; we only want sessions[].
    api.get(`/agents/${agent.slug}/activity?range=30d&limit=1`)
      .then((d) => { if (!stop) setData(d); })
      .catch(() => { if (!stop) setData({ sessions: [] }); });
    return () => { stop = true; };
  }, [agent.slug, agent.updatedAt]);
  if (!data) return <div className="text-xs text-fgdim">{t('dialogs.loading')}</div>;
  return <RunsList sessions={data.sessions} onOpenSession={onOpenSession} />;
}

/**
 * The persona's first real line — the one-line "who is this" under the name.
 * A markdown heading ("# who") is a label, not a description: skipped.
 */
export const personaLine = (persona) => {
  for (const raw of String(persona || '').split('\n')) {
    if (/^\s*#/.test(raw)) continue;
    const line = raw.replace(/^[>\-*\s]+/, '').trim();
    if (line) return line.length > 120 ? `${line.slice(0, 119)}…` : line;
  }
  return '';
};

/** UX1 — live status of the agent: working / next scheduled run / idle. */
export function SurfaceStatus({ agent, sessions, triggers }) {
  const t = useT();
  const mine = (sessions || []).filter((s) => !s.archived && s.metadata?.agent === agent.slug);
  const working = mine.some((s) => s.claude?.state === 'working');
  const runs = mine.filter((s) => !s.metadata?.agentHome).length;
  const nextCron = working ? null : nextCronFor(agent.slug, triggers);
  const label = working
    ? t('agent.surface.status.working')
    : nextCron
      ? t('agent.surface.status.nextRun', { when: untilTime(nextCron, t) })
      : runs === 0
        ? t('agent.surface.status.idle')
        : runs === 1
          ? t('rail.teamSession')
          : t('rail.teamSessions', { n: runs });
  return (
    <span data-agent-status={working ? 'working' : nextCron ? 'next-run' : 'idle'} className="flex shrink-0 items-center gap-1.5 text-xs text-fgdim">
      {working
        ? <span className="host-spinner h-[11px] w-[11px]" />
        : <span className="h-[7px] w-[7px] rounded-full" style={{ background: agent.color || '#c4c4c4', opacity: nextCron || runs ? 1 : 0.45 }} />}
      {label}
    </span>
  );
}

/** UX1 — today's token spend against the agent's daily cap (A3), as a bar. */
export function BudgetBar({ budget }) {
  const t = useT();
  if (!budget?.cap) return <span data-agent-budget="none" className="text-xs text-fgdim">{t('agent.surface.budgetNone')}</span>;
  const pct = Math.min(100, Math.round((budget.usedTokens / budget.cap) * 100));
  return (
    <span data-agent-budget={budget.exceeded ? 'exceeded' : 'ok'} className="flex min-w-0 shrink items-center gap-2">
      <span className="h-1.5 w-[90px] shrink-0 overflow-hidden rounded-full bg-muted">
        <span className="block h-full rounded-full" style={{ width: `${pct}%`, background: budget.exceeded ? 'var(--hb-err)' : 'var(--hb-ok)' }} />
      </span>
      <span dir="ltr" className={`truncate text-xs tabular-nums ${budget.exceeded ? 'font-medium text-danger' : 'text-fgdim'}`}>
        {budget.exceeded
          ? t('agent.surface.budgetExceeded')
          : t('agent.surface.budget', { used: fmtTokens(budget.usedTokens), cap: fmtTokens(budget.cap) })}
      </span>
    </span>
  );
}

// UX2: the sentinel slug for "no agent yet" — never a real one (SLUG_RE bars
// underscores), so it can't collide with anything createAgent would accept.
export const NEW_AGENT_SLUG = '__new__';

const DRAFT_COLOR = '#6A4FC4';

const row = 'flex items-baseline gap-3 border-b border-hair py-2 text-sm last:border-b-0';
const rowLbl = 'w-[88px] shrink-0 text-xs text-fgdim';

/**
 * AGENT-PAGE: everything that used to sit in the tall header — handle, persona
 * line, model, tools, domains, budget, skills, auto-approve — as a popover under
 * the one-row header, opened from the name or the ⋯ menu. This is the popover's
 * BODY (AgentView wraps it in a ui Popover anchored to the name button).
 */
export function AgentDetailsDrawer({ agent, budget, onClose, onEditPersona }) {
  const t = useT();
  const persona = personaLine(agent.persona);
  const tools = agent.tools || [];
  const line = (label, value, key) => (value ? <div key={key} className={row}><span className={rowLbl}>{label}</span><span dir="auto" className="min-w-0 flex-1 break-words text-fg">{value}</span></div> : null);
  return (
    <div data-agent-details-drawer role="dialog" aria-label={t('agent.page.details')}>
      <div className="flex items-start gap-3">
        <AgentAvatar agent={agent} size={40} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span dir="auto" className="text-base leading-tight font-semibold text-fg">{agent.name}</span>
            <span dir="ltr" className="text-xs text-fgdim">@{agent.slug}</span>
          </div>
          {persona && <div dir="auto" className="mt-0.5 text-xs leading-snug text-fgdim">{persona}</div>}
        </div>
        <Tip label={t('chrome.settings.closeTitle')}>
          <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label={t('chrome.settings.closeTitle')}><Icon icon={faXmark} /></Button>
        </Tip>
      </div>
      <div className="mt-3">
        <div className={row}><span className={rowLbl}>{t('agent.card.budget')}</span><span className="min-w-0 flex-1"><BudgetBar budget={budget} /></span></div>
        {line(t('agent.card.engine'), agent.engine ? engineLabel(agent.engine) : null, 'engine')}
        {line(t('agent.card.model'), agent.model || t('agent.card.modelDefault'), 'model')}
        {line(t('agent.card.tools'), tools.length ? tools.map((id) => (TOOL_FAMILIES.includes(id) ? t(`agent.tool.${id}`) : id)).join(' · ') : null, 'tools')}
        {line(t('agent.card.domains'), (agent.domains || []).join(', '), 'domains')}
        {line(t('agent.card.skills'), (agent.skills || []).join(', '), 'skills')}
        {line(t('agent.card.autoApprove'), (agent.autoApprove || []).join(', '), 'autoApprove')}
        {line('', agent.createdAt ? t('agent.page.created', { when: relTime(agent.createdAt) }) : null, 'created')}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button data-agent-details-edit onClick={onEditPersona}><Icon icon={faIdBadge} /> {t('agent.page.editPersona')}</Button>
        <span className="text-xs text-fgdim">{t('agent.oneLiner')}</span>
      </div>
    </div>
  );
}

/**
 * AGENT-PAGE: the destructive action, two steps away from the header — behind
 * the ⋯ menu, then this dialog, which only enables Delete once the agent's
 * exact name has been typed. Chosen over "hold 2 seconds": a long-press is what
 * phones use for text selection / context menus and a scroll cancels it, it is
 * invisible to a screen reader, and it never confirms WHICH agent — typing the
 * name does all three.
 */
export function DeleteAgentDialog({ agent, onClose, onDeleted }) {
  return <Overlay onClose={onClose} size="md"><DeleteAgentForm agent={agent} onClose={onClose} onDeleted={onDeleted} titleAs={DialogTitle} /></Overlay>;
}

/** The dialog's body (exported so it can be rendered without the portal; `titleAs` is the Dialog's title part when inside one). */
export function DeleteAgentForm({ agent, onClose, onDeleted, titleAs: Title = 'div' }) {
  const t = useT();
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const ref = useRef(null);
  useEffect(() => { ref.current?.focus(); }, []);
  const match = typed.trim() === String(agent.name || '').trim();
  const del = async () => {
    if (!match || busy) return;
    setBusy(true);
    const ok = await deleteAgent(agent, t);
    setBusy(false);
    if (ok) { onDeleted?.(); onClose(); }
  };
  return (
    <div data-agent-delete-dialog className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Title className="text-base font-semibold text-destructive">{t('agent.page.deleteTitle')}</Title>
        <p dir="auto" className="text-sm text-fgdim">{t('agent.page.deleteConfirm', { name: agent.name })}</p>
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="agent-delete-name" className="text-sm text-fg">
          {t('agent.page.deleteTypeName')} <bdi dir="auto" className="font-medium select-all">{agent.name}</bdi>
        </label>
        <Input
          id="agent-delete-name"
          ref={ref}
          data-agent-delete-name
          dir="auto"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') del(); }}
          placeholder={agent.name}
          autoComplete="off"
          aria-invalid={typed && !match ? true : undefined}
        />
        {typed && !match && <div className="text-xs text-danger">{t('agent.page.deleteNameMismatch')}</div>}
      </div>
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button onClick={onClose}>{t('dialogs.cancel')}</Button>
        <Button variant="destructive" data-agent-delete-confirm onClick={del} disabled={!match || busy}>
          {busy ? t('agent.page.deleteBusy') : t('agent.page.deleteDo')}
        </Button>
      </div>
    </div>
  );
}

// Menu open-state lives in AgentView's `pop` so the page's Escape handler can
// tell "a menu is open" from "bare surface". Functional update: an item's
// onSelect may already have moved `pop` on (menu → details/delete) before the
// menu reports that it closed.
const popOpen = (setPop, id) => (o) => setPop((p) => (o ? id : p === id ? null : p));

/** The ⋯ menu: details, and the delete — danger-styled, separated, last. */
export function MoreMenu({ open, onOpenChange, onCloseAutoFocus, onDetails, onDelete }) {
  const t = useT();
  return (
    <DropdownMenu modal={false} open={open} onOpenChange={onOpenChange}>
      <Tip label={t('agent.page.more')}>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" data-agent-more aria-label={t('agent.page.more')}><Icon icon={faEllipsis} /></Button>
        </DropdownMenuTrigger>
      </Tip>
      <DropdownMenuContent data-agent-menu align="end" className="w-52" onCloseAutoFocus={onCloseAutoFocus}>
        <DropdownMenuItem data-agent-menu-details onSelect={onDetails}>
          <Icon icon={faCircleInfo} /> {t('agent.page.details')}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" data-agent-delete onSelect={onDelete}>
          <Icon icon={faTrash} /> {t('agent.page.delete')}…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export default function AgentView({ slug, tab: wantTab, draftName, onTab, onClose, onOpenSession, onCreated }) {
  const t = useT();
  const { agents, sessions, triggers } = useStore();
  const isNew = slug === NEW_AGENT_SLUG;
  const [tab, setTabLocal] = useState(TABS.includes(wantTab) ? wantTab : 'home');
  const [fetched, setFetched] = useState(null); // full record (persona) — the store list has it too, but fetch to be exact
  const [missing, setMissing] = useState(false);
  const [budget, setBudget] = useState(null);
  // AGENT-PAGE header popovers: the tab switcher (mobile), the ⋯ menu, the
  // details drawer, the delete dialog. At most one is open at a time.
  const [pop, setPop] = useState(null); // 'tabs' | 'menu' | 'details' | 'delete' | null
  const popRef = useRef(null);
  popRef.current = pop;
  const setTab = (id) => { setTabLocal(id); onTab?.(id); };
  useEffect(() => { if (TABS.includes(wantTab) && wantTab !== tab) setTabLocal(wantTab); /* eslint-disable-line react-hooks/exhaustive-deps */ }, [wantTab]);
  useEffect(() => {
    if (isNew) return; // a draft has nothing to GET — see the local `draft` object below
    let stop = false;
    setMissing(false);
    api.get(`/agents/${encodeURIComponent(slug)}`).then((a) => { if (!stop) setFetched(a); }).catch(() => { if (!stop) setMissing(true); });
    return () => { stop = true; };
  }, [slug, isNew]);
  // A3 budget for the header bar — the cheap all-agents endpoint, refreshed when
  // the record changes (raising the cap in the persona tab lifts the bar at once).
  useEffect(() => {
    if (isNew) return; // no budget exists for a draft
    let stop = false;
    api.get('/agents/budgets')
      .then((r) => { if (!stop) setBudget((r?.budgets || []).find((b) => b.slug === slug) || null); })
      .catch(() => { if (!stop) setBudget(null); });
    return () => { stop = true; };
  }, [slug, isNew, fetched?.updatedAt]);
  useEffect(() => {
    // Escape closes an open popover/dialog first (they swallow it themselves);
    // only a bare surface closes on Escape.
    const onKey = (e) => { if (e.key === 'Escape' && !popRef.current) { e.stopPropagation(); onClose(); } };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  // Create mode: an in-memory draft, never fetched — there is nothing on disk
  // yet. Only the Persona tab makes sense until POST /agents returns a slug.
  const draft = { slug: null, name: draftName || '', emoji: '🤖', color: DRAFT_COLOR, model: '', persona: '', skills: [], tools: [], budget: null, domains: [], autoApprove: [], updatedAt: 0 };
  const agent = isNew ? draft : (fetched || (agents || []).find((a) => a.slug === slug) || null);
  const color = agent?.color || '#c4c4c4';
  const effectiveTab = isNew ? 'persona' : tab;
  // A tab that opens "the agent's home session" (Routine → "Add via the chat",
  // an activity row) means the Home tab —
  // leaving the surface for it and being bounced back by App would only flicker.
  const openSession = (id) => (id && id === agent?.homeSessionId ? setTab('home') : onOpenSession?.(id));
  const closePop = () => setPop(null);

  const navItem = (id) => {
    const disabled = isNew && id !== 'persona';
    const current = effectiveTab === id;
    return (
      // native title (not Tip): a disabled button never receives the pointer events a tooltip needs
      <button
          key={id}
          type="button"
          data-agent-tab={id}
          title={disabled ? t('agent.page.tabDisabledHint') : undefined}
          disabled={disabled}
          onClick={() => { if (!disabled) setTab(id); }}
          aria-current={current ? 'page' : undefined}
          className={`flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium whitespace-nowrap outline-none focus-visible:outline-2 focus-visible:outline-ring coarse:min-h-11 ${disabled ? 'cursor-not-allowed opacity-40' : 'cursor-pointer'} ${current ? 'bg-muted text-fg' : 'text-fgdim hover:text-fg'}`}
        >
          <span className="w-4 text-center"><Icon icon={ICONS[id]} /></span>
          {t(`agent.page.tab.${id}`)}
        </button>
    );
  };

  let body;
  if (isNew) body = <PersonaTab key="draft" agent={agent} isNew onSaved={(a) => onCreated?.(a)} onDeleted={onClose} />;
  else if (missing || (!agent && fetched === null && agents?.length)) body = <div className="text-sm text-fgdim">{t('agent.page.notFound')}</div>;
  else if (!agent) body = <div className="text-xs text-fgdim">{t('dialogs.loading')}</div>;
  else if (effectiveTab === 'home') body = <HomeTab agent={agent} onOpenSession={openSession} />;
  else if (effectiveTab === 'memory') body = <MemoryTab agent={agent} />;
  else if (effectiveTab === 'activity') body = <ActivityTab agent={agent} onOpenSession={openSession} />;
  else if (effectiveTab === 'runs') body = <RunsTab agent={agent} onOpenSession={openSession} />;
  else if (effectiveTab === 'connections') body = <AgentConnectionsPanel agent={agent} />;
  else if (effectiveTab === 'routine') body = <RoutinePanel agent={agent} onOpenSession={openSession} />;
  else body = <PersonaTab key={agent.updatedAt} agent={agent} onSaved={setFetched} onDeleted={onClose} onOpenHome={() => setTab('home')} />;

  const title = agent?.name || (isNew ? t('agent.page.createTitle') : t('agent.page.title'));
  return (
    // AGENT-PAGE: ONE row — hamburger (mobile) · avatar · name · status · tab
    // switcher · ⋯ · ✕. A faint wash of the agent's colour keeps it reading as
    // the agent's place; everything else (handle, persona line, budget, model,
    // tools…) lives in the details popover under the name.
    <div data-agent-page={slug} data-agent-surface={slug} className="flex min-h-0 flex-1 flex-col bg-panel">
      <div data-agent-header className="relative z-20 flex h-11 shrink-0 items-center gap-2 border-b border-hair px-3" style={{ background: `linear-gradient(180deg, ${color}26, ${color}0d)` }}>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t('rail.openSessions')}
          onClick={() => window.dispatchEvent(new CustomEvent('host:open-rail'))}
          className="md:hidden"
        >
          <Icon icon={faBars} />
        </Button>
        {/* avatar + name = the details trigger (a draft has no details yet) */}
        <Popover open={pop === 'details' && !!agent && !isNew} onOpenChange={popOpen(setPop, 'details')}>
          <Tip label={isNew ? undefined : t('agent.page.detailsHint')}>
            <PopoverTrigger asChild>
              <button
                type="button"
                data-agent-details={isNew ? undefined : 'toggle'}
                disabled={isNew || !agent}
                className="flex min-w-0 shrink cursor-pointer items-center gap-2 rounded-md py-0.5 pe-1.5 text-start outline-none focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default coarse:min-h-11"
              >
                {agent ? <AgentAvatar agent={agent} size={26} /> : null}
                <span dir="auto" className="min-w-0 truncate text-sm leading-tight font-semibold text-fg">{title}</span>
                {!isNew && agent && <span className="hidden shrink-0 text-xs text-fgdim sm:inline"><Icon icon={faCaretDown} /></span>}
              </button>
            </PopoverTrigger>
          </Tip>
          <PopoverContent align="start" className="thin-scroll max-h-[70vh] w-[min(27.5rem,calc(100vw-1rem))] overflow-y-auto p-4" onCloseAutoFocus={(e) => { if (popRef.current) e.preventDefault(); }}>
            {agent && !isNew && <AgentDetailsDrawer agent={agent} budget={budget} onClose={closePop} onEditPersona={() => { closePop(); setTab('persona'); }} />}
          </PopoverContent>
        </Popover>
        {agent && !isNew && <SurfaceStatus agent={agent} sessions={sessions} triggers={triggers} />}
        <div className="ms-auto flex min-w-0 shrink items-center gap-1">
          {/* sm+: the tabs inline (scroll when tight); <sm: a switcher button */}
          <div data-agent-tabs="pills" className="thin-scroll hidden min-w-0 items-center gap-1 overflow-x-auto sm:flex">{TABS.map((id) => navItem(id))}</div>
          <DropdownMenu modal={false} open={pop === 'tabs'} onOpenChange={popOpen(setPop, 'tabs')}>
            <DropdownMenuTrigger asChild>
              <Button data-agent-tabs="switcher" size="sm" aria-label={t('agent.page.tabSwitcher')} className="sm:hidden">
                <Icon icon={ICONS[effectiveTab]} />
                {t(`agent.page.tab.${effectiveTab}`)}
                <Icon icon={faCaretDown} className="text-fgdim" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent data-agent-tabs-menu aria-label={t('agent.page.tabSwitcher')} align="end" className="w-52">
              {TABS.map((id) => {
                const disabled = isNew && id !== 'persona';
                return (
                  <DropdownMenuItem key={id} data-agent-tab={id} disabled={disabled} aria-current={effectiveTab === id ? 'page' : undefined} className={effectiveTab === id ? 'bg-muted font-medium' : undefined} onSelect={() => setTab(id)}>
                    <Icon icon={ICONS[id]} /> {t(`agent.page.tab.${id}`)}
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        {agent && !isNew && (
          <MoreMenu
            open={pop === 'menu'}
            onOpenChange={popOpen(setPop, 'menu')}
            onCloseAutoFocus={(e) => { if (popRef.current === 'details' || popRef.current === 'delete') e.preventDefault(); }}
            onDetails={() => setPop('details')}
            onDelete={() => setPop('delete')}
          />
        )}
        <Tip label={t('chrome.settings.closeTitle')}>
          <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label={t('chrome.settings.closeTitle')}>
            <Icon icon={faXmark} />
          </Button>
        </Tip>
      </div>
      {pop === 'delete' && agent && !isNew && (
        <DeleteAgentDialog agent={agent} onClose={closePop} onDeleted={onClose} />
      )}
      {effectiveTab === 'home' && agent ? (
        <div key="home" className="flex min-h-0 flex-1 flex-col bg-bg">{body}</div>
      ) : (
        <div className="thin-scroll min-h-0 flex-1 overflow-y-auto">
          <div key={effectiveTab} className="mx-auto w-full max-w-[720px] px-4 py-5 sm:px-7">{body}</div>
        </div>
      )}
    </div>
  );
}
