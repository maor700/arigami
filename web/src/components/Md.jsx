import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { strongDirOf, bidiParts } from '../lib/i18n.js';

// Markdown with per-block direction. Every text block (paragraph, list,
// heading, quote, table, cell) takes its OWN direction from its prose (see
// strongDirOf: RTL once Hebrew letters are a small share, so a Hebrew item that
// opens with "Vite" or "`Rail.jsx`" is still Hebrew), so a Hebrew list gets its
// bullets/numbers, indent and quote bar on the right and an English list inside
// a Hebrew UI keeps them on the left. Neither `unicode-bidi: plaintext` nor
// `dir="auto"` can do it: both decide by the FIRST strong letter, which is the
// bug. Inline code is skipped for the decision, code blocks are always LTR.
// A list item inherits its list's side (the marker sits there); an item written
// wholly in the other script orders its words in a wrapper with its own dir.
// URLs, paths and identifiers in RTL prose become LTR isolates (<bdi>).

const textOf = (node) => {
  if (node.type === 'text') return node.value;
  if (node.type !== 'element' || node.tagName === 'code' || node.tagName === 'pre') return '';
  return (node.children || []).map(textOf).join(' ');
};

/** Direction of a hast node's prose (inline code excluded); nothing strong → ltr. */
export function nodeDir(node) {
  return strongDirOf(textOf(node)) || 'ltr';
}

const BLOCKS = new Set(['p', 'ul', 'ol', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'table', 'th', 'td']);
const LETTERS = { rtl: /[\u0590-\u08FF\uFB1D-\uFEFC]/, ltr: /[A-Za-z]/ };

function bidiTree(node, listDir, rtl) {
  if (node.type !== 'element' && node.type !== 'root') return;
  if (node.tagName === 'pre') { node.properties = { ...node.properties, dir: 'ltr' }; return; }
  if (node.tagName === 'code') return;
  if (BLOCKS.has(node.tagName)) {
    node.properties = { ...node.properties, dir: nodeDir(node) };
    rtl = node.properties.dir === 'rtl';
  }
  if (node.tagName === 'li' && listDir) {
    const own = strongDirOf(textOf(node));
    if (own && own !== listDir && !LETTERS[listDir].test(textOf(node))) {
      rtl = own === 'rtl';
      node.children = [{ type: 'element', tagName: 'div', properties: { dir: own }, children: node.children }];
    }
  }
  const nextList = node.tagName === 'ul' || node.tagName === 'ol' ? node.properties.dir : node.tagName === 'li' ? null : listDir;
  node.children = (node.children || []).flatMap((c) => {
    if (c.type !== 'text') { bidiTree(c, nextList, rtl); return [c]; }
    return bidiParts(c.value, rtl).map((x) => (typeof x === 'string'
      ? { type: 'text', value: x }
      : { type: 'element', tagName: 'bdi', properties: { dir: 'ltr' }, children: [{ type: 'text', value: x.ltr }] }));
  });
}
export const rehypeBidi = () => (tree) => bidiTree(tree, null, false);

// Code is LTR, but a string and a comment that both hold Hebrew would otherwise
// fuse into ONE right-to-left run across the `"; // ` between them (bidi: neutrals
// between two RTL runs go RTL), so the quote, `;` and `//` hop sides. Each run of
// RTL words becomes its own isolate (<bdi>): the words keep their reading order,
// the syntax around them keeps the code's order.
const RTL_RUN = /[\u0590-\u08FF\uFB1D-\uFEFC](?:[\u0590-\u08FF\uFB1D-\uFEFC\d ]*[\u0590-\u08FF\uFB1D-\uFEFC\d])?/g;
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

export const MD_COMPONENTS = { code: MdCode };

const PLUGINS = [remarkGfm];
const REHYPE = [rehypeBidi];

export default function Md({ children, remarkPlugins = PLUGINS, components, ...rest }) {
  return <Markdown remarkPlugins={remarkPlugins} components={components ? { ...MD_COMPONENTS, ...components } : MD_COMPONENTS} rehypePlugins={REHYPE} {...rest}>{children}</Markdown>;
}
