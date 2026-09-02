// Renders a git unified diff like an editor — side-by-side (default) or inline.
// Supports GitHub-style per-line review comments: hover a line for a "+", which
// opens an inline composer; existing comments render as threads under the line.
import { useMemo, useState } from 'react';
import { CommentThread, CommentComposer } from './Comments.jsx';
import { highlightDiff } from '../lib/highlight.js';
import { useT } from '../lib/i18n.js';

// Render a line of code as syntax-highlighted spans (lowlight tokens) when we
// have them, else as plain text. Whitespace is preserved by the parent's
// `whitespace-pre`. An empty line still needs a space so the row has height.
function Code({ tokens, text }) {
  if (!tokens || !tokens.length) return <span className="text-fg">{text || ' '}</span>;
  return (
    <span className="text-fg">
      {tokens.map((t, i) => (t.c ? <span key={i} className={t.c}>{t.v}</span> : t.v))}
    </span>
  );
}

const ADD_BG = 'rgba(95,181,106,0.16)';
const DEL_BG = 'rgba(217,128,120,0.16)';
const GAP_BG = 'rgba(128,128,128,0.06)';

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

const Gutter = ({ n, compact }) => (
  <span className={`inline-block shrink-0 select-none text-right text-fgdim tabular-nums ${compact ? 'w-6 pr-1' : 'w-9 pr-2'}`}>{n ?? ''}</span>
);

function HunkRow({ text }) {
  // B18: source text is LTR even when the cockpit is RTL (Hebrew)
  return <div dir="ltr" className="bg-[rgba(80,120,200,0.10)] px-2 py-0.5 text-start font-mono text-[10.5px] text-fgdim">{text || '⋯'}</div>;
}

// The "+" add-comment affordance, shown on row hover.
function AddBtn({ onClick }) {
  const t = useT();
  return (
    <button
      type="button"
      onClick={onClick}
      title={t('chat.addCommentLine')}
      className="absolute left-0 top-1/2 z-10 hidden h-3.5 w-3.5 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full border border-border bg-panel text-[9px] leading-none text-fgdim opacity-50 hover:border-ink hover:bg-brand hover:text-[#1a1a1a] hover:opacity-100 group-hover:flex [@media(pointer:coarse)]:flex"
    >
      +
    </button>
  );
}

// Comment block (threads + open composer) rendered under a diff line.
function LineComments({ lis, byLi, openLi, onAdd, handlers = {}, onClose, label }) {
  const t = useT();
  const here = lis.filter((li) => byLi.get(li)?.length || openLi === li);
  if (!here.length) return null;
  return (
    <div className="border-y border-hair bg-rail/40 px-9 py-1.5">
      {lis.map((li) =>
        (byLi.get(li)?.length || openLi === li) ? (
          <div key={li} className="flex flex-col gap-1.5 py-0.5">
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

function SideCell({ cell, sign, bg, tokens, compact }) {
  return (
    <div
      dir="ltr"
      className="flex min-w-0 overflow-x-auto text-start whitespace-pre font-mono text-[11px] leading-[1.55] thin-scroll"
      style={{ background: cell ? bg : GAP_BG }}
    >
      {cell && (
        <>
          <Gutter n={cell.n} compact={compact} />
          <span className="w-3 shrink-0 select-none text-fgdim">{cell.ctx ? '' : sign}</span>
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
  const tokens = useMemo(() => highlightDiff(lines, path), [lines, path]);
  const tok = (li) => (tokens ? tokens.get(li) : null);

  if (diff == null) return <div className="p-8 text-center font-mono text-[11px] text-fgdim">{t('chat.selectFileDiff')}</div>;
  if (diff.includes('Binary files ')) return <div className="p-8 text-center font-mono text-[11px] text-fgdim">{t('chat.binaryNoDiff')}</div>;
  if (!lines.length) return <div className="p-8 text-center font-mono text-[11px] text-fgdim">{t('chat.noChangesFile')}</div>;

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
    <div className="border-b border-hair bg-rail/40 px-3 py-2">
      <div className="mb-1 font-mono text-[9px] font-bold tracking-wide text-fgdim uppercase">
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
      <div className="diff-syntax min-w-0 py-1">
        {OrphanComments}
        {rows.map((r, i) => {
          if (r.hunk !== undefined) return <HunkRow key={i} text={r.hunk} />;
          const lis = [...new Set([r.left?.li, r.right?.li].filter((x) => x != null))];
          const anchor = r.right?.li ?? r.left?.li;
          return (
            <div key={i}>
              <div className="group relative grid grid-cols-2 border-b border-hair/40">
                {anchor != null && onAddComment && <AddBtn onClick={() => setOpenLi(anchor)} />}
                <div className="border-r border-hair/40"><SideCell cell={r.left} sign="-" bg={r.left?.ctx ? 'transparent' : DEL_BG} tokens={tok(r.left?.li)} compact={compact} /></div>
                <SideCell cell={r.right} sign="+" bg={r.right?.ctx ? 'transparent' : ADD_BG} tokens={tok(r.right?.li)} compact={compact} />
              </div>
              <LineComments lis={lis} {...blockProps} />
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div className="diff-syntax min-w-0 py-1">
      {OrphanComments}
      {lines.map((l, i) => {
        if (l.type === 'hunk') return <HunkRow key={i} text={l.text} />;
        const bg = l.type === 'add' ? ADD_BG : l.type === 'del' ? DEL_BG : 'transparent';
        const sign = l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' ';
        return (
          <div key={i}>
            <div dir="ltr" className="group relative flex overflow-x-auto text-start whitespace-pre font-mono text-[11px] leading-[1.55] thin-scroll" style={{ background: bg }}>
              {onAddComment && <AddBtn onClick={() => setOpenLi(l.li)} />}
              {compact ? (
                <Gutter n={l.newN ?? l.oldN} compact />
              ) : (
                <>
                  <Gutter n={l.oldN} />
                  <Gutter n={l.newN} />
                </>
              )}
              <span className="w-3 shrink-0 select-none text-fgdim">{sign}</span>
              <Code tokens={tok(l.li)} text={l.text} />
            </div>
            <LineComments lis={[l.li]} {...blockProps} />
          </div>
        );
      })}
    </div>
  );
}
