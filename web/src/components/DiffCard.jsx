// Inline diff card for edit-type tool events (Edit / MultiEdit / Write /
// NotebookEdit / codex fileChange). The model comes from lib/editDiff.js; this
// file is only presentation. Code is always LTR + monospace and scrolls
// sideways (no wrapping); the labels around it follow the pane's direction.
import { useEffect, useState } from 'react';
import { buildCards } from '../lib/editDiff.js';
import { loadFullChatEvent } from '../lib/store.js';
import { useT } from '../lib/i18n.js';
import { CheckIcon, ChevronDownIcon, CopyIcon, FileDiffIcon } from 'lucide-react';
import { Button, Tip, TooltipProvider } from './ui/index.js';

export const PREVIEW_LINES = 14;
export const MAX_RENDER = 400;

const ADD_BG = 'var(--diff-add-bg)';
const DEL_BG = 'var(--diff-del-bg)';
const GAP_BG = 'var(--diff-gap-bg)';
const ADD_FG = 'var(--diff-add-mark)'; // same mark colour as the Changes tab diff
const DEL_FG = 'var(--diff-del-mark)';
const TAP = 'coarse:min-h-11';

// rows → the slice to draw for `limit` code lines (gaps are free).
export function visibleRows(rows, limit) {
  const out = [];
  let n = 0;
  for (const r of rows) {
    if (r.t !== 'gap') { if (n >= limit) break; n++; }
    out.push(r);
  }
  while (out.length && out[out.length - 1].t === 'gap') out.pop();
  return out;
}
export const codeLines = (rows) => rows.reduce((n, r) => n + (r.t === 'gap' ? 0 : 1), 0);

function CopyPath({ path }) {
  const t = useT();
  const [done, setDone] = useState(false);
  return (
    <TooltipProvider>
    <Tip label={t('chat.diff.copyPath')}>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={t('chat.diff.copyPath')}
        onClick={async (e) => {
          e.stopPropagation();
          try { await navigator.clipboard.writeText(path); setDone(true); setTimeout(() => setDone(false), 1200); } catch { /* denied */ }
        }}
      >
        {done ? <CheckIcon /> : <CopyIcon />}
      </Button>
    </Tip>
    </TooltipProvider>
  );
}

function Tokens({ tokens, text }) {
  if (!tokens || !tokens.length) return <>{text || ' '}</>;
  return <>{tokens.map((k, i) => (k.c ? <span key={i} className={k.c}>{k.v}</span> : k.v))}</>;
}

export function DiffBody({ rows, path, tokens }) {
  const t = useT();
  return (
    <div dir="ltr" className="diff-syntax thin-scroll overflow-x-auto font-mono text-xs leading-[1.6]" data-diff-body>
      <div className="w-max min-w-full">
        {rows.map((r, i) => {
          if (r.t === 'gap') {
            return (
              <div key={i} className="px-2 py-px text-2xs text-[var(--term-faint)] select-none" style={{ background: GAP_BG }}>
                {r.count ? `⋯ ${t('chat.diff.unchanged', { n: r.count })}` : '⋯'}
              </div>
            );
          }
          const bg = r.t === 'add' ? ADD_BG : r.t === 'del' ? DEL_BG : undefined;
          const num = r.t === 'del' ? r.o : r.n;
          return (
            <div key={i} data-row={r.t} className="flex" style={{ background: bg, boxShadow: r.t === 'ctx' ? undefined : `inset 2px 0 0 ${r.t === 'add' ? ADD_FG : DEL_FG}` }}>
              <span className="sticky left-0 z-[1] w-9 shrink-0 pe-1.5 text-right text-[var(--term-faint)] tabular-nums select-none" style={{ background: bg ? `linear-gradient(${bg},${bg}), var(--term-codebg)` : 'var(--term-codebg)' }}>{num ?? ''}</span>
              <span className="w-3 shrink-0 text-center select-none" style={{ color: r.t === 'add' ? ADD_FG : r.t === 'del' ? DEL_FG : 'transparent' }}>{r.t === 'add' ? '+' : r.t === 'del' ? '−' : ' '}</span>
              <span className={`whitespace-pre pe-3 ${r.t === 'ctx' ? 'text-[var(--term-dim)]' : 'text-[var(--term-fg)]'}`}><Tokens tokens={tokens?.get(i)} text={r.text} /></span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Card({ c, sessionId }) {
  const t = useT();
  const total = codeLines(c.rows);
  const isNew = c.kind === 'create';
  const collapsedStart = isNew && total > PREVIEW_LINES;
  const [expanded, setExpanded] = useState(false);
  const [hidden, setHidden] = useState(collapsedStart);
  const limit = expanded ? MAX_RENDER : hidden ? 0 : PREVIEW_LINES;
  const rows = visibleRows(c.rows, limit);
  const shown = codeLines(rows);
  const more = total - shown;
  const [tokens, setTokens] = useState(null);

  // Lazy syntax highlighting — the lowlight bundle is only fetched when a card shows code.
  useEffect(() => {
    if (!rows.length) { setTokens(null); return undefined; }
    let live = true;
    import('../lib/highlight.js').then((m) => {
      if (!live || !m.langFor(c.path)) return;
      const lines = rows.map((r, i) => ({ type: r.t === 'gap' ? 'hunk' : r.t, text: r.text, li: i }));
      setTokens(m.highlightDiff(lines, c.path));
    }).catch(() => {});
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c.path, shown, c.rows]);

  const toggleLabel = expanded
    ? t('chat.diff.collapse')
    : hidden ? t('chat.diff.showAll', { n: total }) : t('chat.diff.showMore', { n: more });
  const canToggle = expanded || more > 0 || hidden;
  const tooLarge = expanded && total > MAX_RENDER;
  const onToggle = () => {
    if (expanded) { setExpanded(false); setHidden(collapsedStart); } else { setExpanded(true); setHidden(false); }
  };

  return (
    <div
      data-diff-card={c.path}
      data-not-applied={c.notApplied ? '1' : undefined}
      className={`my-2 min-w-0 overflow-hidden rounded-lg border border-[var(--term-border)] bg-[var(--term-codebg)] ${c.notApplied ? 'opacity-70' : ''}`}
    >
      <div className="flex min-w-0 items-center gap-2 border-b border-[var(--term-border)] ps-3 pe-1.5 py-1 text-xs">
        <FileDiffIcon className="size-3.5 shrink-0 text-[var(--term-faint)]" />
        <span dir="ltr" className="flex min-w-0 flex-1 items-baseline overflow-hidden whitespace-nowrap" title={c.path}>
          {c.dir && <span className="min-w-0 truncate text-[var(--term-faint)]">{c.dir}</span>}
          <bdi dir="ltr" className="shrink-0 font-medium text-[var(--term-fg)]">{c.base || c.path}</bdi>
        </span>
        {isNew && <span className="shrink-0 rounded-sm bg-[var(--term-hover)] px-1.5 text-2xs text-[var(--term-dim)]">{t('chat.diff.newFile')}</span>}
        <span dir="ltr" className={`shrink-0 whitespace-nowrap tabular-nums ${c.notApplied ? 'line-through opacity-60' : ''}`}>
          <span className="text-diffadd">+{c.add}</span>
          <span className="ms-1.5 text-diffdel">−{c.del}</span>
        </span>
        <CopyPath path={c.path} />
      </div>
      {c.notApplied && (
        <div className="border-b border-[var(--term-border)] px-3 py-1.5 text-xs text-[var(--term-dim)]" data-not-applied-note>
          {t('chat.diff.notApplied')}
          <span dir="auto" className="mx-1.5 text-[var(--term-faint)]">{c.notApplied.length > 120 ? `${c.notApplied.slice(0, 120)}…` : c.notApplied}</span>
        </div>
      )}
      {c.rows.length === 0 && !c.notApplied && (
        <div className="px-3 py-1.5 text-xs text-[var(--term-faint)]">{t('chat.diff.noChange')}</div>
      )}
      {rows.length > 0 && <DiffBody rows={rows} path={c.path} tokens={tokens} />}
      {tooLarge && (
        <div className="flex flex-wrap items-center gap-x-3 border-t border-[var(--term-border)] px-3 py-1.5 text-xs text-[var(--term-dim)]">
          <span>{t('chat.diff.tooLarge', { shown: MAX_RENDER, total })}</span>
          <button
            type="button"
            onClick={() => window.dispatchEvent(new CustomEvent('host:open-changes', { detail: { sessionId } }))}
            className={`cursor-pointer text-[var(--term-fg)] underline underline-offset-2 ${TAP}`}
          >
            {t('chat.diff.openChanges')}
          </button>
        </div>
      )}
      {canToggle && (
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          className={`flex w-full cursor-pointer items-center justify-center gap-1.5 border-t border-[var(--term-border)] px-3 py-1.5 text-xs text-[var(--term-dim)] hover:bg-[var(--term-hover)] hover:text-[var(--term-fg)] ${TAP}`}
        >
          <ChevronDownIcon className={`size-3.5 transition-transform ${expanded ? 'rotate-180' : ''}`} />
          {toggleLabel}
        </button>
      )}
    </div>
  );
}

// One edit event → its card(s). A clipped row pulls its full copy first.
export default function DiffCard({ event, result, sessionId }) {
  const t = useT();
  useEffect(() => {
    if (event.clipped && event.seq) loadFullChatEvent(sessionId, event.seq);
  }, [event.clipped, event.seq, sessionId]);
  const model = buildCards(event, result);
  if (!model) return null;
  if (event.clipped) {
    return (
      <div className="my-2 rounded-lg border border-[var(--term-border)] bg-[var(--term-codebg)] px-3 py-2 text-xs text-[var(--term-faint)]" data-diff-loading>
        <span className="host-spinner me-1.5 inline-block size-3" />
        <bdi dir="ltr" className="text-[var(--term-dim)]">{model.cards[0]?.path}</bdi> {t('chat.diff.loading')}
      </div>
    );
  }
  return (
    <>
      {model.cards.map((c, i) => <Card key={`${c.path}:${i}`} c={c} sessionId={sessionId} />)}
    </>
  );
}
