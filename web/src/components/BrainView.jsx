// Brain view (M4.1) — a thin, read/edit layer over what M1–M3 already built:
// memory.ts's search/capped-docs/journal/episodes/log/pending (M1), the cron
// trigger list (M2, reused via Launcher.jsx's exported CronSubPanel — not
// duplicated), and the skill-proposals queue (M3, reused via SkillsView.jsx's
// exported ProposalsPane). "Ask the brain" (M4.2) finds-or-creates the singleton
// brain session and jumps to it as an ordinary session — no embedded chat
// engine here, SessionView already owns that.
import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { toastError, toastSuccess } from '../lib/toast.js';
import { useT } from '../lib/i18n.js';
import { useIsDesktop } from '../lib/useMedia.js';
import { Icon } from '../lib/icons.js';
import {
  faBrain,
  faCheck,
  faMagnifyingGlass,
  faPen,
  faPlus,
  faRotateLeft,
  faTrashCan,
  faXmark,
} from '@fortawesome/free-solid-svg-icons';
import { CronSubPanel } from './Launcher.jsx';
import { ProposalsPane } from './SkillsView.jsx';
import { fmtDateTime } from '../lib/time.js';
import { Button } from './ui/button.jsx';
import { Input } from './ui/input.jsx';
import { Tip } from './ui/tooltip.jsx';
import { Tabs, TabsList, TabsTrigger } from './ui/tabs.jsx';

function bulletLines(content) {
  return (content || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.replace(/^[-*]\s*/, ''));
}

function fmtDate(iso) {
  if (!iso) return '';
  try {
    return fmtDateTime(iso);
  } catch {
    return iso;
  }
}

/* ---------- USER.md / MEMORY.md — inline bullet editor --------------------- */

function CappedDoc({ target, path, onChanged }) {
  const t = useT();
  const [content, setContent] = useState(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState('');
  const [editingIdx, setEditingIdx] = useState(null);
  const [editText, setEditText] = useState('');

  const load = () =>
    api
      .get(`/memory/get?path=${encodeURIComponent(path)}`)
      .then((r) => setContent(r.content || ''))
      .catch(() => setContent(''));
  useEffect(() => { load(); }, [path]);

  const write = async (body) => {
    setBusy(true);
    try {
      await api.post('/memory/write', { target, source: 'ui', ...body });
      await load();
      onChanged?.();
    } catch (e) {
      toastError(String(e.message || e).replace(/^HTTP \d+ — /, ''));
    } finally {
      setBusy(false);
    }
  };

  if (content === null) return <div className="text-xs text-fgdim">{t('dialogs.loading')}</div>;
  const items = bulletLines(content);

  return (
    <div className="rounded-lg border border-hair p-3">
      <div className="mb-2 flex items-center gap-2">
        <span className="font-mono text-xs font-medium text-fg" dir="ltr">{path}</span>
        <span className="text-xs text-fgdim">{t('brain.lineCount', { n: items.length })}</span>
      </div>
      <div className="flex flex-col gap-1">
        {items.map((line, i) =>
          editingIdx === i ? (
            <div key={i} className="flex items-center gap-1.5">
              <Input
                autoFocus
                value={editText}
                onChange={(e) => setEditText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && editText.trim())
                    write({ action: 'replace', old_text: line, content: editText.trim() }).then(() => setEditingIdx(null));
                  if (e.key === 'Escape') setEditingIdx(null);
                }}
                className="flex-1"
              />
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t('dialogs.save')}
                disabled={busy || !editText.trim()}
                onClick={() => write({ action: 'replace', old_text: line, content: editText.trim() }).then(() => setEditingIdx(null))}
              >
                <Icon icon={faCheck} />
              </Button>
              <Button variant="ghost" size="icon-sm" aria-label={t('dialogs.cancel')} onClick={() => setEditingIdx(null)}>
                <Icon icon={faXmark} />
              </Button>
            </div>
          ) : (
            <div key={i} className="flex items-start gap-1.5">
              <span className="min-w-0 flex-1 text-sm leading-snug text-fg">{line}</span>
              <Tip label={t('dialogs.edit')}>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={t('dialogs.edit')}
                  onClick={() => {
                    setEditingIdx(i);
                    setEditText(line);
                  }}
                >
                  <Icon icon={faPen} />
                </Button>
              </Tip>
              <Tip label={t('dialogs.delete')}>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={t('dialogs.delete')}
                  disabled={busy}
                  onClick={() => write({ action: 'remove', old_text: line })}
                  className="hover:text-danger"
                >
                  <Icon icon={faTrashCan} />
                </Button>
              </Tip>
            </div>
          )
        )}
        {!items.length && <div className="text-xs text-fgdim">{t('brain.docEmpty')}</div>}
      </div>
      <div className="mt-2 flex items-center gap-1.5">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && draft.trim()) write({ action: 'add', content: draft.trim() }).then(() => setDraft(''));
          }}
          placeholder={t('brain.addLinePlaceholder')}
            aria-label={t('brain.addLinePlaceholder')}
          className="flex-1"
        />
        <Button
          size="icon"
          aria-label={t('brain.addLinePlaceholder')}
          disabled={busy || !draft.trim()}
          onClick={() => write({ action: 'add', content: draft.trim() }).then(() => setDraft(''))}
        >
          <Icon icon={faPlus} />
        </Button>
      </div>
    </div>
  );
}

/* ---------- search -------------------------------------------------------- */

function SearchPane() {
  const t = useT();
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState(null);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    if (!query.trim()) return;
    setBusy(true);
    try {
      setHits(await api.get(`/memory/search?query=${encodeURIComponent(query.trim())}`).then((r) => r.hits));
    } catch (e) {
      toastError(String(e.message || e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-lg border border-hair p-3">
      <div className="mb-2 flex items-center gap-1.5">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && run()}
          placeholder={t('brain.searchPlaceholder')}
            aria-label={t('brain.searchPlaceholder')}
          className="flex-1"
        />
        <Button size="icon" aria-label={t('brain.searchPlaceholder')} disabled={busy || !query.trim()} onClick={run}>
          <Icon icon={faMagnifyingGlass} />
        </Button>
      </div>
      {hits && (
        <div className="flex flex-col gap-1.5">
          {hits.length === 0 && <div className="text-xs text-fgdim">{t('brain.noHits')}</div>}
          {hits.map((h, i) => (
            <div key={i} className="rounded-md border border-hair p-2">
              <div className="mb-0.5 flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs font-medium text-fg" dir="ltr">{h.path}</span>
                <span className="text-xs text-fgdim">{h.scope}</span>
                <span className="ms-auto text-xs text-fgdim">{fmtDate(h.updatedAt)}</span>
              </div>
              <div className="text-xs leading-snug text-fgdim">{h.snippet}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------- journal / episodes: list + read-a-file ------------------------ */

function FileListPane({ scope, title, emptyLabel, addable, onAdd }) {
  const t = useT();
  const [files, setFiles] = useState(null);
  const [selected, setSelected] = useState(null);
  const [content, setContent] = useState('');
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);

  const load = () =>
    api
      .get('/memory')
      .then((r) => {
        const list = (r.files || []).filter((f) => f.scope === scope).sort((a, b) => (b.path > a.path ? 1 : -1));
        setFiles(list);
        setSelected((cur) => (cur && list.some((f) => f.path === cur) ? cur : list[0]?.path || null));
      })
      .catch(() => setFiles([]));
  useEffect(() => { load(); }, [scope]);

  useEffect(() => {
    if (!selected) {
      setContent('');
      return;
    }
    api
      .get(`/memory/get?path=${encodeURIComponent(selected)}`)
      .then((r) => setContent(r.content || ''))
      .catch(() => setContent(''));
  }, [selected]);

  const submitAdd = async () => {
    if (!draft.trim()) return;
    setBusy(true);
    try {
      await onAdd(draft.trim());
      setDraft('');
      await load();
    } catch (e) {
      toastError(String(e.message || e));
    } finally {
      setBusy(false);
    }
  };

  if (files === null) return <div className="text-xs text-fgdim">{t('dialogs.loading')}</div>;

  return (
    <div className="rounded-lg border border-hair p-3">
      <div className="mb-2 text-xs font-medium text-fgdim">{title} · {files.length}</div>
      {addable && (
        <div className="mb-2 flex items-center gap-1.5">
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submitAdd()}
            placeholder={t('brain.journalPlaceholder')}
            aria-label={t('brain.journalPlaceholder')}
            className="flex-1"
          />
          <Button size="icon" aria-label={t('brain.journalPlaceholder')} disabled={busy || !draft.trim()} onClick={submitAdd}>
            <Icon icon={faPlus} />
          </Button>
        </div>
      )}
      {files.length === 0 ? (
        <div className="text-xs text-fgdim">{emptyLabel}</div>
      ) : (
        <div className="flex gap-3">
          <div className="flex max-h-[220px] w-[180px] shrink-0 flex-col gap-0.5 overflow-y-auto thin-scroll">
            {files.map((f) => (
              <button
                key={f.path}
                type="button"
                onClick={() => setSelected(f.path)}
                className={`truncate rounded-md px-2 py-1 text-start font-mono text-xs ${
                  selected === f.path ? 'bg-muted text-fg' : 'text-fgdim hover:bg-muted'
                }`}
              >
                {f.path.split('/').pop()}
              </button>
            ))}
          </div>
          <pre className="thin-scroll min-w-0 flex-1 overflow-auto whitespace-pre-wrap break-words rounded-md border border-hair bg-bg p-2 text-xs leading-relaxed text-fg">
            {content}
          </pre>
        </div>
      )}
    </div>
  );
}

/* ---------- change log + undo ---------------------------------------------- */

function LogPane({ onChanged }) {
  const t = useT();
  const [log, setLog] = useState(null);
  const [busy, setBusy] = useState(null);

  const load = () => api.get('/memory/log?limit=50').then(setLog).catch(() => setLog([]));
  useEffect(() => { load(); }, []);

  const undo = async (seq) => {
    setBusy(seq);
    try {
      await api.post(`/memory/log/${seq}/undo`);
      toastSuccess(t('brain.undone'));
      await load();
      onChanged?.();
    } catch (e) {
      toastError(String(e.message || e).replace(/^HTTP \d+ — /, ''));
    } finally {
      setBusy(null);
    }
  };

  if (log === null) return <div className="text-xs text-fgdim">{t('dialogs.loading')}</div>;

  return (
    <div className="rounded-lg border border-hair p-3">
      <div className="mb-2 text-xs font-medium text-fgdim">{t('brain.changeLog')}</div>
      {log.length === 0 && <div className="text-xs text-fgdim">{t('brain.logEmpty')}</div>}
      <div className="flex flex-col gap-1">
        {log.map((e) => (
          <div key={e.seq} className="flex items-center gap-2 rounded-md border border-hair px-2 py-1.5">
            <span className="shrink-0 font-mono text-xs text-fgdim">#{e.seq}</span>
            <span className="shrink-0 rounded-sm bg-muted px-1.5 text-2xs font-medium text-fgdim">{e.action}</span>
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg" dir="ltr">{e.path}</span>
            <span className="shrink-0 text-xs text-fgdim">{e.source}</span>
            <span className="shrink-0 text-xs text-fgdim">{fmtDate(e.ts)}</span>
            {e.action !== 'undo' && (
              <Tip label={t('brain.undo')}>
                <Button variant="ghost" size="icon-xs" aria-label={t('brain.undo')} disabled={busy === e.seq} onClick={() => undo(e.seq)}>
                  <Icon icon={faRotateLeft} />
                </Button>
              </Tip>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---------- pending facts: LEARN1 — the raw approve/reject list moved to
   Settings › General › Memory (the manual-mode block of autonomous learning). The
   header keeps a pending-count link there instead of a tab. ------------------ */

/* ---------- memory tab: composes everything above --------------------------- */

function MemoryTab({ onChanged }) {
  const t = useT();
  return (
    <div className="mx-auto flex max-w-[720px] flex-col gap-3">
      <CappedDoc target="user" path="USER.md" onChanged={onChanged} />
      <CappedDoc target="memory" path="MEMORY.md" onChanged={onChanged} />
      <SearchPane />
      <FileListPane
        scope="journal"
        title={t('brain.journal')}
        emptyLabel={t('brain.journalEmpty')}
        addable
        onAdd={(text) => api.post('/memory/write', { target: 'journal', action: 'add', content: text, source: 'ui' })}
      />
      <FileListPane scope="episode" title={t('brain.episodes')} emptyLabel={t('brain.episodesEmpty')} />
      <LogPane onChanged={onChanged} />
    </div>
  );
}

/* ---------- the view --------------------------------------------------------- */

export default function BrainView({ onClose }) {
  const t = useT();
  const desktop = useIsDesktop();
  const [mode, setMode] = useState('memory'); // 'memory' | 'cron' | 'proposals'
  const [pendingCount, setPendingCount] = useState(0);
  const [askBusy, setAskBusy] = useState(false);

  const refreshPendingCount = () => {
    api
      .get('/memory/pending')
      .then((list) => setPendingCount((list || []).length))
      .catch(() => {});
  };
  useEffect(() => { refreshPendingCount(); }, [mode]);

  const askBrain = async () => {
    setAskBusy(true);
    try {
      const { id } = await api.post('/brain/session');
      window.dispatchEvent(new CustomEvent('host:select-session', { detail: { id } }));
      onClose?.();
    } catch (e) {
      toastError(String(e.message || e).replace(/^HTTP \d+ — /, ''));
    } finally {
      setAskBusy(false);
    }
  };

  const TABS = ['memory', 'cron', 'proposals'];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-hair bg-panel px-4 py-2.5">
        <span className="flex items-center gap-1.5 text-sm font-semibold text-fg">
          <Icon icon={faBrain} /> {t('brain.title')}
        </span>
        <Tabs value={mode} onValueChange={setMode} className="ms-2">
          <TabsList variant="segmented">
            {TABS.map((mItem) => (
              <TabsTrigger key={mItem} value={mItem}>
                {t(`brain.tab.${mItem}`)}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <a href="#/settings/appearance/memory" data-brain-pending-link className="ms-auto shrink-0 text-xs text-fgdim underline hover:text-fg">
          {pendingCount > 0 ? t('brain.pendingLink', { n: pendingCount }) : t('brain.pendingLink.none')}
        </a>
        <a href="#/settings/automation/heartbeat" className="shrink-0 text-xs text-fgdim underline hover:text-fg">{t('brain.heartbeatSettings')}</a>
        <Button variant="primary" onClick={askBrain} disabled={askBusy}>
          {askBusy ? t('brain.asking') : t('brain.askBrain')}
        </Button>
        <Tip label={t('dialogs.close')}>
          <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label={t('dialogs.close')}>
            <Icon icon={faXmark} />
          </Button>
        </Tip>
      </div>

      {mode === 'memory' && (
        <div className="thin-scroll min-h-0 flex-1 overflow-y-auto p-4">
          <MemoryTab onChanged={refreshPendingCount} />
        </div>
      )}
      {mode === 'cron' && <CronSubPanel />}
      {mode === 'proposals' && <ProposalsPane desktop={desktop} />}
    </div>
  );
}
