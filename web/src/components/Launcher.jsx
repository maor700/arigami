import { useEffect, useId, useMemo, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import { ChevronDown, ChevronRight, Pin, Star, TriangleAlert, X, Zap, ArrowUp } from 'lucide-react';
import { api, PALETTE } from '../lib/api.js';
import { useStore } from '../lib/store.js';
import { useLinearList } from '../lib/linearMeta.js';
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
import { modelOptionsFor, effortOptionsFor, coerceSessionOptions, resolveEngine } from '../lib/engines.js';
import { extLauncherItems, findExtension } from '../lib/ext.js';
import { cn } from '../lib/utils.js';
import ExtLauncherPane from './ExtLauncherPane.jsx';
import { EngineToggle, Hint, NativeSelect, Segmented } from './EngineToggle.jsx';
// Re-exported so the tests that always imported it from here keep working.
export { EngineToggle };
import { Wave, Dot } from './ui.jsx';
import { Button } from './ui/button.jsx';
import { Badge, StatusDot } from './ui/badge.jsx';
import { Checkbox } from './ui/checkbox.jsx';
import { Input, Textarea } from './ui/input.jsx';
import { Label } from './ui/label.jsx';
import { Switch } from './ui/switch.jsx';
import { Tabs, TabsList, TabsTrigger } from './ui/tabs.jsx';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover.jsx';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from './ui/dialog.jsx';
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogFooter, AlertDialogTitle, AlertDialogDescription, AlertDialogAction, AlertDialogCancel } from './ui/alert-dialog.jsx';
import { t, useT } from '../lib/i18n.js';
import { fmtDateTime } from '../lib/time.js';

// Shared launcher look. One section-label style (12px, medium, muted — no
// uppercase/mono/tracking), one card, one inner padding so every pane lines up.
const sectionLabel = 'text-xs font-medium text-muted-foreground';
const hintText = 'text-xs leading-relaxed text-muted-foreground';
const errText = 'text-xs text-destructive';
const cardBox = 'rounded-lg border border-hair';
// Content column of a form pane: roomy, never wider than a comfortable line.
const paneCol = 'mx-auto w-full max-w-3xl';

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
    folderName: sessionOpts?.folderName || undefined,
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
      <span className="flex h-3 w-3 shrink-0 items-end justify-center gap-px" aria-hidden="true">
        <span className="rounded-[1px]" style={{ width: 3, height: 5, background: c }} />
        <span className="rounded-[1px]" style={{ width: 3, height: 8, background: c }} />
        <span className="rounded-[1px]" style={{ width: 3, height: 11, background: high ? c : dim }} />
      </span>
    );
  }
  return (
    <span
      className="flex w-3 shrink-0 justify-center"
      aria-hidden="true"
    >
      <span className="rounded-[2px]" style={{ width: 11, height: 4, background: '#d5d8e0' }} />
    </span>
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
    <div className="flex h-9 items-center gap-2.5 rounded-md border border-input bg-background px-3 transition-[border-color,box-shadow] duration-150 focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/35 coarse:h-11">
      <span aria-hidden="true" className="size-3 shrink-0 rotate-45 rounded-[2px] bg-muted-foreground" />
      <input
        ref={ref}
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && commit()}
        placeholder={t('launcher.paste.placeholder')}
        className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
      />
      <bdi className="shrink-0 text-xs text-muted-foreground tabular-nums">ENG-16498</bdi>
    </div>
  );
}

// Multi-select tag filter with an Any/All (OR/AND) operator. Linear's API only
// takes one label, so the server (listIssuesByFacets) fans out OR into N calls
// and resolves AND by intersection — here we just collect the selection + op.
// A ui/Popover (a bottom-anchored panel clamped to the viewport on phones).
function LabelPicker({ options, selected, op, onChange, disabled }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');

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
    <Popover open={open && !disabled} onOpenChange={setOpen}>
      <Hint label={t('launcher.labels.filterTitle')}>
        <PopoverTrigger asChild>
          <Button variant="default" disabled={disabled} className={cn('max-w-full', selected.length && 'border-foreground/40')}>
            <span className="max-w-32 truncate">{summary}</span>
            {selected.length > 1 && <span className="text-xs text-muted-foreground uppercase">{op}</span>}
            <ChevronDown className="size-4 text-muted-foreground" aria-hidden="true" />
          </Button>
        </PopoverTrigger>
      </Hint>
      <PopoverContent align="start" className="w-64 p-2.5">
        <div className="mb-2.5 flex items-center gap-2">
          <span className={sectionLabel}>{t('launcher.labels.match')}</span>
          <Segmented
            value={op}
            options={[
              ['or', t('launcher.labels.opAny')],
              ['and', t('launcher.labels.opAll')],
            ]}
            onChange={(v) => onChange({ labels: selected, labelOp: v })}
            label={t('launcher.labels.match')}
          />
          {selected.length > 0 && (
            <Button variant="ghost" size="xs" className="ms-auto" onClick={() => onChange({ labels: [], labelOp: op })}>
              {t('launcher.labels.clear')}
            </Button>
          )}
        </div>
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t('launcher.labels.searchPlaceholder')}
          className="mb-2"
        />
        <div className="thin-scroll max-h-48 overflow-y-auto">
          {filtered.length === 0 && <div className="px-1 py-2 text-xs text-muted-foreground">{t('launcher.labels.none')}</div>}
          {filtered.map((l) => (
            <label
              key={l}
              className="flex min-h-8 cursor-pointer items-center gap-2.5 rounded-md px-1.5 text-sm hover:bg-muted coarse:min-h-11"
            >
              <Checkbox checked={selected.includes(l)} onCheckedChange={() => toggle(l)} />
              <span className="min-w-0 truncate">{l}</span>
            </label>
          ))}
        </div>
      </PopoverContent>
    </Popover>
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
  const hideId = useId();
  const set = (patch) => onChange({ ...filters, ...patch });
  // Live workspace statuses when we have them; the state-type buckets as a
  // fallback (offline / not yet loaded).
  const stateOpts = statuses.length
    ? [['', t('launcher.state.any')], ...statuses.map((s) => [s.name, s.name])]
    : STATE_OPTS.map(([v, k]) => [v, t(k)]);
  return (
    <div className="flex flex-wrap items-center gap-2 px-4 pb-3">
      <Segmented
        value={filters.assignee}
        options={[
          ['me', t('launcher.filter.me')],
          ['any', t('launcher.filter.anyone')],
        ]}
        onChange={(v) => set({ assignee: v })}
        disabled={disabled}
        label={t('launcher.meta.assignee')}
      />
      <NativeSelect disabled={disabled} value={filters.state} onChange={(e) => set({ state: e.target.value })}>
        {stateOpts.map(([v, l]) => (
          <option key={v} value={v}>{l}</option>
        ))}
      </NativeSelect>
      <NativeSelect aria-label={t('launcher.meta.priority')} disabled={disabled} value={filters.priority} onChange={(e) => set({ priority: e.target.value })}>
        {PRIORITY_OPTS.map(([v, k]) => (
          <option key={v} value={v}>{t(k)}</option>
        ))}
      </NativeSelect>
      <LabelPicker
        options={labels}
        selected={filters.labels}
        op={filters.labelOp}
        onChange={({ labels: ls, labelOp }) => set({ labels: ls, labelOp })}
        disabled={disabled}
      />
      {showSearch && (
        <Input
          disabled={disabled}
          value={filters.query}
          onChange={(e) => set({ query: e.target.value })}
          placeholder={t('launcher.filter.searchPlaceholder')}
          aria-label={t('launcher.filter.searchPlaceholder')}
          className="min-w-32 flex-1"
        />
      )}
      <Hint label={t('launcher.filter.sortTitle')}>
        <Segmented
          value={filters.orderBy}
          options={[
            ['updatedAt', t('launcher.filter.updated')],
            ['createdAt', t('launcher.filter.created')],
          ]}
          onChange={(v) => set({ orderBy: v })}
          disabled={disabled}
          label={t('launcher.filter.sortTitle')}
        />
      </Hint>
      {showHideOpen && (
        <Hint label={t('launcher.filter.hideOpenTitle')}>
          <label htmlFor={hideId} className={cn('flex min-h-8 cursor-pointer items-center gap-2 text-sm text-muted-foreground coarse:min-h-11', disabled && 'cursor-not-allowed opacity-50')}>
            <Checkbox id={hideId} disabled={disabled} checked={!!filters.hideOpen} onCheckedChange={(v) => set({ hideOpen: !!v })} />
            {t('launcher.filter.hideOpen')}
          </label>
        </Hint>
      )}
    </div>
  );
}

// ---- preset chips (shared by the ticket-filter and session-option bars) ----
// A chip = one hairline-bordered group: apply button (with the label), then the
// small icon actions. Active = neutral fill. Colour only on a set default star/pin.
const chipCls = (active) =>
  cn(
    'inline-flex min-h-7 items-center rounded-md border text-xs transition-colors coarse:min-h-11',
    active ? 'border-foreground/25 bg-muted text-foreground' : 'border-border bg-transparent text-muted-foreground',
  );
function PresetIconBtn({ tip, active, onClick, danger, children }) {
  return (
    <Hint label={tip}>
      <button
        type="button"
        aria-label={tip}
        aria-pressed={active == null ? undefined : !!active}
        onClick={onClick}
        className={cn(
          'inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-sm outline-none hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring coarse:size-11 [&_svg]:size-3.5',
          active ? 'text-[var(--hb-warn)]' : 'text-muted-foreground',
          danger && 'hover:text-destructive',
        )}
      >
        {children}
      </button>
    </Hint>
  );
}
function PresetApply({ onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="min-h-7 max-w-40 cursor-pointer truncate rounded-sm px-2 text-xs font-medium outline-none hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring coarse:min-h-11"
    >
      {children}
    </button>
  );
}
// "+ Save current" → an inline name box. Blur or Enter commits, Esc cancels.
function PresetSave({ onSave }) {
  const t = useT();
  const [naming, setNaming] = useState(false);
  const [draft, setDraft] = useState('');
  const commit = () => {
    const name = draft.trim();
    if (name) onSave(name);
    setDraft('');
    setNaming(false);
  };
  return naming ? (
    <Input
      autoFocus
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
        else if (e.key === 'Escape') { setDraft(''); setNaming(false); }
      }}
      placeholder={t('launcher.presets.namePlaceholder')}
      aria-label={t('launcher.presets.namePlaceholder')}
      className="h-7 w-36"
    />
  ) : (
    <Button variant="ghost" size="xs" onClick={() => setNaming(true)}>
      {t('launcher.presets.saveCurrent')}
    </Button>
  );
}

// Saved presets: apply (chip), set default (★), delete (×), save current (+).
// `presets` includes the built-in first; the built-in can't be deleted.
function PresetBar({ presets, defaultId, current, onApply }) {
  const t = useT();
  const activeId = presets.find((p) => filtersEqual(p.filters, current))?.id || null;
  return (
    <div className="flex flex-wrap items-center gap-2 px-4 pb-3">
      <span className={sectionLabel}>{t('launcher.presets.title')}</span>
      {presets.map((p) => (
        <span key={p.id} className={chipCls(activeId === p.id)}>
          <PresetIconBtn
            tip={defaultId === p.id ? t('launcher.presets.unsetDefault') : t('launcher.presets.setDefault')}
            active={defaultId === p.id}
            onClick={() => setDefaultTicketPreset(p.id)}
          >
            <Star className={defaultId === p.id ? 'fill-current' : undefined} />
          </PresetIconBtn>
          <PresetApply onClick={() => onApply(p.filters)}>
            {p.builtin ? t('launcher.preset.myOpenWork') : p.name}
          </PresetApply>
          {!p.builtin && (
            <PresetIconBtn tip={t('launcher.presets.delete')} danger onClick={() => deleteTicketPreset(p.id)}>
              <X />
            </PresetIconBtn>
          )}
        </span>
      ))}
      <PresetSave onSave={(name) => saveTicketPreset(name, current)} />
    </div>
  );
}

function sessionOptionsEqual(a, b) {
  return (
    (a?.folderName || '') === (b?.folderName || '') &&
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
  return { folderName: d?.folderName || '', engine: d?.engine || '', skill: d?.skill || '', model: d?.model || '', effort: d?.effort || '' };
}


// Folder names are unique (case/space-insensitive), so a session is filed by PICKING one
// from the list. "New folder…" reveals a text box; a name that matches an existing folder
// just files the session there (the host resolves names the same way).
const folderKey = (n) => String(n || '').trim().replace(/\s+/g, ' ').toLowerCase();
export function FolderPicker({ value, onChange }) {
  const t = useT();
  const { folders } = useStore();
  const names = useMemo(
    () => [...new Set((folders || []).map((f) => f.name).filter(Boolean))].sort((a, b) => a.localeCompare(b)),
    [folders]
  );
  const [creating, setCreating] = useState(false);
  const match = value ? names.find((n) => folderKey(n) === folderKey(value)) : '';
  const isNew = creating || (!!value && !match);
  return (
    <span className="flex max-w-full flex-wrap items-center gap-2">
      <Hint label={t('launcher.options.folderHint')}>
        <NativeSelect
          value={isNew ? '__new' : match || ''}
          onChange={(e) => {
            const v = e.target.value;
            if (v === '__new') { setCreating(true); onChange(''); return; }
            setCreating(false);
            onChange(v);
          }}
          aria-label={t('launcher.options.folder')}
        >
          <option value="">{t('launcher.options.noFolder')}</option>
          {names.map((n) => <option key={n} value={n}>{n}</option>)}
          <option value="__new">{t('launcher.options.newFolder')}</option>
        </NativeSelect>
      </Hint>
      {isNew && (
        <Input
          type="text"
          autoFocus={creating}
          value={value || ''}
          onChange={(e) => onChange(e.target.value)}
          className="w-44 max-w-full"
          placeholder={t('launcher.options.folder')}
          aria-label={t('launcher.options.folder')}
        />
      )}
      {isNew && value && match && <span data-folder-exists className="text-xs text-muted-foreground">{t('launcher.options.folderExists')}</span>}
    </span>
  );
}

// Which skill (from GET /skills — whatever's actually bundled, no fixed
// default), which model, which effort a new session starts with. The model and
// effort lists are read off the engine EngineToggle picked (and, on Codex, off
// the model too — the ladder moves with it), so these never offer a value the
// chosen engine would reject.
//
// Exported for tests.
export function SessionOptionsPicker({ options, onChange, hideSkill = false }) {
  const t = useT();
  const [skills, setSkills] = useState([]);
  useEffect(() => {
    api.get('/skills').then((r) => setSkills(r?.skills || [])).catch(() => {});
  }, []);
  const { models: claudeModels } = useModels();
  const engine = resolveEngine(options.engine);
  const modelOptions = modelOptionsFor(engine, claudeModels);
  const effortOptions = effortOptionsFor(engine, options.model);
  const set = (patch) => onChange({ ...options, ...patch });
  const setAndCoerce = (patch) => onChange(coerceSessionOptions({ ...options, ...patch }, claudeModels));
  return (
    <div className="flex flex-wrap items-center gap-2 pb-3">
      <FolderPicker value={options.folderName} onChange={(folderName) => set({ folderName })} />
      {!hideSkill && (
        <Hint label={skills.find((s) => s.name === options.skill)?.description || ''}>
          <NativeSelect
            value={options.skill || ''}
            onChange={(e) => set({ skill: e.target.value })}
          >
            <option value="">{t('launcher.options.noSkill')}</option>
            {skills.map((s) => (
              <option key={s.name} value={s.name}>{s.name}</option>
            ))}
          </NativeSelect>
        </Hint>
      )}
      <Hint label={modelOptions.find((o) => o.value === (options.model || 'default'))?.desc || ''}>
        <NativeSelect
          value={options.model || 'default'}
          onChange={(e) => setAndCoerce({ model: e.target.value === 'default' ? '' : e.target.value })}
        >
          {modelOptions.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </NativeSelect>
      </Hint>
      <NativeSelect
        value={options.effort || 'default'}
        onChange={(e) => set({ effort: e.target.value === 'default' ? '' : e.target.value })}
        aria-label={t('rail.effort')}
      >
        {effortOptions.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </NativeSelect>
    </div>
  );
}

// Saved skill/model/effort presets — same interaction as PresetBar (chip,
// star = default, pin = this tab's default, × = delete, + = save current).
function SessionPresetBar({ presets, defaultId, defaultByMode, mode, current, onApply }) {
  const t = useT();
  const tabDefaultId = defaultByMode[mode];
  const activeId = presets.find((p) => sessionOptionsEqual(p, current))?.id || null;
  return (
    <div className="flex flex-wrap items-center gap-2 pb-3">
      <span className={sectionLabel}>{t('launcher.presets.title')}</span>
      {presets.map((p) => (
        <span key={p.id} className={chipCls(activeId === p.id)}>
          <PresetIconBtn
            tip={defaultId === p.id ? t('launcher.presets.unsetGlobalDefault') : t('launcher.presets.setGlobalDefault')}
            active={defaultId === p.id}
            onClick={() => setDefaultSessionPreset(p.id)}
          >
            <Star className={defaultId === p.id ? 'fill-current' : undefined} />
          </PresetIconBtn>
          <PresetIconBtn
            tip={tabDefaultId === p.id ? t('launcher.presets.unsetTabDefault') : t('launcher.presets.setTabDefault')}
            active={tabDefaultId === p.id}
            onClick={() => setModeDefaultSessionPreset(mode, p.id)}
          >
            <Pin className={tabDefaultId === p.id ? 'fill-current' : undefined} />
          </PresetIconBtn>
          <PresetApply onClick={() => onApply(p)}>{p.name}</PresetApply>
          <PresetIconBtn tip={t('launcher.presets.delete')} danger onClick={() => deleteSessionPreset(p.id)}>
            <X />
          </PresetIconBtn>
        </span>
      ))}
      <PresetSave onSave={(name) => saveSessionPreset(name, current)} />
    </div>
  );
}

function TicketRow({ ticket, selected, onPick, openSession }) {
  const t = useT();
  // A ticket already in a host session: disabled (not selectable), marked with
  // the session colour dot, and badged "in session".
  if (openSession) {
    const color = openSession.color || '#c4c4c4';
    return (
      <Hint label={t('launcher.ticket.openSessionTitle', { name: openSession.title || openSession.id })}>
        <div className="mb-0.5 flex min-h-9 cursor-not-allowed items-center gap-3 rounded-md px-3 py-1.5 opacity-70 coarse:min-h-11">
          <Dot color={color} size={10} />
          <bdi className="shrink-0 text-xs font-medium text-muted-foreground tabular-nums">{ticket.id}</bdi>
          <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">{ticket.title}</span>
          <Badge>{t('launcher.ticket.inSession')}</Badge>
        </div>
      </Hint>
    );
  }
  return (
    <div
      onClick={() => onPick(ticket)}
      className={cn(
        'mb-0.5 flex min-h-9 cursor-pointer items-center gap-3 rounded-md px-3 py-1.5 coarse:min-h-11',
        selected ? 'row-selected' : 'hover:bg-muted',
      )}
    >
      <PriorityGlyph priority={ticket.priority} />
      <bdi className="shrink-0 text-xs font-medium text-foreground tabular-nums">{ticket.id}</bdi>
      <span className={cn('min-w-0 flex-1 truncate text-sm', selected ? 'text-foreground' : 'text-muted-foreground')}>
        {ticket.title}
      </span>
      {ticket.status && <Badge variant="outline">{ticket.status}</Badge>}
      {ticket.project && (
        <span className="hidden max-w-32 shrink-0 truncate text-xs text-muted-foreground sm:inline">{ticket.project}</span>
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
    <div className={cn(cardBox, 'mx-4 mb-3 bg-card p-4')}>
      <div className="mb-1 text-sm font-semibold">{t('launcher.connect.heading')}</div>
      <div className={cn(hintText, 'mb-3')}>
        {t('launcher.connect.body')}
      </div>
      {/* the Start/Create action of the view stays the one accent button */}
      <Button variant="default" onClick={connect} disabled={busy}>
        {busy ? t('launcher.connect.waiting') : t('launcher.connect.button')}
      </Button>
      {err && <div className={cn(errText, 'mt-2')}>{err}</div>}
      <div className={cn(hintText, 'mt-3')}>
        {t('launcher.connect.agentsNote')}{' '}
        <a href="#/settings/connections/mcp" className="underline underline-offset-2 hover:text-foreground">{t('launcher.connect.agentsLink')}</a>
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
    <div className="flex min-h-0 min-w-0 flex-1 flex-col border-b border-hair max-md:flex-none md:border-e md:border-b-0">
      <div className="flex items-center gap-3 px-4 pt-4 pb-3">
        <span className="min-w-0 flex-1"><PasteField onPick={onPick} autoFocus /></span>
        {connected && (
          <Hint label={t('launcher.picker.liveTitle')}>
            <Badge status="ok">{t('launcher.picker.live')}</Badge>
          </Hint>
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
      <div className="thin-scroll min-h-0 flex-1 overflow-y-auto border-t border-hair px-2 py-2 max-md:max-h-[45dvh]">
        {tickets === null && (
          <div className="flex items-center gap-2 px-3 py-5 text-sm text-muted-foreground">
            <span className="host-spinner size-3.5" /> {t('launcher.picker.loading')}
          </div>
        )}
        {tickets !== null && error && (
          <div className="flex flex-col items-start gap-3 px-3 py-5 text-sm text-muted-foreground">
            <span>{t('launcher.picker.loadError')}</span>
            <Button variant="outline" size="sm" onClick={() => setReloadKey((k) => k + 1)}>
              {t('launcher.picker.retry')}
            </Button>
          </div>
        )}
        {tickets !== null && !error && !needsAuth && visible.length === 0 && (
          <div className="px-3 py-5 text-sm text-muted-foreground">{t('launcher.picker.empty')}</div>
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
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 text-foreground">{children}</span>
    </>
  );
}

// Full ticket details (description + comments + links) before you commit to it.
// A ui/Dialog: Esc / outside-click / the corner X close it, focus is trapped and restored.
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

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent aria-describedby={undefined} className="flex max-h-[85dvh] w-[min(45rem,calc(100vw-1.5rem))] flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="shrink-0 flex-row flex-wrap items-center gap-3 border-b border-hair px-5 py-3 pe-12">
          <DialogTitle className="text-sm tabular-nums"><bdi>{id}</bdi></DialogTitle>
          {data?.status && (
            <Badge variant="outline">
              <span className="size-1.5 shrink-0 rounded-full" style={{ background: data.statusColor }} />
              {data.status}
            </Badge>
          )}
          {data?.url && (
            <a href={data.url} target="_blank" rel="noopener" className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground">
              {t('launcher.details.openInLinear')}
            </a>
          )}
        </DialogHeader>

        <div className="thin-scroll min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {data === undefined && (
            <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
              <span className="host-spinner size-3.5" /> {t('launcher.details.loading')}
            </div>
          )}
          {data === null && (
            <div className="py-6 text-sm text-destructive">{t('launcher.details.error')}</div>
          )}
          {data && (
            <>
              <h2 className="mb-4 text-lg leading-snug font-semibold text-foreground">{data.title}</h2>
              <div className="mb-5 grid grid-cols-[5.5rem_1fr] gap-x-3 gap-y-2 text-sm">
                <MetaRow label={t('launcher.meta.assignee')}>{data.assignee}</MetaRow>
                <MetaRow label={t('launcher.meta.priority')}>{data.priority}</MetaRow>
                <MetaRow label={t('launcher.meta.project')}>{data.project}</MetaRow>
                <MetaRow label={t('launcher.meta.team')}>{data.team}</MetaRow>
                <MetaRow label={t('launcher.meta.creator')}>{data.creator}</MetaRow>
                {data.labels.length > 0 && (
                  <MetaRow label={t('launcher.meta.labels')}>
                    <span className="flex flex-wrap gap-1.5">
                      {data.labels.map((l) => (
                        <Badge key={l.name} variant="outline">
                          <span className="size-1.5 shrink-0 rounded-full" style={{ background: l.color || 'var(--hb-faint)' }} />
                          {l.name}
                        </Badge>
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
                <div className="border-t border-hair pt-4 text-sm text-muted-foreground">{t('launcher.details.noDescription')}</div>
              )}

              {data.links.length > 0 && (
                <div className="mt-5 border-t border-hair pt-4">
                  <div className={cn(sectionLabel, 'mb-2')}>{t('launcher.details.links')}</div>
                  <div className="flex flex-col gap-1.5">
                    {data.links.map((a) => (
                      <a key={a.url} href={a.url} target="_blank" rel="noopener" className="truncate text-sm text-foreground underline underline-offset-2 hover:decoration-2">
                        {a.title}
                      </a>
                    ))}
                  </div>
                </div>
              )}

              {data.comments.length > 0 && (
                <div className="mt-5 border-t border-hair pt-4">
                  <div className={cn(sectionLabel, 'mb-3')}>
                    {t('launcher.details.comments', { n: data.comments.length })}
                  </div>
                  <div className="flex flex-col gap-3">
                    {data.comments.map((c, i) => (
                      <div key={i} className="rounded-md border border-hair bg-card px-3.5 py-3">
                        <div className="mb-1 text-xs font-medium text-foreground">{c.author || t('launcher.details.someone')}</div>
                        <div className="md-light text-sm"><Markdown>{c.body}</Markdown></div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ProvisionRow({ label, children }) {
  return (
    <div className="flex items-center gap-3 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <bdi className="ms-auto min-w-0 truncate text-foreground">{children}</bdi>
    </div>
  );
}

// Permission modes are the SDK's own words; shared by the ticket and empty forms.
function PermissionOptions({ defaultLabel }) {
  return (
    <>
      <option value="default">{defaultLabel}</option>
      <option value="acceptEdits">acceptEdits</option>
      <option value="plan">plan</option>
      <option value="bypassPermissions">bypassPermissions</option>
    </>
  );
}

function PlanPanel({ ticket, config, sessions, onCreate, onEmptyInstead, onLater, busy, error, mode, onMode, onViewDetails, prompt, onPrompt, options, onOptions }) {
  const t = useT();
  const prefs = usePrefs();
  const permId = useId();
  const promptId = useId();
  const color = nextPaletteColor(sessions, config);
  return (
    <div className="thin-scroll flex w-full shrink-0 flex-col bg-panel p-5 md:w-[22.5rem] md:overflow-y-auto">
      <div className={cn(sectionLabel, 'mb-3')}>
        {t('launcher.plan.selectedTicket')}
      </div>
      {!ticket ? (
        <div className={cn(hintText, 'flex-1 pt-1 text-sm')}>
          {t('launcher.plan.pickHint')}
        </div>
      ) : (
        <>
          <div className="mb-1.5 flex items-center gap-2">
            <bdi className="text-sm font-semibold tabular-nums">{ticket.id}</bdi>
            {ticket.status && <Badge variant="outline">{ticket.status}</Badge>}
          </div>
          <div className="mb-3 text-base leading-snug text-foreground">
            {ticket.title || t('launcher.plan.pastedTitle')}
          </div>
          <Button variant="outline" size="sm" className="mb-4 self-start" onClick={() => onViewDetails(ticket.id)}>
            {t('launcher.plan.viewDetails')}
          </Button>
          <div className="mb-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-xs">
            <span className="text-muted-foreground">{t('launcher.meta.assignee')}</span>
            <span className="text-foreground">{ticket.assignee || t('launcher.plan.you')}</span>
            {ticket.priority != null && (
              <>
                <span className="text-muted-foreground">{t('launcher.meta.priority')}</span>
                <span className="text-foreground">
                  {{ 1: t('launcher.priority.urgent'), 2: t('launcher.priority.high'), 3: t('launcher.priority.medium'), 4: t('launcher.priority.low') }[ticket.priority] ||
                    String(ticket.priority)}
                </span>
              </>
            )}
            {ticket.project && (
              <>
                <span className="text-muted-foreground">{t('launcher.meta.project')}</span>
                <span className="text-foreground">{ticket.project}</span>
              </>
            )}
            {ticket.labels?.length > 0 && (
              <>
                <span className="text-muted-foreground">{t('launcher.meta.labels')}</span>
                <span className="text-foreground">{ticket.labels.join(', ')}</span>
              </>
            )}
          </div>
          <div className="border-t border-hair pt-4">
            <div className="mb-3 text-sm font-semibold">{t('launcher.plan.provision')}</div>
            <div className="flex flex-col gap-2.5">
              <ProvisionRow label="Worktree">app-worktrees/{ticket.id.toLowerCase()}</ProvisionRow>
              <ProvisionRow label="Branch">
                <Badge mono className="min-w-0"><span className="truncate">feat/{slug(ticket.title) || ticket.id.toLowerCase()}</span></Badge>
              </ProvisionRow>
              <ProvisionRow label="Dev server">
                :{config?.devServerPorts?.[0] ?? 'auto'}
              </ProvisionRow>
              <div className="flex items-center gap-3 text-xs">
                <span className="text-muted-foreground">{t('launcher.plan.sessionColour')}</span>
                <span className="ms-auto flex items-center gap-1.5">
                  <Dot color={color} />
                  <span className="text-muted-foreground">auto</span>
                </span>
              </div>
            </div>
          </div>
        </>
      )}
      {error && <div className={cn(errText, 'mt-3')}>{error}</div>}
      <div className="mt-auto flex flex-col gap-3 pt-5">
        {ticket && (
          <>
            <EngineToggle options={options} onChange={onOptions} />
            <SessionOptionsPicker options={options} onChange={onOptions} />
            <SessionPresetBar
              presets={prefs.sessionPresets}
              defaultId={prefs.sessionDefaultPresetId}
              defaultByMode={prefs.sessionDefaultPresetByMode}
              mode="ticket"
              current={options}
              onApply={onOptions}
            />
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={promptId}>
                {t('launcher.plan.extraInstructions')}
              </Label>
              <Textarea
                id={promptId}
                value={prompt}
                onChange={(e) => onPrompt(e.target.value)}
                rows={4}
                spellCheck={false}
                placeholder={t('launcher.plan.extraInstructionsPlaceholder')}
              />
            </div>
          </>
        )}
        <div className="flex items-center gap-3">
          <Label htmlFor={permId}>
            {t('launcher.plan.permissions')}
          </Label>
          <NativeSelect id={permId} value={mode} onChange={(e) => onMode(e.target.value)} wrapperClassName="flex-1" className="w-full">
            <PermissionOptions defaultLabel={t('launcher.plan.permDefault')} />
          </NativeSelect>
        </div>
        <Button variant="primary" size="lg" className="w-full" disabled={!ticket || busy} onClick={onCreate}>
          {busy ? t('launcher.plan.creating') : t('launcher.plan.createSession')}
        </Button>
        <Button variant="outline" className="w-full" onClick={onLater} disabled={!ticket || busy}>
          {t('launcher.plan.doItLater')}
        </Button>
        <Button variant="ghost" className="w-full text-muted-foreground" onClick={onEmptyInstead}>
          {t('launcher.plan.emptyInstead')}
        </Button>
      </div>
    </div>
  );
}

// A label + control pair of the form panes.
function Field({ label, htmlFor, className, children }) {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
    </div>
  );
}

function EmptyForm({ config, sessions, onCreated }) {
  const t = useT();
  const prefs = usePrefs();
  const nameId = useId();
  const cwdId = useId();
  const permId = useId();
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
        folderName: options.folderName || undefined,
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
        folderName: options.folderName || undefined,
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
      <div className="w-full max-w-xl px-5 py-8 md:py-10">
        <div className="mb-2 text-base font-semibold text-foreground">{t('launcher.empty.promptFirst')}</div>
        <Textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); create(); } }}
          rows={3}
          autoFocus
          dir="auto"
          placeholder={t('launcher.firstRun.placeholder')}
          aria-label={t('launcher.empty.promptFirst')}
          className="mb-4 min-h-24 text-base"
        />
        <EngineToggle options={options} onChange={setOptions} className="mb-3" />
        <Button variant="ghost" size="sm" onClick={() => setAdvanced((v) => !v)} aria-expanded={advanced} className="mb-4 -ms-2.5 text-muted-foreground">
          <ChevronRight aria-hidden="true" className={cn('transition-transform rtl:rotate-180', advanced && 'rotate-90 rtl:rotate-90')} />
          {t('launcher.empty.advanced')} <span className="font-normal">· {t('launcher.empty.advancedHint')}</span>
        </Button>
        <div className={advanced ? '' : 'hidden'}>
        <div className="mb-5 flex flex-col gap-5 border-s border-hair ps-4">
          <Field label={t('launcher.empty.sessionName')} htmlFor={nameId}>
            <Input
              id={nameId}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && create()}
              placeholder={t('launcher.empty.namePlaceholder')}
            />
            <div className={cn(hintText, 'flex flex-wrap items-center gap-1.5')}>
              <span>{t('launcher.empty.leaveBlank')}</span>
              <Badge mono variant="outline">{scratchN}</Badge>
              <span>{t('launcher.empty.renamedBy')}</span>
              <Badge mono variant="outline">host.set_title()</Badge>
            </div>
          </Field>

          <Field label={t('launcher.empty.workingDir')} htmlFor={cwdId}>
            <Input
              id={cwdId}
              value={cwd}
              dir="ltr"
              onChange={(e) => setCwd(e.target.value)}
              placeholder={config?.defaultCwd || '~/Desktop/repos'}
              className="text-start font-mono"
            />
          </Field>

          <Field label={t('launcher.empty.permMode')} htmlFor={permId}>
            <NativeSelect id={permId} value={mode} onChange={(e) => setMode(e.target.value)} wrapperClassName="w-full" className="w-full">
              <PermissionOptions defaultLabel="default" />
            </NativeSelect>
          </Field>

          <div className="flex flex-col gap-1.5">
            <span className={sectionLabel}>{t('launcher.options.title')}</span>
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
        </div>
        </div>

        {error && <div className={cn(errText, 'mb-3')}>{error}</div>}
        <Button variant="primary" size="lg" className="w-full" disabled={busy} onClick={create}>
          {busy ? t('launcher.plan.creating') : t('launcher.empty.createEmpty')}
        </Button>
        <Hint label={prompt.trim() || options.skill ? t('launcher.empty.addToPending') : t('launcher.empty.deferTitle')}>
          <span className="mt-2 block">
            <Button variant="outline" className="w-full" onClick={later} disabled={busy || (!prompt.trim() && !options.skill)}>
              {t('launcher.plan.doItLater')}
            </Button>
          </span>
        </Hint>
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
export function TriggerLogModal({ triggerId, onClose }) {
  const t = useT();
  const [detail, setDetail] = useState(null);
  const logRef = useRef(null);
  const [loadError, setLoadError] = useState(null);
  const [lastLoaded, setLastLoaded] = useState(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let stop = false;
    let terminal = false;
    let pending = false;
    const tick = async () => {
      if (stop || terminal || pending) return;
      pending = true;
      try {
        const d = await api.get(`/triggers/${triggerId}`);
        if (!stop) {
          setDetail(d);
          setLoadError(null);
          setLastLoaded(Date.now());
        }
      } catch (e) {
        terminal = e.status === 404;
        if (!stop) setLoadError({ message: String(e.message || e), terminal });
      } finally {
        pending = false;
      }
    };
    tick();
    const iv = setInterval(tick, 1500);
    return () => {
      stop = true;
      clearInterval(iv);
    };
  }, [triggerId, retry]);
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [detail?.log?.length]);
  const log = detail?.log || [];
  const statusText = detail?.enabled ? t(detail.type === 'cron' ? 'launcher.cron.scheduled' : 'launcher.trigger.polling') : t('launcher.trigger.disabled');
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent aria-describedby={undefined} className="flex h-[72dvh] w-[min(47.5rem,calc(100vw-1.5rem))] flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="flex-row items-center gap-2.5 border-b border-hair px-5 py-3 pe-12">
          <Zap className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <DialogTitle className="min-w-0 truncate text-sm">{detail?.name || t('launcher.trigger.defaultName')}</DialogTitle>
          <Badge status={detail?.enabled ? 'ok' : 'idle'}>{statusText}</Badge>
        </DialogHeader>
        <div className="grid max-h-[35dvh] shrink-0 grid-cols-1 gap-x-5 gap-y-1.5 overflow-y-auto border-b border-hair px-5 py-3 text-xs text-muted-foreground tabular-nums sm:grid-cols-2">
          {detail?.type === 'cron' ? <>
            <span>{t('launcher.cron.scheduleLabel')} {scheduleSummary(detail.schedule, t)}</span>
            <span>{t('launcher.cron.targetLabel')} {detail.sessionMode}</span>
            <span>{t('launcher.cron.metaLastRun')} {fmtAgo(detail.lastRun)}</span>
            <span>{t('launcher.cron.metaNextRun')} {detail.nextRunAt ? fmtDateTime(detail.nextRunAt) : '—'}</span>
            <span>{t('launcher.cron.runCount', { n: detail.runs?.length || 0 })}</span>
            {detail.runs?.map((run, i) => <span key={i} className="sm:col-span-2">
              {fmtDateTime(run.at)} · {run.state} {run.summary}
              {run.sessionId && <a className="underline underline-offset-2 hover:text-foreground" onClick={onClose} href={`#/session/${encodeURIComponent(run.sessionId)}`}> {run.sessionId}</a>}
            </span>)}
          </> : detail ? <>
          <span>{t('launcher.trigger.metaFilter')} <span className="text-foreground">{detail ? filterSummary(detail.filters) : '—'}</span></span>
          <span>{t('launcher.trigger.metaPoll')} <span className="text-foreground">{t('launcher.trigger.every60s')}</span></span>
          <span>{t('launcher.trigger.metaLastPoll')} <span className="text-foreground">{fmtAgo(detail?.lastPolledAt)}</span></span>
          <span>{t('launcher.trigger.metaSpawned')} <span className="text-foreground">{detail?.createdSessions?.length || 0}</span></span>
          <span>{t('launcher.trigger.metaSeen')} <span className="text-foreground">{t('launcher.trigger.ticketsSeen', { n: detail?.seen?.length || 0 })}</span></span>
          <span>{t('launcher.trigger.metaPrimed')} <span className="text-foreground">{detail?.primed ? t('launcher.common.yes') : t('launcher.common.no')}</span></span>
          </> : null}
          {detail?.lastError && (
            <span className="text-destructive sm:col-span-2">{t('launcher.trigger.metaLastError')} {detail.lastError}</span>
          )}
        </div>
        {loadError && <div role="alert" className="flex flex-wrap items-center gap-x-2 border-b border-hair px-5 py-2 text-xs text-destructive">
          {loadError.terminal ? t('launcher.cron.deleted') : loadError.message}
          {lastLoaded && <span> {t('launcher.cron.lastLoaded', { time: fmtDateTime(lastLoaded) })}</span>}
          {!loadError.terminal && <Button variant="outline" size="xs" onClick={() => setRetry((n) => n + 1)}>{t('launcher.picker.retry')}</Button>}
        </div>}
        <div className={cn(sectionLabel, 'border-b border-hair px-5 py-2')}>
          {t('launcher.trigger.activity')}
        </div>
        <pre
          ref={logRef}
          dir="ltr"
          className="thin-scroll min-h-0 flex-1 overflow-auto bg-term px-4 py-3 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap"
        >
          {detail == null ? (
            <span className="text-[#888]">{loadError ? loadError.message : t('launcher.trigger.loadingLog')}</span>
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
      </DialogContent>
    </Dialog>
  );
}

// Shown when enabling autonomous mode on a trigger — spells out the blast radius.
// An AlertDialog: it must be answered (Cancel / Enable), Esc cancels. Cancel is
// focused first, so a stray Enter cannot enable unattended runs.
function AutonomyWarningModal({ onConfirm, onCancel }) {
  const t = useT();
  const [dontShow, setDontShow] = useState(false);
  const dontId = useId();
  return (
    <AlertDialog open onOpenChange={(o) => !o && onCancel()}>
      <AlertDialogContent className="w-[min(28.75rem,calc(100vw-1.5rem))]">
        <AlertDialogHeader className="flex-row items-center gap-2 pe-0">
          <TriangleAlert className="size-4 shrink-0 text-[var(--hb-warn)]" aria-hidden="true" />
          <AlertDialogTitle>{t('launcher.autonomy.title')}</AlertDialogTitle>
        </AlertDialogHeader>
        <AlertDialogDescription asChild>
          <div className="text-sm leading-relaxed">
            {t('launcher.autonomy.intro')} <b>{t('launcher.autonomy.autonomousMode')}</b>:
            <ul className="mt-2 list-disc space-y-1 ps-5">
              <li>
                {t('launcher.autonomy.li1a')} <b>{t('launcher.autonomy.autoApproved')}</b>{t('launcher.autonomy.li1b')}
              </li>
              <li>
                {t('launcher.autonomy.li2a')} <b>{t('launcher.autonomy.wontStop')}</b>{t('launcher.autonomy.li2b')}
              </li>
              <li>{t('launcher.autonomy.li3')}</li>
            </ul>
            <div className="mt-3">
              {t('launcher.autonomy.warn')}
            </div>
          </div>
        </AlertDialogDescription>
        <label htmlFor={dontId} className="flex min-h-8 cursor-pointer items-center gap-2.5 text-xs text-muted-foreground coarse:min-h-11">
          <Checkbox id={dontId} checked={dontShow} onCheckedChange={(v) => setDontShow(!!v)} />
          {t('launcher.autonomy.dontShow')}
        </label>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('launcher.common.cancel')}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={() => onConfirm(dontShow)}>
            {t('launcher.autonomy.enable')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// last-run state → the Badge's status dot (colour only in the dot)
const CRON_RUN_STATUS = { started: 'idle', done: 'ok', blocked: 'warn', error: 'err', milestone: 'idle', held: 'warn' };

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
  const { triggers, sessions } = useStore();
  const cronJobs = triggers.filter((x) => x.type === 'cron');
  const [logId, setLogId] = useState(null);
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [scheduleKind, setScheduleKind] = useState('cron');
  const [scheduleValues, setScheduleValues] = useState({ cron: '0 9 * * *', interval: '30m', at: '' });
  const scheduleValue = scheduleValues[scheduleKind];
  const [sessionMode, setSessionMode] = useState('isolated');
  const [targetSessionId, setTargetSessionId] = useState('');
  const [deliverPush, setDeliverPush] = useState(true);
  const [deliverMaster, setDeliverMaster] = useState('');
  const [deliverWhatsapp, setDeliverWhatsapp] = useState('');
  const [autonomous, setAutonomous] = useState(false);
  const [engine, setEngine] = useState('');
  const [folderName, setFolderName] = useState('');
  const [warnOpen, setWarnOpen] = useState(false);
  const prefs = usePrefs();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const [operations, setOperations] = useState({});
  const inFlight = useRef(new Set());
  const operate = async (id, action) => {
    if (inFlight.current.has(id)) return;
    inFlight.current.add(id);
    setOperations((all) => ({ ...all, [id]: { pending: true } }));
    try {
      const result = await action();
      if (result?.ok === false) throw new Error(result.reason || 'Operation failed');
      setOperations((all) => ({ ...all, [id]: {} }));
    } catch (e) {
      setOperations((all) => ({ ...all, [id]: { error: String(e.message || e), retry: action } }));
    } finally {
      inFlight.current.delete(id);
    }
  };

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
        engine: engine || undefined,
        folderName: folderName || undefined,
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
    <div className="thin-scroll flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
      <div className={cn(paneCol, 'border-b border-hair px-4 pt-5 pb-5')}>
        <div className="mb-3 text-sm font-semibold">
          {t('launcher.cron.newJob')}
        </div>
        <div className="flex flex-col gap-2.5">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('launcher.cron.namePlaceholder')}
          aria-label={t('launcher.cron.namePlaceholder')}
        />
        <Textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder={t('launcher.cron.promptPlaceholder')}
          aria-label={t('launcher.cron.promptPlaceholder')}
          rows={2}
        />
        <div className="flex flex-wrap items-center gap-2">
          <NativeSelect
            value={scheduleKind}
            onChange={(e) => setScheduleKind(e.target.value)}
            aria-label={t('launcher.cron.scheduleLabel')}
          >
            <option value="cron">{t('launcher.cron.kindCron')}</option>
            <option value="interval">{t('launcher.cron.kindInterval')}</option>
            <option value="at">{t('launcher.cron.kindAt')}</option>
          </NativeSelect>
          <Input
            dir="ltr"
            value={scheduleValue}
            onChange={(e) => setScheduleValues({ ...scheduleValues, [scheduleKind]: e.target.value })}
            placeholder={
              scheduleKind === 'cron' ? '0 9 * * 1-5' : scheduleKind === 'interval' ? '30m' : '2026-09-01T09:00:00'
            }
            aria-label={t('launcher.cron.scheduleLabel')}
            className="min-w-40 flex-1 text-start font-mono"
          />
        </div>
        {(scheduleKind === 'cron' || scheduleKind === 'at') && (
          <div className={hintText}>
            {scheduleKind === 'cron' && t('launcher.cron.stepHelp')}
            {scheduleKind === 'at' && t('launcher.cron.atHelp')}
          </div>
        )}
        {sessionMode === 'isolated' && <FolderPicker value={folderName} onChange={setFolderName} />}
        {sessionMode === 'isolated' && <EngineToggle options={{ engine }} onChange={(o) => setEngine(o.engine || '')} />}
        <div className="flex flex-wrap items-center gap-2">
          <NativeSelect
            value={sessionMode}
            onChange={(e) => setSessionMode(e.target.value)}
          >
            <option value="isolated">{t('launcher.cron.modeIsolated')}</option>
            <option value="existing">{t('launcher.cron.modeExisting')}</option>
          </NativeSelect>
          {sessionMode === 'existing' && (
            <NativeSelect value={targetSessionId} onChange={(e) => setTargetSessionId(e.target.value)} wrapperClassName="min-w-0 flex-1" className="w-full">
              <option value="">{t('launcher.cron.selectTarget')}</option>
              {sessions.map((session) => <option key={session.id} value={session.id}>{session.title || session.id}</option>)}
            </NativeSelect>
          )}
        </div>
        <div className={cn(cardBox, 'flex flex-col gap-2.5 p-3')}>
          <span className={sectionLabel}>{t('launcher.cron.deliver')}</span>
          <label className="flex min-h-8 cursor-pointer items-center gap-2.5 text-sm coarse:min-h-11">
            <Checkbox checked={deliverPush} onCheckedChange={(v) => setDeliverPush(!!v)} />
            {t('launcher.cron.deliverPush')}
          </label>
          <Input
            value={deliverMaster}
            onChange={(e) => setDeliverMaster(e.target.value)}
            placeholder={t('launcher.cron.deliverMasterPlaceholder')}
            aria-label={t('launcher.cron.deliverMasterPlaceholder')}
            dir="ltr"
            className="text-start font-mono"
          />
          <Hint label={t('launcher.cron.deliverWhatsappTip')}>
            <Input
              value={deliverWhatsapp}
              onChange={(e) => setDeliverWhatsapp(e.target.value)}
              placeholder={t('launcher.cron.deliverWhatsappPlaceholder')}
              aria-label={t('launcher.cron.deliverWhatsappPlaceholder')}
              dir="ltr"
              className="text-start font-mono"
            />
          </Hint>
        </div>
        <AutonomousCheck checked={autonomous} onChange={onToggleAutonomous} />
        {error && <div className={errText}>{error}</div>}
        <div className="flex justify-end">
          <Button
            variant="primary"
            disabled={busy || !prompt.trim() || !scheduleValue.trim() || (sessionMode === 'existing' && !targetSessionId.trim())}
            onClick={create}
          >
            {busy ? t('launcher.plan.creating') : t('launcher.cron.createJob')}
          </Button>
        </div>
        </div>
      </div>
      <div className={cn(paneCol, 'px-4 py-5')}>
        <div className={cn(sectionLabel, 'mb-3')}>
          {t('launcher.cron.listHeading', { n: cronJobs.length })}
        </div>
        {cronJobs.length === 0 && <div className="py-4 text-sm text-muted-foreground">{t('launcher.cron.emptyList')}</div>}
        {cronJobs.map((cj) => {
          const lastRunState = cj.runs?.length ? cj.runs[cj.runs.length - 1].state : null;
          const op = operations[cj.id];
          return (
            <div key={cj.id} className={cn(cardBox, 'mb-2.5 flex flex-col gap-2 p-3.5')}>
              {cj.lastError && <div role="alert" className={errText}>{cj.lastError} {cj.schedule.kind === 'at' && !cj.enabled && t('launcher.cron.repairRetry')}</div>}
              {cj.sessionMode.startsWith('existing:') && <NativeSelect
                aria-label={t('launcher.cron.targetLabel')}
                value={cj.sessionMode.slice('existing:'.length)}
                disabled={op?.pending}
                onChange={(e) => { const sessionMode = `existing:${e.target.value}`; operate(cj.id, () => api.patch(`/triggers/${cj.id}`, { sessionMode })); }}
                wrapperClassName="w-full" className="w-full"
              >
                {!sessions.some((session) => cj.sessionMode === `existing:${session.id}`) && <option value={cj.sessionMode.slice('existing:'.length)}>{t('launcher.cron.missingTarget')}</option>}
                {sessions.map((session) => <option key={session.id} value={session.id}>{session.title || session.id}</option>)}
              </NativeSelect>}
              {op?.pending && <div role="status" className="text-xs text-muted-foreground">{t('launcher.cron.pending')}</div>}
              {op?.error && <div role="alert" className="flex flex-wrap items-center gap-2 text-xs text-destructive">
                {op.error} <Button variant="outline" size="xs" onClick={() => operate(cj.id, op.retry)}>{t('launcher.picker.retry')}</Button>
              </div>}
              <div className="flex items-center gap-2.5">
                <Hint label={cj.enabled ? t('launcher.trigger.enabledTitle') : t('launcher.trigger.disabledTitle')}>
                  <span className="inline-flex"><StatusDot status={cj.enabled ? 'ok' : 'idle'} className="size-2" /></span>
                </Hint>
                {cj.autonomous && (
                  <Hint label={t('launcher.trigger.autonomousBadgeTip')}>
                    <span className="inline-flex shrink-0 cursor-help text-[var(--hb-warn)]">
                      <TriangleAlert className="size-4" aria-hidden="true" />
                    </span>
                  </Hint>
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{cj.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">{scheduleSummary(cj.schedule, t)}</span>
                </span>
                {lastRunState && (
                  <Badge status={CRON_RUN_STATUS[lastRunState] || 'idle'}>{lastRunState}</Badge>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground tabular-nums">
                <span>{t('launcher.cron.metaLastRun')} {fmtAgo(cj.lastRun)}</span>
                <span aria-hidden="true">·</span>
                <span>{t('launcher.cron.metaNextRun')} {cj.nextRunAt ? fmtDateTime(cj.nextRunAt) : '—'}</span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Hint label={t('launcher.cron.runNowTitle')}>
                  <Button variant="outline" size="sm" disabled={op?.pending} onClick={() => operate(cj.id, () => api.post(`/triggers/${cj.id}/run`))}>
                    {t('launcher.cron.runNow')}
                  </Button>
                </Hint>
                <Hint label={t('launcher.trigger.openLog')}>
                  <Button variant="ghost" size="sm" onClick={() => setLogId(cj.id)}>
                    <Zap /> {t('launcher.trigger.logs')}
                  </Button>
                </Hint>
                <OnOffSwitch
                  enabled={!!cj.enabled}
                  disabled={op?.pending}
                  onToggle={() => operate(cj.id, () => api.patch(`/triggers/${cj.id}`, { enabled: !cj.enabled }))}
                />
                <Hint label={t('launcher.trigger.deleteTitle')}>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t('launcher.trigger.deleteTitle')}
                    disabled={op?.pending}
                    onClick={() => operate(cj.id, () => api.del(`/triggers/${cj.id}`))}
                    className="ms-auto hover:text-destructive"
                  >
                    <X />
                  </Button>
                </Hint>
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

// The "autonomous (unattended)" checkbox shared by the cron and Linear-trigger
// forms. Turning it on is gated behind the warning dialog by the caller.
function AutonomousCheck({ checked, onChange }) {
  const t = useT();
  const id = useId();
  return (
    <label htmlFor={id} className="flex cursor-pointer items-start gap-2.5 text-sm">
      <Checkbox id={id} checked={checked} onCheckedChange={(v) => onChange(!!v)} className="mt-0.5" />
      <span className={checked ? 'text-destructive' : 'text-muted-foreground'}>
        {checked && (
          <Hint label={t('launcher.trigger.autonomousTip')}>
            <span className="me-1.5 inline-flex cursor-help align-text-bottom">
              <TriangleAlert className="size-4" aria-hidden="true" />
            </span>
          </Hint>
        )}
        {t('launcher.trigger.autonomousLabel')}
      </span>
    </label>
  );
}

// Enable/disable a standing trigger: a switch plus its On/Off word. The title
// names the ACTION ("Disable (stop polling)" / "Enable").
function OnOffSwitch({ enabled, disabled, onToggle }) {
  const t = useT();
  const id = useId();
  const action = enabled ? t('launcher.trigger.disableAction') : t('launcher.trigger.enableAction');
  return (
    <Hint label={action}>
      <label htmlFor={id} className={cn('inline-flex min-h-7 cursor-pointer items-center gap-2 px-1 text-xs text-muted-foreground coarse:min-h-11', disabled && 'cursor-not-allowed opacity-50')}>
        <Switch id={id} aria-label={action} checked={enabled} disabled={disabled} onCheckedChange={onToggle} />
        {enabled ? t('launcher.trigger.on') : t('launcher.trigger.off')}
      </label>
    </Hint>
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
    <div className="flex shrink-0 border-b border-hair px-4 py-2.5">
      <Tabs value={subMode} onValueChange={onChange}>
        <TabsList variant="segmented" aria-label={t('launcher.header.fromTrigger')}>
          {[
            ['linear', 'launcher.cron.subTabLinear'],
            ['cron', 'launcher.cron.subTabCron'],
          ].map(([mode, key]) => (
            <TabsTrigger key={mode} value={mode} className="coarse:h-10">
              {t(key)}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
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
        folderName: options.folderName || undefined,
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
      <div className="thin-scroll min-h-0 flex-1 overflow-y-auto">
      <div className={cn(paneCol, 'border-b border-hair px-4 pt-5 pb-5')}>
        <div className="mb-3 text-sm font-semibold">
          {t('launcher.trigger.newTrigger')}
        </div>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('launcher.trigger.namePlaceholder')}
          aria-label={t('launcher.trigger.namePlaceholder')}
          className="mb-3"
        />
        {showConnect && <div className="-mx-4"><ConnectLinear onConnected={() => setReloadKey((k) => k + 1)} /></div>}
        <div className="-mx-4">
          <FilterBar
            filters={filters}
            onChange={setFilters}
            labels={labels}
            statuses={statuses}
            disabled={showConnect}
            showSearch={false}
            showHideOpen={false}
          />
        </div>

        <EngineToggle options={options} onChange={setOptions} className="pb-3" />
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
        <Textarea
          value={injectPrompt}
          onChange={(e) => setInjectPrompt(e.target.value)}
          placeholder={t('launcher.trigger.injectPlaceholder')}
          aria-label={t('launcher.trigger.injectPlaceholder')}
          rows={2}
          className="mb-3"
        />

        {/* autonomous (unattended) mode — gated behind the warning dialog */}
        <AutonomousCheck checked={autonomous} onChange={onToggleAutonomous} />

        {error && <div className={cn(errText, 'mt-2')}>{error}</div>}
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
          <span className={cn(hintText, 'min-w-0 flex-1 basis-56')}>
            {t('launcher.trigger.firesBefore')} <em>{t('launcher.trigger.after')}</em> {t('launcher.trigger.firesAfter')}
          </span>
          <Button variant="primary" className="ms-auto" disabled={busy || showConnect} onClick={create}>
            {busy ? t('launcher.plan.creating') : t('launcher.trigger.createTrigger')}
          </Button>
        </div>
      </div>
      <div className={cn(paneCol, 'px-4 py-5')}>
        <div className={cn(sectionLabel, 'mb-3')}>
          {t('launcher.trigger.listHeading', { n: triggers.length })}
        </div>
        {triggers.length === 0 && (
          <div className="py-4 text-sm text-muted-foreground">
            {t('launcher.trigger.emptyList')}
          </div>
        )}
        {triggers.map((trg) => (
          <div
            key={trg.id}
            className={cn(cardBox, 'mb-2.5 flex flex-wrap items-center gap-x-3 gap-y-2 p-3.5')}
          >
            <Hint label={trg.enabled ? t('launcher.trigger.enabledTitle') : t('launcher.trigger.disabledTitle')}>
              <span className="inline-flex"><StatusDot status={trg.enabled ? 'ok' : 'idle'} className="size-2" /></span>
            </Hint>
            {trg.autonomous && (
              <Hint label={t('launcher.trigger.autonomousBadgeTip')}>
                <span className="inline-flex shrink-0 cursor-help text-[var(--hb-warn)]">
                  <TriangleAlert className="size-4" aria-hidden="true" />
                </span>
              </Hint>
            )}
            <span className="min-w-0 flex-1 basis-40">
              <span className="block truncate text-sm font-medium">{trg.name}</span>
              <span className="block truncate text-xs text-muted-foreground">
                {filterSummary(trg.filters)}
                {trg.lastError ? <> · <TriangleAlert className="inline size-3.5 align-text-bottom" aria-hidden="true" /> {trg.lastError}</> : ''}
              </span>
            </span>
            <Hint label={t('launcher.trigger.spawnedTitle')}>
              <span className="inline-flex shrink-0 items-center text-xs text-muted-foreground tabular-nums">
                {trg.createdSessions?.length || 0}<ArrowUp className="size-3" aria-hidden="true" />
              </span>
            </Hint>
            <Hint label={t('launcher.trigger.openLog')}>
              <Button variant="ghost" size="sm" onClick={() => setLogId(trg.id)}>
                <Zap /> {t('launcher.trigger.logs')}
              </Button>
            </Hint>
            <OnOffSwitch
              enabled={!!trg.enabled}
              onToggle={() => api.patch(`/triggers/${trg.id}`, { enabled: !trg.enabled }).catch(() => {})}
            />
            <Hint label={t('launcher.trigger.deleteTitle')}>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t('launcher.trigger.deleteTitle')}
                onClick={() => api.del(`/triggers/${trg.id}`).catch(() => {})}
                className="hover:text-destructive"
              >
                <X />
              </Button>
            </Hint>
          </div>
        ))}
      </div>
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
  // Extension-contributed modes (manifest `openFrom: ["launcher"]`). The core
  // launcher deliberately knows nothing about what they are for — a PR review,
  // a Jira issue, an on-call page — only that an extension claimed a mode and
  // holds the permission to finish the job.
  const { extensions } = useStore();
  const extModes = useMemo(() => extLauncherItems(extensions), [extensions]);
  const extMode = extModes.find((x) => x.mode === mode) || null;
  // Engine / model / effort for a session started from an extension's tab: the human's
  // call, made in the panel beside the tab (like the ticket tab's). Seeded from the extension's
  // own settings (or their schema defaults) when its mode opens, then editable per launch.
  const [extOptions, setExtOptions] = useState(() => defaultSessionOptions(prefs, 'ext'));
  const extOptionsRef = useRef(extOptions);
  extOptionsRef.current = extOptions;
  const extKey = extMode?.ext || '';
  useEffect(() => {
    if (!extKey) return;
    const rec = findExtension(extensions, extKey);
    const saved = rec?.settings || {};
    const schema = rec?.settingsSchema || {};
    const base = defaultSessionOptions(prefs, 'ext');
    const pick = (k) => saved[k] || schema[k]?.default || base[k] || '';
    setExtOptions({ ...base, engine: pick('engine'), model: pick('model'), effort: pick('effort'), folderName: pick('folderName') });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [extKey]);
  // An extension that was disabled or uninstalled while its mode was open must
  // not leave the launcher on a blank body. Same treatment `linear` gets.
  useEffect(() => {
    if (mode.startsWith('ext:') && !extMode) setModeRaw('empty');
  }, [mode, extMode]);
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
        folderName: sessionOpts.folderName || undefined,
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
      <Dialog open={gated} onOpenChange={(o) => !o && setGated(false)}>
        <DialogContent aria-describedby={undefined} showClose={false} className="w-[min(26.25rem,calc(100vw-1.5rem))]">
          <DialogHeader className="pe-0">
            <DialogTitle>{t('launcher.gate.title')}</DialogTitle>
            <DialogDescription>{t('launcher.gate.body')}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Button variant="primary" size="lg" disabled={busy} onClick={startChatOnboarding}>
              {busy ? t('launcher.gate.starting') : t('launcher.gate.setupChat')}
            </Button>
            <Button variant="outline" size="lg" onClick={() => { setGated(false); onNeedsSetup?.(); }}>
              {t('launcher.gate.openSetup')}
            </Button>
            <Button variant="ghost" onClick={() => setGated(false)} className="text-muted-foreground">
              {t('launcher.common.cancel')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      {/* header */}
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-hair px-4 py-2 md:min-h-12 md:flex-nowrap md:py-0">
        <Wave />
        <span className="text-sm font-semibold">{t('launcher.header.title')}</span>
        <Tabs value={mode} onValueChange={setMode} className="min-w-0 max-md:order-last max-md:w-full md:ms-3">
          <TabsList variant="segmented" aria-label={t('launcher.header.title')} className="max-w-full overflow-x-auto">
            {linear && (
              <TabsTrigger value="ticket" className="coarse:h-10">{t('launcher.header.fromTicket')}</TabsTrigger>
            )}
            <TabsTrigger value="empty" className="coarse:h-10">{t('launcher.header.emptySession')}</TabsTrigger>
            <TabsTrigger value="trigger" className="coarse:h-10">{t('launcher.header.fromTrigger')}</TabsTrigger>
            {extModes.map((x) => (
              <Hint key={x.mode} label={x.ext}>
                <TabsTrigger value={x.mode} className="coarse:h-10">{x.title}</TabsTrigger>
              </Hint>
            ))}
          </TabsList>
        </Tabs>
        {onClose && (
          <Hint label={t('launcher.header.closeTitle')}>
            <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label={t('launcher.header.closeTitle')} className="ms-auto">
              <X />
            </Button>
          </Hint>
        )}
      </div>

      <div className="flex min-h-0 flex-1 flex-col max-md:overflow-y-auto md:flex-row">
        {extMode ? (
          <>
            <ExtLauncherPane item={extMode} onCreated={onCreated} getSessionOptions={() => extOptionsRef.current} />
            <div className="shrink-0 border-t border-hair bg-panel p-4 md:w-72 md:border-t-0 md:border-s">
              <div className={cn(sectionLabel, 'mb-3')}>
                {t('launcher.ext.sessionOptions')}
              </div>
              <EngineToggle options={extOptions} onChange={setExtOptions} className="pb-3" />
              <SessionOptionsPicker options={extOptions} onChange={setExtOptions} hideSkill />
            </div>
          </>
        ) : mode === 'ticket' ? (
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
