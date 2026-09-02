// Brain view (M4.1) — a thin, read/edit layer over what M1–M3 already built:
// memory.ts's search/capped-docs/journal/episodes/log/pending (M1), the cron
// trigger list (M2, reused via Launcher.jsx's exported CronSubPanel — not
// duplicated), and the skill-proposals queue (M3, reused via SkillsView.jsx's
// exported ProposalsPane). "שאל את המוח" (M4.2) finds-or-creates the singleton
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

  if (content === null) return <div className="text-[11px] text-fgdim">{t('dialogs.loading')}</div>;
  const items = bulletLines(content);

  return (
    <div className="rounded-[10px] border border-hair p-3">
      <div className="mb-2 flex items-center gap-2">
        <span className="font-mono text-[11.5px] font-bold text-fg">{path}</span>
        <span className="text-[10px] text-fgdim">{t('brain.lineCount', { n: items.length })}</span>
      </div>
      <div className="flex flex-col gap-1">
        {items.map((line, i) =>
          editingIdx === i ? (
            <div key={i} className="flex items-center gap-1.5">
              <input
                autoFocus
                value={editText}
                onChange={(e) => setEditText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && editText.trim())
                    write({ action: 'replace', old_text: line, content: editText.trim() }).then(() => setEditingIdx(null));
                  if (e.key === 'Escape') setEditingIdx(null);
                }}
                className="min-w-0 flex-1 rounded-[6px] border border-ink bg-bg px-2 py-1 text-[11.5px] outline-none"
              />
              <button
                type="button"
                disabled={busy || !editText.trim()}
                onClick={() => write({ action: 'replace', old_text: line, content: editText.trim() }).then(() => setEditingIdx(null))}
                className="shrink-0 cursor-pointer text-[11px] text-fgdim hover:text-fg disabled:opacity-40"
              >
                <Icon icon={faCheck} />
              </button>
              <button type="button" onClick={() => setEditingIdx(null)} className="shrink-0 cursor-pointer text-[11px] text-fgdim hover:text-fg">
                <Icon icon={faXmark} />
              </button>
            </div>
          ) : (
            <div key={i} className="flex items-start gap-1.5">
              <span className="min-w-0 flex-1 text-[11.5px] leading-snug text-fg">{line}</span>
              <button
                type="button"
                onClick={() => {
                  setEditingIdx(i);
                  setEditText(line);
                }}
                title={t('dialogs.edit')}
                className="shrink-0 cursor-pointer text-[10px] text-fgdim hover:text-fg"
              >
                <Icon icon={faPen} />
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => write({ action: 'remove', old_text: line })}
                title={t('dialogs.delete')}
                className="shrink-0 cursor-pointer text-[10px] text-fgdim hover:text-danger disabled:opacity-40"
              >
                <Icon icon={faTrashCan} />
              </button>
            </div>
          )
        )}
        {!items.length && <div className="text-[11px] text-fgdim">{t('brain.docEmpty')}</div>}
      </div>
      <div className="mt-2 flex items-center gap-1.5">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && draft.trim()) write({ action: 'add', content: draft.trim() }).then(() => setDraft(''));
          }}
          placeholder={t('brain.addLinePlaceholder')}
          className="min-w-0 flex-1 rounded-[7px] border border-border bg-panel px-2 py-1 text-[11.5px] outline-none placeholder:text-fgdim focus:border-ink"
        />
        <button
          type="button"
          disabled={busy || !draft.trim()}
          onClick={() => write({ action: 'add', content: draft.trim() }).then(() => setDraft(''))}
          className="shrink-0 cursor-pointer rounded-[7px] border border-ink bg-panel px-2 py-1 text-[10.5px] font-bold text-fg hover:bg-chip disabled:opacity-40"
        >
          <Icon icon={faPlus} />
        </button>
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
    <div className="rounded-[10px] border border-hair p-3">
      <div className="mb-2 flex items-center gap-1.5">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && run()}
          placeholder={t('brain.searchPlaceholder')}
          className="min-w-0 flex-1 rounded-[7px] border border-border bg-panel px-2 py-1.5 text-[11.5px] outline-none placeholder:text-fgdim focus:border-ink"
        />
        <button
          type="button"
          disabled={busy || !query.trim()}
          onClick={run}
          className="shrink-0 cursor-pointer rounded-[7px] border-[1.5px] border-ink bg-panel px-2.5 py-1.5 text-[11px] font-bold text-fg hover:bg-chip disabled:opacity-40"
        >
          <Icon icon={faMagnifyingGlass} />
        </button>
      </div>
      {hits && (
        <div className="flex flex-col gap-1.5">
          {hits.length === 0 && <div className="text-[11px] text-fgdim">{t('brain.noHits')}</div>}
          {hits.map((h, i) => (
            <div key={i} className="rounded-[8px] border border-hair p-2">
              <div className="mb-0.5 flex items-center gap-2">
                <span className="font-mono text-[10.5px] font-bold text-fg">{h.path}</span>
                <span className="text-[9.5px] text-fgdim">{h.scope}</span>
                <span className="ml-auto text-[9.5px] text-fgdim">{fmtDate(h.updatedAt)}</span>
              </div>
              <div className="text-[11px] leading-snug text-fgdim">{h.snippet}</div>
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

  if (files === null) return <div className="text-[11px] text-fgdim">{t('dialogs.loading')}</div>;

  return (
    <div className="rounded-[10px] border border-hair p-3">
      <div className="mb-2 font-mono text-[10px] tracking-[0.08em] text-fgdim uppercase">{title} · {files.length}</div>
      {addable && (
        <div className="mb-2 flex items-center gap-1.5">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submitAdd()}
            placeholder={t('brain.journalPlaceholder')}
            className="min-w-0 flex-1 rounded-[7px] border border-border bg-panel px-2 py-1 text-[11.5px] outline-none placeholder:text-fgdim focus:border-ink"
          />
          <button
            type="button"
            disabled={busy || !draft.trim()}
            onClick={submitAdd}
            className="shrink-0 cursor-pointer rounded-[7px] border border-ink bg-panel px-2 py-1 text-[10.5px] font-bold text-fg hover:bg-chip disabled:opacity-40"
          >
            <Icon icon={faPlus} />
          </button>
        </div>
      )}
      {files.length === 0 ? (
        <div className="text-[11px] text-fgdim">{emptyLabel}</div>
      ) : (
        <div className="flex gap-3">
          <div className="flex max-h-[220px] w-[180px] shrink-0 flex-col gap-0.5 overflow-y-auto thin-scroll">
            {files.map((f) => (
              <button
                key={f.path}
                type="button"
                onClick={() => setSelected(f.path)}
                className={`truncate rounded-[6px] px-2 py-1 text-left font-mono text-[10.5px] ${
                  selected === f.path ? 'bg-chip text-fg' : 'text-fgdim hover:bg-chip/60'
                }`}
              >
                {f.path.split('/').pop()}
              </button>
            ))}
          </div>
          <pre className="thin-scroll min-w-0 flex-1 overflow-auto whitespace-pre-wrap break-words rounded-[8px] border border-hair bg-bg p-2 text-[11px] leading-relaxed text-fg">
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

  if (log === null) return <div className="text-[11px] text-fgdim">{t('dialogs.loading')}</div>;

  return (
    <div className="rounded-[10px] border border-hair p-3">
      <div className="mb-2 font-mono text-[10px] tracking-[0.08em] text-fgdim uppercase">{t('brain.changeLog')}</div>
      {log.length === 0 && <div className="text-[11px] text-fgdim">{t('brain.logEmpty')}</div>}
      <div className="flex flex-col gap-1">
        {log.map((e) => (
          <div key={e.seq} className="flex items-center gap-2 rounded-[7px] border border-hair px-2 py-1.5">
            <span className="shrink-0 font-mono text-[9.5px] text-fgdim">#{e.seq}</span>
            <span className="shrink-0 rounded-full border border-hair px-1.5 text-[9px] font-bold text-fgdim uppercase">{e.action}</span>
            <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-fg">{e.path}</span>
            <span className="shrink-0 text-[9.5px] text-fgdim">{e.source}</span>
            <span className="shrink-0 text-[9.5px] text-fgdim">{fmtDate(e.ts)}</span>
            {e.action !== 'undo' && (
              <button
                type="button"
                disabled={busy === e.seq}
                onClick={() => undo(e.seq)}
                title={t('brain.undo')}
                className="shrink-0 cursor-pointer text-[10.5px] text-fgdim hover:text-fg disabled:opacity-40"
              >
                <Icon icon={faRotateLeft} />
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---------- pending facts ---------------------------------------------------- */

function PendingTab({ onChanged }) {
  const t = useT();
  const [list, setList] = useState(null);
  const [busy, setBusy] = useState(null);

  const load = () => api.get('/memory/pending').then(setList).catch(() => setList([]));
  useEffect(() => { load(); }, []);

  const decide = async (id, action) => {
    setBusy(id);
    try {
      await api.post(`/memory/pending/${id}/${action}`);
      toastSuccess(action === 'approve' ? t('brain.factApproved') : t('brain.factRejected'));
      await load();
      onChanged?.();
    } catch (e) {
      toastError(String(e.message || e).replace(/^HTTP \d+ — /, ''));
    } finally {
      setBusy(null);
    }
  };

  if (list === null) return <div className="text-[12px] text-fgdim">{t('dialogs.loading')}</div>;

  return (
    <div className="mx-auto flex max-w-[720px] flex-col gap-2">
      {list.length === 0 && <div className="p-4 text-center text-[12px] text-fgdim">{t('brain.noPending')}</div>}
      {list.map((f) => (
        <div key={f.id} className="rounded-[10px] border border-hair p-3">
          <div className="mb-1.5 flex items-center gap-2 text-[9.5px] text-fgdim">
            <span className="rounded-full border border-hair px-1.5 py-px font-bold uppercase">{f.target}</span>
            <span>{f.source}</span>
            <span className="ml-auto">{fmtDate(f.createdAt)}</span>
          </div>
          <div className="mb-2 text-[12px] leading-relaxed text-fg">{f.content}</div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={busy === f.id}
              onClick={() => decide(f.id, 'reject')}
              className="cursor-pointer rounded-lg border-[1.5px] border-ink bg-panel px-2.5 py-1 text-[11px] font-bold text-fg hover:bg-chip disabled:opacity-40"
            >
              {t('brain.reject')}
            </button>
            <button
              type="button"
              disabled={busy === f.id}
              onClick={() => decide(f.id, 'approve')}
              className="cursor-pointer rounded-lg border-[1.5px] border-ink bg-brand px-2.5 py-1 text-[11px] font-bold text-fg disabled:opacity-40"
            >
              {t('brain.approve')}
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

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
  const [mode, setMode] = useState('memory'); // 'memory' | 'pending' | 'cron' | 'proposals'
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

  const TABS = ['memory', 'pending', 'cron', 'proposals'];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-hair bg-panel px-4 py-2.5">
        <span className="flex items-center gap-1.5 text-[14px] font-bold text-fg">
          <Icon icon={faBrain} /> {t('brain.title')}
        </span>
        <div className="ml-2 flex overflow-hidden rounded-lg border-[1.5px] border-ink">
          {TABS.map((mItem) => (
            <button
              key={mItem}
              type="button"
              onClick={() => setMode(mItem)}
              className={`relative cursor-pointer px-3 py-1 text-[11px] font-bold ${
                mode === mItem ? 'bg-brand text-fg' : 'bg-panel text-fgdim hover:bg-chip'
              }`}
            >
              {t(`brain.tab.${mItem}`)}
              {mItem === 'pending' && pendingCount > 0 && (
                <span className="ml-1.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-[#9c3b33] px-1 text-[9px] font-bold text-white">
                  {pendingCount}
                </span>
              )}
            </button>
          ))}
        </div>
        <a href="#/settings/automation/heartbeat" className="ms-auto shrink-0 text-[11px] text-fgdim underline hover:text-fg">{t('brain.heartbeatSettings')}</a>
        <button
          type="button"
          onClick={askBrain}
          disabled={askBusy}
          className="shrink-0 cursor-pointer rounded-lg border-[1.5px] border-ink bg-brand px-3 py-1.5 text-[11.5px] font-bold text-fg disabled:cursor-default disabled:opacity-40"
        >
          {askBusy ? t('brain.asking') : t('brain.askBrain')}
        </button>
        <button
          type="button"
          onClick={onClose}
          className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-md border border-hair text-fgdim hover:border-ink hover:text-fg"
          title={t('dialogs.close')}
        >
          <Icon icon={faXmark} />
        </button>
      </div>

      {mode === 'memory' && (
        <div className="thin-scroll min-h-0 flex-1 overflow-y-auto p-4">
          <MemoryTab onChanged={refreshPendingCount} />
        </div>
      )}
      {mode === 'pending' && (
        <div className="thin-scroll min-h-0 flex-1 overflow-y-auto p-4">
          <PendingTab onChanged={refreshPendingCount} />
        </div>
      )}
      {mode === 'cron' && <CronSubPanel />}
      {mode === 'proposals' && <ProposalsPane desktop={desktop} />}
    </div>
  );
}
