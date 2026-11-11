import { dirOf, strongDirOf, bidiParts } from '../lib/i18n.js';

// Plain (non-markdown) user or agent text in either language. The element takes
// the text's own direction (see strongDirOf: RTL once Hebrew is a small share of
// the letters, so "Vite מפעיל…" stays Hebrew), and URLs, paths, identifiers and
// "#1E40AF" inside RTL text sit in LTR isolates so their punctuation stays put.
// `lines`: multi-line text (whitespace-pre-wrap) — every line is its own block
// with its own direction, the way markdown paragraphs are.

/** Text with its LTR islands wrapped in <bdi dir="ltr">. */
export function Isolated({ text }) {
  const parts = bidiParts(text);
  if (parts.length === 1 && typeof parts[0] === 'string') return parts[0];
  return parts.map((x, i) => (typeof x === 'string' ? x : <bdi key={i} dir="ltr">{x.ltr}</bdi>));
}

export default function BidiText({ text, as: Tag = 'div', lines = false, dir, ...rest }) {
  const s = text == null ? '' : String(text);
  const d = dir || dirOf(s);
  if (!lines || !s.includes('\n')) return <Tag dir={d} {...rest}><Isolated text={s} /></Tag>;
  return (
    <Tag dir={d} {...rest}>
      {s.split('\n').map((line, i) => (
        <div key={i} dir={strongDirOf(line) || d}>{line ? <Isolated text={line} /> : '​'}</div>
      ))}
    </Tag>
  );
}
