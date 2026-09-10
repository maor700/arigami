import { useEffect, useMemo, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import { api, PALETTE } from '../lib/api.js';
import { useStore } from '../lib/store.js';
import { useLinearList } from '../lib/linearMeta.js';
import { Icon } from '../lib/icons.js';
import {
  faArrowUp,
  faBolt,
  faCaretDown,
  faStar,
  faThumbtack,
  faTriangleExclamation,
  faXmark,
} from '@fortawesome/free-solid-svg-icons';
import {
  usePrefs,
  setPrefs,
  EMPTY_TICKET_FILTERS,
  sanitizeFilters,
  saveTicketPreset,
  deleteTicketPreset,
  setDefaultTicketPreset,
  saveSessionPreset,
  deleteSessionPreset,
  setDefaultSessionPreset,
  setModeDefaultSessionPreset,
} from '../lib/prefs.js';
import { useModels } from '../lib/models.js';
import { engineOptions, modelOptionsFor, effortOptionsFor, coerceSessionOptions } from '../lib/engines.js';
import { Wave, Dot, YellowButton, tint } from './ui.jsx';
import { t, useT } from '../lib/i18n.js';
import { fmtDateTime } from '../lib/time.js';

// [value, i18n key]; labels resolved with t() at render/summary time.
const STATE_OPTS = [
  ['', 'launcher.state.any'],
  ['triage', 'launcher.state.triage'],
  ['backlog', 'launcher.state.backlog'],
  ['unstarted', 'launcher.state.todo'],
  ['started', 'launcher.state.inProgress'],
  ['completed', 'launcher.state.done'],
  ['canceled', 'launcher.state.canceled'],
];
const PRIORITY_OPTS = [
  ['', 'launcher.priority.any'],
  ['1', 'launcher.priority.urgent'],
  ['2', 'launcher.priority.high'],
  ['3', 'launcher.priority.medium'],
  ['4', 'launcher.priority.low'],
  ['0', 'launcher.priority.none'],
];

const filtersEqual = (a, b) =>
  JSON.stringify(sanitizeFilters(a)) === JSON.stringify(sanitizeFilters(b));

// Built-in preset, always present + the default when the user hasn't picked one.
// "My open work": my tickets, recent first, hiding ones already in a session.
const BUILTIN_PRESET = {
  id: 'builtin:my-open',
  name: 'My open work',
  builtin: true,
  filters: sanitizeFilters({ assignee: 'me', orderBy: 'updatedAt', hideOpen: true }),
};

/* ---------- shared launcher helpers --------------------------------------- */

export function extractTicketId(raw) {
  const m = String(raw || '').match(/([A-Za-z]{2,8}-\d{1,6})/);
  return m ? m[1].toUpperCase() : null;
}

function slug(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 28)
    .replace(/-+$/, '');
}

// The session's first message is built server-side from `skill` (+ ticket id)
// so the absolute $SKILL_DIR path never has to be known client-side — see
// server/api.ts's buildFirstPrompt. `prompt` here is just the optional extra
// instructions merged in after the skill's own prompt (or used verbatim if no
// skill is picked).
export function buildTicketPayload(ticket, config, sessions, permissionMode, promptOverride, sessionOpts) {
  const id = ticket.id;
  return {
    title: ticket.title && ticket.title !== id ? ticket.title : id,
    cwd: config?.reposDir || config?.defaultCwd || undefined,
    metadata: { ticket: id },
    ...(permissionMode ? { permissionMode } : {}),
    ...(promptOverride && promptOverride.trim() ? { prompt: promptOverride.trim() } : {}),
    engine: sessionOpts?.engine || undefined,
    skill: sessionOpts?.skill || undefined,
    model: sessionOpts?.model || undefined,
    effort: sessionOpts?.effort || undefined,
  };
}

export function nextPaletteColor(sessions, config) {
  const palette = config?.palette?.length ? config.palette : PALETTE;
  return palette[(sessions?.length || 0) % palette.length];
}

/* ---------- ticket normalization ------------------------------------------- */

function normalizeTicket(t) {
  if (!t || typeof t !== 'object') return null;
  const id = t.identifier || t.id || t.key;
  if (!id) return null;
  return {
    id: String(id),
    title: t.title || t.name || '',
    status: t.status || t.state?.name || t.state || '',
    project: t.project?.name || t.project || t.team?.name || '',
    priority:
      (t.priority && typeof t.priority === 'object' ? (t.priority.value ?? t.priority.name) : t.priority) ??
      t.priorityLabel ??
      null,
    assignee: t.assignee?.name || t.assignee || '',
    labels: Array.isArray(t.labels)
      ? t.labels.map((l) => (typeof l === 'string' ? l : l?.name)).filter(Boolean)
      : Array.isArray(t.labels?.nodes)
        ? t.labels.nodes.map((l) => l?.name).filter(Boolean)
        : [],
    updatedAt: t.updatedAt || t.updated_at || '',
    createdAt: t.createdAt || t.created_at || '',
  };
}

// Linear-style priority glyph: 1 urgent / 2 high → amber bars; 3 normal → grey
// bars; 4 low / 0 none → flat dash.
function PriorityGlyph({ priority }) {
  const p = typeof priority === 'string' ? priority.toLowerCase() : priority;
  const high = p === 1 || p === 2 || p === 'urgent' || p === 'high';
  const normal = p === 3 || p === 'medium' || p === 'normal';
  if (high || normal) {
    const c = high ? '#CE8324' : '#A7A9B0';
    const dim = high ? '#CE8324' : '#d8d8d8';
    return (
      <span className="flex shrink-0 flex-col gap-[1.5px]" aria-hidden="true">
        <span style={{ width: 4, height: 5, background: dim }} />
        <span style={{ width: 4, height: 8, background: c }} />
        <span style={{ width: 4, height: 11, background: high ? c : dim }} />
      </span>
    );
  }
  return (
    <span
      className="shrink-0 rounded-[2px]"
      style={{ width: 11, height: 4, background: '#d5d8e0' }}
      aria-hidden="true"
    />
  );
}

/* ---------- launcher pieces ------------------------------------------------- */

function PasteField({ onPick, autoFocus }) {
  const t = useT();
  const [val, setVal] = useState('');
  const ref = useRef(null);
  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);
  const commit = () => {
    const id = extractTicketId(val);
    if (id) {
      onPick({ id, title: '', status: '', project: '', priority: null, pasted: true });
      setVal('');
    }
  };
  return (
    <div className="flex items-center gap-[9px] rounded-[9px] border-[1.5px] border-ink px-3 py-[9px] focus-within:shadow-[2px_2px_0_rgba(42,42,42,0.16)]">
      <span
        className="h-[13px] w-[13px] shrink-0 rotate-45 rounded-[2px]"
        style={{ background: '#5b62d6' }}
      />
      <input
        ref={ref}
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && commit()}
        placeholder={t('launcher.paste.placeholder')}
        className="min-w-0 flex-1 bg-transparent text-[12.5px] outline-none placeholder:text-fgdim"
      />
      <span className="shrink-0 font-mono text-[11px] text-fgdim">ENG-16498</span>
    </div>
  );
}

const selCls =
  'cursor-pointer rounded-[7px] border border-border bg-panel px-2 py-[3px] text-[11px] text-fg outline-none hover:border-fgdim focus:border-ink disabled:opacity-40';

// Multi-select tag filter with an Any/All (OR/AND) operator. Linear's API only
// takes one label, so the server (listIssuesByFacets) fans out OR into N calls
// and resolves AND by intersection — here we just collect the selection + op.
function LabelPicker({ options, selected, op, onChange, disabled }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const toggle = (name) => {
    const has = selected.includes(name);
    onChange({
      labels: has ? selected.filter((l) => l !== name) : [...selected, name],
      labelOp: op,
    });
  };

  const summary =
    selected.length === 0
      ? t('launcher.labels.any')
      : selected.length === 1
        ? selected[0]
        : `${selected[0]} +${selected.length - 1}`;
  const filtered = q ? options.filter((l) => l.toLowerCase().includes(q.toLowerCase())) : options;

  return (
    <span className="relative" ref={ref}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        title={t('launcher.labels.filterTitle')}
        className={`${selCls} flex items-center gap-1 ${selected.length ? 'border-ink font-bold' : ''}`}
      >
        <span className="max-w-[120px] truncate">{summary}</span>
        {selected.length > 1 && (
          <span className="font-mono text-[11px] md:text-[9px] text-fgdim uppercase">{op}</span>
        )}
        <span className="text-[10px] md:text-[8px] text-fgdim"><Icon icon={faCaretDown} /></span>
      </button>
      {open && !disabled && (
        <div className="absolute top-full left-0 z-30 mt-1 w-[220px] rounded-[9px] border-[1.5px] border-ink bg-panel p-2 shadow-[2px_2px_0_rgba(42,42,42,0.16)]">
          <div className="mb-2 flex items-center gap-1.5">
            <span className="text-[11.5px] md:text-[10px] font-bold tracking-wide text-fgdim uppercase">{t('launcher.labels.match')}</span>
            <span className="flex overflow-hidden rounded-[6px] border border-border">
              {[
                ['or', t('launcher.labels.opAny')],
                ['and', t('launcher.labels.opAll')],
              ].map(([v, l]) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => onChange({ labels: selected, labelOp: v })}
                  className={`cursor-pointer px-2 py-[2px] text-[11.5px] md:text-[10.5px] ${
                    op === v ? 'bg-brand font-bold text-fg' : 'bg-panel text-fgdim'
                  }`}
                >
                  {l}
                </button>
              ))}
            </span>
            {selected.length > 0 && (
              <button
                type="button"
                onClick={() => onChange({ labels: [], labelOp: op })}
                className="ml-auto cursor-pointer text-[11.5px] md:text-[10.5px] text-fgdim hover:text-danger"
              >
                {t('launcher.labels.clear')}
              </button>
            )}
          </div>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t('launcher.labels.searchPlaceholder')}
            className="mb-1.5 w-full rounded-[6px] border border-border bg-bg px-2 py-[3px] text-[11px] outline-none focus:border-ink"
          />
          <div className="thin-scroll max-h-[180px] overflow-y-auto">
            {filtered.length === 0 && <div className="px-1 py-2 text-[11px] text-fgdim">{t('launcher.labels.none')}</div>}
            {filtered.map((l) => (
              <label
                key={l}
                className="flex cursor-pointer items-center gap-2 rounded-[6px] px-1.5 py-[3px] text-[11.5px] hover:bg-chip"
              >
                <input
                  type="checkbox"
                  checked={selected.includes(l)}
                  onChange={() => toggle(l)}
                  className="cursor-pointer"
                />
                <span className="min-w-0 truncate">{l}</span>
              </label>
            ))}
          </div>
        </div>
      )}
    </span>
  );
}

// Faceted, combinable filters → one list_issues call. `disabled` while not connected.
function FilterBar({
  filters,
  onChange,
  labels,
  statuses = [],
  disabled,
  showSearch = true,
  showHideOpen = true,
}) {
  const t = useT();
  const set = (patch) => onChange({ ...filters, ...patch });
  // Live workspace statuses when we have them; the state-type buckets as a
  // fallback (offline / not yet loaded).
  const stateOpts = statuses.length
    ? [['', t('launcher.state.any')], ...statuses.map((s) => [s.name, s.name])]
    : STATE_OPTS.map(([v, k]) => [v, t(k)]);
  return (
    <div className="flex flex-wrap items-center gap-1.5 px-[18px] pb-2">
      <span className="flex overflow-hidden rounded-[7px] border border-border">
        {[
          ['me', t('launcher.filter.me')],
          ['any', t('launcher.filter.anyone')],
        ].map(([v, l]) => (
          <button
            key={v}
            type="button"
            disabled={disabled}
            onClick={() => set({ assignee: v })}
            className={`cursor-pointer px-2.5 py-[3px] text-[11px] disabled:opacity-40 ${
              filters.assignee === v ? 'bg-brand font-bold text-fg' : 'bg-panel text-fgdim'
            }`}
          >
            {l}
          </button>
        ))}
      </span>
      <select disabled={disabled} value={filters.state} onChange={(e) => set({ state: e.target.value })} className={selCls}>
        {stateOpts.map(([v, l]) => (
          <option key={v} value={v}>{l}</option>
        ))}
      </select>
      <select disabled={disabled} value={filters.priority} onChange={(e) => set({ priority: e.target.value })} className={selCls}>
        {PRIORITY_OPTS.map(([v, k]) => (
          <option key={v} value={v}>{t(k)}</option>
        ))}
      </select>
      <LabelPicker
        options={labels}
        selected={filters.labels}
        op={filters.labelOp}
        onChange={({ labels: ls, labelOp }) => set({ labels: ls, labelOp })}
        disabled={disabled}
      />
      {showSearch && (
        <input
          disabled={disabled}
          value={filters.query}
          onChange={(e) => set({ query: e.target.value })}
          placeholder={t('launcher.filter.searchPlaceholder')}
          className="min-w-[120px] flex-1 rounded-[7px] border border-border bg-panel px-2.5 py-[3px] text-[11px] outline-none focus:border-ink disabled:opacity-40"
        />
      )}
      <span className="flex overflow-hidden rounded-[7px] border border-border" title={t('launcher.filter.sortTitle')}>
        {[
          ['updatedAt', t('launcher.filter.updated')],
          ['createdAt', t('launcher.filter.created')],
        ].map(([v, l]) => (
          <button
            key={v}
            type="button"
            disabled={disabled}
            onClick={() => set({ orderBy: v })}
            className={`cursor-pointer px-2 py-[3px] text-[11px] disabled:opacity-40 ${
              filters.orderBy === v ? 'bg-brand font-bold text-fg' : 'bg-panel text-fgdim'
            }`}
          >
            {l}
          </button>
        ))}
      </span>
      {showHideOpen && (
        <button
          type="button"
          disabled={disabled}
          onClick={() => set({ hideOpen: !filters.hideOpen })}
          title={t('launcher.filter.hideOpenTitle')}
          className={`flex cursor-pointer items-center gap-1 rounded-[7px] border px-2 py-[3px] text-[11px] disabled:opacity-40 ${
            filters.hideOpen ? 'border-ink bg-chip font-bold text-fg' : 'border-border bg-panel text-fgdim hover:border-fgdim'
          }`}
        >
          <span className="text-[11.5px] md:text-[10px]">{filters.hideOpen ? '☑' : '☐'}</span> {t('launcher.filter.hideOpen')}
        </button>
      )}
    </div>
  );
}

// Saved presets: apply (chip), set default (★), delete (×), save current (+).
// `presets` includes the built-in first; the built-in can't be deleted.
function PresetBar({ presets, defaultId, current, onApply }) {
  const t = useT();
  const activeId = presets.find((p) => filtersEqual(p.filters, current))?.id || null;
  const [naming, setNaming] = useState(false);
  const [draft, setDraft] = useState('');
  const commit = () => {
    const name = draft.trim();
    if (name) saveTicketPreset(name, current);
    setDraft('');
    setNaming(false);
  };
  return (
    <div className="flex flex-wrap items-center gap-1.5 px-[18px] pb-2.5">
      <span className="text-[11.5px] md:text-[10px] font-bold tracking-wide text-fgdim uppercase">{t('launcher.presets.title')}</span>
      {presets.map((p) => (
        <span
          key={p.id}
          className={`flex items-center gap-1 rounded-full border px-2 py-[2px] text-[11.5px] md:text-[10.5px] ${
            activeId === p.id ? 'border-ink bg-chip font-bold text-fg' : 'border-border bg-panel text-fgdim'
          }`}
        >
          <button
            type="button"
            onClick={() => setDefaultTicketPreset(p.id)}
            title={defaultId === p.id ? t('launcher.presets.unsetDefault') : t('launcher.presets.setDefault')}
            className={`cursor-pointer ${defaultId === p.id ? 'text-[#CE8324]' : 'text-fgdim hover:text-fg'}`}
          >
            <Icon icon={faStar} className={defaultId === p.id ? undefined : 'opacity-30'} />
          </button>
          <button type="button" onClick={() => onApply(p.filters)} className="cursor-pointer">
            {p.builtin ? t('launcher.preset.myOpenWork') : p.name}
          </button>
          {!p.builtin && (
            <button
              type="button"
              onClick={() => deleteTicketPreset(p.id)}
              title={t('launcher.presets.delete')}
              className="cursor-pointer text-fgdim hover:text-danger"
            >
              <Icon icon={faXmark} />
            </button>
          )}
        </span>
      ))}
      {naming ? (
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            else if (e.key === 'Escape') { setDraft(''); setNaming(false); }
          }}
          placeholder={t('launcher.presets.namePlaceholder')}
          className="w-28 rounded-full border border-ink bg-panel px-2 py-[2px] text-[11.5px] md:text-[10.5px] outline-none placeholder:text-fgdim"
        />
      ) : (
        <button
          type="button"
          onClick={() => setNaming(true)}
          className="cursor-pointer rounded-full border border-border bg-panel px-2 py-[2px] text-[11.5px] md:text-[10.5px] font-bold text-fg hover:border-ink"
        >
          {t('launcher.presets.saveCurrent')}
        </button>
      )}
    </div>
  );
}

function sessionOptionsEqual(a, b) {
  return (
    (a?.engine || '') === (b?.engine || '') &&
    (a?.skill || '') === (b?.skill || '') &&
    (a?.model || '') === (b?.model || '') &&
    (a?.effort || '') === (b?.effort || '')
  );
}

// This launcher tab's ('ticket' | 'empty' | 'trigger') own default wins over
// the any-tab default (more specific); neither set → blank, same as picking
// nothing.
function defaultSessionOptions(prefs, mode) {
  const id = prefs.sessionDefaultPresetByMode[mode] || prefs.sessionDefaultPresetId;
  const d = prefs.sessionPresets.find((p) => p.id === id);
  return { engine: d?.engine || '', skill: d?.skill || '', model: d?.model || '', effort: d?.effort || '' };
}

// WHICH ENGINE a new session is born on. A visible segmented toggle, not a
// <select> among the others and not behind the "Advanced" fold: this is a
// first-class choice about what the session IS, made before anything else, so
// it has to be readable at a glance and switchable in one click. The three
// selects below it (skill/model/effort) stay in Advanced — they refine a
// session, they don't define it.
//
// Switching runs coerceSessionOptions(), which drops a model/effort the new
// engine doesn't offer instead of POSTing e.g. a Claude alias to a Codex
// session (lib/engines.js: Codex's model list is static and its effort ladder
// is per-model, with an `ultra` rung Claude has no equivalent for). Picking
// Codex before its driver is registered is meant to fail loudly at spawn
// (pickEngine throws) — there is deliberately no quiet fall-back to Claude.
//
// Exported for tests.
export function EngineToggle({ options, onChange, className = '' }) {
  const t = useT();
  const { models: claudeModels } = useModels();
  const current = options.engine || 'claude';
  const pick = (value) =>
    onChange(coerceSessionOptions({ ...options, engine: value === 'claude' ? '' : value }, claudeModels));
  return (
    <div className={`flex flex-wrap items-center gap-2 ${className}`}>
      <span className="font-mono text-[11px] md:text-[9.5px] tracking-[0.06em] text-fgdim uppercase">
        {t('launcher.options.engine')}
      </span>
      <span
        role="radiogroup"
        aria-label={t('launcher.options.engine')}
        className="inline-flex shrink-0 items-center overflow-hidden rounded-[7px] border-[1.5px] border-ink"
      >
        {engineOptions().map((o, i) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={current === o.value}
            title={o.desc}
            onClick={() => current !== o.value && pick(o.value)}
            className={`cursor-pointer px-3 py-[5px] text-[11.5px] leading-none ${i ? 'border-s border-ink' : ''} ${
              current === o.value ? 'bg-ink font-bold text-white' : 'bg-panel text-fgdim hover:text-fg'
            }`}
          >
            {o.label}
          </button>
        ))}
      </span>
    </div>
  );
}

// Which skill (from GET /skills — whatever's actually bundled, no fixed
// default), which model, which effort a new session starts with. The model and
// effort lists are read off the engine EngineToggle picked (and, on Codex, off
// the model too — the ladder moves with it), so these never offer a value the
// chosen engine would reject.
//
// Exported for tests.
export function SessionOptionsPicker({ options, onChange }) {
  const t = useT();
  const [skills, setSkills] = useState([]);
  useEffect(() => {
    api.get('/skills').then((r) => setSkills(r?.skills || [])).catch(() => {});
  }, []);
  const { models: claudeModels } = useModels();
  const engine = options.engine || 'claude';
  const modelOptions = modelOptionsFor(engine, claudeModels);
  const effortOptions = effortOptionsFor(engine, options.model);
  const set = (patch) => onChange({ ...options, ...patch });
  const setAndCoerce = (patch) => onChange(coerceSessionOptions({ ...options, ...patch }, claudeModels));
  return (
    <div className="flex flex-wrap items-center gap-1.5 pb-2">
      <select
        value={options.skill || ''}
        onChange={(e) => set({ skill: e.target.value })}
        className={selCls}
        title={skills.find((s) => s.name === options.skill)?.description || ''}
      >
        <option value="">{t('launcher.options.noSkill')}</option>
        {skills.map((s) => (
          <option key={s.name} value={s.name}>{s.name}</option>
        ))}
      </select>
      <select
        value={options.model || 'default'}
        onChange={(e) => setAndCoerce({ model: e.target.value === 'default' ? '' : e.target.value })}
        className={selCls}
        title={modelOptions.find((o) => o.value === (options.model || 'default'))?.desc || ''}
      >
        {modelOptions.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
      <select
        value={options.effort || 'default'}
        onChange={(e) => set({ effort: e.target.value === 'default' ? '' : e.target.value })}
        className={selCls}
        aria-label={t('rail.effort')}
      >
        {effortOptions.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </div>
  );
}

// Saved skill/model/effort presets — same interaction as PresetBar (chip,
// star = default, × = delete, + = save current).
function SessionPresetBar({ presets, defaultId, defaultByMode, mode, current, onApply }) {
  const t = useT();
  const tabDefaultId = defaultByMode[mode];
  const activeId = presets.find((p) => sessionOptionsEqual(p, current))?.id || null;
  const [naming, setNaming] = useState(false);
  const [draft, setDraft] = useState('');
  const commit = () => {
    const name = draft.trim();
    if (name) saveSessionPreset(name, current);
    setDraft('');
    setNaming(false);
  };
  return (
    <div className="flex flex-wrap items-center gap-1.5 pb-2.5">
      <span className="text-[11.5px] md:text-[10px] font-bold tracking-wide text-fgdim uppercase">{t('launcher.presets.title')}</span>
      {presets.map((p) => (
        <span
          key={p.id}
          className={`flex items-center gap-1 rounded-full border px-2 py-[2px] text-[11.5px] md:text-[10.5px] ${
            activeId === p.id ? 'border-ink bg-chip font-bold text-fg' : 'border-border bg-panel text-fgdim'
          }`}
        >
          <button
            type="button"
            onClick={() => setDefaultSessionPreset(p.id)}
            title={defaultId === p.id ? t('launcher.presets.unsetGlobalDefault') : t('launcher.presets.setGlobalDefault')}
            className={`cursor-pointer ${defaultId === p.id ? 'text-[#CE8324]' : 'text-fgdim hover:text-fg'}`}
          >
            <Icon icon={faStar} className={defaultId === p.id ? undefined : 'opacity-30'} />
          </button>
          <button
            type="button"
            onClick={() => setModeDefaultSessionPreset(mode, p.id)}
            title={tabDefaultId === p.id ? t('launcher.presets.unsetTabDefault') : t('launcher.presets.setTabDefault')}
            className={`cursor-pointer ${tabDefaultId === p.id ? 'text-[#CE8324]' : 'text-fgdim hover:text-fg'}`}
          >
            <Icon icon={faThumbtack} className={tabDefaultId === p.id ? undefined : 'opacity-30'} />
          </button>
          <button type="button" onClick={() => onApply(p)} className="cursor-pointer">
            {p.name}
          </button>
          <button
            type="button"
            onClick={() => deleteSessionPreset(p.id)}
            title={t('launcher.presets.delete')}
            className="cursor-pointer text-fgdim hover:text-danger"
          >
            <Icon icon={faXmark} />
          </button>
        </span>
      ))}
      {naming ? (
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            else if (e.key === 'Escape') { setDraft(''); setNaming(false); }
          }}
          placeholder={t('launcher.presets.namePlaceholder')}
          className="w-28 rounded-full border border-ink bg-panel px-2 py-[2px] text-[11.5px] md:text-[10.5px] outline-none placeholder:text-fgdim"
        />
      ) : (
        <button
          type="button"
          onClick={() => setNaming(true)}
          className="cursor-pointer rounded-full border border-border bg-panel px-2 py-[2px] text-[11.5px] md:text-[10.5px] font-bold text-fg hover:border-ink"
        >
          {t('launcher.presets.saveCurrent')}
        </button>
      )}
    </div>
  );
}

function TicketRow({ ticket, selected, onPick, openSession }) {
  const t = useT();
  // A ticket already in a host session: disabled (not selectable), tinted with
  // the session colour, and badged "in session".
  if (openSession) {
    const color = openSession.color || '#c4c4c4';
    return (
      <div
        title={t('launcher.ticket.openSessionTitle', { name: openSession.title || openSession.id })}
        className="mb-1 flex cursor-not-allowed items-center gap-[11px] rounded-[9px] border-2 border-transparent px-[11px] py-[9px] opacity-70"
        style={{ background: tint(color, '14'), borderLeft: `3px solid ${color}` }}
      >
        <Dot color={color} size={10} />
        <span className="shrink-0 font-mono text-[11.5px] font-bold text-fgdim">{ticket.id}</span>
        <span className="min-w-0 flex-1 truncate text-[12.5px] text-fgdim">{ticket.title}</span>
        <span
          className="shrink-0 rounded-[5px] px-[7px] py-px text-[11.5px] md:text-[10px] font-bold"
          style={{ background: tint(color, '2a'), color: '#2a2a2a' }}
        >
          {t('launcher.ticket.inSession')}
        </span>
      </div>
    );
  }
  return (
    <div
      onClick={() => onPick(ticket)}
      className={`mb-1 flex cursor-pointer items-center gap-[11px] rounded-[9px] px-[11px] py-[9px] ${
        selected
          ? 'border-2 border-ink bg-chip shadow-[2px_2px_0_rgba(42,42,42,0.16)]'
          : 'border-2 border-transparent hover:bg-chip'
      }`}
    >
      <PriorityGlyph priority={ticket.priority} />
      <span className="shrink-0 font-mono text-[11.5px] font-bold">{ticket.id}</span>
      <span className={`min-w-0 flex-1 truncate text-[12.5px] ${selected ? 'text-fg' : 'text-fgdim'}`}>
        {ticket.title}
      </span>
      {ticket.status && (
        <span className="shrink-0 rounded-[5px] border border-border px-[7px] py-px text-[11.5px] md:text-[10px] text-fgdim">
          {ticket.status}
        </span>
      )}
      {ticket.project && (
        <span className="shrink-0 font-mono text-[11.5px] md:text-[10px] text-fgdim">{ticket.project}</span>
      )}
    </div>
  );
}

// Live "Connect Linear" banner — kicks off the server-side OAuth flow, opens the
// consent page, and polls status until the host has tokens.
//
// M1: this is the TICKET LIST's own Linear grant (server/linear-mcp.ts), not the
// agent-facing one. Agents get Linear through the generic native-MCP card in
// Settings → Connections, which is a separate grant on purpose: two independent
// OAuth clients must not share one refresh token (rotation would revoke the
// other's). The note below says so, so nobody wonders why they connected Linear
// once and the other place still says "not connected".
function ConnectLinear({ onConnected }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const pollRef = useRef(null);

  useEffect(() => () => clearInterval(pollRef.current), []);

  const connect = async () => {
    setBusy(true);
    setErr('');
    try {
      const r = await api.post('/linear/connect');
      if (r.connected) {
        onConnected();
        setBusy(false);
        return;
      }
      if (r.authUrl) {
        window.open(r.authUrl, 'linear-auth', 'width=520,height=720');
        pollRef.current = setInterval(async () => {
          try {
            const s = await api.get('/linear/status');
            if (s.connected) {
              clearInterval(pollRef.current);
              setBusy(false);
              onConnected();
            }
          } catch {}
        }, 1500);
      } else {
        setErr(t('launcher.connect.startError'));
        setBusy(false);
      }
    } catch (e) {
      setErr(String(e.message || e));
      setBusy(false);
    }
  };

  return (
    <div className="mx-3 mb-3 rounded-[10px] border-[1.5px] border-ink bg-panel px-4 py-3.5 shadow-[2px_2px_0_rgba(42,42,42,0.12)]">
      <div className="mb-1 text-[12.5px] font-bold">{t('launcher.connect.heading')}</div>
      <div className="mb-3 text-[11px] leading-relaxed text-fgdim">
        {t('launcher.connect.body')}
      </div>
      <button
        type="button"
        onClick={connect}
        disabled={busy}
        className="cursor-pointer rounded-[8px] border-[1.5px] border-ink bg-brand px-3.5 py-1.5 text-[11.5px] font-bold text-fg disabled:opacity-60"
      >
        {busy ? t('launcher.connect.waiting') : t('launcher.connect.button')}
      </button>
      {err && <div className="mt-2 text-[11.5px] md:text-[10.5px] text-danger">{err}</div>}
      <div className="mt-2 text-[11.5px] md:text-[10.5px] leading-snug text-fgdim">
        {t('launcher.connect.agentsNote')}{' '}
        <a href="#/settings/connections/mcp" className="underline hover:text-fg">{t('launcher.connect.agentsLink')}</a>
      </div>
    </div>
  );
}

function TicketPicker({ selected, onPick, sessions }) {
  const t = useT();
  const prefs = usePrefs();
  // built-in preset first; user presets after. Effective default falls back to
  // the built-in when the user hasn't starred one — so it's active on open.
  const allPresets = useMemo(() => [BUILTIN_PRESET, ...prefs.ticketPresets], [prefs.ticketPresets]);
  const effectiveDefaultId = prefs.ticketDefaultPresetId || BUILTIN_PRESET.id;
  const [filters, setFilters] = useState(() => {
    const d = allPresets.find((p) => p.id === effectiveDefaultId) || BUILTIN_PRESET;
    return sanitizeFilters(d.filters);
  });
  const [tickets, setTickets] = useState(null); // null = loading
  const [error, setError] = useState(null);
  const [connected, setConnected] = useState(null); // null=unknown
  const [needsAuth, setNeedsAuth] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const labels = useLinearList('labels', !!connected);
  const statuses = useLinearList('statuses', !!connected);

  // tickets that already have a (non-archived) host session → id → session.
  const openByTicket = useMemo(() => {
    const m = {};
    for (const s of sessions || []) {
      if (s.archived) continue;
      // metadata.ticket is authoritative; fall back to an id parsed from the title
      const tid = (s.metadata?.ticket || extractTicketId(s.title) || '').toUpperCase();
      if (tid) m[tid] = s;
    }
    return m;
  }, [sessions]);

  useEffect(() => {
    api.get('/linear/status').then((s) => setConnected(!!s.connected)).catch(() => setConnected(false));
  }, [reloadKey]);

  // debounce so typing in search doesn't fire a request per keystroke
  const qs = useMemo(() => new URLSearchParams(filters).toString(), [filters]);
  useEffect(() => {
    let dead = false;
    const run = () => {
      setTickets(null);
      setError(null);
      api
        .get(`/linear/tickets?${qs}`)
        .then((res) => {
          if (dead) return;
          if (res?.needsAuth) { setNeedsAuth(true); setTickets([]); return; }
          setNeedsAuth(false);
          const list = Array.isArray(res) ? res : res?.tickets || res?.issues || [];
          const rows = list.map(normalizeTicket).filter(Boolean);
          const key = filters.orderBy; // recent-first
          rows.sort((a, b) => String(b[key] || '').localeCompare(String(a[key] || '')));
          setTickets(rows);
        })
        .catch((e) => {
          if (!dead) { setError(String(e.message || e)); setTickets([]); }
        });
    };
    const t = setTimeout(run, filters.query ? 300 : 0);
    return () => { dead = true; clearTimeout(t); };
  }, [qs, reloadKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const showConnect = connected === false || needsAuth;
  const visible = (tickets || []).filter(
    (t) => !(filters.hideOpen && openByTicket[t.id.toUpperCase()])
  );

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col border-b border-hair md:border-r md:border-b-0">
      <div className="flex items-center gap-2 px-[18px] pt-4 pb-2">
        <span className="flex-1"><PasteField onPick={onPick} autoFocus /></span>
        {connected && (
          <span className="flex shrink-0 items-center gap-1 text-[11.5px] md:text-[10px] text-fgdim" title={t('launcher.picker.liveTitle')}>
            <span className="h-1.5 w-1.5 rounded-full bg-[#3C9A4E]" /> {t('launcher.picker.live')}
          </span>
        )}
      </div>
      {showConnect && <ConnectLinear onConnected={() => setReloadKey((k) => k + 1)} />}
      <FilterBar filters={filters} onChange={setFilters} labels={labels} statuses={statuses} disabled={showConnect} />
      <PresetBar
        presets={allPresets}
        defaultId={effectiveDefaultId}
        current={filters}
        onApply={(f) => setFilters(sanitizeFilters(f))}
      />
      <div className="thin-scroll min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        {tickets === null && (
          <div className="flex items-center gap-2 px-3 py-5 text-xs text-fgdim">
            <span className="host-spinner h-3.5 w-3.5" /> {t('launcher.picker.loading')}
          </div>
        )}
        {tickets !== null && error && (
          <div className="flex flex-col items-start gap-2 px-3 py-5 text-xs text-fgdim">
            <span>{t('launcher.picker.loadError')}</span>
            <button
              type="button"
              onClick={() => setReloadKey((k) => k + 1)}
              className="rounded border border-border px-2 py-1 text-[11px] hover:border-ink hover:text-fg"
            >
              {t('launcher.picker.retry')}
            </button>
          </div>
        )}
        {tickets !== null && !error && !needsAuth && visible.length === 0 && (
          <div className="px-3 py-5 text-xs text-fgdim">{t('launcher.picker.empty')}</div>
        )}
        {visible.map((t) => (
          <TicketRow
            key={t.id}
            ticket={t}
            selected={selected?.id === t.id}
            onPick={onPick}
            openSession={openByTicket[t.id.toUpperCase()]}
          />
        ))}
      </div>
    </div>
  );
}

// Normalize a ticket-details payload from either the Linear MCP (get_issue) or
// the cache/API-key path (pages.getTicket) into one shape the modal renders.
function normalizeDetails(d) {
  if (!d || typeof d !== 'object') return null;
  const name = (x) => (x && typeof x === 'object' ? x.name || x.displayName || '' : x || '');
  const labels = (Array.isArray(d.labels) ? d.labels : d.labels?.nodes || []).map((l) =>
    typeof l === 'string' ? { name: l } : { name: l?.name, color: l?.color }
  ).filter((l) => l.name);
  const comments = (Array.isArray(d.comments) ? d.comments : d.comments?.nodes || []).map((c) => ({
    body: c.body || c.text || '',
    author: name(c.author || c.user) || '',
    createdAt: c.createdAt || c.created_at || '',
  })).filter((c) => c.body);
  const links = (Array.isArray(d.attachments) ? d.attachments : d.attachments?.nodes || []).map((a) => ({
    title: a.title || a.subtitle || a.url,
    url: a.url,
  })).filter((a) => a.url);
  return {
    id: d.identifier || d.id || d.key || '',
    title: d.title || d.name || '',
    description: d.description || d.body || '',
    status: name(d.state) || d.status || '',
    statusColor: d.state?.color || d.statusColor || '#9aa3ad',
    priority:
      d.priorityLabel ||
      (d.priority && typeof d.priority === 'object' ? d.priority.name : d.priority) ||
      '',
    assignee: name(d.assignee) || '',
    creator: name(d.creator) || d.createdBy || '',
    project: name(d.project) || '',
    team: name(d.team) || '',
    url: d.url || '',
    createdAt: d.createdAt || '',
    updatedAt: d.updatedAt || '',
    labels,
    comments,
    links,
  };
}

function MetaRow({ label, children }) {
  if (!children) return null;
  return (
    <>
      <span className="text-fgdim">{label}</span>
      <span className="min-w-0 text-fg">{children}</span>
    </>
  );
}

// Full ticket details (description + comments + links) before you commit to it.
function TicketDetailsModal({ id, onClose }) {
  const t = useT();
  const [data, setData] = useState(undefined); // undefined=loading, null=error
  useEffect(() => {
    let dead = false;
    setData(undefined);
    api
      .get(`/linear/ticket/${id}`)
      .then((d) => !dead && setData(normalizeDetails(d)))
      .catch(() => !dead && setData(null));
    return () => { dead = true; };
  }, [id]);

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6" onMouseDown={onClose}>
      <div
        className="flex max-h-[85vh] w-[720px] max-w-full flex-col overflow-hidden rounded-[12px] border-[1.5px] border-ink bg-panel shadow-[4px_4px_0_rgba(0,0,0,0.25)]"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center gap-2.5 border-b border-hair px-4 py-3">
          <span className="font-mono text-[12.5px] font-bold text-fg">{id}</span>
          {data?.status && (
            <span
              className="rounded-[5px] border px-[7px] py-px text-[11.5px] md:text-[10px]"
              style={{ borderColor: data.statusColor, color: data.statusColor }}
            >
              {data.status}
            </span>
          )}
          {data?.url && (
            <a href={data.url} target="_blank" rel="noopener" className="text-[11px] text-fgdim underline hover:text-fg">
              {t('launcher.details.openInLinear')}
            </a>
          )}
          <button
            type="button"
            onClick={onClose}
            className="ml-auto flex h-7 w-7 cursor-pointer items-center justify-center rounded-md border border-hair text-fgdim hover:border-ink hover:text-fg"
          >
            <Icon icon={faXmark} />
          </button>
        </div>

        <div className="thin-scroll min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {data === undefined && (
            <div className="flex items-center gap-2 py-6 text-xs text-fgdim">
              <span className="host-spinner h-3.5 w-3.5" /> {t('launcher.details.loading')}
            </div>
          )}
          {data === null && (
            <div className="py-6 text-xs text-danger">{t('launcher.details.error')}</div>
          )}
          {data && (
            <>
              <h2 className="mb-3 text-[16px] leading-snug font-bold text-fg">{data.title}</h2>
              <div className="mb-4 grid grid-cols-[88px_1fr] gap-x-3 gap-y-1.5 text-[11.5px]">
                <MetaRow label={t('launcher.meta.assignee')}>{data.assignee}</MetaRow>
                <MetaRow label={t('launcher.meta.priority')}>{data.priority}</MetaRow>
                <MetaRow label={t('launcher.meta.project')}>{data.project}</MetaRow>
                <MetaRow label={t('launcher.meta.team')}>{data.team}</MetaRow>
                <MetaRow label={t('launcher.meta.creator')}>{data.creator}</MetaRow>
                {data.labels.length > 0 && (
                  <MetaRow label={t('launcher.meta.labels')}>
                    <span className="flex flex-wrap gap-1">
                      {data.labels.map((l) => (
                        <span
                          key={l.name}
                          className="rounded-[5px] border px-1.5 py-px text-[11.5px] md:text-[10px]"
                          style={{ borderColor: l.color || '#cbd0d8', color: l.color || '#6b7280' }}
                        >
                          {l.name}
                        </span>
                      ))}
                    </span>
                  </MetaRow>
                )}
              </div>

              {data.description ? (
                <div className="md-light border-t border-hair pt-4">
                  <Markdown>{data.description}</Markdown>
                </div>
              ) : (
                <div className="border-t border-hair pt-4 text-xs text-fgdim">{t('launcher.details.noDescription')}</div>
              )}

              {data.links.length > 0 && (
                <div className="mt-4 border-t border-hair pt-3">
                  <div className="mb-1.5 text-[11px] md:text-[9.5px] font-bold tracking-wide text-fgdim uppercase">{t('launcher.details.links')}</div>
                  <div className="flex flex-col gap-1">
                    {data.links.map((a) => (
                      <a key={a.url} href={a.url} target="_blank" rel="noopener" className="truncate text-[11.5px] text-[#2C6BD6] hover:underline">
                        {a.title}
                      </a>
                    ))}
                  </div>
                </div>
              )}

              {data.comments.length > 0 && (
                <div className="mt-4 border-t border-hair pt-3">
                  <div className="mb-2 text-[11px] md:text-[9.5px] font-bold tracking-wide text-fgdim uppercase">
                    {t('launcher.details.comments', { n: data.comments.length })}
                  </div>
                  <div className="flex flex-col gap-3">
                    {data.comments.map((c, i) => (
                      <div key={i} className="rounded-md border border-hair bg-bg px-3 py-2">
                        <div className="mb-1 text-[11.5px] md:text-[10.5px] font-bold text-fg">{c.author || t('launcher.details.someone')}</div>
                        <div className="md-light text-[12px]"><Markdown>{c.body}</Markdown></div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function ProvisionRow({ label, children }) {
  return (
    <div className="flex items-center gap-[9px] text-[11.5px]">
      <span className="h-3.5 w-3.5 shrink-0 rounded-[3px] bg-border" />
      <span className="text-fgdim">{label}</span>
      <span className="ml-auto min-w-0 truncate text-right font-mono text-[11.5px] md:text-[10.5px] text-fg">
        {children}
      </span>
    </div>
  );
}

function PlanPanel({ ticket, config, sessions, onCreate, onEmptyInstead, onLater, busy, error, mode, onMode, onViewDetails, prompt, onPrompt, options, onOptions }) {
  const t = useT();
  const prefs = usePrefs();
  const color = nextPaletteColor(sessions, config);
  return (
    <div className="flex w-full shrink-0 flex-col bg-panel p-[16px_18px] md:w-[332px]">
      <div className="mb-2 font-mono text-[11.5px] md:text-[10px] tracking-[0.08em] text-fgdim uppercase">
        {t('launcher.plan.selectedTicket')}
      </div>
      {!ticket ? (
        <div className="flex-1 pt-2 text-xs leading-relaxed text-fgdim">
          {t('launcher.plan.pickHint')}
        </div>
      ) : (
        <>
          <div className="mb-[5px] flex items-center gap-2">
            <span className="font-mono text-[12.5px] font-bold">{ticket.id}</span>
            {ticket.status && (
              <span className="rounded-[5px] border border-border px-[7px] py-px text-[11.5px] md:text-[10px] text-fgdim">
                {ticket.status}
              </span>
            )}
          </div>
          <div className="mb-2 text-sm leading-snug text-fg">
            {ticket.title || t('launcher.plan.pastedTitle')}
          </div>
          <button
            type="button"
            onClick={() => onViewDetails(ticket.id)}
            className="mb-3 cursor-pointer self-start rounded-[7px] border border-border bg-bg px-2.5 py-1 text-[11px] font-bold text-fg hover:border-ink"
          >
            {t('launcher.plan.viewDetails')}
          </button>
          <div className="mb-3.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-[11.5px]">
            <span className="text-fgdim">{t('launcher.meta.assignee')}</span>
            <span className="text-fgdim">{ticket.assignee || t('launcher.plan.you')}</span>
            {ticket.priority != null && (
              <>
                <span className="text-fgdim">{t('launcher.meta.priority')}</span>
                <span className="text-fgdim">
                  {{ 1: t('launcher.priority.urgent'), 2: t('launcher.priority.high'), 3: t('launcher.priority.medium'), 4: t('launcher.priority.low') }[ticket.priority] ||
                    String(ticket.priority)}
                </span>
              </>
            )}
            {ticket.project && (
              <>
                <span className="text-fgdim">{t('launcher.meta.project')}</span>
                <span className="text-fgdim">{ticket.project}</span>
              </>
            )}
            {ticket.labels?.length > 0 && (
              <>
                <span className="text-fgdim">{t('launcher.meta.labels')}</span>
                <span className="text-fgdim">{ticket.labels.join(', ')}</span>
              </>
            )}
          </div>
          <div className="border-t border-dashed border-border pt-3">
            <div className="mb-2.5 text-[13px] font-bold">{t('launcher.plan.provision')}</div>
            <div className="flex flex-col gap-2">
              <ProvisionRow label="Worktree">app-worktrees/{ticket.id.toLowerCase()}</ProvisionRow>
              <ProvisionRow label="Branch">
                feat/{slug(ticket.title) || ticket.id.toLowerCase()}
              </ProvisionRow>
              <ProvisionRow label="Dev server">
                :{config?.devServerPorts?.[0] ?? 'auto'}
              </ProvisionRow>
              <div className="flex items-center gap-[9px] text-[11.5px]">
                <span className="h-3.5 w-3.5 shrink-0 rounded-[3px] bg-border" />
                <span className="text-fgdim">{t('launcher.plan.sessionColour')}</span>
                <span className="ml-auto flex items-center gap-[5px]">
                  <Dot color={color} />
                  <span className="font-mono text-[11.5px] md:text-[10px] text-fgdim">auto</span>
                </span>
              </div>
            </div>
          </div>
        </>
      )}
      {error && <div className="mt-3 text-[11px] text-danger">{error}</div>}
      <div className="mt-auto flex flex-col gap-2 pt-3.5">
        {ticket && (
          <>
            <EngineToggle options={options} onChange={onOptions} className="pb-2" />
            <SessionOptionsPicker options={options} onChange={onOptions} />
            <SessionPresetBar
              presets={prefs.sessionPresets}
              defaultId={prefs.sessionDefaultPresetId}
              defaultByMode={prefs.sessionDefaultPresetByMode}
              mode="ticket"
              current={options}
              onApply={onOptions}
            />
            <div className="flex flex-col gap-1">
              <span className="font-mono text-[11px] md:text-[9.5px] tracking-[0.06em] text-fgdim uppercase">
                {t('launcher.plan.extraInstructions')}
              </span>
              <textarea
                value={prompt}
                onChange={(e) => onPrompt(e.target.value)}
                rows={4}
                spellCheck={false}
                placeholder={t('launcher.plan.extraInstructionsPlaceholder')}
                className="w-full resize-y rounded-[7px] border border-border bg-panel px-2 py-1.5 font-mono text-[11.5px] md:text-[10.5px] leading-snug outline-none focus:border-ink"
              />
            </div>
          </>
        )}
        <div className="flex items-center gap-2">
          <span className="font-mono text-[11px] md:text-[9.5px] tracking-[0.06em] text-fgdim uppercase">
            {t('launcher.plan.permissions')}
          </span>
          <select
            value={mode}
            onChange={(e) => onMode(e.target.value)}
            className="min-w-0 flex-1 cursor-pointer rounded-[7px] border border-border bg-panel px-2 py-1 font-mono text-[11.5px] md:text-[10.5px] outline-none focus:border-ink"
          >
            <option value="default">{t('launcher.plan.permDefault')}</option>
            <option value="acceptEdits">acceptEdits</option>
            <option value="plan">plan</option>
            <option value="bypassPermissions">bypassPermissions</option>
          </select>
        </div>
        <YellowButton
          className="w-full rounded-[9px] py-2.5"
          disabled={!ticket || busy}
          onClick={onCreate}
        >
          {busy ? t('launcher.plan.creating') : t('launcher.plan.createSession')}
        </YellowButton>
        <button
          type="button"
          onClick={onLater}
          disabled={!ticket || busy}
          className="cursor-pointer rounded-[9px] border border-border py-2 text-xs font-bold text-fg hover:border-ink disabled:opacity-40"
        >
          {t('launcher.plan.doItLater')}
        </button>
        <button
          type="button"
          onClick={onEmptyInstead}
          className="cursor-pointer p-1 text-xs text-fgdim hover:text-fg"
        >
          {t('launcher.plan.emptyInstead')}
        </button>
      </div>
    </div>
  );
}

function EmptyForm({ config, sessions, onCreated }) {
  const t = useT();
  const prefs = usePrefs();
  const [name, setName] = useState('');
  const [cwd, setCwd] = useState(config?.defaultCwd || '');
  const [mode, setMode] = useState('bypassPermissions');
  const [prompt, setPrompt] = useState('');
  const [options, setOptions] = useState(() => defaultSessionOptions(prefs, 'empty'));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  // F8: the defaults are fine for a first session — name, cwd, permission
  // mode and skill/model/effort fold away behind "Advanced".
  const [advanced, setAdvanced] = useState(false);

  useEffect(() => {
    if (!cwd && config?.defaultCwd) setCwd(config.defaultCwd);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config?.defaultCwd]);

  const scratchN = useMemo(() => {
    const n = (sessions || []).filter((s) => /^scratch-\d+$/.test(s.title || '')).length;
    return `scratch-${n + 1}`;
  }, [sessions]);

  const create = async () => {
    if (busy) return; // guard: Enter can fire while a POST is already in flight
    setBusy(true);
    setError(null);
    try {
      const session = await api.post('/sessions', {
        ...(name.trim() ? { title: name.trim() } : {}),
        ...(cwd.trim() ? { cwd: cwd.trim() } : {}),
        permissionMode: mode,
        ...(prompt.trim() ? { prompt } : {}),
        engine: options.engine || undefined,
        skill: options.skill || undefined,
        model: options.model || undefined,
        effort: options.effort || undefined,
      });
      onCreated(session);
    } catch (e) {
      setError(String(e.message || e));
      setBusy(false);
    }
  };

  // Defer an empty session into the Pending queue instead of starting it now.
  // A starting prompt or a chosen skill is required — a queued blank session
  // with neither would have nothing to do when it's later started (incl. by
  // autoplay).
  const later = async () => {
    if (busy) return; // guard against double-submit
    if (!prompt.trim() && !options.skill) {
      setError(t('launcher.empty.deferRequired'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.post('/pending', {
        kind: 'empty',
        title: name.trim() || scratchN,
        ...(cwd.trim() ? { cwd: cwd.trim() } : {}),
        permissionMode: mode,
        ...(prompt.trim() ? { prompt } : {}),
        engine: options.engine || undefined,
        skill: options.skill || undefined,
        model: options.model || undefined,
        effort: options.effort || undefined,
      });
      setName('');
    } catch (e) {
      setError(String(e.message || e));
    }
    setBusy(false);
  };

  return (
    <div className="flex min-w-0 flex-1 justify-center overflow-y-auto">
      <div className="w-full max-w-[440px] px-6 py-7">
        <div className="mb-1.5 text-[13px] font-bold text-fg">{t('launcher.empty.promptFirst')}</div>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); create(); } }}
          rows={3}
          autoFocus
          dir="auto"
          placeholder={t('launcher.firstRun.placeholder')}
          className="mb-3 w-full resize-y rounded-[9px] border-[1.5px] border-ink px-3 py-[9px] text-[12.5px] leading-snug outline-none placeholder:text-fgdim focus:shadow-[2px_2px_0_rgba(42,42,42,0.16)]"
        />
        <EngineToggle options={options} onChange={setOptions} className="mb-3" />
        <button type="button" onClick={() => setAdvanced((v) => !v)} aria-expanded={advanced} className="mb-3 cursor-pointer text-[11.5px] font-semibold text-fgdim hover:text-fg">
          {advanced ? '▾' : '▸'} {t('launcher.empty.advanced')} <span className="font-normal">· {t('launcher.empty.advancedHint')}</span>
        </button>
        <div className={advanced ? '' : 'hidden'}>
        <div className="mb-1.5 font-mono text-[11px] md:text-[9.5px] tracking-[0.06em] text-fgdim uppercase">
          {t('launcher.empty.sessionName')}
        </div>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && create()}
          placeholder={t('launcher.empty.namePlaceholder')}
          className="mb-2 w-full rounded-[9px] border-[1.5px] border-ink px-3 py-[9px] text-[12.5px] outline-none placeholder:text-fgdim focus:shadow-[2px_2px_0_rgba(42,42,42,0.16)]"
        />
        <div className="mb-4 flex flex-wrap items-center gap-1.5 text-[11px] leading-relaxed text-fgdim">
          <span>{t('launcher.empty.leaveBlank')}</span>
          <span className="rounded-[5px] border border-border bg-panel px-1.5 py-px font-mono text-[11.5px] md:text-[10.5px] text-fgdim">
            {scratchN}
          </span>
          <span>{t('launcher.empty.renamedBy')}</span>
          <span className="rounded-[5px] border border-[#ecd9a0] bg-chip px-1.5 py-px font-mono text-[11.5px] md:text-[10px] text-fg">
            host.set_title()
          </span>
        </div>

        <div className="mb-1.5 font-mono text-[11px] md:text-[9.5px] tracking-[0.06em] text-fgdim uppercase">
          {t('launcher.empty.workingDir')}
        </div>
        <input
          value={cwd}
          dir="ltr"
          onChange={(e) => setCwd(e.target.value)}
          placeholder={config?.defaultCwd || '~/Desktop/repos'}
          className="mb-4 w-full text-start rounded-[9px] border-[1.5px] border-border px-3 py-[9px] font-mono text-[11.5px] outline-none placeholder:text-fgdim focus:border-ink"
        />

        <div className="mb-1.5 font-mono text-[11px] md:text-[9.5px] tracking-[0.06em] text-fgdim uppercase">
          {t('launcher.empty.permMode')}
        </div>
        <select
          value={mode}
          onChange={(e) => setMode(e.target.value)}
          className="mb-5 w-full cursor-pointer rounded-[9px] border-[1.5px] border-border bg-panel px-3 py-[9px] font-mono text-[11.5px] outline-none focus:border-ink"
        >
          <option value="default">default</option>
          <option value="acceptEdits">acceptEdits</option>
          <option value="plan">plan</option>
          <option value="bypassPermissions">bypassPermissions</option>
        </select>

        <div className="mb-1.5 font-mono text-[11px] md:text-[9.5px] tracking-[0.06em] text-fgdim uppercase">
          {t('launcher.options.title')}
        </div>
        <SessionOptionsPicker options={options} onChange={setOptions} />
        <SessionPresetBar
          presets={prefs.sessionPresets}
          defaultId={prefs.sessionDefaultPresetId}
          defaultByMode={prefs.sessionDefaultPresetByMode}
          mode="empty"
          current={options}
          onApply={setOptions}
        />

        </div>

        {error && <div className="mb-3 text-[11px] text-danger">{error}</div>}
        <YellowButton className="w-full rounded-[9px] py-2.5" disabled={busy} onClick={create}>
          {busy ? t('launcher.plan.creating') : t('launcher.empty.createEmpty')}
        </YellowButton>
        <button
          type="button"
          onClick={later}
          disabled={busy || (!prompt.trim() && !options.skill)}
          title={prompt.trim() || options.skill ? t('launcher.empty.addToPending') : t('launcher.empty.deferTitle')}
          className="mt-2 w-full cursor-pointer rounded-[9px] border border-border py-2 text-xs font-bold text-fg hover:border-ink disabled:cursor-default disabled:opacity-40"
        >
          {t('launcher.plan.doItLater')}
        </button>
      </div>
    </div>
  );
}

/* ---------- triggers tab ----------------------------------------------------- */

function filterSummary(f) {
  const s = sanitizeFilters(f);
  const parts = [s.assignee === 'any' ? t('launcher.filter.anyone') : t('launcher.filter.me')];
  if (s.state) {
    const k = STATE_OPTS.find(([v]) => v === s.state)?.[1];
    parts.push(k ? t(k) : s.state);
  }
  if (s.priority) {
    const k = PRIORITY_OPTS.find(([v]) => v === s.priority)?.[1];
    parts.push(k ? t(k) : s.priority);
  }
  if (s.labels.length) parts.push(s.labels.join(s.labelOp === 'and' ? ' & ' : ' / '));
  if (s.query) parts.push(`“${s.query}”`);
  return parts.join(' · ');
}

const TLOG_COLOR = { fire: '#7ee787', warn: '#e3b341', error: '#ff7b72', info: '#9aa0a6' };
const fmtClock = (ts) =>
  new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const fmtAgo = (ts) => {
  if (!ts) return '—';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return t('launcher.time.secondsAgo', { n: s });
  if (s < 3600) return t('launcher.time.minutesAgo', { n: Math.floor(s / 60) });
  return t('launcher.time.hoursAgo', { n: Math.floor(s / 3600) });
};

// Service modal for a trigger — polls GET /__api/triggers/:id every 1.5s for the
// live detail + activity log (mirrors the listener details modal).
function TriggerLogModal({ triggerId, onClose }) {
  const t = useT();
  const [detail, setDetail] = useState(null);
  const logRef = useRef(null);
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try {
        const d = await api.get(`/triggers/${triggerId}`);
        if (!stop) setDetail(d);
      } catch {
        /* trigger may have been deleted */
      }
    };
    tick();
    const iv = setInterval(tick, 1500);
    return () => {
      stop = true;
      clearInterval(iv);
    };
  }, [triggerId]);
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [detail?.log?.length]);
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const log = detail?.log || [];
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6" onMouseDown={onClose}>
      <div
        className="flex h-[72vh] w-[760px] max-w-full flex-col overflow-hidden rounded-[12px] border-[1.5px] border-ink bg-panel shadow-[4px_4px_0_rgba(0,0,0,0.25)]"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2.5 border-b border-hair px-4 py-3">
          <span className="text-[13px] leading-none"><Icon icon={faBolt} /></span>
          <span className="font-mono text-[13px] font-bold text-fg">{detail?.name || t('launcher.trigger.defaultName')}</span>
          <span className="font-mono text-[11.5px] md:text-[10.5px] text-fgdim">
            {detail?.enabled ? t('launcher.trigger.polling') : t('launcher.trigger.disabled')}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto flex h-7 w-7 cursor-pointer items-center justify-center rounded-md border border-hair text-fgdim hover:border-ink hover:text-fg"
          >
            <Icon icon={faXmark} />
          </button>
        </div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 border-b border-hair px-4 py-2.5 font-mono text-[11.5px] md:text-[10px] text-fgdim">
          <span>{t('launcher.trigger.metaFilter')} <span className="text-fg">{detail ? filterSummary(detail.filters) : '—'}</span></span>
          <span>{t('launcher.trigger.metaPoll')} <span className="text-fg">{t('launcher.trigger.every60s')}</span></span>
          <span>{t('launcher.trigger.metaLastPoll')} <span className="text-fg">{fmtAgo(detail?.lastPolledAt)}</span></span>
          <span>{t('launcher.trigger.metaSpawned')} <span className="text-fg">{detail?.createdSessions?.length || 0}</span></span>
          <span>{t('launcher.trigger.metaSeen')} <span className="text-fg">{t('launcher.trigger.ticketsSeen', { n: detail?.seen?.length || 0 })}</span></span>
          <span>{t('launcher.trigger.metaPrimed')} <span className="text-fg">{detail?.primed ? t('launcher.common.yes') : t('launcher.common.no')}</span></span>
          {detail?.lastError && (
            <span className="col-span-2 text-danger">{t('launcher.trigger.metaLastError')} {detail.lastError}</span>
          )}
        </div>
        <div className="border-b border-hair px-4 py-1.5 font-mono text-[11px] md:text-[9.5px] tracking-wide text-fgdim uppercase">
          {t('launcher.trigger.activity')}
        </div>
        <pre
          ref={logRef}
          dir="ltr"
          className="thin-scroll min-h-0 flex-1 overflow-auto bg-term px-3.5 py-3 font-mono text-[11px] leading-relaxed break-words whitespace-pre-wrap"
        >
          {detail == null ? (
            <span className="text-[#888]">{t('launcher.trigger.loadingLog')}</span>
          ) : log.length === 0 ? (
            <span className="text-[#888]">{t('launcher.trigger.noActivity')}</span>
          ) : (
            log.map((e, i) => (
              <div key={i}>
                <span className="text-[#6a6a6a]">{fmtClock(e.ts)} </span>
                <span style={{ color: TLOG_COLOR[e.level] || '#cfcfcf' }}>{e.text}</span>
              </div>
            ))
          )}
        </pre>
      </div>
    </div>
  );
}

// Shown when enabling autonomous mode on a trigger — spells out the blast radius.
function AutonomyWarningModal({ onConfirm, onCancel }) {
  const t = useT();
  const [dontShow, setDontShow] = useState(false);
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-6"
      onMouseDown={onCancel}
    >
      <div
        className="w-[460px] max-w-full rounded-[12px] border-[1.5px] border-ink bg-panel p-5 shadow-[4px_4px_0_rgba(0,0,0,0.25)]"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="mb-2 flex items-center gap-2">
          <span className="text-[18px]"><Icon icon={faTriangleExclamation} /></span>
          <span className="text-[14px] font-bold">{t('launcher.autonomy.title')}</span>
        </div>
        <div className="mb-4 text-[12px] leading-relaxed text-fgdim">
          {t('launcher.autonomy.intro')} <b>{t('launcher.autonomy.autonomousMode')}</b>:
          <ul className="mt-2 list-disc space-y-1 pl-4">
            <li>
              {t('launcher.autonomy.li1a')} <b>{t('launcher.autonomy.autoApproved')}</b>{t('launcher.autonomy.li1b')}
            </li>
            <li>
              {t('launcher.autonomy.li2a')} <b>{t('launcher.autonomy.wontStop')}</b>{t('launcher.autonomy.li2b')}
            </li>
            <li>{t('launcher.autonomy.li3')}</li>
          </ul>
          <div className="mt-2">
            {t('launcher.autonomy.warn')}
          </div>
        </div>
        <label className="mb-4 flex cursor-pointer items-center gap-2 text-[11.5px] text-fgdim">
          <input
            type="checkbox"
            checked={dontShow}
            onChange={(e) => setDontShow(e.target.checked)}
            className="cursor-pointer"
          />
          {t('launcher.autonomy.dontShow')}
        </label>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="cursor-pointer rounded-[8px] border border-border px-3 py-1.5 text-[12px] text-fg hover:border-ink"
          >
            {t('launcher.common.cancel')}
          </button>
          <button
            type="button"
            onClick={() => onConfirm(dontShow)}
            className="cursor-pointer rounded-[8px] border-[1.5px] border-danger bg-danger px-3 py-1.5 text-[12px] font-bold text-white"
          >
            {t('launcher.autonomy.enable')}
          </button>
        </div>
      </div>
    </div>
  );
}

const CRON_RUN_COLOR = { started: '#9aa0a6', done: '#7ee787', blocked: '#e3b341', error: '#ff7b72', milestone: '#9aa0a6', held: '#e3b341' };

function scheduleSummary(schedule, t) {
  if (!schedule) return '—';
  if (schedule.kind === 'cron') return `${t('launcher.cron.kindCron')} "${schedule.value}"`;
  if (schedule.kind === 'interval') return `${t('launcher.cron.kindInterval')} ${schedule.value}`;
  if (schedule.kind === 'at') return `${t('launcher.cron.kindAt')} ${fmtDateTime(schedule.value)}`;
  return schedule.value;
}

// Minimal M2 UI: standing cron jobs (durable, agent-callable — see docs/TRIGGERS.md
// "Cron"), sharing the trigger registry + the same activity-log modal (TriggerLogModal)
// used for Linear-filter triggers' history.
// Exported so BrainView.jsx (M4) can embed the same cron list+form under the
// Brain tab — spec says "link/wrap the existing Cron tab, don't duplicate"
// (SPEC-ARIGAMI-BRAIN.md M4.1).
export function CronSubPanel() {
  const t = useT();
  const { triggers } = useStore();
  const cronJobs = triggers.filter((x) => x.type === 'cron');
  const [logId, setLogId] = useState(null);
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [scheduleKind, setScheduleKind] = useState('cron');
  const [scheduleValue, setScheduleValue] = useState('0 9 * * *');
  const [sessionMode, setSessionMode] = useState('isolated');
  const [targetSessionId, setTargetSessionId] = useState('');
  const [deliverPush, setDeliverPush] = useState(true);
  const [deliverMaster, setDeliverMaster] = useState('');
  const [deliverWhatsapp, setDeliverWhatsapp] = useState('');
  const [autonomous, setAutonomous] = useState(false);
  const [warnOpen, setWarnOpen] = useState(false);
  const prefs = usePrefs();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const onToggleAutonomous = (checked) => {
    if (!checked) return setAutonomous(false);
    if (prefs.autonomyWarningDismissed) return setAutonomous(true);
    setWarnOpen(true);
  };

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.post('/triggers', {
        type: 'cron',
        name: name.trim() || undefined,
        prompt,
        schedule: { kind: scheduleKind, value: scheduleValue.trim() },
        sessionMode: sessionMode === 'existing' ? `existing:${targetSessionId.trim()}` : 'isolated',
        deliver: { push: deliverPush, master: deliverMaster.trim() || undefined, whatsapp: deliverWhatsapp.trim() || undefined },
        autonomous,
      });
      setName('');
      setPrompt('');
      setTargetSessionId('');
      setDeliverMaster('');
      setDeliverWhatsapp('');
      setAutonomous(false);
    } catch (e) {
      setError(String(e.message || e));
    }
    setBusy(false);
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="border-b border-hair px-[18px] pt-4 pb-3">
        <div className="mb-2 font-mono text-[11.5px] md:text-[10px] tracking-[0.08em] text-fgdim uppercase">
          {t('launcher.cron.newJob')}
        </div>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('launcher.cron.namePlaceholder')}
          className="mb-2 w-full rounded-[9px] border-[1.5px] border-ink px-3 py-[9px] text-[12.5px] outline-none placeholder:text-fgdim focus:shadow-[2px_2px_0_rgba(42,42,42,0.16)]"
        />
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder={t('launcher.cron.promptPlaceholder')}
          rows={2}
          className="mb-2 w-full resize-y rounded-[9px] border border-border bg-panel px-3 py-2 text-[11.5px] outline-none placeholder:text-fgdim focus:border-ink"
        />
        <div className="mb-2 flex items-center gap-2">
          <select
            value={scheduleKind}
            onChange={(e) => setScheduleKind(e.target.value)}
            className="rounded-[8px] border border-border bg-panel px-2 py-1.5 text-[11.5px] outline-none focus:border-ink"
          >
            <option value="cron">{t('launcher.cron.kindCron')}</option>
            <option value="interval">{t('launcher.cron.kindInterval')}</option>
            <option value="at">{t('launcher.cron.kindAt')}</option>
          </select>
          <input
            value={scheduleValue}
            onChange={(e) => setScheduleValue(e.target.value)}
            placeholder={
              scheduleKind === 'cron' ? '0 9 * * 1-5' : scheduleKind === 'interval' ? '30m' : '2026-09-01T09:00:00'
            }
            className="min-w-0 flex-1 rounded-[8px] border border-border bg-panel px-2.5 py-1.5 font-mono text-[11.5px] outline-none placeholder:text-fgdim focus:border-ink"
          />
        </div>
        <div className="mb-2 flex items-center gap-2">
          <select
            value={sessionMode}
            onChange={(e) => setSessionMode(e.target.value)}
            className="rounded-[8px] border border-border bg-panel px-2 py-1.5 text-[11.5px] outline-none focus:border-ink"
          >
            <option value="isolated">{t('launcher.cron.modeIsolated')}</option>
            <option value="existing">{t('launcher.cron.modeExisting')}</option>
          </select>
          {sessionMode === 'existing' && (
            <input
              value={targetSessionId}
              onChange={(e) => setTargetSessionId(e.target.value)}
              placeholder={t('launcher.cron.targetSessionPlaceholder')}
              className="min-w-0 flex-1 rounded-[8px] border border-border bg-panel px-2.5 py-1.5 font-mono text-[11px] outline-none placeholder:text-fgdim focus:border-ink"
            />
          )}
        </div>
        <div className="mb-2 flex flex-col gap-1.5 rounded-[9px] border border-border p-2">
          <span className="font-mono text-[11px] md:text-[9.5px] tracking-[0.08em] text-fgdim uppercase">{t('launcher.cron.deliver')}</span>
          <label className="flex cursor-pointer items-center gap-2 text-[11.5px]">
            <input type="checkbox" checked={deliverPush} onChange={(e) => setDeliverPush(e.target.checked)} className="cursor-pointer" />
            {t('launcher.cron.deliverPush')}
          </label>
          <input
            value={deliverMaster}
            onChange={(e) => setDeliverMaster(e.target.value)}
            placeholder={t('launcher.cron.deliverMasterPlaceholder')}
            className="w-full rounded-[8px] border border-border bg-panel px-2.5 py-1.5 font-mono text-[11px] outline-none placeholder:text-fgdim focus:border-ink"
          />
          <input
            value={deliverWhatsapp}
            onChange={(e) => setDeliverWhatsapp(e.target.value)}
            placeholder={t('launcher.cron.deliverWhatsappPlaceholder')}
            title={t('launcher.cron.deliverWhatsappTip')}
            className="w-full rounded-[8px] border border-border bg-panel px-2.5 py-1.5 font-mono text-[11px] outline-none placeholder:text-fgdim focus:border-ink"
          />
        </div>
        <label className="mb-2 flex cursor-pointer items-start gap-2 text-[11.5px]">
          <input type="checkbox" checked={autonomous} onChange={(e) => onToggleAutonomous(e.target.checked)} className="mt-0.5 cursor-pointer" />
          <span className={autonomous ? 'text-danger' : 'text-fgdim'}>
            {autonomous && (
              <span className="mr-1 cursor-help" title={t('launcher.trigger.autonomousTip')}>
                <Icon icon={faTriangleExclamation} />
              </span>
            )}
            {t('launcher.trigger.autonomousLabel')}
          </span>
        </label>
        {error && <div className="mb-1 text-[11px] text-danger">{error}</div>}
        <div className="flex justify-end">
          <YellowButton
            className="shrink-0 rounded-[9px] px-3.5 py-1.5 text-[11.5px]"
            disabled={busy || !prompt.trim() || !scheduleValue.trim() || (sessionMode === 'existing' && !targetSessionId.trim())}
            onClick={create}
          >
            {busy ? t('launcher.plan.creating') : t('launcher.cron.createJob')}
          </YellowButton>
        </div>
      </div>
      <div className="thin-scroll min-h-0 flex-1 overflow-y-auto px-[18px] py-3">
        <div className="mb-2 font-mono text-[11.5px] md:text-[10px] tracking-[0.08em] text-fgdim uppercase">
          {t('launcher.cron.listHeading', { n: cronJobs.length })}
        </div>
        {cronJobs.length === 0 && <div className="py-4 text-xs text-fgdim">{t('launcher.cron.emptyList')}</div>}
        {cronJobs.map((cj) => {
          const lastRunState = cj.runs?.length ? cj.runs[cj.runs.length - 1].state : null;
          return (
            <div key={cj.id} className="mb-2 flex flex-col gap-1.5 rounded-[9px] border border-border px-3 py-2">
              <div className="flex items-center gap-2">
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ background: cj.enabled ? '#3C9A4E' : '#d2d2d2' }}
                  title={cj.enabled ? t('launcher.trigger.enabledTitle') : t('launcher.trigger.disabledTitle')}
                />
                {cj.autonomous && (
                  <span className="shrink-0 cursor-help text-[13px]" title={t('launcher.trigger.autonomousBadgeTip')}>
                    <Icon icon={faTriangleExclamation} />
                  </span>
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12.5px] font-bold">{cj.name}</span>
                  <span className="block truncate text-[11.5px] md:text-[10.5px] text-fgdim">{scheduleSummary(cj.schedule, t)}</span>
                </span>
                {lastRunState && (
                  <span
                    className="shrink-0 rounded-full px-1.5 py-[1px] text-[11px] md:text-[9.5px] font-bold text-white"
                    style={{ background: CRON_RUN_COLOR[lastRunState] || '#9aa0a6' }}
                  >
                    {lastRunState}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2 text-[11.5px] md:text-[10px] text-fgdim">
                <span>{t('launcher.cron.metaLastRun')} {fmtAgo(cj.lastRun)}</span>
                <span>·</span>
                <span>{t('launcher.cron.metaNextRun')} {cj.nextRunAt ? fmtDateTime(cj.nextRunAt) : '—'}</span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => api.post(`/triggers/${cj.id}/run`).catch(() => {})}
                  title={t('launcher.cron.runNowTitle')}
                  className="shrink-0 cursor-pointer rounded-[6px] border border-border px-2 py-[3px] text-[11.5px] md:text-[10.5px] text-fgdim hover:border-ink"
                >
                  {t('launcher.cron.runNow')}
                </button>
                <button
                  type="button"
                  onClick={() => setLogId(cj.id)}
                  title={t('launcher.trigger.openLog')}
                  className="shrink-0 cursor-pointer rounded-[6px] border border-border px-2 py-[3px] text-[11.5px] md:text-[10.5px] text-fgdim hover:border-ink"
                >
                  <Icon icon={faBolt} /> {t('launcher.trigger.logs')}
                </button>
                <button
                  type="button"
                  onClick={() => api.patch(`/triggers/${cj.id}`, { enabled: !cj.enabled }).catch(() => {})}
                  title={cj.enabled ? t('launcher.trigger.disableAction') : t('launcher.trigger.enableAction')}
                  className="shrink-0 cursor-pointer rounded-[6px] border border-border px-2 py-[3px] text-[11.5px] md:text-[10.5px] text-fgdim hover:border-ink"
                >
                  {cj.enabled ? t('launcher.trigger.on') : t('launcher.trigger.off')}
                </button>
                <button
                  type="button"
                  onClick={() => api.del(`/triggers/${cj.id}`).catch(() => {})}
                  title={t('launcher.trigger.deleteTitle')}
                  className="ml-auto shrink-0 cursor-pointer px-1 text-[13px] text-fgdim hover:text-danger"
                >
                  <Icon icon={faXmark} />
                </button>
              </div>
            </div>
          );
        })}
      </div>
      {logId && <TriggerLogModal triggerId={logId} onClose={() => setLogId(null)} />}
      {warnOpen && (
        <AutonomyWarningModal
          onCancel={() => setWarnOpen(false)}
          onConfirm={(dontShow) => {
            if (dontShow) setPrefs({ autonomyWarningDismissed: true });
            setAutonomous(true);
            setWarnOpen(false);
          }}
        />
      )}
    </div>
  );
}

// The "From trigger" tab: a new-trigger form (reusing FilterBar) + the list of
// standing triggers. Creating a trigger arms-and-primes it server-side; it then
// drops matching tickets into the Pending queue. No session is born here.
// Sub-mode switch shared by both trigger kinds — Linear-filter (M0) and cron
// (M2, docs/TRIGGERS.md "Cron"). Same registry + activity-log modal, different forms.
function TriggerKindSwitch({ subMode, onChange }) {
  const t = useT();
  return (
    <div className="flex gap-1.5 border-b border-hair px-[18px] pt-3 pb-2">
      {[
        ['linear', 'launcher.cron.subTabLinear'],
        ['cron', 'launcher.cron.subTabCron'],
      ].map(([mode, key]) => (
        <button
          key={mode}
          type="button"
          onClick={() => onChange(mode)}
          className={`cursor-pointer rounded-[7px] px-2.5 py-1 text-[11px] font-bold ${
            subMode === mode ? 'bg-brand text-ink' : 'bg-panel text-fgdim hover:text-fg'
          }`}
        >
          {t(key)}
        </button>
      ))}
    </div>
  );
}

function TriggerTab() {
  const t = useT();
  const { triggers: allTriggers } = useStore();
  const triggers = allTriggers.filter((x) => x.type !== 'cron'); // cron jobs render in CronSubPanel
  const prefs = usePrefs();
  const [subMode, setSubMode] = useState('linear');
  const [logId, setLogId] = useState(null);
  const [autonomous, setAutonomous] = useState(false);
  const [injectPrompt, setInjectPrompt] = useState('');
  const [warnOpen, setWarnOpen] = useState(false);
  // A trigger fires unattended, so its skill/model/effort are fixed at
  // creation time and copied onto the trigger record itself — but the picker
  // + presets are the same widget as the ticket/empty forms, seeded from the
  // same default preset, for a consistent starting point.
  const [options, setOptions] = useState(() => defaultSessionOptions(prefs, 'trigger'));

  const onToggleAutonomous = (checked) => {
    if (!checked) return setAutonomous(false);
    if (prefs.autonomyWarningDismissed) return setAutonomous(true);
    setWarnOpen(true);
  };
  const [name, setName] = useState('');
  const [filters, setFilters] = useState(() => sanitizeFilters(EMPTY_TICKET_FILTERS));
  const [connected, setConnected] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);
  const labels = useLinearList('labels', !!connected);
  const statuses = useLinearList('statuses', !!connected);

  useEffect(() => {
    api.get('/linear/status').then((s) => setConnected(!!s.connected)).catch(() => setConnected(false));
  }, [reloadKey]);

  const showConnect = connected === false;

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.post('/triggers', {
        name: name.trim() || t('launcher.trigger.untitled'),
        filters,
        autonomous,
        injectPrompt,
        engine: options.engine || undefined,
        skill: options.skill || undefined,
        model: options.model || undefined,
        effort: options.effort || undefined,
      });
      setName('');
      setFilters(sanitizeFilters(EMPTY_TICKET_FILTERS));
      setAutonomous(false);
      setInjectPrompt('');
      setOptions(defaultSessionOptions(prefs, 'trigger'));
    } catch (e) {
      setError(String(e.message || e));
    }
    setBusy(false);
  };

  if (subMode === 'cron') {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <TriggerKindSwitch subMode={subMode} onChange={setSubMode} />
        <CronSubPanel />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <TriggerKindSwitch subMode={subMode} onChange={setSubMode} />
      <div className="border-b border-hair px-[18px] pt-4 pb-3">
        <div className="mb-2 font-mono text-[11.5px] md:text-[10px] tracking-[0.08em] text-fgdim uppercase">
          {t('launcher.trigger.newTrigger')}
        </div>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('launcher.trigger.namePlaceholder')}
          className="mb-2 w-full rounded-[9px] border-[1.5px] border-ink px-3 py-[9px] text-[12.5px] outline-none placeholder:text-fgdim focus:shadow-[2px_2px_0_rgba(42,42,42,0.16)]"
        />
        {showConnect && <ConnectLinear onConnected={() => setReloadKey((k) => k + 1)} />}
        <FilterBar
          filters={filters}
          onChange={setFilters}
          labels={labels}
          statuses={statuses}
          disabled={showConnect}
          showSearch={false}
          showHideOpen={false}
        />

        <EngineToggle options={options} onChange={setOptions} className="pb-2" />
        <SessionOptionsPicker options={options} onChange={setOptions} />
        <SessionPresetBar
          presets={prefs.sessionPresets}
          defaultId={prefs.sessionDefaultPresetId}
          defaultByMode={prefs.sessionDefaultPresetByMode}
          mode="trigger"
          current={options}
          onApply={setOptions}
        />

        {/* extra instructions injected into the task prompt on start */}
        <textarea
          value={injectPrompt}
          onChange={(e) => setInjectPrompt(e.target.value)}
          placeholder={t('launcher.trigger.injectPlaceholder')}
          rows={2}
          className="mt-2 w-full resize-y rounded-[9px] border border-border bg-panel px-3 py-2 text-[11.5px] outline-none placeholder:text-fgdim focus:border-ink"
        />

        {/* autonomous (unattended) mode — gated behind the warning modal */}
        <label className="mt-2 flex cursor-pointer items-start gap-2 text-[11.5px]">
          <input
            type="checkbox"
            checked={autonomous}
            onChange={(e) => onToggleAutonomous(e.target.checked)}
            className="mt-0.5 cursor-pointer"
          />
          <span className={autonomous ? 'text-danger' : 'text-fgdim'}>
            {autonomous && (
              <span
                className="mr-1 cursor-help"
                title={t('launcher.trigger.autonomousTip')}
              >
                <Icon icon={faTriangleExclamation} />
              </span>
            )}
            {t('launcher.trigger.autonomousLabel')}
          </span>
        </label>

        {error && <div className="mt-1 text-[11px] text-danger">{error}</div>}
        <div className="mt-2 flex items-center gap-3">
          <span className="text-[11px] leading-snug text-fgdim">
            {t('launcher.trigger.firesBefore')} <em>{t('launcher.trigger.after')}</em> {t('launcher.trigger.firesAfter')}
          </span>
          <YellowButton
            className="ml-auto shrink-0 rounded-[9px] px-3.5 py-1.5 text-[11.5px]"
            disabled={busy || showConnect}
            onClick={create}
          >
            {busy ? t('launcher.plan.creating') : t('launcher.trigger.createTrigger')}
          </YellowButton>
        </div>
      </div>
      <div className="thin-scroll min-h-0 flex-1 overflow-y-auto px-[18px] py-3">
        <div className="mb-2 font-mono text-[11.5px] md:text-[10px] tracking-[0.08em] text-fgdim uppercase">
          {t('launcher.trigger.listHeading', { n: triggers.length })}
        </div>
        {triggers.length === 0 && (
          <div className="py-4 text-xs text-fgdim">
            {t('launcher.trigger.emptyList')}
          </div>
        )}
        {triggers.map((trg) => (
          <div
            key={trg.id}
            className="mb-2 flex items-center gap-2 rounded-[9px] border border-border px-3 py-2"
          >
            <span
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ background: trg.enabled ? '#3C9A4E' : '#d2d2d2' }}
              title={trg.enabled ? t('launcher.trigger.enabledTitle') : t('launcher.trigger.disabledTitle')}
            />
            {trg.autonomous && (
              <span
                className="shrink-0 cursor-help text-[13px]"
                title={t('launcher.trigger.autonomousBadgeTip')}
              >
                <Icon icon={faTriangleExclamation} />
              </span>
            )}
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[12.5px] font-bold">{trg.name}</span>
              <span className="block truncate text-[11.5px] md:text-[10.5px] text-fgdim">
                {filterSummary(trg.filters)}
                {trg.lastError ? <> · <Icon icon={faTriangleExclamation} /> {trg.lastError}</> : ''}
              </span>
            </span>
            <span className="shrink-0 font-mono text-[11.5px] md:text-[10px] text-fgdim" title={t('launcher.trigger.spawnedTitle')}>
              {trg.createdSessions?.length || 0}<Icon icon={faArrowUp} className="text-[10px] md:text-[8px]" />
            </span>
            <button
              type="button"
              onClick={() => setLogId(trg.id)}
              title={t('launcher.trigger.openLog')}
              className="shrink-0 cursor-pointer rounded-[6px] border border-border px-2 py-[3px] text-[11.5px] md:text-[10.5px] text-fgdim hover:border-ink"
            >
              <Icon icon={faBolt} /> {t('launcher.trigger.logs')}
            </button>
            <button
              type="button"
              onClick={() => api.patch(`/triggers/${trg.id}`, { enabled: !trg.enabled }).catch(() => {})}
              title={trg.enabled ? t('launcher.trigger.disableAction') : t('launcher.trigger.enableAction')}
              className="shrink-0 cursor-pointer rounded-[6px] border border-border px-2 py-[3px] text-[11.5px] md:text-[10.5px] text-fgdim hover:border-ink"
            >
              {trg.enabled ? t('launcher.trigger.on') : t('launcher.trigger.off')}
            </button>
            <button
              type="button"
              onClick={() => api.del(`/triggers/${trg.id}`).catch(() => {})}
              title={t('launcher.trigger.deleteTitle')}
              className="shrink-0 cursor-pointer px-1 text-[13px] text-fgdim hover:text-danger"
            >
              <Icon icon={faXmark} />
            </button>
          </div>
        ))}
      </div>
      {logId && <TriggerLogModal triggerId={logId} onClose={() => setLogId(null)} />}
      {warnOpen && (
        <AutonomyWarningModal
          onCancel={() => setWarnOpen(false)}
          onConfirm={(dontShow) => {
            if (dontShow) setPrefs({ autonomyWarningDismissed: true });
            setAutonomous(true);
            setWarnOpen(false);
          }}
        />
      )}
    </div>
  );
}

/* ---------- the launcher ----------------------------------------------------- */

export default function Launcher({ config, sessions, onClose, onCreated, onNeedsSetup, initialMode }) {
  const t = useT();
  const prefs = usePrefs();
  // F8: "From a ticket" only exists once Linear is connected — a new user does
  // not know what Linear is. Until then the launcher opens on the empty form.
  const [linear, setLinear] = useState(null); // null = unknown yet
  useEffect(() => {
    let alive = true;
    api.get('/linear/status').then((r) => { if (alive) setLinear(!!r?.connected); }).catch(() => { if (alive) setLinear(false); });
    return () => { alive = false; };
  }, []);
  const [mode, setModeRaw] = useState(initialMode || 'empty');
  const setMode = (m) => setModeRaw(m);
  useEffect(() => {
    if (linear === false && mode === 'ticket') setModeRaw('empty');
  }, [linear, mode]);
  const [selected, setSelected] = useState(null);
  const [permMode, setPermMode] = useState('bypassPermissions');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [detailsId, setDetailsId] = useState(null);
  const [gated, setGated] = useState(false); // no ready repo → offer Setup / chat
  // Which skill/model/effort a new session starts with — feeds PlanPanel
  // (the ticket tab), seeded from that tab's own default preset if set, else
  // the any-tab default, editable per-launch, savable.
  const [sessionOpts, setSessionOpts] = useState(() => defaultSessionOptions(prefs, 'ticket'));
  // Editable extra instructions, merged after the chosen skill's own prompt (or
  // used verbatim if no skill is picked) — reset per ticket, unlike sessionOpts.
  const [ticketPrompt, setTicketPrompt] = useState('');
  useEffect(() => {
    setTicketPrompt('');
  }, [selected?.id]);

  const createFromTicket = async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    // Launcher gating: the ticket flow needs a provisioned workspace. If no repo
    // is ready, route to Setup instead of creating a session that dead-ends on a
    // missing workspace.
    try {
      const st = await api.get('/onboarding/status');
      const steps = st?.steps || [];
      const globalsOk = steps
        .filter((s) => s.scope === 'global')
        .every((s) => s.status === 'ok');
      const repoNames = [
        ...new Set(steps.filter((s) => s.scope.startsWith('repo:')).map((s) => s.scope.slice(5))),
      ];
      const anyReady =
        globalsOk &&
        repoNames.some((n) =>
          steps.filter((s) => s.scope === `repo:${n}`).every((s) => s.status === 'ok'),
        );
      if (!anyReady) {
        setBusy(false);
        setGated(true); // offer Setup UI or chat onboarding
        return;
      }
    } catch {
      /* status unavailable — don't block; fall through to create */
    }
    try {
      const session = await api.post(
        '/sessions',
        buildTicketPayload(selected, config, sessions, permMode, ticketPrompt, sessionOpts),
      );
      onCreated(session);
    } catch (e) {
      setError(String(e.message || e));
      setBusy(false);
    }
  };

  // Chat onboarding — spawn a session that runs the onboarding skill, which
  // drives the same /__api/onboarding/* engine conversationally.
  const startChatOnboarding = async () => {
    setBusy(true);
    setError(null);
    try {
      const s = await api.post('/sessions', {
        title: 'Onboarding',
        prompt:
          'Run the arigami:onboarding skill to provision a workspace so I can work on tickets. Follow that skill exactly — ask me which repo to add if it is not obvious.',
        permissionMode: 'bypassPermissions',
      });
      setGated(false);
      onCreated(s);
    } catch (e) {
      setError(String(e.message || e));
      setBusy(false);
    }
  };

  // "Do it later" — defer the selected ticket into the Pending queue instead of
  // starting it now. It shows up in the rail's Pending tasks section.
  const deferSelected = async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      await api.post('/pending', {
        ticket: selected.id,
        title: selected.title || selected.id,
        ...(ticketPrompt.trim() ? { prompt: ticketPrompt } : {}),
        engine: sessionOpts.engine || undefined,
        skill: sessionOpts.skill || undefined,
        model: sessionOpts.model || undefined,
        effort: sessionOpts.effort || undefined,
      });
      setSelected(null);
    } catch (e) {
      setError(String(e.message || e));
    }
    setBusy(false);
  };

  return (
    <div className="relative flex min-h-0 flex-1 flex-col bg-bg text-fg">
      {/* Launcher gate: fired when no repo is ready — offer Setup UI or chat onboarding */}
      {gated && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-[420px] rounded-[12px] border-[1.5px] border-ink bg-panel p-5 shadow-xl">
            <div className="text-[14px] font-bold text-fg">{t('launcher.gate.title')}</div>
            <p className="mt-1.5 text-[12px] leading-relaxed text-fgdim">
              {t('launcher.gate.body')}
            </p>
            <div className="mt-4 flex flex-col gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={startChatOnboarding}
                className="cursor-pointer rounded-[8px] border-[1.5px] border-ink bg-brand px-3 py-2 text-[12px] font-bold text-fg disabled:opacity-50"
              >
                {busy ? t('launcher.gate.starting') : t('launcher.gate.setupChat')}
              </button>
              <button
                type="button"
                onClick={() => { setGated(false); onNeedsSetup?.(); }}
                className="cursor-pointer rounded-[8px] border border-border bg-bg px-3 py-2 text-[12px] font-semibold text-fg hover:border-ink"
              >
                {t('launcher.gate.openSetup')}
              </button>
              <button
                type="button"
                onClick={() => setGated(false)}
                className="cursor-pointer px-3 py-1 text-[11px] text-fgdim hover:text-fg"
              >
                {t('launcher.common.cancel')}
              </button>
            </div>
          </div>
        </div>
      )}
      {/* header */}
      <div className="flex h-11 shrink-0 items-center gap-[9px] border-b border-hair px-4">
        <Wave />
        <span className="text-sm font-bold">{t('launcher.header.title')}</span>
        <span className="ml-3.5 flex overflow-hidden rounded-lg border-[1.5px] border-ink">
          {linear && (
          <button
            type="button"
            onClick={() => setMode('ticket')}
            className={`cursor-pointer px-[11px] py-1 text-[11px] ${
              mode === 'ticket' ? 'bg-brand font-bold' : 'bg-panel text-fgdim'
            }`}
          >
            {t('launcher.header.fromTicket')}
          </button>
          )}
          <button
            type="button"
            onClick={() => setMode('empty')}
            className={`cursor-pointer px-[11px] py-1 text-[11px] ${linear ? 'border-l-[1.5px] border-ink ' : ''}${
              mode === 'empty' ? 'bg-brand font-bold' : 'bg-panel text-fgdim'
            }`}
          >
            {t('launcher.header.emptySession')}
          </button>
          <button
            type="button"
            onClick={() => setMode('trigger')}
            className={`cursor-pointer border-l-[1.5px] border-ink px-[11px] py-1 text-[11px] ${
              mode === 'trigger' ? 'bg-brand font-bold' : 'bg-panel text-fgdim'
            }`}
          >
            {t('launcher.header.fromTrigger')}
          </button>
        </span>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            title={t('launcher.header.closeTitle')}
            className="ml-auto cursor-pointer px-1 text-[15px] text-fgdim hover:text-fg"
          >
            <Icon icon={faXmark} />
          </button>
        )}
      </div>

      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        {mode === 'ticket' ? (
          <>
            <TicketPicker selected={selected} onPick={setSelected} sessions={sessions} />
            <PlanPanel
              ticket={selected}
              config={config}
              sessions={sessions}
              busy={busy}
              error={error}
              onCreate={createFromTicket}
              onEmptyInstead={() => setMode('empty')}
              onLater={deferSelected}
              mode={permMode}
              onMode={setPermMode}
              onViewDetails={setDetailsId}
              prompt={ticketPrompt}
              onPrompt={setTicketPrompt}
              options={sessionOpts}
              onOptions={setSessionOpts}
            />
          </>
        ) : mode === 'trigger' ? (
          <TriggerTab />
        ) : (
          <EmptyForm config={config} sessions={sessions} onCreated={onCreated} />
        )}
      </div>
      {detailsId && <TicketDetailsModal id={detailsId} onClose={() => setDetailsId(null)} />}
    </div>
  );
}
