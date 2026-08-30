// A1 — the Agent page (#/agents/<slug>), same visual language as Settings:
// header + tabs פרסונה / זיכרון / פעילות (חיבורים / שגרה are A2 placeholders).
//   persona   identity fields + the persona textarea → PATCH /__api/agents/:slug
//   memory    the agent's MEMORY.md + journal (memory namespace agents/<slug>/…)
//   activity  the agent's sessions + their episodes (GET /__api/agents/:slug/activity)
import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { Icon } from '../lib/icons.js';
import { useT } from '../lib/i18n.js';
import { useIsDesktop } from '../lib/useMedia.js';
import { useModels } from '../lib/models.js';
import { useStore } from '../lib/store.js';
import { relTime } from '../lib/time.js';
import { toastError, toastSuccess } from '../lib/toast.js';
import { Wave } from './ui.jsx';
import { AgentAvatar, TOOL_FAMILIES } from './AgentCard.jsx';
import { faXmark, faIdBadge, faBrain, faListCheck, faLink, faClock, faComments, faTrash, faCaretDown, faCaretRight } from '@fortawesome/free-solid-svg-icons';

const TABS = ['persona', 'memory', 'activity', 'connections', 'routine'];
const ICONS = { persona: faIdBadge, memory: faBrain, activity: faListCheck, connections: faLink, routine: faClock };

const input = 'w-full rounded-[7px] border-[1.5px] border-border bg-panel px-2.5 py-1.5 text-[12px] text-fg outline-none focus:border-ink';
const lbl = 'mb-1 block font-mono text-[10px] tracking-[0.08em] text-fgdim uppercase';
const btn = 'cursor-pointer rounded-lg border-[1.5px] border-ink bg-panel px-3 py-1.5 text-[11.5px] font-bold text-fg hover:bg-chip disabled:opacity-40';
const btnBrand = 'cursor-pointer rounded-lg border-[1.5px] border-ink bg-brand px-3 py-1.5 text-[11.5px] font-bold text-[#1a1a1a] shadow-[2px_2px_0_#2a2a2a] disabled:opacity-40 disabled:shadow-none';

function PersonaTab({ agent, onSaved, onDeleted, onOpenHome }) {
  const t = useT();
  const { models } = useModels();
  const [skillNames, setSkillNames] = useState([]);
  const [form, setForm] = useState({
    name: agent.name, emoji: agent.emoji, color: agent.color, model: agent.model || '', persona: agent.persona || '',
    skills: agent.skills || [], tools: agent.tools || [], budget: agent.budget?.tokensPerDay ? String(agent.budget.tokensPerDay) : '',
  });
  const [busy, setBusy] = useState(false);
  // Advanced (model/budget/tools/skills) opens only when something is already set there.
  const [advanced, setAdvanced] = useState(!!(agent.model || agent.budget?.tokensPerDay || agent.tools?.length || agent.skills?.length));
  useEffect(() => { api.get('/skills').then((r) => setSkillNames((r?.skills || []).map((s) => s.name))).catch(() => {}); }, []);
  const set = (k) => (e) => setForm((c) => ({ ...c, [k]: e.target.value }));
  const toggle = (k, v) => setForm((c) => ({ ...c, [k]: c[k].includes(v) ? c[k].filter((x) => x !== v) : [...c[k], v] }));
  const save = async () => {
    setBusy(true);
    try {
      const a = await api.patch(`/agents/${agent.slug}`, {
        name: form.name.trim(), emoji: form.emoji.trim() || '🤖', color: form.color, model: form.model || null, persona: form.persona,
        skills: form.skills, tools: form.tools, budget: Number(form.budget) > 0 ? { tokensPerDay: Number(form.budget) } : null,
      });
      toastSuccess(t('agent.page.saved'));
      onSaved?.(a);
    } catch (e) {
      toastError(t('agent.page.saveFailed', { err: e?.body?.error || e?.message || e }));
    } finally {
      setBusy(false);
    }
  };
  const del = async () => {
    if (!window.confirm(t('agent.page.deleteConfirm', { name: agent.name }))) return;
    try { await api.del(`/agents/${agent.slug}`); toastSuccess(t('agent.page.deleted')); onDeleted?.(); } catch (e) { toastError(e?.message || String(e)); }
  };
  return (
    <div className="flex flex-col gap-4">
      <section className="rounded-[10px] border border-hair p-3">
        <div className="mb-2 font-mono text-[10px] tracking-[0.08em] text-fgdim uppercase">{t('agent.page.identity')}</div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div><label className={lbl}>{t('agent.card.name')}</label><input dir="auto" value={form.name} onChange={set('name')} className={input} /></div>
          <div className="grid grid-cols-[64px_1fr] gap-2">
            <div><label className={lbl}>{t('agent.card.emoji')}</label><input value={form.emoji} onChange={set('emoji')} className={`${input} text-center`} /></div>
            <div><label className={lbl}>{t('agent.card.color')}</label><input type="color" value={form.color} onChange={set('color')} className="h-[34px] w-full cursor-pointer rounded-[7px] border-[1.5px] border-border bg-panel p-0.5" /></div>
          </div>
        </div>
      </section>
      <section className="rounded-[10px] border border-hair p-3">
        <label className={lbl}>{t('agent.card.persona')}</label>
        <textarea dir="auto" rows={10} value={form.persona} onChange={set('persona')} className={`${input} resize-y font-mono text-[11.5px] leading-relaxed`} />
      </section>
      <button type="button" onClick={() => setAdvanced((v) => !v)} className="flex cursor-pointer items-center gap-1.5 font-mono text-[10.5px] tracking-[0.08em] text-fgdim uppercase hover:text-fg">
        <Icon icon={advanced ? faCaretDown : faCaretRight} /> {t('agent.card.advanced')}
      </button>
      {advanced && (
      <section className="rounded-[10px] border border-hair p-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label className={lbl}>{t('agent.card.model')}</label>
            <select value={form.model} onChange={set('model')} className={input}>
              <option value="">{t('agent.card.modelDefault')}</option>
              {(models || []).filter((m) => m.value && m.value !== 'default').map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
              {form.model && !(models || []).some((m) => m.value === form.model) && <option value={form.model}>{form.model}</option>}
            </select>
          </div>
          <div><label className={lbl}>{t('agent.card.budget')}</label><input type="number" min="0" value={form.budget} onChange={set('budget')} placeholder={t('agent.card.budgetNone')} className={input} /></div>
          <div className="sm:col-span-2">
            <label className={lbl}>{t('agent.card.tools')}</label>
            <div className="flex flex-wrap gap-x-3 gap-y-1">
              {TOOL_FAMILIES.map((id) => (
                <label key={id} className="flex cursor-pointer items-center gap-1 text-[11.5px] text-fg"><input type="checkbox" checked={form.tools.includes(id)} onChange={() => toggle('tools', id)} /> {t(`agent.tool.${id}`)}</label>
              ))}
            </div>
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
        <button type="button" onClick={save} disabled={busy || !form.name.trim()} className={btnBrand}>{t('agent.page.save')}</button>
        <button type="button" onClick={onOpenHome} className={btn}><Icon icon={faComments} /> {t('agent.page.openHome')}</button>
        <button type="button" onClick={del} className={`${btn} ms-auto text-danger`}><Icon icon={faTrash} /> {t('agent.page.delete')}</button>
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
        <div className="mb-2 flex items-center gap-2 font-mono text-[10px] tracking-[0.08em] text-fgdim uppercase">
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

function ActivityTab({ agent, onOpenSession }) {
  const t = useT();
  const [data, setData] = useState(null);
  const [ep, setEp] = useState(null);
  const [epText, setEpText] = useState('');
  useEffect(() => { api.get(`/agents/${agent.slug}/activity`).then(setData).catch(() => setData({ sessions: [], episodes: [] })); }, [agent.slug]);
  useEffect(() => {
    if (!ep) return;
    api.get(`/memory/get?path=${encodeURIComponent(ep)}`).then((r) => setEpText(r.content || '')).catch(() => setEpText(''));
  }, [ep]);
  if (!data) return <div className="text-[11px] text-fgdim">{t('dialogs.loading')}</div>;
  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-[10px] border border-hair p-3">
        <div className="mb-2 font-mono text-[10px] tracking-[0.08em] text-fgdim uppercase">{t('agent.page.sessions')} · {data.sessions.length}</div>
        {data.sessions.length === 0 && <div className="text-[11px] text-fgdim">{t('agent.page.noSessions')}</div>}
        {data.sessions.map((s) => (
          <button key={s.id} type="button" onClick={() => onOpenSession(s.id)} className={`flex w-full cursor-pointer items-center gap-2 rounded-[7px] px-2 py-1.5 text-start hover:bg-chip/60 ${s.archived ? 'opacity-60' : ''}`}>
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: s.claudeState === 'working' ? '#CE8324' : '#c4c4c4' }} />
            <span dir="auto" className="min-w-0 flex-1 truncate font-mono text-[11.5px] font-bold text-fg">{s.title}</span>
            {s.home && <span className="rounded-full bg-chip px-1.5 py-px font-mono text-[9px] text-fgdim">{t('agent.page.home')}</span>}
            <span className="font-mono text-[10px] text-fgdim">{[s.status, relTime(s.updatedAt)].filter(Boolean).join(' · ')}</span>
          </button>
        ))}
      </div>
      <div className="rounded-[10px] border border-hair p-3">
        <div className="mb-2 font-mono text-[10px] tracking-[0.08em] text-fgdim uppercase">{t('agent.page.episodes')} · {data.episodes.length}</div>
        {data.episodes.length === 0 && <div className="text-[11px] text-fgdim">{t('agent.page.noEpisodes')}</div>}
        {data.episodes.length > 0 && (
          <div className="flex gap-3">
            <div className="thin-scroll flex max-h-[260px] w-[200px] shrink-0 flex-col gap-0.5 overflow-y-auto">
              {data.episodes.map((e) => (
                <button key={e.path} type="button" onClick={() => setEp(e.path)} className={`truncate rounded-[6px] px-2 py-1 text-start font-mono text-[10.5px] ${ep === e.path ? 'bg-chip text-fg' : 'text-fgdim hover:bg-chip/60'}`}>
                  {e.path.split('/').pop()}
                </button>
              ))}
            </div>
            <pre dir="auto" className="thin-scroll min-w-0 flex-1 overflow-auto whitespace-pre-wrap break-words rounded-[8px] border border-hair bg-bg p-2 text-[11px] leading-relaxed text-fg">{epText}</pre>
          </div>
        )}
      </div>
    </div>
  );
}

export default function AgentView({ slug, onClose, onOpenSession }) {
  const t = useT();
  const desktop = useIsDesktop();
  const { agents } = useStore();
  const [tab, setTab] = useState('persona');
  const [fetched, setFetched] = useState(null); // full record (persona) — the store list has it too, but fetch to be exact
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    let stop = false;
    setMissing(false);
    api.get(`/agents/${encodeURIComponent(slug)}`).then((a) => { if (!stop) setFetched(a); }).catch(() => { if (!stop) setMissing(true); });
    return () => { stop = true; };
  }, [slug]);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  const agent = fetched || (agents || []).find((a) => a.slug === slug) || null;

  const openHome = async () => {
    try {
      const r = await api.get(`/agents/${slug}/home`);
      if (r?.session?.id) onOpenSession(r.session.id);
    } catch (e) {
      toastError(t('rail.teamOpenFailed'));
    }
  };

  const navItem = (id) => (
    <button
      key={id}
      type="button"
      onClick={() => setTab(id)}
      aria-current={tab === id ? 'page' : undefined}
      className={desktop
        ? `flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-start text-[12.5px] ${tab === id ? 'bg-chip font-bold text-fg' : 'text-fgdim hover:bg-chip/60 hover:text-fg'}`
        : `flex shrink-0 cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1 text-[11.5px] ${tab === id ? 'border-ink bg-chip font-bold text-fg' : 'border-hair text-fgdim'}`}
    >
      <span className="w-4 text-center text-[12px]"><Icon icon={ICONS[id]} /></span>
      {t(`agent.page.tab.${id}`)}
    </button>
  );

  let body;
  if (missing || (!agent && fetched === null && agents?.length)) body = <div className="text-[12px] text-fgdim">{t('agent.page.notFound')}</div>;
  else if (!agent) body = <div className="text-[11px] text-fgdim">{t('dialogs.loading')}</div>;
  else if (tab === 'memory') body = <MemoryTab agent={agent} />;
  else if (tab === 'activity') body = <ActivityTab agent={agent} onOpenSession={onOpenSession} />;
  else if (tab === 'connections' || tab === 'routine') body = <div className="text-[12px] text-fgdim">{t('agent.page.soon')}</div>;
  else body = <PersonaTab key={agent.updatedAt} agent={agent} onSaved={setFetched} onDeleted={onClose} onOpenHome={openHome} />;

  return (
    <div data-agent-page={slug} className="flex min-h-0 flex-1 flex-col bg-panel">
      <div className="flex h-11 shrink-0 items-center gap-[9px] border-b border-hair px-4">
        <Wave />
        {agent ? <AgentAvatar agent={agent} size={20} /> : null}
        <span dir="auto" className="text-sm font-bold text-fg">{agent?.name || t('agent.page.title')}</span>
        <span className="text-[12px] text-fgdim">/ {t(`agent.page.tab.${tab}`)}</span>
        {agent && (
          <button type="button" onClick={openHome} title={t('agent.page.openHome')} className="ms-2 cursor-pointer rounded-md border border-border px-2 py-0.5 text-[11px] text-fgdim hover:border-ink hover:text-fg">
            <Icon icon={faComments} /> {t('rail.teamHomeChat')}
          </button>
        )}
        <button type="button" onClick={onClose} title={t('chrome.settings.closeTitle')} className="ms-auto cursor-pointer px-1 text-[15px] text-fgdim hover:text-fg">
          <Icon icon={faXmark} />
        </button>
      </div>
      {!desktop && <div className="thin-scroll flex shrink-0 gap-1.5 overflow-x-auto border-b border-hair px-3 py-2">{TABS.map(navItem)}</div>}
      <div className="flex min-h-0 flex-1">
        {desktop && <nav className="flex w-[180px] shrink-0 flex-col gap-0.5 border-e border-hair px-2 py-3">{TABS.map(navItem)}</nav>}
        <div className="thin-scroll min-h-0 flex-1 overflow-y-auto">
          <div key={tab} className="mx-auto w-full max-w-[640px] px-4 py-5 sm:px-7">{body}</div>
        </div>
      </div>
    </div>
  );
}
