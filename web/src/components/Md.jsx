import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { strongDirOf } from '../lib/i18n.js';

// Markdown with per-block direction. Every text block (paragraph, list,
// heading, quote, table, cell) takes its OWN direction from its first strong
// character, so a Hebrew list gets its bullets/numbers, indent and quote bar on
// the right and an English list inside a Hebrew UI keeps them on the left —
// `unicode-bidi: plaintext` only reorders runs, it never moves markers, indents
// or bars (those follow the element's `direction`). `dir="auto"` can't do it
// either: a container whose children carry their own `dir` sees no text and
// falls back to LTR. So the direction is computed here, from the hast node.
// Inline code is skipped (`dir` of "`Rail.jsx` מכיל באג" is Hebrew), code blocks
// are always LTR.

/** First-strong direction of a hast node's prose (inline code excluded). */
export function nodeDir(node) {
  let out = null;
  const walk = (n) => {
    if (out) return;
    if (n.type === 'text') {
      out = strongDirOf(n.value);
    } else if (n.type === 'element' && n.tagName !== 'code' && n.tagName !== 'pre') {
      for (const c of n.children || []) walk(c);
    }
  };
  walk(node);
  return out || 'ltr';
}

// Code is LTR, but a string and a comment that both hold Hebrew would otherwise
// fuse into ONE right-to-left run across the `"; // ` between them (bidi: neutrals
// between two RTL runs go RTL), so the quote, `;` and `//` hop sides. Each run of
// RTL words becomes its own isolate (<bdi>): the words keep their reading order,
// the syntax around them keeps the code's order.
const RTL_RUN = /[\u0590-\u08FF\uFB1D-\uFEFC](?:[\u0590-\u08FF\uFB1D-\uFEFC\d ]*[\u0590-\u08FF\uFB1D-\uFEFC])?/g;
export function isolateRtlRuns(text) {
  const out = [];
  let last = 0;
  for (const m of String(text).matchAll(RTL_RUN)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push({ rtl: m[0] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function MdCode({ node, children, ...props }) { // eslint-disable-line no-unused-vars
  const parts = typeof children === 'string' ? isolateRtlRuns(children) : null;
  if (!parts || !parts.some((x) => typeof x !== 'string')) return <code {...props}>{children}</code>;
  return <code {...props}>{parts.map((x, i) => (typeof x === 'string' ? x : <bdi key={i}>{x.rtl}</bdi>))}</code>;
}

const dirred = (Tag) => function MdBlock({ node, ...props }) {
  return <Tag dir={nodeDir(node)} {...props} />;
};

export const MD_COMPONENTS = {
  p: dirred('p'), ul: dirred('ul'), ol: dirred('ol'), // li inherits its list: the marker sits on the list's side (see .md li)
  h1: dirred('h1'), h2: dirred('h2'), h3: dirred('h3'), h4: dirred('h4'), h5: dirred('h5'), h6: dirred('h6'),
  blockquote: dirred('blockquote'), table: dirred('table'), th: dirred('th'), td: dirred('td'),
  code: MdCode,
  pre: function MdPre({ node, ...props }) { return <pre dir="ltr" {...props} />; }, // eslint-disable-line no-unused-vars
};

const PLUGINS = [remarkGfm];

export default function Md({ children, remarkPlugins = PLUGINS, components, ...rest }) {
  return <Markdown remarkPlugins={remarkPlugins} components={components ? { ...MD_COMPONENTS, ...components } : MD_COMPONENTS} {...rest}>{children}</Markdown>;
}
