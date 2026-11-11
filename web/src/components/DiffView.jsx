// Renders a git unified diff like an editor — side-by-side (default) or inline.
// Supports GitHub-style per-line review comments: hover a line for a "+", which
// opens an inline composer; existing comments render as threads under the line.
// Colours come from the shared --diff-* tokens (index.css), the same ones the
// chat DiffCard uses, so a diff reads the same in both places.
import { useEffect, useMemo, useState } from 'react';
import { PlusIcon } from 'lucide-react';
import { CommentThread, CommentComposer } from './Comments.jsx';
import { useT } from '../lib/i18n.js';

// Render a line of code as syntax-highlighted spans (lowlight tokens) when we
// have them, else as plain text. Whitespace is preserved by the parent's
// `whitespace-pre`. An empty line still needs a space so the row has height.
function Code({ tokens, text }) {
  const cls = 'min-w-0 flex-1 pe-3 break-words whitespace-pre-wrap text-foreground';
  if (!tokens || !tokens.length) return <span className={cls}>{text || ' '}</span>;
  return (
    <span className={cls}>
      {tokens.map((t, i) => (t.c ? <span key={i} className={t.c}>{t.v}</span> : t.v))}
    </span>
  );
}

// type → row tint / gutter tint / sign colour (all from the shared tokens)
const TINT = {
  add: { row: 'var(--diff-add-bg)', gutter: 'var(--diff-add-gutter)', mark: 'var(--diff-add-mark)', sign: '+' },
  del: { row: 'var(--diff-del-bg)', gutter: 'var(--diff-del-gutter)', mark: 'var(--diff-del-mark)', sign: '−' },
};
// Long lines wrap (indentation kept) instead of scrolling each row on its own.
const ROW = 'flex min-w-0 text-start font-mono text-2xs leading-[1.6] coarse:min-h-7';

// Flat line model: {type:'hunk'|'ctx'|'del'|'add', oldN?, newN?, text, li, label}
// li = stable index among non-hunk lines; label = "L<n>" used as the comment anchor.
function parseDiff(diff) {
  const out = [];
  let oldN = 0, newN = 0, li = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('@@')) {
      const m = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)/.exec(line);
      oldN = m ? +m[1] : 0;
      newN = m ? +m[2] : 0;
      out.push({ type: 'hunk', text: (m && m[3].trim()) || '' });
      continue;
    }
    if (!out.length) continue; // file headers precede the first hunk
    const c = line[0];
    const text = line.slice(1);
    if (c === ' ') { out.push({ type: 'ctx', oldN, newN, text, li: li++, label: `L${newN}` }); oldN++; newN++; }
    else if (c === '-') { out.push({ type: 'del', oldN, text, li: li++, label: `L${oldN}` }); oldN++; }
    else if (c === '+') { out.push({ type: 'add', newN, text, li: li++, label: `L${newN}` }); newN++; }
  }
  return out;
}

function toSplitRows(lines) {
  const rows = [];
  let dels = [], adds = [];
  const flush = () => {
    const n = Math.max(dels.length, adds.length);
    for (let k = 0; k < n; k++) rows.push({ left: dels[k] || null, right: adds[k] || null });
    dels = []; adds = [];
  };
  for (const l of lines) {
    if (l.type === 'hunk') { flush(); rows.push({ hunk: l.text }); }
    else if (l.type === 'ctx') { flush(); rows.push({ left: { ...l, n: l.oldN, ctx: true }, right: { ...l, n: l.newN, ctx: true } }); }
    else if (l.type === 'del') dels.push({ ...l, n: l.oldN });
    else if (l.type === 'add') adds.push({ ...l, n: l.newN });
  }
  flush();
  return rows;
}

const Gutter = ({ n, compact, tint }) => (
  <span
    className={`inline-block shrink-0 select-none border-e border-border/60 text-end text-muted-foreground tabular-nums ${compact ? 'w-8 pe-1.5' : 'w-11 pe-2'}`}
    style={tint ? { background: tint.gutter } : undefined}
  >
    {n ?? ''}
  </span>
);

const Sign = ({ tint }) => (
  <span className="w-4 shrink-0 text-center select-none" style={{ color: tint ? tint.mark : 'transparent' }}>{tint ? tint.sign : ' '}</span>
);

function HunkRow({ text }) {
  // B18: source text is LTR even when the cockpit is RTL (Hebrew)
  return <div dir="ltr" className="border-y border-border/50 bg-[var(--diff-hunk-bg)] px-3 py-0.5 text-start font-mono text-2xs text-muted-foreground">{text || '⋯'}</div>;
}

// The "+" add-comment affordance, shown on row hover (always on touch). Code
// rows are forced LTR, so the physical `left` is the gutter side in both
// directions.
function AddBtn({ onClick }) {
  const t = useT();
  return (
    <button
      type="button"
      onClick={onClick}
      title={t('chat.addCommentLine')}
      aria-label={t('chat.addCommentLine')}
      className="absolute left-1 top-1/2 z-10 hidden size-4 -translate-y-1/2 cursor-pointer items-center justify-center rounded-sm border border-border bg-card text-muted-foreground shadow-sm hover:bg-foreground hover:text-background focus-visible:flex group-hover:flex coarse:flex coarse:size-6 coarse:after:absolute coarse:after:-inset-[11px]"
    >
      <PlusIcon className="size-3" />
    </button>
  );
}

// Comment block (threads + open composer) rendered under a diff line.
function LineComments({ lis, byLi, openLi, onAdd, handlers = {}, onClose, label }) {
  const t = useT();
  const here = lis.filter((li) => byLi.get(li)?.length || openLi === li);
  if (!here.length) return null;
  return (
    <div className="border-y border-border/60 bg-muted/40 px-3 py-2 md:ps-12">
      {lis.map((li) =>
        (byLi.get(li)?.length || openLi === li) ? (
          <div key={li} className="flex flex-col gap-2 py-0.5">
            <CommentThread comments={byLi.get(li) || []} {...handlers} />
            {openLi === li && (
              <CommentComposer
                autoFocus
                placeholder={t('chat.commentOnLine', { label: label(li) })}
                onSubmit={(body) => onAdd(li, label(li), body)}
                onCancel={onClose}
              />
            )}
          </div>
        ) : null
      )}
    </div>
  );
}

function SideCell({ cell, kind, tokens, compact }) {
  const tint = cell && !cell.ctx ? TINT[kind] : null;
  return (
    <div
      dir="ltr"
      className={ROW}
      style={{ background: cell ? tint?.row : 'var(--diff-gap-bg)' }}
    >
      {cell && (
        <>
          <Gutter n={cell.n} compact={compact} tint={tint} />
          <Sign tint={tint} />
          <Code tokens={tokens} text={cell.text} />
        </>
      )}
    </div>
  );
}

export function DiffView({ diff, mode = 'split', comments = [], onAddComment, commentHandlers = {}, path, compact = false }) {
  const t = useT();
  const [openLi, setOpenLi] = useState(null);
  // Parse + syntax-highlight once per (diff, path); coloring is class-based so
  // it's theme-independent (the .diff-syntax CSS palette follows the theme).
  const lines = useMemo(() => (diff == null ? [] : parseDiff(diff)), [diff]);
  // The highlighter (lowlight + its grammars, ~0.4 MB) is its own chunk: lines render plain at once
  // and take their colours when it arrives — same row heights, so nothing shifts.
  const [tokens, setTokens] = useState(null);
  useEffect(() => {
    let live = true;
    setTokens(null);
    import('../lib/highlight.js').then((m) => { if (live) setTokens(m.highlightDiff(lines, path)); }).catch(() => {});
    return () => { live = false; };
  }, [lines, path]);
  const tok = (li) => (tokens ? tokens.get(li) : null);

  const note = 'p-8 text-center text-sm text-muted-foreground';
  if (diff == null) return <div className={note}>{t('chat.selectFileDiff')}</div>;
  if (diff.includes('Binary files ')) return <div className={note}>{t('chat.binaryNoDiff')}</div>;
  if (!lines.length) return <div className={note}>{t('chat.noChangesFile')}</div>;

  // Map each comment to a diff line. Hand-added comments carry the stable `li`;
  // auto-review suggestions carry only a `lineLabel` (e.g. "L42", a new-file
  // line number) — resolve those to the matching line's li. Comments whose line
  // isn't in the visible diff become "orphans" so they're never silently lost.
  const labelToLi = new Map();
  for (const l of lines) if (l.label != null && !labelToLi.has(l.label)) labelToLi.set(l.label, l.li);
  const byLi = new Map();
  const orphans = [];
  for (const c of comments) {
    let li = c.target?.li;
    if (li == null && c.target?.lineLabel != null) li = labelToLi.get(c.target.lineLabel);
    if (li == null) { orphans.push(c); continue; }
    if (!byLi.has(li)) byLi.set(li, []);
    byLi.get(li).push(c);
  }
  const labelFor = (li) => lines.find((l) => l.li === li)?.label || `line ${li}`;

  const OrphanComments = orphans.length ? (
    <div className="border-b border-border/60 bg-muted/40 px-3 py-2">
      <div className="mb-1.5 text-2xs font-medium text-muted-foreground">
        {t('chat.commentsOutsideView')}
      </div>
      <CommentThread comments={orphans} {...commentHandlers} />
    </div>
  ) : null;

  const add = (li, label, body) => { onAddComment?.({ kind: 'line', li, lineLabel: label }, body); setOpenLi(null); };
  const blockProps = { byLi, openLi, onAdd: add, handlers: commentHandlers, onClose: () => setOpenLi(null), label: labelFor };

  if (mode === 'split') {
    const rows = toSplitRows(lines);
    return (
      <div className="diff-syntax min-w-0">
        {OrphanComments}
        {rows.map((r, i) => {
          if (r.hunk !== undefined) return <HunkRow key={i} text={r.hunk} />;
          const lis = [...new Set([r.left?.li, r.right?.li].filter((x) => x != null))];
          const anchor = r.right?.li ?? r.left?.li;
          return (
            <div key={i}>
              {/* old left / new right in both directions — code columns never mirror */}
              <div dir="ltr" className="group relative grid grid-cols-2">
                {anchor != null && onAddComment && <AddBtn onClick={() => setOpenLi(anchor)} />}
                <div className="min-w-0 border-e border-border/60"><SideCell cell={r.left} kind="del" tokens={tok(r.left?.li)} compact={compact} /></div>
                <SideCell cell={r.right} kind="add" tokens={tok(r.right?.li)} compact={compact} />
              </div>
              <LineComments lis={lis} {...blockProps} />
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div className="diff-syntax min-w-0">
      {OrphanComments}
      {lines.map((l, i) => {
        if (l.type === 'hunk') return <HunkRow key={i} text={l.text} />;
        const tint = TINT[l.type] || null;
        return (
          <div key={i}>
            <div dir="ltr" className={`group relative ${ROW}`} style={{ background: tint?.row }}>
              {onAddComment && <AddBtn onClick={() => setOpenLi(l.li)} />}
              {compact ? (
                <Gutter n={l.newN ?? l.oldN} compact tint={tint} />
              ) : (
                <>
                  <Gutter n={l.oldN} tint={tint} />
                  <Gutter n={l.newN} tint={tint} />
                </>
              )}
              <Sign tint={tint} />
              <Code tokens={tok(l.li)} text={l.text} />
            </div>
            <LineComments lis={[l.li]} {...blockProps} />
          </div>
        );
      })}
    </div>
  );
}
