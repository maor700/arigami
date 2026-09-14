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
import { useEffect, useRef, useState } from 'react';
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
import { fmtTokens, fmtUsd } from './settings/Budgets.jsx';
import AgentConnectionsPanel from './settings/AgentConnections.jsx';
import RoutinePanel, { untilTime, nextCronFor } from './RoutineList.jsx';
import SessionView from './SessionView.jsx';
import { deleteAgent } from './DelegatedLine.jsx';
import { Overlay } from './Dialogs.jsx';
import { GhostButton } from './ui.jsx';
import { faXmark, faIdBadge, faBrain, faListCheck, faLink, faClock, faComments, faTrash, faCaretDown, faCaretRight, faDiagramProject, faEllipsis, faBars, faCircleInfo } from '@fortawesome/free-solid-svg-icons';

export const TABS = ['home', 'persona', 'memory', 'connections', 'routine', 'activity', 'runs'];
const ICONS = { home: faComments, persona: faIdBadge, memory: faBrain, connections: faLink, routine: faClock, activity: faListCheck, runs: faDiagramProject };

const input = 'w-full rounded-[7px] border-[1.5px] border-border bg-panel px-2.5 py-1.5 text-[12px] text-fg outline-none focus:border-ink';
const lbl = 'mb-1 block font-mono text-[11.5px] md:text-[10px] tracking-[0.08em] text-fgdim uppercase';
const btn = 'cursor-pointer rounded-lg border-[1.5px] border-ink bg-panel px-3 py-1.5 text-[11.5px] font-bold text-fg hover:bg-chip disabled:opacity-40';
const btnBrand = 'cursor-pointer rounded-lg border-[1.5px] border-ink bg-brand px-3 py-1.5 text-[11.5px] font-bold text-[#1a1a1a] shadow-[2px_2px_0_#2a2a2a] disabled:opacity-40 disabled:shadow-none';

function PersonaTab({ agent, onSaved, onDeleted, onOpenHome, isNew }) {
  const t = useT();
  const { models } = useModels();
  const [skillNames, setSkillNames] = useState([]);
  const [form, setForm] = useState({
    name: agent.name, slug: agent.slug || '', emoji: agent.emoji, color: agent.color, engine: agent.engine || '', model: agent.model || '', persona: agent.persona || '',
    skills: agent.skills || [], tools: agent.tools || [], budget: agent.budget?.tokensPerDay ? String(agent.budget.tokensPerDay) : '',
    domains: (agent.domains || []).join(', '), autoApprove: agent.autoApprove || [],
  });
  const [busy, setBusy] = useState(false);
  // Advanced (model/budget/tools/skills) opens only when something is already set there.
  const [advanced, setAdvanced] = useState(!!(agent.engine || agent.model || agent.budget?.tokensPerDay || agent.tools?.length || agent.skills?.length || agent.domains?.length || agent.autoApprove?.length));
  useEffect(() => { api.get('/skills').then((r) => setSkillNames((r?.skills || []).map((s) => s.name))).catch(() => {}); }, []);
  const set = (k) => (e) => setForm((c) => ({ ...c, [k]: e.target.value }));
  const toggle = (k, v) => setForm((c) => ({ ...c, [k]: c[k].includes(v) ? c[k].filter((x) => x !== v) : [...c[k], v] }));
  const save = async () => {
    setBusy(true);
    try {
      const body = {
        name: form.name.trim(), emoji: form.emoji.trim() || '🤖', color: form.color, engine: form.engine || null, model: form.model || null, persona: form.persona,
        skills: form.skills, tools: form.tools, budget: Number(form.budget) > 0 ? { tokensPerDay: Number(form.budget) } : null,
        domains: form.domains.split(',').map((d) => d.trim()).filter(Boolean), autoApprove: form.autoApprove,
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
      <section className="rounded-[10px] border border-hair p-3">
        <div className="mb-2 font-mono text-[11.5px] md:text-[10px] tracking-[0.08em] text-fgdim uppercase">{t('agent.page.identity')}</div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div><label className={lbl}>{t('agent.card.name')}</label><input dir="auto" value={form.name} onChange={set('name')} className={input} /></div>
          <div className="grid grid-cols-[64px_1fr] gap-2">
            <div><label className={lbl}>{t('agent.card.emoji')}</label><input value={form.emoji} onChange={set('emoji')} className={`${input} text-center`} /></div>
            <div><label className={lbl}>{t('agent.card.color')}</label><input type="color" value={form.color} onChange={set('color')} className="h-[34px] w-full cursor-pointer rounded-[7px] border-[1.5px] border-border bg-panel p-0.5" /></div>
          </div>
          {isNew && (
            <div className="sm:col-span-2">
              <label className={lbl}>{t('agent.card.slug')}</label>
              <input data-agent-field="slug" dir="ltr" value={form.slug} onChange={set('slug')} placeholder="marketing-lead" className={`${input} font-mono`} />
            </div>
          )}
        </div>
      </section>
      <section className="rounded-[10px] border border-hair p-3">
        <label className={lbl}>{t('agent.card.persona')}</label>
        <textarea dir="auto" rows={10} value={form.persona} onChange={set('persona')} className={`${input} resize-y font-mono text-[11.5px] leading-relaxed`} />
      </section>
      <button type="button" onClick={() => setAdvanced((v) => !v)} className="flex cursor-pointer items-center gap-1.5 font-mono text-[11.5px] md:text-[10.5px] tracking-[0.08em] text-fgdim uppercase hover:text-fg">
        <Icon icon={advanced ? faCaretDown : faCaretRight} /> {t('agent.card.advanced')}
      </button>
      {advanced && (
      <section className="rounded-[10px] border border-hair p-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {/* the model list below is this engine's catalog; switching engines drops a model the new one lacks */}
          <EngineToggle
            data-agent-field="engine"
            className="sm:col-span-2"
            label={t('agent.card.engine')}
            options={{ engine: form.engine, model: form.model }}
            onChange={(o) => setForm((c) => ({ ...c, engine: o.engine || '', model: o.model || '' }))}
          />
          <div>
            <label className={lbl}>{t('agent.card.model')}</label>
            <select data-agent-field="model" value={form.model} onChange={set('model')} className={input}>
              <option value="">{t('agent.card.modelDefault')}</option>
              {agentModelOptions(form.engine, models, form.model).map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
          </div>
          <div><label className={lbl}>{t('agent.card.budget')}</label><input type="number" min="0" value={form.budget} onChange={set('budget')} placeholder={t('agent.card.budgetNone')} className={input} /></div>
          <div className="sm:col-span-2">
            <label className={lbl}>{t('agent.card.tools')}</label>
            <div className="flex flex-wrap gap-x-3 gap-y-1">
              {TOOL_FAMILIES.map((id) => (
                <label key={id} className="flex cursor-pointer items-center gap-1 text-[11.5px] text-fg"><input type="checkbox" checked={form.tools.includes(id)} onChange={() => toggle('tools', id)} /> {t(`agent.tool.${id}`)}</label>
              ))}
              {form.tools.filter((x) => !TOOL_FAMILIES.includes(x)).map((x) => (
                <label key={x} className="flex cursor-pointer items-center gap-1 font-mono text-[11.5px] md:text-[10.5px] text-fg"><input type="checkbox" checked onChange={() => toggle('tools', x)} /> {x}</label>
              ))}
            </div>
            <div className="mt-1 text-[11.5px] md:text-[10.5px] text-fgdim">{t('agent.card.toolsHint')}</div>
          </div>
          <div className="sm:col-span-2">
            <label className={lbl}>{t('agent.card.domains')}</label>
            <input dir="ltr" value={form.domains} onChange={set('domains')} placeholder="example.com, *.notion.so" className={`${input} font-mono`} />
            <div className="mt-1 text-[11.5px] md:text-[10.5px] text-fgdim">{t('agent.card.domainsHint')}</div>
          </div>
          <div className="sm:col-span-2">
            <label className={lbl}>{t('agent.card.autoApprove')}</label>
            {form.autoApprove.length === 0 ? <span className="text-[11px] text-fgdim">{t('agent.card.autoApproveNone')}</span> : (
              <div className="flex flex-wrap gap-x-3 gap-y-1">
                {form.autoApprove.map((k) => (
                  <label key={k} className="flex cursor-pointer items-center gap-1 font-mono text-[11px] text-fg"><input type="checkbox" checked onChange={() => toggle('autoApprove', k)} /> {k}</label>
                ))}
              </div>
            )}
          </div>
          <div className="sm:col-span-2">
            <label className={lbl}>{t('agent.card.skills')}</label>
            {skillNames.length === 0 ? <span className="text-[11px] text-fgdim">{t('agent.card.noSkills')}</span> : (
              <div className="flex flex-wrap gap-x-3 gap-y-1">
                {skillNames.map((n) => (
                  <label key={n} className="flex cursor-pointer items-center gap-1 font-mono text-[11px] text-fg"><input type="checkbox" checked={form.skills.includes(n)} onChange={() => toggle('skills', n)} /> {n}</label>
                ))}
              </div>
            )}
          </div>
        </div>
      </section>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" data-agent-save onClick={save} disabled={busy || !form.name.trim()} className={btnBrand}>{t(isNew ? 'agent.page.create' : 'agent.page.save')}</button>
        {!isNew && <button type="button" onClick={onOpenHome} className={btn}><Icon icon={faComments} /> {t('agent.page.openHome')}</button>}
        {isNew && <button type="button" data-agent-discard onClick={cancelDraft} className={`${btn} ms-auto`}>{t('agent.page.cancel')}</button>}
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
  if (files === null) return <div className="text-[11px] text-fgdim">{t('dialogs.loading')}</div>;
  const journal = files.filter((f) => f.path !== memPath);
  return (
    <div className="flex flex-col gap-3">
      <div className="text-[11.5px] text-fgdim">{t('agent.page.memoryHint')}</div>
      <div className="rounded-[10px] border border-hair p-3">
        <div className="mb-2 flex items-center gap-2 font-mono text-[11.5px] md:text-[10px] tracking-[0.08em] text-fgdim uppercase">
          <button type="button" onClick={() => setSelected(memPath)} className={`cursor-pointer rounded px-1.5 py-0.5 ${selected === memPath ? 'bg-chip text-fg' : ''}`}>{t('agent.page.memoryDoc')}</button>
          <span>·</span>
          <span>{t('agent.page.journal')} · {journal.length}</span>
          {journal.map((f) => (
            <button key={f.path} type="button" onClick={() => setSelected(f.path)} className={`cursor-pointer rounded px-1.5 py-0.5 normal-case tracking-normal ${selected === f.path ? 'bg-chip text-fg' : ''}`}>{f.path.split('/').pop()}</button>
          ))}
        </div>
        <pre dir="auto" className="thin-scroll max-h-[420px] min-h-[80px] overflow-auto whitespace-pre-wrap break-words rounded-[8px] border border-hair bg-bg p-2 text-[11px] leading-relaxed text-fg">
          {content || (selected === memPath ? t('brain.docEmpty') : t('agent.page.journalEmpty'))}
        </pre>
      </div>
    </div>
  );
}

const RANGES = ['today', '7d', '30d'];
const KIND_TONE = { session: 'text-fgdim', turn: 'text-fg', action: 'text-[#CE8324]', artifact: 'text-[#1F9C82]', policy: 'text-danger', budget: 'text-danger' };

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
    <div data-activity-kind={e.kind} className="flex items-baseline gap-2 border-b border-hair py-1 text-[11px] last:border-b-0">
      <span className="w-[76px] shrink-0 font-mono text-[11.5px] md:text-[10px] text-fgdim" dir="ltr">{day} {hhmm}</span>
      <span className={`w-[72px] shrink-0 font-mono text-[11.5px] md:text-[10px] uppercase ${KIND_TONE[e.kind] || 'text-fg'}`}>{t(`agent.activity.kind.${e.kind}`)}</span>
      <span dir="auto" className="min-w-0 flex-1 truncate text-fg">
        {e.sessionId ? <button type="button" onClick={() => onOpenSession?.(e.sessionId)} className="cursor-pointer font-mono text-[11.5px] md:text-[10px] text-fgdim underline">{String(e.sessionId).slice(5, 11)}</button> : null}
        {e.sessionId && what ? ' · ' : ''}{what}
      </span>
      {e.kind === 'turn' && <span className="shrink-0 font-mono text-[11.5px] md:text-[10px] text-fgdim" dir="ltr">{fmtTokens(e.tokens)} · {fmtUsd(e.costUsd)}</span>}
    </div>
  );
}

export function ActivityTotals({ totals, budget }) {
  const t = useT();
  const at = budget?.resetsAt ? new Date(budget.resetsAt) : null;
  const hhmm = at ? `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}` : '';
  const cells = [
    ['tokens', fmtTokens(totals?.tokens)], ['cost', fmtUsd(totals?.costUsd)], ['turns', totals?.turns ?? 0], ['runs', totals?.sessions ?? 0],
    ['actions', totals?.actions ?? 0], ['artifacts', totals?.artifacts ?? 0], ['denied', totals?.denied ?? 0],
  ];
  return (
    <div data-activity-totals className="grid grid-cols-4 gap-2 sm:grid-cols-7">
      {cells.map(([k, v]) => (
        <div key={k} className="rounded-[8px] border border-hair px-2 py-1.5">
          <div className="font-mono text-[11px] md:text-[9px] tracking-[0.08em] text-fgdim uppercase">{t(`agent.activity.${k}`)}</div>
          <div className={`font-mono text-[13px] font-bold ${k === 'denied' && v ? 'text-danger' : 'text-fg'}`} dir="ltr">{v}</div>
        </div>
      ))}
      <div data-activity-budget className="col-span-4 rounded-[8px] border border-hair px-2 py-1.5 sm:col-span-7">
        <span className="font-mono text-[11px] md:text-[9px] tracking-[0.08em] text-fgdim uppercase">{t('agent.activity.budget')} · </span>
        {budget?.cap ? (
          <span className={`font-mono text-[11px] ${budget.exceeded ? 'font-bold text-danger' : 'text-fg'}`} dir="ltr">
            {fmtTokens(budget.usedTokens)} / {fmtTokens(budget.cap)} ({Math.min(100, Math.round((budget.usedTokens / budget.cap) * 100))}%)
            {budget.exceeded ? ` — ${t('agent.activity.budgetExceeded', { at: hhmm })}` : ''}
          </span>
        ) : <span className="font-mono text-[11px] text-fgdim">{t('agent.activity.budgetNone')}</span>}
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
  if (!data) return <div className="text-[11px] text-fgdim">{t('dialogs.loading')}</div>;
  const entries = data.entries || [];
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-1.5">
        {RANGES.map((r) => (
          <button key={r} type="button" data-range={r} aria-pressed={range === r} onClick={() => setRange(r)} className={`cursor-pointer rounded-full border px-3 py-0.5 text-[11px] ${range === r ? 'border-ink bg-chip font-bold text-fg' : 'border-hair text-fgdim hover:text-fg'}`}>{t(`agent.activity.range.${r}`)}</button>
        ))}
      </div>
      <ActivityTotals totals={data.totals} budget={data.budget} />
      <div className="rounded-[10px] border border-hair p-3">
        <div className="mb-2 font-mono text-[11.5px] md:text-[10px] tracking-[0.08em] text-fgdim uppercase">{t('agent.activity.ledger')} · {entries.length}</div>
        {entries.length === 0 && <div className="text-[11px] text-fgdim">{t('agent.activity.empty')}</div>}
        <div className="thin-scroll max-h-[420px] overflow-y-auto">
          {entries.map((e, i) => <ActivityRow key={`${e.ts}-${i}`} e={e} onOpenSession={onOpenSession} />)}
        </div>
      </div>
      <button type="button" onClick={() => setShowEp((v) => !v)} className="flex cursor-pointer items-center gap-1.5 font-mono text-[11.5px] md:text-[10.5px] tracking-[0.08em] text-fgdim uppercase hover:text-fg">
        <Icon icon={showEp ? faCaretDown : faCaretRight} /> {showEp ? t('agent.activity.hideEpisodes') : t('agent.activity.showEpisodes')} · {data.episodes.length}
      </button>
      {showEp && (
      <div className="rounded-[10px] border border-hair p-3">
        <div className="mb-2 font-mono text-[11.5px] md:text-[10px] tracking-[0.08em] text-fgdim uppercase">{t('agent.page.episodes')} · {data.episodes.length}</div>
        {data.episodes.length === 0 && <div className="text-[11px] text-fgdim">{t('agent.page.noEpisodes')}</div>}
        {data.episodes.length > 0 && (
          <div className="flex gap-3">
            <div className="thin-scroll flex max-h-[260px] w-[200px] shrink-0 flex-col gap-0.5 overflow-y-auto">
              {data.episodes.map((e) => (
                <button key={e.path} type="button" onClick={() => setEp(e.path)} className={`truncate rounded-[6px] px-2 py-1 text-start font-mono text-[11.5px] md:text-[10.5px] ${ep === e.path ? 'bg-chip text-fg' : 'text-fgdim hover:bg-chip/60'}`}>
                  {e.path.split('/').pop()}
                </button>
              ))}
            </div>
            <pre dir="auto" className="thin-scroll min-w-0 flex-1 overflow-auto whitespace-pre-wrap break-words rounded-[8px] border border-hair bg-bg p-2 text-[11px] leading-relaxed text-fg">{epText}</pre>
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
  if (err) return <div data-home-error className="px-4 py-5 text-[12px] text-danger">{t('agent.surface.homeFailed', { err })}</div>;
  if (!session) return <div className="px-4 py-5 text-[11.5px] text-fgdim">{t('agent.surface.homeOpening')}</div>;
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
      <div className="text-[11.5px] text-fgdim">{t('agent.oneLiner')}</div>
      <div className="rounded-[10px] border border-hair p-3">
        <div className="mb-2 font-mono text-[11.5px] md:text-[10px] tracking-[0.08em] text-fgdim uppercase">{t('agent.runs.title')} · {runs.length}</div>
        {runs.length === 0 && <div className="text-[11px] text-fgdim">{t('agent.runs.empty', { oneLiner: t('agent.oneLiner') })}</div>}
        {runs.map((s) => (
          <button key={s.id} type="button" data-agent-run={s.id} onClick={() => onOpenSession(s.id)} className={`flex w-full cursor-pointer items-center gap-2 rounded-[7px] px-2 py-1.5 text-start hover:bg-chip/60 ${s.archived ? 'opacity-60' : ''}`}>
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: s.claudeState === 'working' ? '#CE8324' : '#c4c4c4' }} />
            <span dir="auto" className="min-w-0 flex-1 truncate font-mono text-[11.5px] font-bold text-fg">{s.title}</span>
            {s.archived && <span className="shrink-0 rounded-full bg-chip px-1.5 py-px font-mono text-[11px] md:text-[9px] text-fgdim">{t('agent.runs.archived')}</span>}
            <span className="shrink-0 font-mono text-[11.5px] md:text-[10px] text-fgdim" dir="ltr">{fmtTokens(s.tokens)} · {fmtUsd(s.costUsd)}</span>
            <span className="shrink-0 font-mono text-[11.5px] md:text-[10px] text-fgdim">{[s.status, relTime(s.updatedAt)].filter(Boolean).join(' · ')}</span>
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
  if (!data) return <div className="text-[11px] text-fgdim">{t('dialogs.loading')}</div>;
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
    <span data-agent-status={working ? 'working' : nextCron ? 'next-run' : 'idle'} className="flex shrink-0 items-center gap-1.5 font-mono text-[11.5px] md:text-[10.5px] text-fgdim">
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
  if (!budget?.cap) return <span data-agent-budget="none" className="font-mono text-[11.5px] md:text-[10.5px] text-fgdim">{t('agent.surface.budgetNone')}</span>;
  const pct = Math.min(100, Math.round((budget.usedTokens / budget.cap) * 100));
  return (
    <span data-agent-budget={budget.exceeded ? 'exceeded' : 'ok'} className="flex min-w-0 shrink items-center gap-2">
      <span className="h-[6px] w-[90px] shrink-0 overflow-hidden rounded-full bg-chip">
        <span className="block h-full rounded-full" style={{ width: `${pct}%`, background: budget.exceeded ? 'var(--danger, #C0392B)' : '#1F9C82' }} />
      </span>
      <span dir="ltr" className={`truncate font-mono text-[11.5px] md:text-[10.5px] ${budget.exceeded ? 'font-bold text-danger' : 'text-fgdim'}`}>
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

/** Close a popover on an outside click or Escape (Escape is swallowed so the surface stays open). */
function useDismiss(ref, open, onClose) {
  useEffect(() => {
    if (!open) return;
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey, true); };
  }, [ref, open, onClose]);
}

const row = 'flex items-baseline gap-2 border-b border-hair py-1.5 text-[11.5px] last:border-b-0';
const rowLbl = 'w-[88px] shrink-0 font-mono text-[11px] md:text-[9.5px] tracking-[0.08em] text-fgdim uppercase';

/**
 * AGENT-PAGE: everything that used to sit in the tall header — handle, persona
 * line, model, tools, domains, budget, skills, auto-approve — as a drawer under
 * the one-row header, opened from the name or the ⋯ menu.
 */
export function AgentDetailsDrawer({ agent, budget, onClose, onEditPersona }) {
  const t = useT();
  const ref = useRef(null);
  useDismiss(ref, true, onClose);
  const persona = personaLine(agent.persona);
  const tools = agent.tools || [];
  const line = (label, value, key) => (value ? <div key={key} className={row}><span className={rowLbl}>{label}</span><span dir="auto" className="min-w-0 flex-1 break-words text-fg">{value}</span></div> : null);
  return (
    <div
      ref={ref}
      data-agent-details-drawer
      role="dialog"
      aria-label={t('agent.page.details')}
      className="absolute top-full start-0 z-30 w-full max-h-[70vh] overflow-y-auto thin-scroll border-b-[1.5px] border-ink bg-panel px-4 py-3 shadow-[0_6px_0_rgba(42,42,42,0.12)] sm:start-3 sm:w-[440px] sm:rounded-b-[12px] sm:border-x-[1.5px]"
    >
      <div className="flex items-start gap-3">
        <AgentAvatar agent={agent} size={40} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span dir="auto" className="text-[15px] leading-tight font-bold text-fg">{agent.name}</span>
            <span dir="ltr" className="font-mono text-[11.5px] md:text-[10.5px] text-fgdim">@{agent.slug}</span>
          </div>
          {persona && <div dir="auto" className="mt-0.5 text-[11.5px] leading-snug text-fgdim">{persona}</div>}
        </div>
        <button type="button" onClick={onClose} aria-label={t('chrome.settings.closeTitle')} className="shrink-0 cursor-pointer px-1 text-[14px] text-fgdim hover:text-fg"><Icon icon={faXmark} /></button>
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
        <button type="button" data-agent-details-edit onClick={onEditPersona} className={btn}><Icon icon={faIdBadge} /> {t('agent.page.editPersona')}</button>
        <span className="text-[11.5px] md:text-[10.5px] text-fgdim">{t('agent.oneLiner')}</span>
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
  return <Overlay onClose={onClose}><DeleteAgentForm agent={agent} onClose={onClose} onDeleted={onDeleted} /></Overlay>;
}

/** The dialog's body (exported so it can be rendered without the portal). */
export function DeleteAgentForm({ agent, onClose, onDeleted }) {
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
      <div data-agent-delete-dialog className="w-[400px] max-w-full overflow-hidden rounded-xl border-2 border-danger bg-panel text-fg shadow-[5px_6px_0_rgba(178,59,48,0.25)]">
        <div className="px-[18px] pt-4">
          <div className="text-[17px] leading-tight font-bold text-danger">{t('agent.page.deleteTitle')}</div>
          <p dir="auto" className="mt-2 text-[12px] leading-normal text-fgdim">{t('agent.page.deleteConfirm', { name: agent.name })}</p>
          <label className="mt-3 block text-[12px] text-fg">
            {t('agent.page.deleteTypeName')} <span dir="auto" className="font-mono font-bold select-all">{agent.name}</span>
          </label>
          <input
            ref={ref}
            data-agent-delete-name
            dir="auto"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') del(); }}
            placeholder={agent.name}
            autoComplete="off"
            className="mt-1.5 w-full rounded-lg border-[1.5px] border-danger/50 bg-bg px-2.5 py-2 text-[12.5px] outline-none placeholder:text-fgdim/60 focus:border-danger"
          />
          {typed && !match && <div className="mt-1 text-[11.5px] md:text-[10.5px] text-danger">{t('agent.page.deleteNameMismatch')}</div>}
        </div>
        <div className="flex justify-end gap-[9px] p-[16px_18px]">
          <GhostButton onClick={onClose}>{t('dialogs.cancel')}</GhostButton>
          <button
            type="button"
            data-agent-delete-confirm
            onClick={del}
            disabled={!match || busy}
            className="cursor-pointer rounded-lg border-2 border-danger bg-danger px-4 py-2 text-[12.5px] font-bold text-white shadow-[2px_2px_0_#7d2a23] disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none"
          >
            {busy ? t('agent.page.deleteBusy') : t('agent.page.deleteDo')}
          </button>
        </div>
      </div>
  );
}

/** The ⋯ menu: details, and the delete — danger-styled, separated, last. */
export function MoreMenu({ onClose, onDetails, onDelete }) {
  const t = useT();
  const ref = useRef(null);
  useDismiss(ref, true, onClose);
  const item = 'flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-start text-[12px] hover:bg-chip';
  return (
    <div ref={ref} data-agent-menu role="menu" className="absolute top-full end-2 z-30 mt-1 w-[200px] rounded-[10px] border-[1.5px] border-ink bg-panel p-1.5 shadow-[3px_3px_0_rgba(42,42,42,0.18)]">
      <button type="button" role="menuitem" data-agent-menu-details onClick={() => { onClose(); onDetails(); }} className={`${item} text-fg`}>
        <span className="w-4 text-center text-[12px] text-fgdim"><Icon icon={faCircleInfo} /></span> {t('agent.page.details')}
      </button>
      <div className="my-1 border-t border-hair" />
      <button type="button" role="menuitem" data-agent-delete onClick={() => { onClose(); onDelete(); }} className={`${item} text-danger hover:bg-danger/10`}>
        <span className="w-4 text-center text-[12px]"><Icon icon={faTrash} /></span> {t('agent.page.delete')}…
      </button>
    </div>
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

  const navItem = (id, { inMenu = false } = {}) => {
    const disabled = isNew && id !== 'persona';
    const current = effectiveTab === id;
    return (
      <button
        key={id}
        type="button"
        data-agent-tab={id}
        disabled={disabled}
        title={disabled ? t('agent.page.tabDisabledHint') : undefined}
        onClick={() => { if (disabled) return; setTab(id); if (inMenu) closePop(); }}
        aria-current={current ? 'page' : undefined}
        className={inMenu
          ? `flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start text-[12.5px] ${disabled ? 'cursor-not-allowed opacity-40' : 'cursor-pointer hover:bg-chip'} ${current ? 'font-bold text-fg' : 'text-fgdim'}`
          : `flex h-[26px] shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-[11.5px] ${disabled ? 'cursor-not-allowed opacity-40' : 'cursor-pointer'} ${current ? 'border-ink bg-panel font-bold text-fg' : 'border-transparent text-fgdim hover:text-fg'}`}
        style={!inMenu && current ? { borderColor: color, background: `${color}1a` } : undefined}
      >
        <span className="w-4 text-center text-[12px]"><Icon icon={ICONS[id]} /></span>
        {t(`agent.page.tab.${id}`)}
      </button>
    );
  };

  let body;
  if (isNew) body = <PersonaTab key="draft" agent={agent} isNew onSaved={(a) => onCreated?.(a)} onDeleted={onClose} />;
  else if (missing || (!agent && fetched === null && agents?.length)) body = <div className="text-[12px] text-fgdim">{t('agent.page.notFound')}</div>;
  else if (!agent) body = <div className="text-[11px] text-fgdim">{t('dialogs.loading')}</div>;
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
    // switcher · ⋯ · ✕. The accent wash keeps it reading as the agent's place;
    // everything else (handle, persona line, budget, model, tools…) lives in
    // the details drawer under the name.
    <div data-agent-page={slug} data-agent-surface={slug} className="flex min-h-0 flex-1 flex-col bg-panel">
      <div data-agent-header className="relative z-20 flex h-11 shrink-0 items-center gap-2 border-b-[1.5px] px-3" style={{ background: `linear-gradient(180deg, ${color}26, ${color}0d)`, borderColor: `${color}66` }}>
        <button
          type="button"
          aria-label={t('rail.openSessions')}
          onClick={() => window.dispatchEvent(new CustomEvent('host:open-rail'))}
          className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-[7px] border-[1.5px] border-border bg-bg text-[13px] text-fg md:hidden"
        >
          <Icon icon={faBars} />
        </button>
        {/* avatar + name = the details trigger (a draft has no details yet) */}
        <button
          type="button"
          data-agent-details={isNew ? undefined : 'toggle'}
          disabled={isNew || !agent}
          title={isNew ? undefined : t('agent.page.detailsHint')}
          aria-expanded={pop === 'details'}
          onClick={() => setPop((p) => (p === 'details' ? null : 'details'))}
          className="flex min-w-0 shrink cursor-pointer items-center gap-2 rounded-md py-0.5 pe-1.5 text-start disabled:cursor-default"
        >
          {agent ? <AgentAvatar agent={agent} size={26} /> : null}
          <span dir="auto" className="min-w-0 truncate text-[14px] leading-tight font-bold text-fg">{title}</span>
          {!isNew && agent && <span className="hidden shrink-0 text-[11.5px] md:text-[10px] text-fgdim sm:inline"><Icon icon={faCaretDown} /></span>}
        </button>
        {agent && !isNew && <SurfaceStatus agent={agent} sessions={sessions} triggers={triggers} />}
        <div className="ms-auto flex min-w-0 shrink items-center gap-1">
          {/* sm+: the pills inline (scroll when tight); <sm: a switcher button */}
          <div data-agent-tabs="pills" className="thin-scroll hidden min-w-0 items-center gap-1 overflow-x-auto sm:flex">{TABS.map((id) => navItem(id))}</div>
          <button
            type="button"
            data-agent-tabs="switcher"
            aria-label={t('agent.page.tabSwitcher')}
            aria-expanded={pop === 'tabs'}
            onClick={() => setPop((p) => (p === 'tabs' ? null : 'tabs'))}
            className="flex h-[26px] shrink-0 cursor-pointer items-center gap-1.5 rounded-full border px-2.5 text-[11.5px] font-bold text-fg sm:hidden"
            style={{ borderColor: color, background: `${color}1a` }}
          >
            <span className="w-4 text-center text-[12px]"><Icon icon={ICONS[effectiveTab]} /></span>
            {t(`agent.page.tab.${effectiveTab}`)}
            <span className="text-[11.5px] md:text-[10px] text-fgdim"><Icon icon={faCaretDown} /></span>
          </button>
        </div>
        {agent && !isNew && (
          <button
            type="button"
            data-agent-more
            aria-label={t('agent.page.more')}
            aria-expanded={pop === 'menu'}
            onClick={() => setPop((p) => (p === 'menu' ? null : 'menu'))}
            className="shrink-0 cursor-pointer rounded px-1.5 py-1 text-[14px] text-fgdim hover:bg-chip hover:text-fg"
          >
            <Icon icon={faEllipsis} />
          </button>
        )}
        <button type="button" onClick={onClose} title={t('chrome.settings.closeTitle')} className="shrink-0 cursor-pointer px-1 text-[15px] text-fgdim hover:text-fg">
          <Icon icon={faXmark} />
        </button>
        {pop === 'tabs' && (
          <TabMenu onClose={closePop}>{TABS.map((id) => navItem(id, { inMenu: true }))}</TabMenu>
        )}
        {pop === 'menu' && agent && !isNew && (
          <MoreMenu onClose={closePop} onDetails={() => setPop('details')} onDelete={() => setPop('delete')} />
        )}
        {pop === 'details' && agent && !isNew && (
          <AgentDetailsDrawer agent={agent} budget={budget} onClose={closePop} onEditPersona={() => { closePop(); setTab('persona'); }} />
        )}
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

/** The mobile tab switcher's popover. */
function TabMenu({ onClose, children }) {
  const t = useT();
  const ref = useRef(null);
  useDismiss(ref, true, onClose);
  return (
    <div ref={ref} data-agent-tabs-menu role="menu" aria-label={t('agent.page.tabSwitcher')} className="absolute top-full end-2 z-30 mt-1 w-[200px] rounded-[10px] border-[1.5px] border-ink bg-panel p-1.5 shadow-[3px_3px_0_rgba(42,42,42,0.18)]">
      {children}
    </div>
  );
}
