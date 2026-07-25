// Syntax highlighting for the diff view, via lowlight (highlight.js).
//
// Strategy (decided with the user): highlight PER HUNK, PER SIDE. For each hunk
// we join its old-side lines (context + deletions) and its new-side lines
// (context + additions) into two blocks, highlight each block once, then split
// the resulting token stream back onto individual lines. This keeps multi-line
// constructs (block comments, template strings) correctly colored within the
// visible hunk, with no need to fetch whole files — we only have the diff.
//
// lowlight returns a hast tree; we flatten it to {class, text} tokens carrying
// the nearest token class, then split on newlines into per-line token arrays.
// The caller renders those as React spans against the `.diff-syntax` palette.
import { common, createLowlight } from 'lowlight';

const lowlight = createLowlight(common);

// Don't highlight pathologically large diffs on the main thread.
const MAX_LINES = 1500;

// File extension → highlight.js language id. Unknown extensions fall back to
// lowlight's auto-detection.
const EXT_LANG = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', jsonc: 'json',
  css: 'css', scss: 'scss', less: 'less',
  html: 'xml', xml: 'xml', svg: 'xml', vue: 'xml',
  md: 'markdown', markdown: 'markdown', mdx: 'markdown',
  sh: 'bash', bash: 'bash', zsh: 'bash',
  yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp',
  cs: 'csharp', php: 'php', sql: 'sql', graphql: 'graphql', gql: 'graphql',
  swift: 'swift', kt: 'kotlin', dockerfile: 'dockerfile', diff: 'diff',
};

function langFor(path) {
  const base = String(path || '').split('/').pop().toLowerCase();
  if (base === 'dockerfile') return 'dockerfile';
  const ext = base.includes('.') ? base.split('.').pop() : '';
  return EXT_LANG[ext] || null;
}

// hast → flat token list, each carrying the nearest (most specific) class chain.
function flatten(node, inherited, out) {
  if (node.type === 'text') {
    if (node.value) out.push({ c: inherited, v: node.value });
    return out;
  }
  const cls = node.properties && node.properties.className;
  const c = Array.isArray(cls) && cls.length ? cls.join(' ') : (cls || inherited);
  for (const ch of node.children || []) flatten(ch, c, out);
  return out;
}

// Split a flat token list into per-line arrays of {c, v}, breaking on '\n'.
function toLines(flat) {
  const lines = [[]];
  for (const t of flat) {
    const parts = t.v.split('\n');
    parts.forEach((p, i) => {
      if (i > 0) lines.push([]);
      if (p) lines[lines.length - 1].push({ c: t.c, v: p });
    });
  }
  return lines;
}

function highlightBlock(code, lang) {
  if (!code) return [[]];
  try {
    const tree = lang ? lowlight.highlight(lang, code) : lowlight.highlightAuto(code);
    return toLines(flatten(tree, '', []));
  } catch {
    return null; // unknown language etc. — caller renders plain text
  }
}

// Given parsed diff `lines` (from DiffView's parseDiff: {type, text, li, ...})
// and a file path, return Map<li, Array<{c,v}>> of highlighted tokens per line.
// Returns null when there's nothing to do or the diff is too large to highlight.
export function highlightDiff(lines, path) {
  if (!Array.isArray(lines) || lines.length === 0) return null;
  const changed = lines.filter((l) => l.type === 'add' || l.type === 'del').length;
  if (changed > MAX_LINES) return null;
  const lang = langFor(path);

  const byLi = new Map();
  // Walk hunk groups; within each, highlight old side and new side separately.
  let oldLis = [], oldTxt = [], newLis = [], newTxt = [];
  const flush = () => {
    if (oldTxt.length) {
      const hl = highlightBlock(oldTxt.join('\n'), lang);
      if (hl) oldLis.forEach((li, k) => byLi.set(li, hl[k] || []));
    }
    if (newTxt.length) {
      const hl = highlightBlock(newTxt.join('\n'), lang);
      if (hl) newLis.forEach((li, k) => byLi.set(li, hl[k] || []));
    }
    oldLis = []; oldTxt = []; newLis = []; newTxt = [];
  };
  for (const l of lines) {
    if (l.type === 'hunk') { flush(); continue; }
    if (l.type === 'ctx' || l.type === 'del') { oldLis.push(l.li); oldTxt.push(l.text); }
    if (l.type === 'ctx' || l.type === 'add') { newLis.push(l.li); newTxt.push(l.text); }
  }
  flush();
  return byLi.size ? byLi : null;
}
