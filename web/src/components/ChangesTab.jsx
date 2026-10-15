import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowDownIcon, ArrowLeftIcon, ArrowRightIcon, ArrowUpIcon, CheckIcon, ChevronDownIcon, ChevronUpIcon, ExpandIcon, ExternalLinkIcon,
  MessageSquareIcon, MoreHorizontalIcon, RotateCwIcon, ScaleIcon, ShrinkIcon, TriangleAlertIcon, WandSparklesIcon, XIcon,
} from 'lucide-react';
import { api } from '../lib/api.js';
import { toastError, toastSuccess } from '../lib/toast.js';
import { defaultChangesMode, explanationSwitchOffer, newestExplanation, changesQuery, loadDefaultBase, saveDefaultBase, filterBaseRefs } from '../lib/changesMode.js';
import { Truncate } from './Truncate.jsx';
import { DiffView } from './DiffView.jsx';
import { CommentThread, CommentComposer } from './Comments.jsx';
import { MergePill, MergePanel } from './MergeCard.jsx';
import {
  Badge, Button, StatusDot, Tip, Textarea,
  Tabs, TabsList, TabsTrigger,
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuLabel,
  Popover, PopoverTrigger, PopoverContent,
  Command, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandItem,
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription,
} from './ui/index.js';
import { useIsDesktop } from '../lib/useMedia.js';
import { useT } from '../lib/i18n.js';
import { fmtDateTime } from '../lib/time.js';

// File status letter (M/A/D/??) — the colour is the status, the letter keeps it
// readable without colour.
const STATUS_TEXT = { A: 'text-ok', D: 'text-err', M: 'text-warn' };
function StatusLetter({ status }) {
  const s = String(status || '').trim();
  const code = s === '??' ? '??' : (s[0] || '?').toUpperCase();
  return (
    <span title={s} className={`w-4 shrink-0 text-center font-mono text-2xs font-semibold ${STATUS_TEXT[code] || 'text-muted-foreground'}`}>
      {code}
    </span>
  );
}

const baseName = (p) => String(p || '').split('/').pop();
const dirName = (p) => { const parts = String(p || '').split('/'); parts.pop(); return parts.join('/'); };

// Explanation prose — may be any language; dir comes from the skill ('rtl'/'ltr')
// or falls back to 'auto' (the browser detects per content).
function ExplainCard({ label, title, body, dir = 'auto' }) {
  const t = useT();
  if (!title && !body) return null;
  return (
    <div className="m-3 rounded-lg border border-border bg-card px-3.5 py-3" data-explain-card="">
      <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <WandSparklesIcon className="size-3.5" aria-hidden="true" />
        <span>{label}</span>
      </div>
      {title && <div dir={dir} className="text-base leading-snug font-semibold text-foreground">{title}</div>}
      {body && <div dir={dir} className="mt-1 text-sm leading-relaxed whitespace-pre-wrap text-foreground">{body}</div>}
    </div>
  );
}

const SECTION_LABEL = 'px-3 pt-3 pb-1 text-2xs font-medium text-muted-foreground';

// Sticky review bar: pending count, optional summary, local/remote target, and
// the verdict actions. `target` defaults from the changes mode (uncommitted→local,
// pr→remote) and follows mode changes until the user overrides it.
// `mergeReady`: the review is approved and the Merge control is showing — Merge
// is then the view's one primary action and Approve steps back to neutral.
function ReviewBar({ count, onSubmit, mode, desktop, mergeReady }) {
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
  const pending = t(count === 1 ? 'chat.pendingCommentOne' : 'chat.pendingCommentMany', { n: count });

  // Mobile, collapsed: a slim one-line bar — pending count + a "Review" button
  // that expands the full controls. Reclaims the footer's vertical space while reading.
  if (!full) {
    return (
      <div className="flex shrink-0 items-center gap-2 border-t border-border bg-background px-3 py-1.5" data-review-bar="collapsed">
        <span className="text-xs text-muted-foreground tabular-nums">{pending}</span>
        <Button size="sm" className="ms-auto" onClick={() => setExpanded(true)}>
          {t('chat.review')} <ChevronUpIcon className="size-3.5" />
        </Button>
      </div>
    );
  }

  return (
    <div className="shrink-0 border-t border-border bg-background px-3 py-2" data-review-bar="full">
      {open && (
        <Textarea
          dir="auto"
          rows={2}
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          placeholder={t('chat.reviewSummaryPlaceholder')}
          className="mb-2 min-h-0 resize-none text-sm"
        />
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {!desktop && (
          <Tip label={t('chat.collapse')}>
            <Button variant="ghost" size="icon-sm" aria-label={t('chat.collapse')} onClick={() => setExpanded(false)}>
              <ChevronDownIcon className="size-4" />
            </Button>
          </Tip>
        )}
        {/* where the submitted review goes: fix locally, or post to the GitHub PR */}
        <Tip label={t('chat.reviewSentTitle')}>
          <div>
            <Tabs value={target} onValueChange={pickTarget}>
              <TabsList variant="segmented">
                {['local', 'remote'].map((tg) => (
                  <TabsTrigger key={tg} value={tg} className="coarse:h-11">{tg === 'local' ? t('chat.local') : t('chat.remotePr')}</TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          </div>
        </Tip>
        <span className="text-xs text-muted-foreground tabular-nums">{pending}</span>
        <Button variant="link" size="sm" className="h-auto text-xs text-muted-foreground no-underline hover:underline" onClick={() => setOpen((o) => !o)}>
          {open ? t('chat.hideSummary') : t('chat.addSummary')}
        </Button>
        <div className="ms-auto flex flex-wrap items-center gap-2">
          <Button variant="outline" disabled={!canComment} onClick={() => submit('request-changes')}>
            <StatusDot status="err" /> {t('chat.requestChanges')}
          </Button>
          <Button variant="outline" disabled={!canComment} onClick={() => submit('comment')}>
            {t('chat.comment')}
          </Button>
          <Tip label={target === 'remote' ? t('chat.approvePrTitle') : t('chat.approveLocalTitle')}>
            <Button variant={mergeReady ? 'default' : 'primary'} onClick={() => submit('approve')}>
              <CheckIcon className="size-4" /> {approveLabel}
            </Button>
          </Tip>
        </div>
      </div>
    </div>
  );
}

// "⋯" overflow. Desktop: the rarely used actions (Open in VS Code — decision D2).
// Phone: the whole header action set (explain / review / diff view / refresh),
// so the narrow header stays clean. VS Code is omitted on a phone.
function ChangesMenu({ desktop, noWorktree, expl, hasReview, explaining, reviewing, mode, setMode, onExplain, onReview, onRefresh, onOpenEditor, opening, loading, filesCount, outdated }) {
  const t = useT();
  return (
    <DropdownMenu>
      <Tip label={t('chat.changesActions')}>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label={t('chat.changesActions')} className="relative">
            <MoreHorizontalIcon className="size-4" />
            {!desktop && outdated && <StatusDot status="err" className="absolute end-1 top-1" />}
          </Button>
        </DropdownMenuTrigger>
      </Tip>
      <DropdownMenuContent align="end" className="min-w-52">
        {!desktop && outdated && (
          <DropdownMenuLabel className="flex items-center gap-1.5 text-err" title={t('chat.analysisOutdatedTitle')}>
            <TriangleAlertIcon className="size-3.5" /> {t('chat.analysisOutdated')}
          </DropdownMenuLabel>
        )}
        {!desktop && !noWorktree && (
          <>
            <DropdownMenuItem disabled={explaining} onSelect={onExplain}>
              <WandSparklesIcon /> {explaining ? t('chat.explainingMenu') : expl ? t('chat.reExplainMenu') : t('chat.explainMenu')}
            </DropdownMenuItem>
            <DropdownMenuItem disabled={reviewing} onSelect={onReview}>
              <ScaleIcon /> {reviewing ? t('chat.reviewingMenu') : hasReview ? t('chat.reReviewMenu') : t('chat.autoReviewMenu')}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
        {!desktop && filesCount > 0 && (
          <DropdownMenuItem onSelect={() => setMode(mode === 'split' ? 'inline' : 'split')}>
            <span className="flex-1">{t('chat.diffView')}</span>
            <span className="text-xs text-muted-foreground">{mode === 'split' ? t('chat.split') : t('chat.inline')}</span>
          </DropdownMenuItem>
        )}
        {!desktop && (
          <DropdownMenuItem disabled={loading} onSelect={onRefresh}>
            <RotateCwIcon /> {loading ? t('chat.refreshingMenu') : t('chat.refreshCap')}
          </DropdownMenuItem>
        )}
        {desktop && !noWorktree && (
          <DropdownMenuItem disabled={opening} onSelect={onOpenEditor}>
            <ExternalLinkIcon className="rtl:-scale-x-100" /> {opening ? t('chat.opening') : t('chat.openInVsCode')}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// Searchable branch picker for the comparison base. '' = server default.
function BasePicker({ value, onChange, refs, defaultLabel, title }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const remote = filterBaseRefs(refs.remote, q);
  const local = filterBaseRefs(refs.local, q);
  const showDefault = !q.trim() || defaultLabel.toLowerCase().includes(q.trim().toLowerCase());
  const pick = (v) => { onChange(v); setOpen(false); setQ(''); };
  const Item = ({ v, label }) => (
    <CommandItem value={`${v}|${label || ''}`} onSelect={() => pick(v)} className={v === value ? 'font-medium' : ''}>
      <bdi dir="ltr" className="min-w-0 flex-1 truncate font-mono text-xs">{label || v}</bdi>
      {v === value && <CheckIcon className="size-3.5" />}
    </CommandItem>
  );
  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (!o) setQ(''); }}>
      <Tip label={title}>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm" className="max-w-48 font-mono text-2xs" data-base-picker="">
            <bdi dir="ltr" className="truncate">{value || defaultLabel}</bdi> <ChevronDownIcon className="size-3.5 opacity-60" />
          </Button>
        </PopoverTrigger>
      </Tip>
      <PopoverContent align="start" className="w-64 p-0">
        <Command shouldFilter={false}>
          <CommandInput value={q} onValueChange={setQ} placeholder={t('chat.baseSearch')} dir="ltr" className="font-mono text-xs" />
          <CommandList className="max-h-64">
            {showDefault && <CommandGroup><Item v="" label={defaultLabel} /></CommandGroup>}
            {remote.length > 0 && <CommandGroup heading={t('chat.remoteBranches')}>{remote.map((r) => <Item key={`r:${r}`} v={r} />)}</CommandGroup>}
            {local.length > 0 && <CommandGroup heading={t('chat.localBranches')}>{local.map((r) => <Item key={`l:${r}`} v={r} />)}</CommandGroup>}
            {!showDefault && !remote.length && !local.length && <CommandEmpty>{t('chat.baseNoMatch')}</CommandEmpty>}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
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
  // Comparison base for pr/work: '' = the session's original comparison base.
  const [defaultBase, setDefaultBase] = useState(() => loadDefaultBase(undefined, session.id));
  const [baseSel, setBaseSel] = useState(() => loadDefaultBase(undefined, session.id));
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
  }, [active, session.id, baseSel, session.metadata?.base, session.metadata?.prBase, session.metadata?.worktree]);

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
  }, [session.id, modeQ, session.metadata?.base, session.metadata?.prBase, session.metadata?.worktree]);

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

  // totals + duplicate base names (shown with their folder so two `index.js` stay apart)
  const totalAdd = files.reduce((n, f) => n + (f.additions || 0), 0);
  const totalDel = files.reduce((n, f) => n + (f.deletions || 0), 0);
  const nameCount = new Map();
  for (const f of files) nameCount.set(baseName(f.path), (nameCount.get(baseName(f.path)) || 0) + 1);

  const modeLabel = (m) => (m === 'work' ? t('chat.work') : m === 'uncommitted' ? t('chat.uncommitted') : 'PR');
  const switchMode = (m) => { modeTouchedRef.current = true; setChangesMode(m); setFeatureIdx(null); setSelected(null); resetHistory(); };
  const modeTip = (m) => (m === 'pr' && !prAvailable ? t('chat.prNotAvailable') : m === 'work' ? t('chat.compareWork') : m === 'uncommitted' ? t('chat.compareHead') : t('chat.compareMain'));

  // Features + files — a persistent left rail on desktop, a bottom sheet on a phone.
  const lists = (
    <div data-changes-lists="">
      {features.length > 0 && (
        <>
          <div className={SECTION_LABEL}>{t('chat.features')} · {features.length}</div>
          <div className="flex flex-col gap-px px-1.5">
            {features.map((ft, i) => (
              <button
                key={i}
                type="button"
                onClick={() => navigate({ kind: 'feature', idx: i })}
                className={`flex min-h-9 w-full cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 text-start hover:bg-muted coarse:min-h-11 ${featureIdx === i ? 'row-selected' : ''}`}
              >
                <WandSparklesIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  <span dir={ft.dir || 'auto'} className="block text-sm leading-snug font-medium text-foreground">{ft.title}</span>
                  <span className="text-xs text-muted-foreground tabular-nums">{t('chat.filesCount', { n: (ft.files || []).length })}</span>
                </span>
              </button>
            ))}
          </div>
        </>
      )}
      <div className={SECTION_LABEL}>{t('chat.files')} · {files.length}</div>
      <div className="flex flex-col gap-px px-1.5 pb-3">
        {files.map((f, i) => {
          const cc = commentCountFor(f.path);
          const dup = nameCount.get(baseName(f.path)) > 1;
          return (
            <button
              key={f.path ?? i}
              type="button"
              onClick={() => navigate({ kind: 'file', path: f.path })}
              title={f.path}
              data-file-row={f.path}
              className={`flex min-h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-start text-sm hover:bg-muted coarse:min-h-11 ${featureIdx === null && f.path === selected ? 'row-selected' : ''}`}
            >
              <StatusLetter status={f.status} />
              {f.staged && <StatusDot status="ok" title={t('chat.staged')} />}
              <span dir="ltr" className="min-w-0 flex-1 truncate text-start">
                <bdi className="font-mono text-xs text-foreground">{baseName(f.path)}</bdi>
                {dup && <bdi className="ms-1.5 font-mono text-2xs text-muted-foreground">{dirName(f.path)}</bdi>}
              </span>
              {changesMode === 'work' && (f.committed || f.uncommitted) && (
                <span className="flex shrink-0 gap-0.5">
                  {f.committed && <span title={t('chat.committedMarker')} className="rounded-sm bg-muted px-1 text-2xs leading-4 text-muted-foreground">C</span>}
                  {f.uncommitted && <span title={t('chat.uncommittedMarker')} className="flex items-center gap-1 rounded-sm bg-muted px-1 text-2xs leading-4 text-muted-foreground"><StatusDot status="warn" className="size-1" />U</span>}
                </span>
              )}
              {cc > 0 && <span title={t('chat.commentsCount', { n: cc })} className="flex shrink-0 items-center gap-0.5 text-2xs text-muted-foreground tabular-nums"><MessageSquareIcon className="size-3" />{cc}</span>}
              {fileExpl(f.path) && <span title={t('chat.hasExplanation')} className="shrink-0 text-muted-foreground"><WandSparklesIcon className="size-3" /></span>}
              <span dir="ltr" className="shrink-0 font-mono text-2xs tabular-nums">
                {f.additions != null && <span className="text-ok">+{f.additions}</span>}
                {f.deletions != null && <span className="ms-1 text-err">−{f.deletions}</span>}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );

  const mergeReady = session.metadata?.review?.state === 'approved' && !session.metadata?.merged;
  const md = session.metadata || {};
  const pillShown = !!(md.merged || ((md.review?.state === 'approved' || md.review?.state === 'changes-requested') && md.branch));
  const hasMeta = desktop ? !!(data?.branch || files.length > 0 || expl || outdated || pillShown) : !!(outdated || pillShown);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background" data-changes-tab="">
      <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1.5 border-b border-border bg-background px-3 py-2">
        <h2 className="me-1 text-base font-semibold text-foreground">{t('chat.changes')}</h2>
        {!noWorktree && history.length > 1 && (
          <span className="flex items-center" title={t('chat.navViewedFiles')}>
            <Tip label={t('chat.back')} shortcut="Alt ←">
              <Button variant="ghost" size="icon-sm" aria-label={t('chat.back')} onClick={() => go(-1)} disabled={!canBack}>
                <ArrowLeftIcon className="size-4 rtl:-scale-x-100" />
              </Button>
            </Tip>
            <Tip label={t('chat.forward')} shortcut="Alt →">
              <Button variant="ghost" size="icon-sm" aria-label={t('chat.forward')} onClick={() => go(1)} disabled={!canFwd}>
                <ArrowRightIcon className="size-4 rtl:-scale-x-100" />
              </Button>
            </Tip>
          </span>
        )}
        {!noRepo && (
          <Tabs value={changesMode} onValueChange={switchMode} data-changes-modes="">
            <TabsList variant="segmented">
              {(workAvailable ? ['work', 'uncommitted', 'pr'] : ['uncommitted', 'pr']).map((m) => (
                <Tip key={m} label={modeTip(m)}>
                  <span className="inline-flex">
                    <TabsTrigger value={m} disabled={m === 'pr' && !prAvailable} className="coarse:h-11">{modeLabel(m)}</TabsTrigger>
                  </span>
                </Tip>
              ))}
            </TabsList>
          </Tabs>
        )}
        {(changesMode === 'work' || changesMode === 'pr') && refs && (
          <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
            {t('chat.compareAgainst')}
            <BasePicker
              value={baseSel}
              onChange={setBaseSel}
              refs={refs}
              defaultLabel={t('chat.baseDefault', { base: refs.defaultRef || data?.baseRef || '…' })}
              title={t('chat.comparedAgainstTitle', { base: data?.baseRef || '' })}
            />
            {baseSel !== defaultBase && (
              <Tip label={t('chat.setBaseDefaultTitle')}>
                <Button variant="ghost" size="xs" onClick={() => { saveDefaultBase(baseSel, undefined, session.id); setDefaultBase(baseSel); }}>
                  {t('chat.setBaseDefault')}
                </Button>
              </Tip>
            )}
          </span>
        )}
        <div className="ms-auto flex items-center gap-1.5">
          {/* B14: not a git repo → nothing to explain/review/refresh or to switch between */}
          {noRepo ? null : desktop ? (
            <>
              {!noWorktree && (
                <>
                  <Tip label={t('chat.explainTitle')}>
                    <Button variant="outline" size="sm" onClick={runExplain} disabled={explaining} data-action="explain">
                      {explaining ? <><span className="host-spinner h-3 w-3" /> {t('chat.explaining')}</> : <><WandSparklesIcon className="size-3.5" /> {expl ? t('chat.reExplainMenu') : t('chat.explainMenu')}{outdated && <StatusDot status="err" />}</>}
                    </Button>
                  </Tip>
                  <Tip label={t('chat.reviewTitle')}>
                    <Button variant="outline" size="sm" onClick={runReview} disabled={reviewing} data-action="auto-review">
                      {reviewing ? <><span className="host-spinner h-3 w-3" /> {t('chat.reviewing')}</> : <><ScaleIcon className="size-3.5" /> {hasReview ? t('chat.reReviewMenu') : t('chat.autoReviewMenu')}{outdated && <StatusDot status="err" />}</>}
                    </Button>
                  </Tip>
                </>
              )}
              {files.length > 0 && (
                <Tabs value={mode} onValueChange={setMode} data-diff-layout="">
                  <TabsList variant="segmented">
                    {['split', 'inline'].map((m) => (
                      <TabsTrigger key={m} value={m}>{m === 'split' ? t('chat.split') : t('chat.inline')}</TabsTrigger>
                    ))}
                  </TabsList>
                </Tabs>
              )}
              <Tip label={t('chat.refreshTitle')}>
                <Button variant="ghost" size="icon-sm" aria-label={t('chat.refresh')} onClick={load} disabled={loading} data-action="refresh">
                  <RotateCwIcon className={`size-4 ${loading ? 'animate-spin' : ''}`} />
                </Button>
              </Tip>
              {/* QA round 1: the editor action is a visible button again (it was behind "⋯"
                  next to its visible neighbours); the desktop "⋯" menu held nothing else */}
              {!noWorktree && (
                <Tip label={t('chat.openInVsCode')}>
                  <Button variant="outline" size="sm" onClick={openEditor} disabled={opening} data-action="open-editor">
                    <ExternalLinkIcon className="size-3.5 rtl:-scale-x-100" /> {opening ? t('chat.opening') : t('chat.openInVsCodeShort')}
                  </Button>
                </Tip>
              )}
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

      {/* context line — branch, size, review state: facts, not actions. On a
          phone only the merge state and the outdated warning stay. */}
      {hasMeta && (
        <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-border px-3 py-1.5 text-xs text-muted-foreground" data-changes-meta="">
          {desktop && data?.branch && <Badge mono title={data.branch}><bdi dir="ltr" className="max-w-48 truncate">{data.branch}</bdi></Badge>}
          <MergePill session={session} compact={!desktop} />
          {desktop && files.length > 0 && (
            <span className="tabular-nums">
              {t('chat.filesCount', { n: files.length })}
              <span dir="ltr" className="ms-2 font-mono text-2xs"><span className="text-ok">+{totalAdd}</span> <span className="text-err">−{totalDel}</span></span>
            </span>
          )}
          {desktop && expl && (
            <Badge title={(expl.language ? t('chat.explainedInLang', { lang: expl.language }) : t('chat.explained')) + (expl.generatedAt ? ' · ' + fmtDateTime(expl.generatedAt) : '')}>
              <WandSparklesIcon /> {t('chat.explained')}{expl.language ? ` · ${expl.language}` : ''}
            </Badge>
          )}
          {outdated && (
            <Badge status="err" title={t('chat.outdatedTitle')}><TriangleAlertIcon /> {t('chat.outdated')}</Badge>
          )}
        </div>
      )}

      {/* A new explanation arrived for a mode we're not viewing — OFFER the
          switch, never apply it: the tab must not jump under the user. */}
      {switchOffer && (
        <div className="flex shrink-0 items-center gap-2 border-b border-border bg-muted/50 px-3 py-1.5 text-sm text-foreground" data-switch-offer="">
          <WandSparklesIcon className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1">{t('chat.explanationReadyFor', { mode: modeLabel(switchOffer.mode) })}</span>
          <Button variant="outline" size="sm" onClick={acceptSwitchOffer}>{t('chat.showIt')}</Button>
          <Tip label={t('chat.dismiss')}>
            <Button variant="ghost" size="icon-sm" aria-label={t('chat.dismiss')} onClick={() => setSwitchOffer(null)}><XIcon className="size-4" /></Button>
          </Tip>
        </div>
      )}
      {/* F7: approved → the Merge control lives with the diff it approves */}
      {mergeReady && (
        <div className="shrink-0 border-b border-border bg-card/60 px-3 py-1" data-merge-strip="">
          <MergePanel session={session} dense />
        </div>
      )}
      {noWorktree ? (
        <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">
          {emptyStateText()}
        </div>
      ) : loading && files.length === 0 ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
          <span className="host-spinner h-3.5 w-3.5" /> {t('chat.readingWorktree')}
        </div>
      ) : (
        <>
          <div className={`flex min-h-0 flex-1 ${desktop ? '' : 'flex-col'}`}>
            {/* Phone: one bar that opens the file/feature list as a bottom sheet, so
                the diff gets the full height and day-to-day movement uses the
                back/forward + prev/next controls. Desktop keeps the left rail. */}
            {!desktop && (
              <>
                <button
                  type="button"
                  onClick={() => setListOpen(true)}
                  className="flex min-h-11 shrink-0 cursor-pointer items-center gap-2 border-b border-border bg-background px-3 text-start text-sm"
                  data-files-toggle=""
                >
                  <span className="font-medium text-foreground tabular-nums">{t('chat.files')} · {files.length}</span>
                  {features.length > 0 && <span className="text-muted-foreground">· {t('chat.featuresCount', { n: features.length })}</span>}
                  <span dir="auto" className="ms-auto min-w-0 truncate text-muted-foreground">
                    {curFeature ? curFeature.title : selected ? baseName(selected) : ''}
                  </span>
                  <ChevronUpIcon className="size-4 shrink-0 text-muted-foreground" />
                </button>
                <Sheet open={listOpen} onOpenChange={setListOpen}>
                  <SheetContent side="bottom" className="gap-0 p-0" data-files-sheet="">
                    <SheetHeader className="px-4 pt-1 pb-2">
                      <SheetTitle>{t('chat.files')} · {files.length}</SheetTitle>
                      <SheetDescription className="sr-only">{t('chat.navViewedFiles')}</SheetDescription>
                    </SheetHeader>
                    <div className="thin-scroll min-h-0 flex-1 overflow-y-auto">{lists}</div>
                  </SheetContent>
                </Sheet>
              </>
            )}
            {desktop && (
              <div className="thin-scroll w-64 shrink-0 overflow-y-auto border-e border-border bg-background">{lists}</div>
            )}

            {/* detail */}
            <div className={`flex min-w-0 flex-col bg-background ${fsActive ? 'fixed inset-0 z-40' : 'min-h-0 flex-1'}`}>
              {curFeature ? (
                <div className="thin-scroll min-h-0 flex-1 overflow-auto">
                  <ExplainCard label={t('chat.feature')} title={curFeature.title} body={curFeature.summary} dir={curFeature.dir || 'auto'} />
                  {curFeature.details && (
                    <div dir={curFeature.dir || 'auto'} className="mx-3.5 -mt-1 mb-3 text-sm leading-relaxed whitespace-pre-wrap text-foreground">
                      {curFeature.details}
                    </div>
                  )}
                  <div className={SECTION_LABEL}>{t('chat.filesInFeature')}</div>
                  <div className="flex flex-col gap-px px-1.5">
                    {(curFeature.files || []).map((p) => (
                      <button
                        key={p}
                        type="button"
                        onClick={() => navigate({ kind: 'file', path: p })}
                        className="flex min-h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-start hover:bg-muted coarse:min-h-11"
                      >
                        <ArrowRightIcon className="size-3.5 shrink-0 text-muted-foreground rtl:-scale-x-100" />
                        <bdi dir="ltr" className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">{p}</bdi>
                      </button>
                    ))}
                  </div>
                  <div className="m-3 flex flex-col gap-2">
                    <div className="text-2xs font-medium text-muted-foreground">{t('chat.comments')}</div>
                    <CommentThread comments={featureComments} {...threadProps} />
                    <CommentComposer
                      placeholder={t('chat.commentOnFeature')}
                      onSubmit={(body) => addComment({ kind: 'feature', key: curFeature.title, featureTitle: curFeature.title }, body)}
                    />
                  </div>
                </div>
              ) : !selected ? (
                <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">
                  {emptyStateText()}
                </div>
              ) : (
                <>
                  <div className="flex min-h-10 shrink-0 items-center gap-2 border-b border-border bg-background px-3 py-1" data-file-bar="">
                    {fromFeature && (
                      <Tip label={t('chat.backToFeature', { title: fromFeature.title })}>
                        <Button variant="outline" size="xs" onClick={() => go(-1)} className="max-w-40">
                          <ArrowLeftIcon className="rtl:-scale-x-100" />
                          <Truncate text={fromFeature.title} />
                        </Button>
                      </Tip>
                    )}
                    <Truncate text={selected} className="min-w-0 flex-1 text-start font-mono text-xs text-muted-foreground"><bdi dir="ltr">{selected}</bdi></Truncate>
                    {diffLoading && <span className="host-spinner h-3 w-3 shrink-0" />}
                    <div className="flex shrink-0 items-center gap-1.5">
                      {fileIdx >= 0 && files.length > 1 && (
                        <span className="flex items-center" title={t('chat.prevNextFile')}>
                          <Tip label={prevFile ? t('chat.prevFile', { name: baseName(prevFile.path) }) : t('chat.noPrevFile')}>
                            <Button variant="ghost" size="icon-sm" aria-label={t('chat.noPrevFile')} onClick={() => prevFile && navigate({ kind: 'file', path: prevFile.path })} disabled={!prevFile}>
                              <ArrowUpIcon className="size-4" />
                            </Button>
                          </Tip>
                          <span className="min-w-8 text-center text-xs text-muted-foreground tabular-nums select-none">{fileIdx + 1}/{files.length}</span>
                          <Tip label={nextFile ? t('chat.nextFile', { name: baseName(nextFile.path) }) : t('chat.noNextFile')}>
                            <Button variant="ghost" size="icon-sm" aria-label={t('chat.noNextFile')} onClick={() => nextFile && navigate({ kind: 'file', path: nextFile.path })} disabled={!nextFile}>
                              <ArrowDownIcon className="size-4" />
                            </Button>
                          </Tip>
                        </span>
                      )}
                      {!desktop && (
                        <Button variant="ghost" size="icon-sm" onClick={() => setFullscreen((f) => !f)} aria-label={fullscreen ? t('chat.exitFullscreen') : t('chat.fullscreen')}>
                          {fullscreen ? <ShrinkIcon className="size-4" /> : <ExpandIcon className="size-4" />}
                        </Button>
                      )}
                      <Button variant="outline" size="sm" onClick={() => setFileComposer((o) => !o)}>
                        <MessageSquareIcon className="size-3.5" /> {desktop ? t('chat.commentOnFileBtn') : t('chat.commentBtn')}
                      </Button>
                    </div>
                  </div>
                  <div className="thin-scroll min-h-0 flex-1 overflow-auto">
                    {selected && fileExpl(selected)?.summary && (
                      <ExplainCard label={t('chat.whatChanged')} body={fileExpl(selected).summary} dir={fileExpl(selected).dir || 'auto'} />
                    )}
                    {(fileComments.length > 0 || fileComposer) && (
                      <div className="m-3 flex flex-col gap-2">
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

          <ReviewBar count={comments.filter((c) => !c.resolved).length} onSubmit={submitReview} mode={changesMode} desktop={desktop} mergeReady={mergeReady} />
        </>
      )}
    </div>
  );
}
