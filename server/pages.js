// server/pages.js — host-internal pages, ported from iframe-host-poc/server.js:
//   /__ticket/<id>       full Linear ticket renderer (Details / Comments / GitHub
//                        PR inline sub-tabs; markdown + diffs rendered server-side,
//                        mounted by the Preact card served at /__card.js)
//   /__ticket-data/<id>  JSON the card consumes (ticket + linked PR via gh CLI)
//   /__ticket-img/<file> locally-cached Linear images (signed URLs expire)
// plus `linear` — { listAssigned(filter), getTicket(id) } for the launcher picker.
//
// One-way dependency: this module may import lib/config + lib/secrets only —
// NEVER state/bus/claude (server/index.js wires everything together).
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cfg } from './lib/config.js';
import { secret } from './lib/secrets.js';

// Linear ticket data sources, in order:
//   1. Live Linear GraphQL when a personal API key is set (auto-fresh).
//   2. Local cache <ticketsDir>/<ID>.json — the OLD PoC dir (~/.arigami-tickets),
//      kept so existing cached tickets keep working. Images are downloaded to
//      <ticketsDir>/img and served from /__ticket-img/<file>, because Linear's
//      image URLs are signed and expire in minutes — local copies render forever.
const TICKETS_DIR = cfg.ticketsDir;
const IMG_DIR = cfg.imgDir;
const IMG_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' };

// Lazy so importing this module (e.g. from tests) never shells out to Keychain.
let _linearKey;
const linearKey = () => (_linearKey === undefined ? (_linearKey = secret('LINEAR_API_KEY')) : _linearKey);

// The launcher/ticket-tab fetch live Linear data via the host's OWN OAuth grant
// (server/linear-mcp.ts), whose access token is stored in
// ~/.arigami/linear-oauth.json. The /__ticket page (pending-task preview, the
// Linear session tab) historically used only a personal LINEAR_API_KEY, so a
// ticket that wasn't cached and had no key failed to load even though the app
// was authenticated with Linear. Read that same OAuth token here (directly from
// the file — pages.js must not import linear-mcp/state) so both paths use one
// identity. Linear's GraphQL API accepts an OAuth token as `Bearer <token>`.
const LINEAR_OAUTH_FILE = path.join(
  cfg.configDir,
  'linear-oauth.json'
);
function linearOAuthToken() {
  try {
    const store = JSON.parse(fs.readFileSync(LINEAR_OAUTH_FILE, 'utf8'));
    return store?.tokens?.access_token || null;
  } catch {
    return null;
  }
}
// The Authorization header value: a personal API key is sent raw; an OAuth
// access token is sent as a Bearer token. Prefer the key if explicitly set.
function linearAuthHeader() {
  const key = linearKey();
  if (key) return key;
  const tok = linearOAuthToken();
  return tok ? `Bearer ${tok}` : null;
}

// ---- Linear: fetch ----------------------------------------------------------
const httpsGetJson = (url, opts) =>
  new Promise((resolve, reject) => {
    const r = https.request(url, opts, (res) => {
      const c = [];
      res.on('data', (d) => c.push(d));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(c).toString('utf8')) });
        } catch (e) {
          reject(e);
        }
      });
    });
    r.on('error', reject);
    if (opts && opts.body) r.write(opts.body);
    r.end();
  });

const linearGql = async (query, variables) => {
  const auth = linearAuthHeader();
  if (!auth) return null;
  const { json } = await httpsGetJson('https://api.linear.app/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: auth },
    body: JSON.stringify({ query, variables: variables || {} }),
  });
  return json && json.data;
};

// Live fetch from Linear GraphQL (filter by team key + number parsed from the id).
// Pulls everything the card shows: state, people, labels, dates, parent/children,
// relations, attachments (incl. GitHub PRs), and the full comment thread.
async function fetchLinearLive(id) {
  const m = /^([A-Za-z]+)-(\d+)$/.exec(id);
  if (!m || !linearAuthHeader()) return null;
  const query = `query($key:String!,$num:Float!){issues(filter:{team:{key:{eq:$key}},number:{eq:$num}}){nodes{
    identifier title description url branchName createdAt updatedAt startedAt dueDate estimate priorityLabel
    state{name type color}
    assignee{name avatarUrl} creator{name}
    team{name} project{name} projectMilestone{name}
    labels{nodes{name color}}
    parent{identifier title state{name color}}
    children{nodes{identifier title state{name color}}}
    relations{nodes{type relatedIssue{identifier title state{name color}}}}
    attachments{nodes{title subtitle url sourceType metadata}}
    comments{nodes{id body createdAt parentId resolvedAt quotedText user{name avatarUrl}}}
  }}}`;
  try {
    const data = await linearGql(query, { key: m[1].toUpperCase(), num: Number(m[2]) });
    const n = data && data.issues && data.issues.nodes && data.issues.nodes[0];
    if (!n) return null;
    const arr = (x) => (x && x.nodes ? x.nodes : []);
    return {
      identifier: n.identifier, title: n.title, url: n.url, description: n.description || '',
      branchName: n.branchName, createdAt: n.createdAt, updatedAt: n.updatedAt, startedAt: n.startedAt,
      dueDate: n.dueDate, estimate: n.estimate, priority: n.priorityLabel,
      status: n.state && n.state.name, statusColor: (n.state && n.state.color) || '#3fb950',
      assignee: n.assignee && n.assignee.name, creator: n.creator && n.creator.name,
      team: n.team && n.team.name, project: n.project && n.project.name,
      milestone: n.projectMilestone && n.projectMilestone.name,
      labels: arr(n.labels).map((l) => ({ name: l.name, color: l.color })),
      parent: n.parent ? { identifier: n.parent.identifier, title: n.parent.title, color: n.parent.state && n.parent.state.color } : null,
      children: arr(n.children).map((c) => ({ identifier: c.identifier, title: c.title, color: c.state && c.state.color })),
      relations: arr(n.relations).map((r) => ({ type: r.type, identifier: r.relatedIssue && r.relatedIssue.identifier, title: r.relatedIssue && r.relatedIssue.title, color: r.relatedIssue && r.relatedIssue.state && r.relatedIssue.state.color })),
      attachments: arr(n.attachments).map((a) => ({ title: a.title, subtitle: a.subtitle, url: a.url, sourceType: a.sourceType, metadata: a.metadata })),
      comments: arr(n.comments).map((c) => ({ id: c.id, body: c.body, createdAt: c.createdAt, parentId: c.parentId, resolvedAt: c.resolvedAt, quotedText: c.quotedText, author: c.user && c.user.name })),
    };
  } catch {
    return null;
  }
}

// Composition root (server/index.ts) injects a live fetcher backed by the Linear
// MCP OAuth grant — the SAME credential the launcher/ticket-tab use. pages.js
// must not import linear-mcp (→ state) directly, so it's injected. The fetcher
// returns the raw Linear-MCP `get_issue` object; mcpIssueToTicket maps it to the
// card's raw-ticket shape (ticketData fills any missing fields with defaults).
let _liveFetcher = null;
export function setLiveTicketFetcher(fn) {
  _liveFetcher = typeof fn === 'function' ? fn : null;
}

const nameOf = (v) => (v == null ? undefined : typeof v === 'string' ? v : v.name);
export function mcpIssueToTicket(it) {
  if (!it || typeof it !== 'object') return null;
  const title = it.title;
  if (!title) return null;
  return {
    identifier: it.identifier || it.id,
    title,
    url: it.url,
    description: it.description || '',
    branchName: it.gitBranchName || it.branchName,
    createdAt: it.createdAt, updatedAt: it.updatedAt, startedAt: it.startedAt, dueDate: it.dueDate,
    estimate: it.estimate,
    priority: nameOf(it.priority),
    status: nameOf(it.status) || it.status,
    statusColor: it.statusColor || (it.state && it.state.color),
    assignee: nameOf(it.assignee),
    creator: nameOf(it.createdBy) || nameOf(it.creator),
    team: nameOf(it.team),
    project: nameOf(it.project),
    milestone: nameOf(it.milestone || it.projectMilestone),
    labels: Array.isArray(it.labels)
      ? it.labels.map((l) => (typeof l === 'string' ? { name: l } : { name: l.name, color: l.color }))
      : [],
    attachments: Array.isArray(it.attachments) ? it.attachments : [],
    comments: Array.isArray(it.comments) ? it.comments : [],
    parent: it.parent || null,
    children: Array.isArray(it.children) ? it.children : [],
    relations: Array.isArray(it.relations) ? it.relations : [],
  };
}

async function getTicket(id) {
  const live = await fetchLinearLive(id); // best-effort if a personal API key is set
  if (live) return live;
  // Same credential as the launcher/ticket-tab: fetch via the Linear MCP OAuth
  // grant (injected by index.ts) so an uncached ticket still loads when the app
  // is connected to Linear even without a LINEAR_API_KEY.
  if (_liveFetcher) {
    try {
      const mapped = mcpIssueToTicket(await _liveFetcher(id));
      if (mapped) return mapped;
    } catch {
      /* fall through to cache */
    }
  }
  try {
    return JSON.parse(fs.readFileSync(path.join(TICKETS_DIR, `${id}.json`), 'utf8'));
  } catch {
    return null;
  }
}

// Map a live GraphQL issue node or a cached ticket file to the launcher-picker row.
const issueRow = (n) => ({
  id: n.id || n.identifier,
  identifier: n.identifier,
  title: n.title,
  state: (n.state && n.state.name) || n.status || '',
  priority: n.priorityLabel || n.priority || '',
  project: (n.project && n.project.name) || n.project || '',
  updatedAt: n.updatedAt || '',
});

// Cache-dir fallback: list every cached <ID>.json (filter is moot here = 'all').
function listCachedTickets() {
  let files = [];
  try { files = fs.readdirSync(TICKETS_DIR).filter((f) => /^[A-Za-z]+-\d+\.json$/.test(f)); } catch {}
  const rows = [];
  for (const f of files) {
    try { rows.push(issueRow(JSON.parse(fs.readFileSync(path.join(TICKETS_DIR, f), 'utf8')))); } catch {}
  }
  return rows.sort((a, b) => ((a.updatedAt || '') < (b.updatedAt || '') ? 1 : -1));
}

const ISSUE_ROW_FIELDS = 'id identifier title priorityLabel state{name type} project{name} updatedAt';

// Launcher picker: the viewer's issues from live Linear GraphQL when the key is
// set, else the local cache dir. filter ∈ 'assigned' | 'recent' | 'all'
// (best-effort; the cache fallback always behaves like 'all').
async function listAssigned(filter = 'assigned') {
  if (linearAuthHeader()) {
    try {
      let query;
      if (filter === 'all') {
        query = `query{issues(first:50,orderBy:updatedAt){nodes{${ISSUE_ROW_FIELDS}}}}`;
      } else if (filter === 'recent') {
        query = `query{viewer{assignedIssues(first:50,orderBy:updatedAt){nodes{${ISSUE_ROW_FIELDS}}}}}`;
      } else {
        // assigned = active work only (skip completed/canceled)
        query = `query{viewer{assignedIssues(first:50,orderBy:updatedAt,filter:{state:{type:{nin:["completed","canceled"]}}}){nodes{${ISSUE_ROW_FIELDS}}}}}`;
      }
      const data = await linearGql(query);
      const nodes = filter === 'all'
        ? data && data.issues && data.issues.nodes
        : data && data.viewer && data.viewer.assignedIssues && data.viewer.assignedIssues.nodes;
      if (Array.isArray(nodes)) return nodes.map(issueRow);
    } catch {}
  }
  return listCachedTickets();
}

export const linear = { listAssigned, getTicket };

// ---- render helpers -----------------------------------------------------------
export const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export const fmtDate = (iso) => {
  if (!iso) return '';
  try { return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch { return iso; }
};

// Render a unified-diff patch with line coloring.
export function diffHtml(patch) {
  if (!patch) return '<p class="empty" style="padding:8px 10px">No diff (binary or too large).</p>';
  let lines = esc(patch).split('\n');
  let truncated = false;
  if (lines.length > 600) { lines = lines.slice(0, 600); truncated = true; }
  const body = lines
    .map((l) => {
      const h = l.slice(0, 3);
      const cls = l[0] === '+' && h !== '+++' ? 'add' : l[0] === '-' && h !== '---' ? 'del' : l[0] === '@' ? 'hunk' : '';
      return `<span class="${cls}">${l === '' ? ' ' : l}</span>`;
    })
    .join('');
  return `<pre class="diff">${body}</pre>${truncated ? '<p class="empty" style="padding:6px 10px">… diff truncated</p>' : ''}`;
}

// Markdown subset → HTML for Linear bodies (images, links, bold/italic, code,
// lists, headings, @user mentions). Linear image URLs are signed + short-lived,
// so they render only with fresh live data (cached tickets rewrite them to
// /__ticket-img/<file>).
export function mdToHtml(md) {
  // Linear user mentions come as <user id="...">Name</user> — turn into @Name first.
  const pre = String(md || '').replace(/<user\b[^>]*>([^<]*)<\/user>/g, '@$1');
  const lines = esc(pre).split('\n');
  const out = [];
  let inList = false;
  const closeList = () => { if (inList) { out.push('</ul>'); inList = false; } };
  const inline = (t) =>
    t
      .replace(/!\[([^\]]*)\]\((?:&lt;)?([^)\s]+?)(?:&gt;)?\)/g, '<img alt="$1" src="$2" loading="lazy">')
      .replace(/\[([^\]]+)\]\((?:&lt;)?([^)\s]+?)(?:&gt;)?\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
      .replace(/(^|[\s(])((?:https?:\/\/)[^\s)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  for (const line of lines) {
    const h = /^(#{1,4})\s+(.*)/.exec(line);
    if (h) { closeList(); out.push(`<h${h[1].length + 2}>${inline(h[2])}</h${h[1].length + 2}>`); continue; }
    const li = /^\s*[*-]\s+(.*)/.exec(line);
    if (li) { if (!inList) { out.push('<ul>'); inList = true; } out.push('<li>' + inline(li[1]) + '</li>'); continue; }
    closeList();
    out.push(line.trim() === '' ? '' : '<p>' + inline(line) + '</p>');
  }
  closeList();
  return out.join('\n');
}

export const isPrUrl = (u) => /github\.com\/[^/]+\/[^/]+\/pull\/\d+/.test(u || '');
const LINEAR_ISSUE = (idf) => `https://linear.app/${cfg.linearWorkspace}/issue/${encodeURIComponent(idf)}`;

// Build the JSON the Preact card consumes. Markdown/diffs are pre-rendered here so
// the proven server-side renderers (mdToHtml/diffHtml) remain the single source.
export function ticketData(t, id, pr) {
  if (!t) return { error: true, id };
  const labels = (t.labels || []).map((l) => (typeof l === 'string' ? { name: l } : l)).map((l) => ({ name: l.name, color: l.color || '#79c0ff' }));
  const meta = [
    t.assignee && { text: '👤 ' + t.assignee },
    t.priority && { text: '🚩 ' + t.priority },
    t.project && { text: '📁 ' + t.project },
    t.milestone && { text: '🎯 ' + t.milestone },
    t.updatedAt && { text: '🕑 ' + fmtDate(t.updatedAt) },
    t.branchName && { text: '⎇ ' + t.branchName, mono: true },
  ].filter(Boolean);
  const relations = [];
  if (t.parent) relations.push({ kind: 'Parent', identifier: t.parent.identifier, title: t.parent.title, color: t.parent.color || '#8b949e', url: LINEAR_ISSUE(t.parent.identifier) });
  (t.children || []).forEach((c) => relations.push({ kind: 'Sub', identifier: c.identifier, title: c.title, color: c.color || '#8b949e', url: LINEAR_ISSUE(c.identifier) }));
  (t.relations || []).forEach((r) => r.identifier && relations.push({ kind: r.type, identifier: r.identifier, title: r.title, color: r.color || '#8b949e', url: LINEAR_ISSUE(r.identifier) }));
  const otherLinks = (t.attachments || []).filter((a) => !isPrUrl(a.url));
  const otherLinksHtml = otherLinks.length
    ? '<h4>Links</h4>' + otherLinks.map((a) => `<div class="rrow"><a href="${esc(a.url)}" target="_blank" rel="noopener">🔗 ${esc(a.title || a.url)}</a></div>`).join('')
    : '';
  const replies = {}, tops = [];
  (t.comments || []).forEach((c) => { if (c.parentId) (replies[c.parentId] = replies[c.parentId] || []).push(c); else tops.push(c); });
  const mapC = (c) => ({ author: c.author || 'Someone', time: fmtDate(c.createdAt), resolved: !!c.resolvedAt, quotedText: c.quotedText || '', bodyHtml: mdToHtml(c.body), replies: (replies[c.id] || []).map(mapC) });
  const comments = tops.map(mapC);
  const ghAtt = (t.attachments || []).find((a) => isPrUrl(a.url));
  const ticket = {
    identifier: t.identifier || id, title: t.title, url: t.url,
    status: t.status || '—', statusColor: t.statusColor || '#3fb950',
    labels, meta, descriptionHtml: mdToHtml(t.description || '_No description_'),
    relations, otherLinksHtml, comments, ghUrl: ghAtt ? ghAtt.url : '',
  };
  const prOut = pr ? prViewModel(pr, ghAtt && ghAtt.url) : null;
  return { ticket, pr: prOut };
}

// PR → the view-model the card's GitHubTab renders. Shared by the ticket page
// (linked PR) and the standalone /__pr page.
export function prViewModel(pr, fallbackUrl = '') {
  {
    const ghAtt = fallbackUrl ? { url: fallbackUrl } : null;
    const st = pr.isDraft ? { l: 'Draft', c: '#8b949e' } : pr.state === 'MERGED' ? { l: 'Merged', c: '#a371f7' } : pr.state === 'CLOSED' ? { l: 'Closed', c: '#f85149' } : { l: 'Open', c: '#3fb950' };
    const checks = Array.isArray(pr.statusCheckRollup) ? pr.statusCheckRollup : [];
    const ok = checks.filter((c) => /SUCCESS|NEUTRAL|SKIPPED/i.test(c.conclusion || c.state || '')).length;
    const bad = checks.filter((c) => /FAIL|ERROR|TIMED_OUT|CANCELLED/i.test(c.conclusion || c.state || '')).length;
    const fileArr = (pr.fileList && pr.fileList.length ? pr.fileList : (pr.files || [])).slice(0, 80);
    const BOT = /^(linear-code|vercel|github-actions|coderabbit)/i; // drop linkback/deploy bot noise
    const prC = (pr.comments || []).filter((c) => !BOT.test((c.author && (c.author.login || c.author.name)) || '')).map((c) => ({ a: (c.author && (c.author.login || c.author.name)) || '?', body: c.body, at: c.createdAt }));
    const prR = (pr.reviews || []).filter((r) => r.body || (r.state && r.state !== 'COMMENTED')).map((r) => ({ a: (r.author && (r.author.login || r.author.name)) || '?', body: r.body, at: r.submittedAt, state: r.state }));
    const prRC = (pr.reviewComments || []).map((c) => ({
      a: (c.user && c.user.login) || '?', body: c.body, at: c.created_at,
      loc: c.path ? c.path + (c.line || c.original_line ? ':' + (c.line || c.original_line) : '') : '',
      code: (c.diff_hunk || '').split('\n').slice(-5).join('\n'),
    }));
    const conv = prC.concat(prR).concat(prRC).sort((a, b) => ((a.at || '') < (b.at || '') ? -1 : 1));
    const rcByPath = {};
    (pr.reviewComments || []).forEach((c) => {
      if (!c.path) return;
      (rcByPath[c.path] = rcByPath[c.path] || []).push({ author: (c.user && c.user.login) || '?', line: c.line || c.original_line || '', time: fmtDate(c.created_at), bodyHtml: mdToHtml(c.body || '') });
    });
    return {
      number: pr.number, url: pr.url || (ghAtt && ghAtt.url),
      stateLabel: st.l, stateColor: st.c,
      review: pr.reviewDecision ? pr.reviewDecision.replace(/_/g, ' ').toLowerCase() : '',
      reviewColor: pr.reviewDecision === 'APPROVED' ? '#3fb950' : pr.reviewDecision === 'CHANGES_REQUESTED' ? '#f85149' : '#d29922',
      checks: checks.length ? { label: `checks ✓${ok}${bad ? ' ✗' + bad : ''}`, color: bad ? '#f85149' : '#3fb950' } : null,
      baseRefName: pr.baseRefName, headRefName: pr.headRefName, additions: pr.additions, deletions: pr.deletions, changedFiles: pr.changedFiles,
      bodyHtml: mdToHtml(pr.body || '_No description_'),
      files: fileArr.map((f) => { const name = f.filename || f.path; return { name, additions: f.additions || 0, deletions: f.deletions || 0, diffHtml: diffHtml(f.patch), comments: rcByPath[name] || [] }; }),
      comments: conv.map((c) => ({ author: c.a, time: fmtDate(c.at), state: c.state ? c.state.replace(/_/g, ' ').toLowerCase() : '', stateColor: c.state === 'APPROVED' ? '#3fb950' : c.state === 'CHANGES_REQUESTED' ? '#f85149' : '#8b949e', loc: c.loc || '', codeHtml: c.code ? diffHtml(c.code) : '', bodyHtml: mdToHtml(c.body || '') })),
    };
  }
}

// Styles for the card (the card mounts only the active tab, so no toggling here).
const TICKET_CSS = `
  :root{color-scheme:dark}*{box-sizing:border-box}
  body{margin:0;font:13px/1.6 ui-sans-serif,system-ui,-apple-system;background:#0d1117;color:#c9d1d9}
  a{color:#58a6ff;text-decoration:none}a:hover{text-decoration:underline}
  code{background:#161b22;border:1px solid #30363d;border-radius:4px;padding:1px 5px;font:12px ui-monospace,Menlo,monospace}
  img{max-width:100%;border-radius:8px;margin:8px 0;border:1px solid #21262d}
  blockquote.quote{margin:6px 0;padding:4px 10px;border-left:3px solid #30363d;color:#8b949e;background:#0f141a;border-radius:0 6px 6px 0}
  h3,h4,h5,h6{margin:14px 0 6px;line-height:1.3}
  html,body,#app{height:100%}
  .app{height:100%;display:flex;flex-direction:column;min-height:0}
  .head{flex:0 0 auto;background:#0d1117;padding:14px 16px 0;border-bottom:1px solid #21262d}
  .topbar{display:flex;align-items:center;justify-content:space-between;gap:10px}
  .id{font:600 12px ui-monospace,Menlo,monospace;color:#8b949e}
  .fontctl{display:flex;gap:3px;flex:0 0 auto}
  .fontctl button{background:#161b22;border:1px solid #30363d;color:#c9d1d9;border-radius:6px;cursor:pointer;font:600 11px ui-sans-serif;padding:3px 7px;line-height:1}
  .fontctl button:hover{border-color:#58a6ff;color:#fff}
  h1{font-size:15px;line-height:1.35;margin:8px 0 10px}
  .pill{display:inline-block;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:600;border:1px solid}
  .metarow{display:flex;flex-wrap:wrap;gap:6px 12px;color:#8b949e;font-size:12px;margin:8px 0 12px;align-items:center}
  .metarow .mono,.mono{font-family:ui-monospace,Menlo,monospace}
  .tabs{display:flex;gap:2px}
  .tab{padding:8px 12px;font-size:12px;font-weight:600;color:#8b949e;cursor:pointer;border-bottom:2px solid transparent;user-select:none}
  .tab.active{color:#e6edf3;border-bottom-color:#58a6ff}
  .body{flex:1;min-height:0;overflow:auto;padding:14px 16px 28px}
  .body>section.fill{height:100%}
  .desc p{margin:8px 0}.desc ul{margin:8px 0;padding-left:20px}.desc li{margin:3px 0}
  .desc table{border-collapse:collapse;margin:8px 0}.desc td,.desc th{border:1px solid #21262d;padding:6px 8px;vertical-align:top}
  .rrow{display:flex;align-items:center;gap:8px;margin:6px 0}
  .rlbl{font-size:10px;text-transform:uppercase;letter-spacing:.04em;color:#6e7681;min-width:64px}
  .ref{display:inline-flex;align-items:center;gap:6px;background:#161b22;border:1px solid #21262d;border-radius:6px;padding:5px 9px;color:#c9d1d9}
  .ref b{color:#8b949e;font:600 11px ui-monospace,Menlo,monospace}
  .dot{width:8px;height:8px;border-radius:50%;display:inline-block;flex:0 0 auto}
  .cmt{border-top:1px solid #21262d;padding:12px 0}
  .cmt.reply{margin-left:14px;padding-left:12px;border-top:0;border-left:2px solid #21262d}
  .chead{display:flex;align-items:center;gap:8px;margin-bottom:2px}
  .cauthor{font-weight:600;color:#e6edf3}.ctime{font-size:11px;color:#6e7681}
  .cloc{font:600 11px ui-monospace,Menlo,monospace;color:#d2a8ff;background:#1b2027;border:1px solid #30363d;border-radius:5px;padding:1px 6px}
  .resolved{font-size:10px;color:#3fb950;border:1px solid #3fb95055;border-radius:999px;padding:1px 6px}
  .empty{color:#6e7681}
  .gtabs{display:flex;gap:2px;margin:10px 0 8px;border-bottom:1px solid #21262d}
  .gtab{padding:6px 10px;font-size:12px;font-weight:600;color:#8b949e;cursor:pointer;border-bottom:2px solid transparent}
  .gtab.active{color:#e6edf3;border-bottom-color:#a371f7}
  details.file{border:1px solid #21262d;border-radius:6px;margin:6px 0;background:#0f141a}
  details.file>summary{cursor:pointer;padding:7px 10px;display:flex;justify-content:space-between;gap:10px;font:12px ui-monospace,Menlo,monospace;list-style:none}
  details.file>summary::-webkit-details-marker{display:none}
  .fp{word-break:break-all;color:#c9d1d9}.fd{white-space:nowrap}
  .diff{margin:0;padding:8px 10px;border-top:1px solid #21262d;overflow-x:auto;font:11px/1.5 ui-monospace,Menlo,monospace;white-space:pre}
  .diff span{display:block}
  .diff span.add{background:#13361b;color:#aff5b4}.diff span.del{background:#3a1a1f;color:#ffb3ba}.diff span.hunk{color:#79c0ff}
  .fcct{color:#d2a8ff}
  .filecmts{border-top:1px solid #21262d;background:#0d1117;padding:6px 10px}
  .filecmt{padding:8px 0;border-top:1px solid #161b22}
  .filecmt:first-child{border-top:0}
`;

// HTML shell the tab iframes: mounts the Preact card and hands it the id.
// (The PoC's persisted ticketZoom pref is gone — zoom is card-local now.)
export function ticketShell(id, tab, fallbackTitle) {
  const t = ['details', 'comments', 'github'].includes(tab) ? ` data-tab="${tab}"` : '';
  // Best-effort title known before the live Linear fetch resolves (e.g. from
  // a trigger snapshot) — the card falls back to this if that fetch fails.
  const ft = fallbackTitle ? ` data-fallback-title="${esc(fallbackTitle)}"` : '';
  return `<!doctype html><html data-ticket="${esc(id)}" data-zoom="1"${t}${ft}><head><meta charset="utf-8"><base target="_blank"><style>${TICKET_CSS}</style></head><body><div id="app"></div><script src="/__card.js"></script></body></html>`;
}

// Standalone PR page (/__pr/<owner>/<repo>/<num>) — same card bundle, PR-only
// mode. Exists because github.com refuses framing and the proxy carries no
// GitHub auth; this renders through the user's `gh` login instead.
export function prShell(owner, repo, num) {
  return `<!doctype html><html data-pr="${esc(`${owner}/${repo}/${num}`)}" data-zoom="1"><head><meta charset="utf-8"><base target="_blank"><style>${TICKET_CSS}</style></head><body><div id="app"></div><script src="/__card.js"></script></body></html>`;
}

// ---- GitHub PR: fetch (via gh CLI, reusing the user's auth) --------------------
const execFileP = (cmd, args) =>
  new Promise((resolve, reject) =>
    execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024 }, (e, stdout) => (e ? reject(e) : resolve(stdout)))
  );

export const parsePrUrl = (u) => {
  const m = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(String(u || ''));
  return m ? { owner: m[1], repo: m[2], num: m[3] } : null;
};

async function fetchPR(owner, repo, num) {
  const base = `${owner}/${repo}`;
  const fields = 'number,title,state,isDraft,author,headRefName,baseRefName,additions,deletions,changedFiles,url,body,reviewDecision,statusCheckRollup,files,comments,reviews';
  try {
    const out = await execFileP('gh', ['pr', 'view', String(num), '--repo', base, '--json', fields]);
    const pr = JSON.parse(out);
    // file patches (diffs) aren't in `gh pr view`; pull them from the REST endpoint
    try {
      const filesOut = await execFileP('gh', ['api', `repos/${base}/pulls/${num}/files?per_page=100`]);
      pr.fileList = JSON.parse(filesOut);
    } catch { pr.fileList = []; }
    // inline review comments (per diff-line) aren't in `gh pr view` either
    try {
      const rcOut = await execFileP('gh', ['api', `repos/${base}/pulls/${num}/comments?per_page=100`]);
      pr.reviewComments = JSON.parse(rcOut);
    } catch { pr.reviewComments = []; }
    return pr;
  } catch {
    return null;
  }
}

// ---- the card bundle ------------------------------------------------------------
// Built lazily from server/assets/card.jsx with Bun.build (preact), memoized.
const CARD_SRC = fileURLToPath(new URL('./assets/card.jsx', import.meta.url));
let cardBuild = null;
function buildCard() {
  if (!cardBuild) {
    cardBuild = Bun.build({ entrypoints: [CARD_SRC], minify: true, target: 'browser' })
      .then(async (r) => {
        if (!r.success || !r.outputs.length) throw new Error(r.logs ? r.logs.join('\n') : 'build failed');
        return r.outputs[0].text();
      })
      .catch((e) => { cardBuild = null; throw e; });
  }
  return cardBuild;
}

// ---- HTTP entry -----------------------------------------------------------------
// Returns true if the request was handled (index.js falls through to the proxy
// otherwise). Async work is fire-and-forget, like the PoC handler.
export function handlePage(req, res) {
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // The Preact card bundle the ticket shell mounts.
  if (u.pathname === '/__card.js') {
    buildCard().then(
      (js) => {
        res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-cache' });
        res.end(js);
      },
      (e) => {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end('card build failed: ' + e.message);
      }
    );
    return true;
  }

  // Serve a locally-cached Linear image (downloaded because signed URLs expire).
  if (u.pathname.startsWith('/__ticket-img/')) {
    const name = path.basename(decodeURIComponent(u.pathname.slice('/__ticket-img/'.length)));
    const file = path.join(IMG_DIR, name);
    if (!file.startsWith(IMG_DIR) || !fs.existsSync(file)) { res.writeHead(404).end('no image'); return true; }
    const ext = (name.split('.').pop() || '').toLowerCase();
    res.writeHead(200, { 'content-type': IMG_MIME[ext] || 'application/octet-stream', 'cache-control': 'max-age=86400' });
    fs.createReadStream(file).pipe(res);
    return true;
  }

  // JSON the card fetches (ticket + linked PR). Heavy work (gh) lives here.
  if (u.pathname.startsWith('/__ticket-data/')) {
    const id = u.pathname.slice('/__ticket-data/'.length).toUpperCase().replace(/[^A-Z0-9-]/g, '');
    getTicket(id).then(async (t) => {
      let pr = null;
      const ghAtt = t && (t.attachments || []).find((a) => isPrUrl(a.url));
      if (ghAtt) { const p = parsePrUrl(ghAtt.url); if (p) pr = await fetchPR(p.owner, p.repo, p.num); }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(ticketData(t, id, pr)));
    });
    return true;
  }

  // Standalone PR page + its data. Path: /__pr[-data]/<owner>/<repo>/<num>
  const prM = /^\/__pr(-data)?\/([\w.-]+)\/([\w.-]+)\/(\d+)$/.exec(u.pathname);
  if (prM) {
    const [, isData, owner, repo, num] = prM;
    if (!isData) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(prShell(owner, repo, num));
      return true;
    }
    fetchPR(owner, repo, num).then((pr) => {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(pr ? { pr: prViewModel(pr) } : { error: true }));
    });
    return true;
  }

  // The ticket tab iframes this shell, which mounts the Preact card.
  if (u.pathname.startsWith('/__ticket/')) {
    const id = u.pathname.slice('/__ticket/'.length).toUpperCase().replace(/[^A-Z0-9-]/g, '');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(ticketShell(id, u.searchParams.get('tab') || '', u.searchParams.get('title') || ''));
    return true;
  }

  return false;
}
