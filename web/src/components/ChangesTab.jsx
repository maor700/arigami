import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { toastError, toastSuccess } from '../lib/toast.js';
import { defaultChangesMode, explanationSwitchOffer, newestExplanation, changesQuery, loadDefaultBase, saveDefaultBase, filterBaseRefs } from '../lib/changesMode.js';
import { Truncate } from './Truncate.jsx';
import { DiffView } from './DiffView.jsx';
import { CommentThread, CommentComposer } from './Comments.jsx';
import { MergePill, MergePanel } from './MergeCard.jsx';
import { useIsDesktop } from '../lib/useMedia.js';
import { Icon } from '../lib/icons.js';
import { useT } from '../lib/i18n.js';
import { faArrowDown, faArrowUp, faCaretDown, faCaretUp, faCheck, faComment, faExpand, faRotateRight, faScaleBalanced, faWandMagicSparkles, faTriangleExclamation, faXmark } from '@fortawesome/free-solid-svg-icons';
import { fmtDateTime } from '../lib/time.js';

// Single-letter status chip. Maps git porcelain-ish codes to M/A/D/??.
function StatusChip({ status }) {
  const s = String(status || '').trim();
  const code = s === '??' ? '??' : (s[0] || '?').toUpperCase();
  const color =
    code === 'A' ? '#3C9A4E' : code === 'D' ? '#B23B30' : code === 'M' ? '#CE8324' : '#8a8a8a';
  return (
    <span
      title={s}
      className="flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-[4px] border px-1 font-mono text-[10px] font-bold"
      style={{ color, borderColor: color }}
    >
      {code}
    </span>
  );
}

const baseName = (p) => String(p || '').split('/').pop();

// Explanation prose — may be any language; dir comes from the skill ('rtl'/'ltr')
// or falls back to 'auto' (the browser detects per content).
function ExplainCard({ label, title, body, dir = 'auto' }) {
  if (!title && !body) return null;
  return (
    <div className="m-3 rounded-[10px] border-[1.5px] border-[#e6d27a] bg-chip/60 px-3.5 py-2.5">
      <div className="mb-1 flex items-center gap-1.5">
        <span className="text-[11px]"><Icon icon={faWandMagicSparkles} /></span>
        <span className="font-mono text-[9.5px] font-bold tracking-wide text-fgdim uppercase">{label}</span>
      </div>
      {title && <div dir={dir} className="text-[12.5px] font-bold leading-snug text-fg">{title}</div>}
      {body && <div dir={dir} className="mt-1 text-[12px] leading-relaxed whitespace-pre-wrap text-fg">{body}</div>}
    </div>
  );
}

// Sticky review bar: pending count, optional summary, local/remote target, and
// the verdict actions. `target` defaults from the changes mode (uncommitted→local,
// pr→remote) and follows mode changes until the user overrides it.
function ReviewBar({ count, onSubmit, mode, desktop }) {
  const t = useT();
  const defaultTarget = mode === 'pr' ? 'remote' : 'local';
  const [summary, setSummary] = useState('');
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false); // mobile: full controls revealed
  const [target, setTarget] = useState(defaultTarget);
  const touched = useRef(false);
  // follow the mode default until the user manually picks a target
  useEffect(() => { if (!touched.current) setTarget(defaultTarget); }, [defaultTarget]);
  const pickTarget = (t) => { touched.current = true; setTarget(t); };
  const submit = (verdict) => { onSubmit(verdict, summary.trim(), target); setSummary(''); setOpen(false); setExpanded(false); };
  const canComment = count > 0 || summary.trim();
  const approveLabel = target === 'remote' ? t('chat.approvePr') : t('chat.approve');
  const full = desktop || expanded;

  // Mobile, collapsed: a slim one-line bar — pending count + a "Review" pill that
  // expands the full controls. Reclaims the footer's vertical space while reading.
  if (!full) {
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        className="flex w-full shrink-0 items-center gap-2 border-t-2 border-ink bg-chip px-3.5 py-1.5 text-left"
      >
        <span className="font-mono text-[10.5px] text-fgdim">
          {t(count === 1 ? 'chat.pendingCommentOne' : 'chat.pendingCommentMany', { n: count })}
        </span>
        <span className="ml-auto flex items-center gap-1 rounded-md border-[1.5px] border-ink bg-[#3C9A4E] px-2.5 py-0.5 text-[11px] font-bold text-white">
          {t('chat.review')} <Icon icon={faCaretUp} />
        </span>
      </button>
    );
  }

  return (
    <div className="shrink-0 border-t-2 border-ink bg-chip px-3.5 py-2">
      {open && (
        <textarea
          dir="auto"
          rows={2}
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          placeholder={t('chat.reviewSummaryPlaceholder')}
          className="mb-2 w-full resize-none rounded-md border-[1.5px] border-[#d8c870] bg-bg px-2 py-1 text-[11.5px] outline-none placeholder:text-fgdim"
        />
      )}
      <div className="flex flex-wrap items-center gap-2 gap-y-2">
        {!desktop && (
          <button
            type="button"
            onClick={() => setExpanded(false)}
            title={t('chat.collapse')}
            className="cursor-pointer rounded-[6px] border border-border bg-panel px-1.5 py-0.5 font-mono text-[11px] leading-none text-fgdim hover:text-fg"
          >
            <Icon icon={faCaretDown} />
          </button>
        )}
        {/* where the submitted review goes: fix locally, or post to the GitHub PR */}
        <span className="flex overflow-hidden rounded-[6px] border-[1.5px] border-ink" title={t('chat.reviewSentTitle')}>
          {['local', 'remote'].map((tg) => (
            <button
              key={tg}
              type="button"
              onClick={() => pickTarget(tg)}
              className={`cursor-pointer px-2 py-0.5 font-mono text-[10px] ${
                target === tg ? 'bg-ink font-bold text-white' : 'bg-panel text-fgdim hover:text-fg'
              }`}
            >
              {tg === 'local' ? t('chat.local') : t('chat.remotePr')}
            </button>
          ))}
        </span>
        <span className="font-mono text-[10.5px] text-fgdim">
          {t(count === 1 ? 'chat.pendingCommentOne' : 'chat.pendingCommentMany', { n: count })}
        </span>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="cursor-pointer font-mono text-[10px] text-fgdim underline-offset-2 hover:underline"
        >
          {open ? t('chat.hideSummary') : t('chat.addSummary')}
        </button>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            disabled={!canComment}
            onClick={() => submit('request-changes')}
            className="cursor-pointer rounded-lg border-[1.5px] border-danger bg-panel px-3 py-[5px] text-[11.5px] font-bold text-danger hover:bg-danger/10 disabled:cursor-default disabled:opacity-40"
          >
            {t('chat.requestChanges')}
          </button>
          <button
            type="button"
            disabled={!canComment}
            onClick={() => submit('comment')}
            className="cursor-pointer rounded-lg border-[1.5px] border-[#cdbb66] bg-panel px-3 py-[5px] text-[11.5px] text-fgdim hover:bg-chip disabled:cursor-default disabled:opacity-40"
          >
            {t('chat.comment')}
          </button>
          <button
            type="button"
            onClick={() => submit('approve')}
            title={target === 'remote' ? t('chat.approvePrTitle') : t('chat.approveLocalTitle')}
            className="cursor-pointer rounded-lg border-[1.5px] border-ink bg-[#3C9A4E] px-3.5 py-[5px] text-[11.5px] font-bold text-white shadow-[2px_2px_0_#2a2a2a]"
          >
            <Icon icon={faCheck} /> {approveLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

// Mobile overflow menu — folds the header actions (explain / review / diff
// view / refresh) into a single "⋯" dropdown so the narrow header stays clean.
// VS Code is intentionally omitted here (irrelevant on a phone).
function ChangesMenu({ noWorktree, expl, hasReview, explaining, reviewing, mode, setMode, onExplain, onReview, onRefresh, loading, filesCount, outdated }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey, true); };
  }, [open]);
  const Row = ({ label, value, onClick, disabled, keepOpen }) => (
    <button
      type="button"
      disabled={disabled}
      onClick={() => { onClick(); if (!keepOpen) setOpen(false); }}
      className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left text-[12px] text-fg hover:bg-chip disabled:cursor-default disabled:opacity-50"
    >
      <span className="flex-1">{label}</span>
      {value != null && <span className="shrink-0 font-mono text-[10.5px] text-fgdim">{value}</span>}
    </button>
  );
  return (
    <span ref={ref} className="relative flex items-center">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={t('chat.changesActions')}
        aria-label={t('chat.changesActions')}
        className={`flex h-[24px] items-center rounded-[6px] border-[1.5px] px-2 text-[14px] leading-none text-fgdim hover:border-ink hover:text-fg ${open ? 'border-ink text-fg' : 'border-border bg-panel'}`}
      >
        ⋯
      </button>
      {outdated && <span className="pointer-events-none absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full border border-panel bg-danger" />}
      {open && (
        <div className="absolute top-[30px] right-0 z-30 w-[190px] overflow-hidden rounded-lg border-[1.5px] border-ink bg-panel shadow-[3px_3px_0_rgba(42,42,42,0.18)]">
          {outdated && (
            <div className="flex items-center gap-1.5 bg-danger/10 px-3 py-1.5 font-mono text-[10px] font-bold text-danger" title={t('chat.analysisOutdatedTitle')}>
              <Icon icon={faTriangleExclamation} /> {t('chat.analysisOutdated')}
            </div>
          )}
          {!noWorktree && <Row label={explaining ? t('chat.explainingMenu') : expl ? <><Icon icon={faWandMagicSparkles} /> {t('chat.reExplainMenu')}</> : <><Icon icon={faWandMagicSparkles} /> {t('chat.explainMenu')}</>} disabled={explaining} onClick={onExplain} />}
          {!noWorktree && <Row label={reviewing ? t('chat.reviewingMenu') : hasReview ? <><Icon icon={faScaleBalanced} /> {t('chat.reReviewMenu')}</> : <><Icon icon={faScaleBalanced} /> {t('chat.autoReviewMenu')}</>} disabled={reviewing} onClick={onReview} />}
          <span className="block h-px bg-hair" />
          {filesCount > 0 && <Row label={t('chat.diffView')} value={mode === 'split' ? t('chat.split') : t('chat.inline')} keepOpen onClick={() => setMode(mode === 'split' ? 'inline' : 'split')} />}
          <Row label={loading ? t('chat.refreshingMenu') : <><Icon icon={faRotateRight} /> {t('chat.refreshCap')}</>} disabled={loading} onClick={onRefresh} />
        </div>
      )}
    </span>
  );
}

// Searchable branch picker for the comparison base. '' = server default.
function BasePicker({ value, onChange, refs, defaultLabel, title }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey, true); };
  }, [open]);
  const remote = filterBaseRefs(refs.remote, q);
  const local = filterBaseRefs(refs.local, q);
  const showDefault = !q.trim() || defaultLabel.toLowerCase().includes(q.trim().toLowerCase());
  const pick = (v) => { onChange(v); setOpen(false); setQ(''); };
  const Item = ({ v, label }) => (
    <button
      type="button"
      onClick={() => pick(v)}
      className={`block w-full truncate px-3 py-1.5 text-left font-mono text-[11px] hover:bg-chip ${v === value ? 'font-bold text-fg' : 'text-fgdim'}`}
    >
      {label || v}
    </button>
  );
  return (
    <span ref={ref} className="relative flex items-center">
      <button
        type="button"
        title={title}
        onClick={() => setOpen((v) => !v)}
        className="max-w-[170px] truncate rounded-md border border-border bg-panel px-1.5 py-0.5 font-mono text-[10px] text-fg hover:border-ink"
      >
        {value || defaultLabel} ▾
      </button>
      {open && (
        <div className="absolute top-[26px] left-0 z-30 w-[240px] overflow-hidden rounded-lg border-[1.5px] border-ink bg-panel shadow-[3px_3px_0_rgba(42,42,42,0.18)]">
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              const first = remote[0] || local[0];
              if (first) pick(first);
            }}
            placeholder={t('chat.baseSearch')}
            className="w-full border-b border-hair bg-transparent px-3 py-2 font-mono text-[11px] text-fg outline-none"
          />
          <div className="max-h-[260px] overflow-y-auto">
            {showDefault && <Item v="" label={defaultLabel} />}
            {remote.length > 0 && <div className="px-3 pt-1.5 text-[9.5px] uppercase text-fgdim">{t('chat.remoteBranches')}</div>}
            {remote.map((r) => <Item key={`r:${r}`} v={r} />)}
            {local.length > 0 && <div className="px-3 pt-1.5 text-[9.5px] uppercase text-fgdim">{t('chat.localBranches')}</div>}
            {local.map((r) => <Item key={`l:${r}`} v={r} />)}
            {!showDefault && !remote.length && !local.length && <div className="px-3 py-2 text-[11px] text-fgdim">{t('chat.baseNoMatch')}</div>}
          </div>
        </div>
      )}
    </span>
  );
}

export default function ChangesTab({ session, active }) {
  const t = useT();
  const desktop = useIsDesktop();
  const [data, setData] = useState(null); // {worktree,branch,files,error} | null
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [selected, setSelected] = useState(null); // selected file path
  const [featureIdx, setFeatureIdx] = useState(null); // selected feature, or null = file view
  const [diff, setDiff] = useState(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [mode, setMode] = useState(desktop ? 'split' : 'inline'); // split is too wide on phones
  const [fileComposer, setFileComposer] = useState(false);
  const [listOpen, setListOpen] = useState(false); // mobile: file/feature list sheet
  const [fullscreen, setFullscreen] = useState(false); // mobile: file diff as a full-screen overlay
  const [changesMode, setChangesMode] = useState(() => defaultChangesMode(session)); // 'work' | 'uncommitted' | 'pr'
  // A review session queued from a PR learns it is one a moment after it starts (its first
  // act is to stamp metadata.pr): follow that ONCE, unless the human already picked a mode.
  const modeTouchedRef = useRef(false);
  const isPrSession = !!(session.metadata?.prNumber || session.metadata?.pr);
  useEffect(() => {
    if (isPrSession && !modeTouchedRef.current) setChangesMode('pr');
  }, [isPrSession]);
  const [refs, setRefs] = useState(null);
  // Comparison base for pr/work: '' = server default (origin/<default branch>).
  const [defaultBase, setDefaultBase] = useState(() => loadDefaultBase());
  const [baseSel, setBaseSel] = useState(() => loadDefaultBase());
  const [switchOffer, setSwitchOffer] = useState(null); // {mode, generatedAt} | null — an arrived explanation offered, never applied

  // ---- view navigation history (Back / Forward) --------------------------
  // A "view" is a feature write-up or a file diff. We keep a browser-style
  // stack so the user can step back/forward — notably to return to the feature
  // they opened a file from. Plain closures (recreated each render) read the
  // current history/pos, so event handlers and effects always see fresh state.
  const [history, setHistory] = useState([]); // [{kind:'feature',idx}|{kind:'file',path}]
  const [histPos, setHistPos] = useState(-1);
  const sameView = (a, b) =>
    !!a && !!b && a.kind === b.kind && (a.kind === 'feature' ? a.idx === b.idx : a.path === b.path);
  const applyView = (v) => {
    if (!v) return;
    if (v.kind === 'feature') setFeatureIdx(v.idx);
    else { setFeatureIdx(null); setSelected(v.path); }
  };
  // Navigate to a view: push it (truncating any forward history), or replace
  // the current entry (used for implicit seeds so they don't add back/forward).
  const navigate = (v, replace = false) => {
    applyView(v);
    if (!desktop) setListOpen(false); // on mobile, picking from the sheet closes it
    if (sameView(history[histPos], v)) return;
    const base = replace ? history.slice(0, Math.max(histPos, 0)) : history.slice(0, histPos + 1);
    const next = [...base, v];
    setHistory(next);
    setHistPos(next.length - 1);
  };
  const go = (delta) => {
    const np = histPos + delta;
    if (np < 0 || np >= history.length) return;
    setHistPos(np);
    applyView(history[np]);
  };
  const canBack = histPos > 0;
  const canFwd = histPos >= 0 && histPos < history.length - 1;
  const resetHistory = () => { setHistory([]); setHistPos(-1); };

  // Explanations are stored per-mode on the server (changesExplanations:
  // { uncommitted, pr }). Show the one for the mode currently being viewed.
  const explanations = session.changesExplanations || {};
  const expl = explanations[changesMode] || null;
  const explMatches = !!expl; // expl is, by construction, for the current mode
  const features = Array.isArray(expl?.features) ? expl.features : [];
  const hasReview = (session.review?.comments || []).length > 0;
  const fileExpl = (path) => (expl ? (expl.files || []).find((f) => f.path === path) : null);

  // When a fresh explanation ARRIVES (an explain run just finished) for a mode
  // OTHER than the one being viewed, OFFER to switch — never apply it
  // ourselves. The tab must not jump out from under someone mid-read; only an
  // explicit click on the offer changes the view. We baseline on mount so
  // simply opening the tab never raises an offer — only new writes do.
  const lastExpl = useRef(undefined);
  const changesModeRef = useRef(changesMode);
  changesModeRef.current = changesMode;
  useEffect(() => {
    const offer = explanationSwitchOffer(explanations, changesModeRef.current, lastExpl.current);
    lastExpl.current = newestExplanation(explanations)?.generatedAt || null;
    if (offer) setSwitchOffer(offer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [explanations.work?.generatedAt, explanations.uncommitted?.generatedAt, explanations.pr?.generatedAt]);
  // A manual mode switch (by the user, or by accepting the offer) makes any
  // pending offer for that mode moot.
  useEffect(() => { if (switchOffer?.mode === changesMode) setSwitchOffer(null); }, [changesMode, switchOffer]);
  const acceptSwitchOffer = () => {
    if (!switchOffer) return;
    modeTouchedRef.current = true;
    setChangesMode(switchOffer.mode);
    setFeatureIdx(null);
    setSwitchOffer(null);
  };

  // available refs for the base picker
  useEffect(() => {
    if (!active) return;
    api.get(`/sessions/${session.id}/changes/refs${baseSel ? `?base=${encodeURIComponent(baseSel)}` : ''}`).then(setRefs).catch(() => setRefs(null));
  }, [active, session.id, baseSel]);

  // review comments (live via session-updated)
  const comments = session.review?.comments || [];
  const R = `/sessions/${session.id}/review`;
  const addComment = (target, body) => api.post(`${R}/comment`, { target, body }).catch(() => {});
  const delComment = (cid) => api.del(`${R}/comment/${cid}`).catch(() => {});
  const resolveComment = (cid, resolved) => api.patch(`${R}/comment/${cid}`, { resolved }).catch(() => {});
  const editComment = (cid, body) => api.patch(`${R}/comment/${cid}`, { body }).catch(() => {});
  const acceptSuggestion = (cid) => api.patch(`${R}/comment/${cid}`, { accept: true }).catch(() => {});
  const replyComment = (cid, body) => api.post(`${R}/comment/${cid}/reply`, { body }).catch(() => {});
  const editReply = (cid, rid, body) => api.patch(`${R}/comment/${cid}/reply/${rid}`, { body }).catch(() => {});
  const delReply = (cid, rid) => api.del(`${R}/comment/${cid}/reply/${rid}`).catch(() => {});
  // verdict carries the local|remote target (where the submitted review goes).
  // Confirm the outcome — for a remote PR verdict this posts to GitHub, so a
  // silent no-op vs. a real post must be distinguishable.
  const submitReview = (verdict, summary, target) =>
    api
      .post(`${R}/submit`, { verdict, summary, target })
      .then(() => toastSuccess(target === 'remote' ? t('chat.reviewPosted') : t('chat.reviewSubmitted')))
      .catch((e) => toastError(t('chat.couldntSubmitReview', { err: e?.message || e })));
  // Shared comment-thread handlers (edit/reply/resolve/delete + suggestion accept/reject).
  const threadProps = {
    onDelete: delComment,
    onResolve: resolveComment,
    onEdit: editComment,
    onReply: replyComment,
    onAccept: acceptSuggestion,
    onReject: delComment, // reject a suggestion = discard it
    onEditReply: editReply,
    onDeleteReply: delReply,
  };

  // Read-only AI runs: explain the changes / auto-review them. These are
  // independent headless one-shots that take ~30–60s. The server tracks the
  // live run state on the session (changesExplaining / autoReviewing = the mode
  // being processed, or null) and broadcasts it, so we show a real spinner the
  // whole time instead of a fake timed flash. We also optimistically set it on
  // click so the button reacts instantly before the first broadcast lands.
  const [pending, setPending] = useState({ explain: false, review: false });
  const explaining = !!session.changesExplaining || pending.explain;
  const reviewing = !!session.autoReviewing || pending.review;
  // Clear the optimistic flag once the server's own run-state takes over (or the
  // run finished and cleared it).
  useEffect(() => { if (session.changesExplaining !== undefined) setPending((p) => (p.explain ? { ...p, explain: false } : p)); }, [session.changesExplaining]);
  useEffect(() => { if (session.autoReviewing !== undefined) setPending((p) => (p.review ? { ...p, review: false } : p)); }, [session.autoReviewing]);
  const runExplain = () => {
    if (explaining) return;
    setPending((p) => ({ ...p, explain: true }));
    api.post(`/sessions/${session.id}/changes/explain`, { mode: changesMode })
      .catch(() => setPending((p) => ({ ...p, explain: false })));
  };
  const runReview = () => {
    if (reviewing) return;
    setPending((p) => ({ ...p, review: true }));
    api.post(`/sessions/${session.id}/review/auto`, { mode: changesMode })
      .catch(() => setPending((p) => ({ ...p, review: false })));
  };
  // Open the session's worktree in the local desktop editor (VS Code).
  const [opening, setOpening] = useState(false);
  const openEditor = () => {
    setOpening(true);
    api.post(`/sessions/${session.id}/open-editor`, {})
      .then((r) => { if (r?.error) toastError(t('chat.couldntOpenEditor', { err: r.error })); })
      .catch((e) => toastError(t('chat.couldntOpenEditor', { err: e?.message || e })))
      .finally(() => setTimeout(() => setOpening(false), 1200));
  };

  // Always explicit — the server's default-mode guess (session has a
  // worktree+base → 'work') only applies when `mode` is omitted entirely, and
  // the client's own default (defaultChangesMode) must be what's actually shown.
  const modeQ = changesQuery(changesMode, baseSel);

  const load = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    try {
      const res = await api.get(`/sessions/${session.id}/changes${modeQ ? `?${modeQ}` : ''}`);
      setData(res || {});
    } catch {
      setFailed(true);
    }
    setLoading(false);
  }, [session.id, modeQ]);

  useEffect(() => { if (active) load(); }, [active, load]);
  // P3-3: codex app-server's turn/diff/updated — reload while the tab is open.
  const turnDiffAt = session.claude?.turnDiff?.at;
  useEffect(() => { if (active && turnDiffAt) load(); }, [turnDiffAt]); // eslint-disable-line react-hooks/exhaustive-deps

  const files = Array.isArray(data?.files) ? data.files : [];

  useEffect(() => {
    if (!files.length) { setSelected(null); return; }
    if (!selected || !files.some((f) => f.path === selected)) setSelected(files[0].path);
  }, [files, selected]);

  // Seed the history root once we have an initial file in view (and after a
  // mode switch clears it). Implicit, so it doesn't count as a user navigation.
  useEffect(() => {
    if (history.length === 0 && featureIdx === null && selected) {
      setHistory([{ kind: 'file', path: selected }]);
      setHistPos(0);
    }
  }, [selected, featureIdx, history.length]);

  // Alt+←/→ walk the navigation history while the tab is active.
  useEffect(() => {
    if (!active) return;
    const onKey = (e) => {
      if (!e.altKey || e.metaKey || e.ctrlKey) return;
      const el = e.target;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); go(1); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, history, histPos]);

  useEffect(() => { setFileComposer(false); }, [selected]);

  // Fullscreen is a mobile, file-view-only affordance — leave it when those
  // conditions no longer hold (desktop, a feature view, or nothing selected).
  useEffect(() => {
    if (desktop || featureIdx !== null || !selected) setFullscreen(false);
  }, [desktop, featureIdx, selected]);

  useEffect(() => {
    if (!selected) { setDiff(null); return; }
    let stop = false;
    setDiffLoading(true);
    api
      .get(`/sessions/${session.id}/changes/diff?path=${encodeURIComponent(selected)}${modeQ ? `&${modeQ}` : ''}`)
      .then((res) => { if (!stop) setDiff(res?.error ? `(${res.error})` : res?.diff ?? ''); })
      .catch(() => { if (!stop) setDiff('(failed to load diff)'); })
      .finally(() => { if (!stop) setDiffLoading(false); });
    return () => { stop = true; };
  }, [selected, session.id, data, modeQ]);

  const noWorktree = failed || data?.error || (!loading && !data?.worktree && files.length === 0);
  const noRepo = !loading && data?.emptyReason === 'no-repo';

  const lineComments = comments.filter((c) => c.target?.kind === 'line' && c.target?.path === selected);
  const fileComments = comments.filter((c) => c.target?.kind === 'file' && c.target?.path === selected);
  const curFeature = featureIdx !== null ? features[featureIdx] : null;
  const featureComments = comments.filter(
    (c) => c.target?.kind === 'feature' && c.target?.key === curFeature?.title
  );
  const commentCountFor = (path) => comments.filter((c) => c.target?.path === path).length;

  // Breadcrumb: if we arrived at this file directly from a feature, offer a way
  // back to it. Prev/next step through the changed-file list in rail order.
  const prevView = histPos > 0 ? history[histPos - 1] : null;
  const fromFeature = !curFeature && prevView?.kind === 'feature' ? features[prevView.idx] : null;
  const fileIdx = files.findIndex((f) => f.path === selected);
  const prevFile = fileIdx > 0 ? files[fileIdx - 1] : null;
  const nextFile = fileIdx >= 0 && fileIdx < files.length - 1 ? files[fileIdx + 1] : null;
  // Mobile file-view fullscreen: lift the detail column into a fixed overlay
  // that covers the app chrome so the diff gets the whole screen.
  const fsActive = fullscreen && !desktop && !curFeature && !!selected;

  // Modes: Work (this session's base..HEAD + working tree), Uncommitted (HEAD),
  // or PR (merge-base comparison). Work only exists for a host-managed child
  // worktree (F7: metadata.base + metadata.worktree) — a plain session never
  // sees the button, so its tab behaves exactly as before this mode existed.
  const refData = refs && !refs.error ? refs : null;
  const prAvailable = refData?.available === true;
  const workAvailable = !!(session.metadata?.base && session.metadata?.worktree);

  // The explanation stores the diff "identity" (a signature of the changes) it
  // was generated from. If the worktree has changed since, the explanation (and
  // any auto-review comments) describe a stale diff → show an "outdated" badge.
  const outdated = !!(expl && expl.identity && data?.identity && expl.identity !== data.identity);

  // Empty-state text: distinguishes a real failure (error, from `data.error`)
  // from a clean tree, from a branch with no commits at all yet, and names the
  // base it compared against so "no changes" doesn't read as "nothing to see".
  const baseLabel = data?.baseRef || data?.defaultBranch || null;
  const emptyStateText = () => {
    switch (data?.emptyReason) {
      case 'no-worktree': return t('chat.noWorktreeChanges');
      case 'no-repo': return t('chat.notAGitRepo');
      case 'unborn': return t('chat.nothingCommittedYet');
      case 'clean': return baseLabel ? t('chat.noChangesSince', { base: baseLabel }) : t('chat.noWorktreeChanges');
      default: return data?.error ? String(data.error) : t('chat.noWorktreeChanges');
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-bg">
      <div className="flex shrink-0 flex-wrap items-center gap-2.5 border-b border-hair bg-panel px-3.5 py-2 text-xs">
        <span className="font-bold text-fg">{t('chat.changes')}</span>
        {!noWorktree && (history.length > 1) && (
          <span className="flex overflow-hidden rounded-[6px] border-[1.5px] border-border" title={t('chat.navViewedFiles')}>
            <button
              type="button"
              onClick={() => go(-1)}
              disabled={!canBack}
              title={t('chat.back')}
              className="cursor-pointer px-1.5 py-0.5 font-mono text-[11px] text-fgdim hover:bg-chip hover:text-fg disabled:cursor-default disabled:opacity-30"
            >
              ←
            </button>
            <button
              type="button"
              onClick={() => go(1)}
              disabled={!canFwd}
              title={t('chat.forward')}
              className="cursor-pointer border-l border-border px-1.5 py-0.5 font-mono text-[11px] text-fgdim hover:bg-chip hover:text-fg disabled:cursor-default disabled:opacity-30"
            >
              →
            </button>
          </span>
        )}
        {!noRepo && <div className="flex overflow-hidden rounded-[6px] border-[1.5px] border-border">
          {(workAvailable ? ['work', 'uncommitted', 'pr'] : ['uncommitted', 'pr']).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => { modeTouchedRef.current = true; setChangesMode(m); setFeatureIdx(null); setSelected(null); resetHistory(); }}
              disabled={m === 'pr' && !prAvailable}
              title={
                m === 'pr' && !prAvailable
                  ? t('chat.prNotAvailable')
                  : m === 'work'
                    ? t('chat.compareWork')
                    : m === 'uncommitted' ? t('chat.compareHead') : t('chat.compareMain')
              }
              className={`cursor-pointer px-2.5 py-0.5 font-mono text-[10px] ${
                changesMode === m ? 'bg-chip font-bold text-fg' : 'bg-panel text-fgdim hover:text-fg'
              } ${m === 'pr' && !prAvailable ? 'opacity-40 cursor-not-allowed' : ''}`}
            >
              {m === 'work' ? t('chat.work') : m === 'uncommitted' ? t('chat.uncommitted') : 'PR'}
            </button>
          ))}
        </div>}
        {/* branch / file-count / explained are context, not actions — on mobile
            they're redundant (file count lives in the Files sheet) so we hide
            them to keep the header clean; the outdated warning always shows. */}
        {desktop && data?.branch && <Truncate text={data.branch} className="max-w-[140px] font-mono text-[10.5px] text-fgdim" />}
        {(changesMode === 'work' || changesMode === 'pr') && refs && (
          <span className="flex shrink-0 items-center gap-1 text-[10px] text-fgdim">
            {t('chat.compareAgainst')}
            <BasePicker
              value={baseSel}
              onChange={setBaseSel}
              refs={refs}
              defaultLabel={t('chat.baseDefault', { base: refs.defaultRef || data?.baseRef || '…' })}
              title={t('chat.comparedAgainstTitle', { base: data?.baseRef || '' })}
            />
            {baseSel !== defaultBase && (
              <button
                type="button"
                title={t('chat.setBaseDefaultTitle')}
                onClick={() => { saveDefaultBase(baseSel); setDefaultBase(baseSel); }}
                className="rounded-md border border-border bg-panel px-1.5 py-0.5 text-[10px] hover:text-fg"
              >
                {t('chat.setBaseDefault')}
              </button>
            )}
          </span>
        )}
        <MergePill session={session} compact={!desktop} />
        {desktop && files.length > 0 && <span className="font-mono text-[10.5px] text-fgdim">{t('chat.filesCount', { n: files.length })}</span>}
        {desktop && expl && (
          <span
            title={(expl.language ? t('chat.explainedInLang', { lang: expl.language }) : t('chat.explained')) + (expl.generatedAt ? ' · ' + fmtDateTime(expl.generatedAt) : '')}
            className="flex shrink-0 items-center gap-1 rounded-full border border-[#e6d27a] bg-chip/60 px-2 py-0.5 font-mono text-[9.5px] text-fgdim"
          >
            <Icon icon={faWandMagicSparkles} /> {t('chat.explained')}{expl.language ? ` · ${expl.language}` : ''}
          </span>
        )}
        {desktop && outdated && (
          <span
            title={t('chat.outdatedTitle')}
            className="flex shrink-0 items-center gap-1 rounded-full border border-[#d98078] bg-danger/10 px-2 py-0.5 font-mono text-[9.5px] font-bold text-danger"
          >
            <Icon icon={faTriangleExclamation} /> {t('chat.outdated')}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {/* B14: not a git repo → nothing to explain/review/refresh or to switch between */}
          {noRepo ? null : desktop ? (
            <>
          {!noWorktree && (
            <>
              <button
                type="button"
                onClick={runExplain}
                disabled={explaining}
                title={t('chat.explainTitle')}
                className={`flex cursor-pointer items-center gap-1 rounded-[6px] border-[1.5px] px-2 py-0.5 font-mono text-[10.5px] hover:border-ink hover:text-fg disabled:cursor-default disabled:opacity-60 ${outdated && !explaining ? 'border-[#d98078] text-danger' : 'border-border bg-panel text-fgdim'}`}
              >
                {explaining ? <><span className="host-spinner h-3 w-3" /> {t('chat.explaining')}</> : expl ? <><Icon icon={faWandMagicSparkles} /> {t('chat.reExplain')}</> : <><Icon icon={faWandMagicSparkles} /> {t('chat.explain')}</>}
              </button>
              <button
                type="button"
                onClick={runReview}
                disabled={reviewing}
                title={t('chat.reviewTitle')}
                className={`flex cursor-pointer items-center gap-1 rounded-[6px] border-[1.5px] px-2 py-0.5 font-mono text-[10.5px] hover:border-ink hover:text-fg disabled:cursor-default disabled:opacity-60 ${outdated && !reviewing ? 'border-[#d98078] text-danger' : 'border-border bg-panel text-fgdim'}`}
              >
                {reviewing ? <><span className="host-spinner h-3 w-3" /> {t('chat.reviewing')}</> : hasReview ? <><Icon icon={faScaleBalanced} /> {t('chat.reReview')}</> : <><Icon icon={faScaleBalanced} /> {t('chat.autoReview')}</>}
              </button>
            </>
          )}
          {files.length > 0 && (
            <div className="flex overflow-hidden rounded-[6px] border-[1.5px] border-border">
              {['split', 'inline'].map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMode(m)}
                  className={`cursor-pointer px-2 py-0.5 font-mono text-[10px] ${
                    mode === m ? 'bg-chip font-bold text-fg' : 'bg-panel text-fgdim hover:text-fg'
                  }`}
                >
                  {m === 'split' ? t('chat.split') : t('chat.inline')}
                </button>
              ))}
            </div>
          )}
          {!noWorktree && (
            <button
              type="button"
              onClick={openEditor}
              disabled={opening}
              title={t('chat.openInVsCode')}
              className="flex cursor-pointer items-center gap-1 rounded-[6px] border-[1.5px] border-border bg-panel px-2 py-0.5 font-mono text-[10.5px] text-fgdim hover:border-ink hover:text-fg disabled:opacity-60"
            >
              {opening ? t('chat.opening') : '↗ VS Code'}
            </button>
          )}
          <button
            type="button"
            onClick={load}
            title={t('chat.refreshTitle')}
            disabled={loading}
            className="cursor-pointer rounded-[6px] border-[1.5px] border-border bg-panel px-2 py-0.5 font-mono text-[10.5px] text-fgdim hover:border-ink hover:text-fg disabled:opacity-50"
          >
            {loading ? '…' : <><Icon icon={faRotateRight} /> {t('chat.refresh')}</>}
          </button>
            </>
          ) : (
            <ChangesMenu
              noWorktree={noWorktree}
              expl={expl}
              hasReview={hasReview}
              explaining={explaining}
              reviewing={reviewing}
              mode={mode}
              setMode={setMode}
              onExplain={runExplain}
              onReview={runReview}
              onRefresh={load}
              loading={loading}
              filesCount={files.length}
              outdated={outdated}
            />
          )}
        </div>
      </div>

      {/* A new explanation arrived for a mode we're not viewing — OFFER the
          switch, never apply it: the tab must not jump under the user. */}
      {switchOffer && (
        <div className="flex shrink-0 items-center gap-2 border-b border-hair bg-chip/60 px-3.5 py-1.5 font-mono text-[11px] text-fg">
          <Icon icon={faWandMagicSparkles} />
          <span>{t('chat.explanationReadyFor', { mode: switchOffer.mode === 'work' ? t('chat.work') : switchOffer.mode === 'pr' ? 'PR' : t('chat.uncommitted') })}</span>
          <button type="button" onClick={acceptSwitchOffer} className="ml-auto cursor-pointer rounded-[6px] border-[1.5px] border-ink bg-panel px-2 py-0.5 font-bold hover:bg-chip">
            {t('chat.showIt')}
          </button>
          <button type="button" onClick={() => setSwitchOffer(null)} title={t('chat.dismiss')} className="cursor-pointer text-fgdim hover:text-fg">
            <Icon icon={faXmark} />
          </button>
        </div>
      )}
      {/* F7: approved → the Merge control lives with the diff it approves */}
      {session.metadata?.review?.state === 'approved' && !session.metadata?.merged && (
        <div className="shrink-0 border-b border-hair bg-panel px-3.5 py-1.5">
          <MergePanel session={session} dense />
        </div>
      )}
      {noWorktree ? (
        <div className="flex flex-1 items-center justify-center font-mono text-[11px] text-fgdim">
          {emptyStateText()}
        </div>
      ) : loading && files.length === 0 ? (
        <div className="flex flex-1 items-center justify-center gap-2 font-mono text-[11px] text-fgdim">
          <span className="host-spinner h-3.5 w-3.5" /> {t('chat.readingWorktree')}
        </div>
      ) : (
        <>
          <div className={`flex min-h-0 flex-1 ${desktop ? '' : 'flex-col'}`}>
            {/* Mobile: a toggle that opens the file/feature list as a sheet, so
                the diff gets full height and day-to-day movement uses the
                back/forward + prev/next controls. Desktop keeps the left rail. */}
            {!desktop && (
              <button
                type="button"
                onClick={() => setListOpen((o) => !o)}
                className="flex shrink-0 items-center gap-2 border-b border-hair bg-panel px-3 py-1.5 text-left font-mono text-[11px] text-fgdim"
              >
                <span className="font-bold text-fg">{t('chat.files')} · {files.length}</span>
                {features.length > 0 && <span>· {t('chat.featuresCount', { n: features.length })}</span>}
                <span className="ml-auto truncate text-fgdim">
                  {curFeature ? <><Icon icon={faWandMagicSparkles} /> {curFeature.title}</> : selected ? baseName(selected) : ''}
                </span>
                <span className="shrink-0"><Icon icon={listOpen ? faCaretUp : faCaretDown} /></span>
              </button>
            )}
            {/* features + file list — a persistent left rail on desktop; on
                mobile only when the sheet is open. */}
            <div className={`thin-scroll shrink-0 overflow-y-auto bg-bg ${desktop ? 'w-[260px] border-r border-hair' : listOpen ? 'max-h-[50vh] w-full border-b border-hair' : 'hidden'}`}>
              {features.length > 0 && (
                <>
                  <div className="sticky top-0 bg-bg px-3 py-1.5 font-mono text-[9.5px] font-bold tracking-wide text-fgdim uppercase">
                    {t('chat.features')} · {features.length}
                  </div>
                  {features.map((ft, i) => (
                    <button
                      key={i}
                      type="button"
                      onClick={() => navigate({ kind: 'feature', idx: i })}
                      className={`flex w-full items-start gap-2 border-b border-hair px-3 py-2 text-left ${
                        featureIdx === i ? 'bg-chip' : 'hover:bg-panel'
                      }`}
                    >
                      <span className="mt-px text-[10px]"><Icon icon={faWandMagicSparkles} /></span>
                      <span className="min-w-0 flex-1">
                        <span dir={ft.dir || 'auto'} className="block text-[11.5px] font-bold leading-snug text-fg">{ft.title}</span>
                        <span className="font-mono text-[9px] text-fgdim">{t('chat.filesCount', { n: (ft.files || []).length })}</span>
                      </span>
                    </button>
                  ))}
                  <div className="px-3 py-1.5 font-mono text-[9.5px] font-bold tracking-wide text-fgdim uppercase">
                    {t('chat.files')} · {files.length}
                  </div>
                </>
              )}
              {files.map((f, i) => {
                const cc = commentCountFor(f.path);
                return (
                  <button
                    key={f.path ?? i}
                    type="button"
                    onClick={() => navigate({ kind: 'file', path: f.path })}
                    title={f.path}
                    className={`flex w-full items-center gap-2 border-b border-hair px-3 py-1.5 text-left ${
                      featureIdx === null && f.path === selected ? 'bg-chip' : 'hover:bg-panel'
                    }`}
                  >
                    <StatusChip status={f.status} />
                    {f.staged && <span title={t('chat.staged')} className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#3C9A4E]" />}
                    {changesMode === 'work' && (f.committed || f.uncommitted) && (
                      <span className="flex shrink-0 gap-[2px]">
                        {f.committed && <span title={t('chat.committedMarker')} className="rounded-[3px] border border-[#8a8a8a] px-[3px] font-mono text-[8px] leading-[13px] text-fgdim">C</span>}
                        {f.uncommitted && <span title={t('chat.uncommittedMarker')} className="rounded-[3px] border border-[#c9a227] px-[3px] font-mono text-[8px] leading-[13px] text-[#c9a227]">U</span>}
                      </span>
                    )}
                    <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-fg">{baseName(f.path)}</span>
                    {cc > 0 && <span title={t('chat.commentsCount', { n: cc })} className="shrink-0 font-mono text-[9px] text-fgdim"><Icon icon={faComment} className="text-[8px]" />{cc}</span>}
                    {fileExpl(f.path) && <span title={t('chat.hasExplanation')} className="shrink-0 text-[9px] text-[#c9a227]"><Icon icon={faWandMagicSparkles} /></span>}
                    <span className="shrink-0 font-mono text-[10px]">
                      {f.additions != null && <span style={{ color: '#5fb56a' }}>+{f.additions}</span>}
                      {f.deletions != null && <span className="ml-1" style={{ color: '#d98078' }}>−{f.deletions}</span>}
                    </span>
                  </button>
                );
              })}
            </div>

            {/* detail */}
            <div className={`flex min-w-0 flex-col bg-bg ${fsActive ? 'fixed inset-0 z-40' : 'min-h-0 flex-1'}`}>
              {curFeature ? (
                <div className="thin-scroll min-h-0 flex-1 overflow-auto">
                  <ExplainCard label={t('chat.feature')} title={curFeature.title} body={curFeature.summary} dir={curFeature.dir || 'auto'} />
                  {curFeature.details && (
                    <div dir={curFeature.dir || 'auto'} className="mx-3 -mt-1 mb-3 text-[12px] leading-relaxed whitespace-pre-wrap text-fg">
                      {curFeature.details}
                    </div>
                  )}
                  <div className="px-3 pb-2 font-mono text-[9.5px] font-bold tracking-wide text-fgdim uppercase">{t('chat.filesInFeature')}</div>
                  {(curFeature.files || []).map((p) => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => navigate({ kind: 'file', path: p })}
                      className="flex w-full items-center gap-2 px-3.5 py-1.5 text-left hover:bg-panel"
                    >
                      <span className="text-[9px] text-[#c9a227]">→</span>
                      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-fg">{p}</span>
                    </button>
                  ))}
                  <div className="m-3 flex flex-col gap-1.5">
                    <div className="font-mono text-[9.5px] font-bold tracking-wide text-fgdim uppercase">{t('chat.comments')}</div>
                    <CommentThread comments={featureComments} {...threadProps} />
                    <CommentComposer
                      placeholder={t('chat.commentOnFeature')}
                      onSubmit={(body) => addComment({ kind: 'feature', key: curFeature.title, featureTitle: curFeature.title }, body)}
                    />
                  </div>
                </div>
              ) : !selected ? (
                <div className="flex flex-1 items-center justify-center font-mono text-[11px] text-fgdim">
                  {emptyStateText()}
                </div>
              ) : (
                <>
                  {selected && (
                    <div className="flex shrink-0 items-center gap-2 border-b border-hair bg-panel px-3 py-1.5">
                      {fromFeature && (
                        <button
                          type="button"
                          onClick={() => go(-1)}
                          title={t('chat.backToFeature', { title: fromFeature.title })}
                          className="flex shrink-0 cursor-pointer items-center gap-1 rounded-[6px] border border-[#e6d27a] bg-chip/50 px-1.5 py-0.5 font-mono text-[10px] text-fgdim hover:text-fg"
                        >
                          <span>←</span>
                          <Truncate text={fromFeature.title} className="max-w-[120px]" />
                        </button>
                      )}
                      <Truncate text={selected} className="min-w-0 font-mono text-[10.5px] text-fgdim" />
                      {diffLoading && <span className="host-spinner h-3 w-3 shrink-0" />}
                      <div className="ml-auto flex shrink-0 items-center gap-2">
                        {fileIdx >= 0 && files.length > 1 && (
                          <span className="flex overflow-hidden rounded-[6px] border border-border" title={t('chat.prevNextFile')}>
                            <button
                              type="button"
                              onClick={() => prevFile && navigate({ kind: 'file', path: prevFile.path })}
                              disabled={!prevFile}
                              title={prevFile ? t('chat.prevFile', { name: baseName(prevFile.path) }) : t('chat.noPrevFile')}
                              className="cursor-pointer px-1.5 py-0.5 font-mono text-[10px] text-fgdim hover:bg-chip hover:text-fg disabled:cursor-default disabled:opacity-30"
                            >
                              <Icon icon={faArrowUp} />
                            </button>
                            <span className="select-none border-x border-border px-1.5 py-0.5 font-mono text-[9px] text-fgdim tabular-nums">
                              {fileIdx + 1}/{files.length}
                            </span>
                            <button
                              type="button"
                              onClick={() => nextFile && navigate({ kind: 'file', path: nextFile.path })}
                              disabled={!nextFile}
                              title={nextFile ? t('chat.nextFile', { name: baseName(nextFile.path) }) : t('chat.noNextFile')}
                              className="cursor-pointer px-1.5 py-0.5 font-mono text-[10px] text-fgdim hover:bg-chip hover:text-fg disabled:cursor-default disabled:opacity-30"
                            >
                              <Icon icon={faArrowDown} />
                            </button>
                          </span>
                        )}
                        {!desktop && (
                          <button
                            type="button"
                            onClick={() => setFullscreen((f) => !f)}
                            title={fullscreen ? t('chat.exitFullscreen') : t('chat.fullscreen')}
                            aria-label={fullscreen ? t('chat.exitFullscreen') : t('chat.fullscreen')}
                            className="shrink-0 cursor-pointer rounded-[6px] border border-border px-2 py-0.5 font-mono text-[12px] leading-none text-fgdim hover:border-ink hover:text-fg"
                          >
                            <Icon icon={fullscreen ? faXmark : faExpand} />
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => setFileComposer((o) => !o)}
                          className="shrink-0 cursor-pointer rounded-[6px] border border-border px-2 py-0.5 font-mono text-[10px] text-fgdim hover:border-ink hover:text-fg"
                        >
                          <Icon icon={faComment} /> {desktop ? t('chat.commentOnFileBtn') : t('chat.commentBtn')}
                        </button>
                      </div>
                    </div>
                  )}
                  <div className="thin-scroll min-h-0 flex-1 overflow-auto">
                    {selected && fileExpl(selected)?.summary && (
                      <ExplainCard label={t('chat.whatChanged')} body={fileExpl(selected).summary} dir={fileExpl(selected).dir || 'auto'} />
                    )}
                    {(fileComments.length > 0 || fileComposer) && (
                      <div className="m-3 flex flex-col gap-1.5">
                        <CommentThread comments={fileComments} {...threadProps} />
                        {fileComposer && (
                          <CommentComposer
                            autoFocus
                            placeholder={t('chat.commentOnFile')}
                            onSubmit={(body) => { addComment({ kind: 'file', path: selected }, body); setFileComposer(false); }}
                            onCancel={() => setFileComposer(false)}
                          />
                        )}
                      </div>
                    )}
                    <DiffView
                      diff={diff}
                      mode={mode}
                      path={selected}
                      compact={!desktop}
                      comments={lineComments}
                      onAddComment={(target, body) => addComment({ ...target, path: selected }, body)}
                      commentHandlers={threadProps}
                    />
                  </div>
                </>
              )}
            </div>
          </div>

          <ReviewBar count={comments.filter((c) => !c.resolved).length} onSubmit={submitReview} mode={changesMode} desktop={desktop} />
        </>
      )}
    </div>
  );
}
