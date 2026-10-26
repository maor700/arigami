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
import { cfg } from './lib/config.js';
import { secret } from './lib/secrets.js';
import { resourceRoot } from './lib/resource-root.js';

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
    priorityValue: typeof it.priority === 'object' && it.priority ? it.priority.value : undefined,
    status: nameOf(it.status) || it.status,
    statusType: it.statusType || (it.state && it.state.type),
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
    // list_comments: {id, body, author:{name}, createdAt, parentId, resolvedAt, quotedText}
    comments: Array.isArray(it.comments)
      ? it.comments.map((c) => ({ id: c.id, body: c.body || '', author: nameOf(c.author) || c.author || 'Someone', createdAt: c.createdAt, parentId: c.parentId || null, resolvedAt: c.resolvedAt || null, quotedText: c.quotedText || '' }))
      : [],
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
  const pre = String(md || '')
    .replace(/<user\b[^>]*>([^<]*)<\/user>/g, '@$1')
    // Linear's MCP sends uploads as <linear-image>{"type":"image","attrs":{"src","alt"}}</linear-image> (and
    // <linear-file>/<linear-video> alike) — an image becomes markdown, anything else a link with its name
    .replace(/<linear-(\w+)>\s*(\{[\s\S]*?\})\s*<\/linear-\1>/g, (whole, kind, json) => {
      let a;
      try { a = JSON.parse(json).attrs || {}; } catch { return whole; }
      const src = String(a.src || a.href || a.url || '');
      if (!/^https?:\/\//.test(src)) return whole;
      const name = String(a.alt || a.title || a.name || kind).replace(/[\[\]]/g, '');
      return kind === 'image' ? `![${name}](${src})` : `[${name}](${src})`;
    });
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

// Linear's own colours for a workflow state type, and a stable avatar colour per person.
const STATUS_COLORS = { triage: '#fc7840', backlog: '#bec2c8', unstarted: '#e2e2e2', started: '#f2c94c', completed: '#5e6ad2', canceled: '#95a2b3' };
const AVATAR_COLORS = ['#5e6ad2', '#26b5ce', '#4cb782', '#f2994a', '#eb5757', '#bb87fc', '#f7c8c1', '#0f783c'];
const displayName = (n) => {
  const s = String(n || 'Someone');
  // an email login ("first.last@org") reads as "first.last"
  return s.includes('@') ? s.split('@')[0] : s;
};
const initialsOf = (n) => displayName(n).split(/[\s._-]+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';
const avatarColor = (n) => { let h = 0; for (const ch of String(n || '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return AVATAR_COLORS[h % AVATAR_COLORS.length]; };
const fmtDay = (iso) => { if (!iso) return ''; try { return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); } catch { return iso; } };

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
  const byTime = (a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
  const mapC = (c) => ({ id: c.id || '', author: displayName(c.author), initials: initialsOf(c.author), avatar: avatarColor(c.author), at: c.createdAt || '', time: fmtDate(c.createdAt), resolved: !!c.resolvedAt, quotedText: c.quotedText || '', bodyHtml: mdToHtml(c.body), replies: (replies[c.id] || []).sort(byTime).map(mapC) });
  const comments = tops.sort(byTime).map(mapC);
  const ghAtt = (t.attachments || []).find((a) => isPrUrl(a.url));
  // the sidebar, in Linear's order — only what the ticket has
  const statusType = t.statusType || '';
  const props = [
    { key: 'status', label: 'Status', value: t.status || '—', color: t.statusColor || STATUS_COLORS[statusType] || '#8a8f98', kind: statusType || 'unstarted' },
    t.priority && { key: 'priority', label: 'Priority', value: t.priority, level: t.priorityValue ?? null },
    { key: 'assignee', label: 'Assignee', value: t.assignee ? displayName(t.assignee) : 'Unassigned', initials: t.assignee ? initialsOf(t.assignee) : '', avatar: t.assignee ? avatarColor(t.assignee) : '' },
    labels.length && { key: 'labels', label: 'Labels', labels },
    t.project && { key: 'project', label: 'Project', value: t.project },
    t.milestone && { key: 'milestone', label: 'Milestone', value: t.milestone },
    t.team && { key: 'team', label: 'Team', value: t.team },
    t.estimate != null && t.estimate !== '' && { key: 'estimate', label: 'Estimate', value: String(t.estimate) },
    t.dueDate && { key: 'due', label: 'Due date', value: fmtDay(t.dueDate) },
    t.creator && { key: 'creator', label: 'Created by', value: displayName(t.creator) },
    t.createdAt && { key: 'created', label: 'Created', value: fmtDay(t.createdAt) },
    t.updatedAt && { key: 'updated', label: 'Updated', value: fmtDate(t.updatedAt) },
    t.branchName && { key: 'branch', label: 'Branch', value: t.branchName, mono: true },
  ].filter(Boolean);
  const links = (t.attachments || []).map((a) => ({ title: a.title || a.url, url: a.url, kind: isPrUrl(a.url) ? 'pr' : /sentry\.io/.test(a.url || '') ? 'sentry' : 'link' }));
  const ticket = {
    identifier: t.identifier || id, title: t.title, url: t.url, team: t.team || '', props, links,
    status: t.status || '—', statusColor: t.statusColor || STATUS_COLORS[statusType] || '#3fb950',
    labels, meta, descriptionHtml: mdToHtml(t.description || '_No description_'),
    relations, otherLinksHtml, comments, ghUrl: ghAtt ? ghAtt.url : '',
  };
  const prOut = pr ? prViewModel(pr, ghAtt && ghAtt.url) : null;
  return { ticket, pr: prOut };
}

// PR → the view-model the card's GitHubTab renders. Shared by the ticket page
// (linked PR) and the standalone /__pr page.
export function prViewModel(pr, fallbackUrl = '') {
  const r = pr.rest || {};
  const who = (u) => ({ login: (u && (u.login || u.name)) || 'ghost', avatar: (u && u.avatar_url) || '' });
  const state = r.merged || pr.state === 'MERGED' ? 'merged' : (r.draft || pr.isDraft) ? 'draft' : pr.state === 'CLOSED' || r.state === 'closed' ? 'closed' : 'open';
  const checks = Array.isArray(pr.statusCheckRollup) ? pr.statusCheckRollup : [];
  const checkItems = checks.map((c) => {
    const v = String(c.conclusion || c.state || c.status || '').toUpperCase();
    const st = /SUCCESS|NEUTRAL|SKIPPED/.test(v) ? 'ok' : /FAIL|ERROR|TIMED_OUT|CANCELLED|ACTION_REQUIRED/.test(v) ? 'bad' : 'pending';
    return { name: c.name || c.context || 'check', state: st, url: c.detailsUrl || c.targetUrl || '' };
  });
  const count = (k) => checkItems.filter((c) => c.state === k).length;
  // review threads: replies hang off their root comment; a root belongs to the review it was submitted with
  const rc = (pr.reviewComments || []).slice().sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  const threads = new Map();
  for (const c of rc) {
    const root = c.in_reply_to_id || c.id;
    if (!threads.has(root)) threads.set(root, { id: root, path: c.path || '', line: c.line || c.original_line || '', outdated: c.line == null, hunkHtml: diffHtml((c.diff_hunk || '').split('\n').slice(-6).join('\n')), reviewId: c.pull_request_review_id, comments: [] });
    threads.get(root).comments.push({ id: c.id, ...who(c.user), at: c.created_at, time: fmtDate(c.created_at), html: safeHtml(c.body_html || mdToHtml(c.body || '')) });
  }
  const threadList = [...threads.values()];
  const timeline = [];
  for (const c of pr.issueComments || []) {
    timeline.push({ kind: 'comment', id: c.id, ...who(c.user), assoc: (c.author_association || '').toLowerCase(), at: c.created_at, time: fmtDate(c.created_at), html: safeHtml(c.body_html || mdToHtml(c.body || '')) });
  }
  for (const rv of pr.restReviews || []) {
    const mine = threadList.filter((t) => t.reviewId === rv.id);
    if (rv.state === 'COMMENTED' && !rv.body && !mine.length) continue;
    timeline.push({ kind: 'review', id: rv.id, ...who(rv.user), at: rv.submitted_at, time: fmtDate(rv.submitted_at), state: String(rv.state || '').toLowerCase(), html: rv.body ? safeHtml(rv.body_html || mdToHtml(rv.body)) : '', threads: mine });
  }
  // threads whose review is not in the list (e.g. a pending one) still show
  const shown = new Set(timeline.flatMap((e) => (e.threads || []).map((t) => t.id)));
  for (const t of threadList) if (!shown.has(t.id)) timeline.push({ kind: 'review', id: 't' + t.id, ...t.comments[0], state: 'commented', html: '', threads: [t] });
  timeline.sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')));
  // reviewers: the latest decisive review of each person, then the still-requested ones
  const reviewers = new Map();
  for (const rv of pr.restReviews || []) if (rv.user && rv.state !== 'COMMENTED') reviewers.set(rv.user.login, { ...who(rv.user), state: String(rv.state).toLowerCase() });
  for (const u of r.requested_reviewers || []) if (!reviewers.has(u.login)) reviewers.set(u.login, { ...who(u), state: 'pending' });
  const threadsByPath = {};
  for (const t of threadList) (threadsByPath[t.path] = threadsByPath[t.path] || []).push(t);
  const fileArr = (pr.fileList && pr.fileList.length ? pr.fileList : (pr.files || [])).slice(0, 100);
  return {
    owner: pr.owner || '', repo: pr.repo || '', number: pr.number, title: pr.title || r.title || '', url: pr.url || fallbackUrl,
    state, author: who(r.user || pr.author), createdAt: r.created_at || '', created: fmtDate(r.created_at),
    base: pr.baseRefName || r.base?.ref || '', head: pr.headRefName || r.head?.ref || '',
    commits: Array.isArray(pr.commits) ? pr.commits.length : r.commits || 0,
    additions: pr.additions || 0, deletions: pr.deletions || 0, changedFiles: pr.changedFiles || fileArr.length,
    reviewDecision: String(pr.reviewDecision || '').toLowerCase(),
    bodyHtml: r.body_html ? safeHtml(r.body_html) : mdToHtml(pr.body || '_No description provided._'),
    labels: (r.labels || []).map((l) => ({ name: l.name, color: '#' + (l.color || '8b949e') })),
    assignees: (r.assignees || []).map(who),
    reviewers: [...reviewers.values()],
    checks: { total: checkItems.length, ok: count('ok'), bad: count('bad'), pending: count('pending'), items: checkItems },
    timeline,
    files: fileArr.map((f) => { const name = f.filename || f.path; return { name, status: f.status || '', additions: f.additions || 0, deletions: f.deletions || 0, diffHtml: diffHtml(f.patch), threads: threadsByPath[name] || [] }; }),
    // the Linear tab's GitHub pill
    stateLabel: { open: 'Open', draft: 'Draft', merged: 'Merged', closed: 'Closed' }[state],
  };
}

// Styles for the card (the card mounts only the active tab, so no toggling here).
const TICKET_CSS = `
  :root{color-scheme:dark;--bg:#16171a;--side:#18191c;--panel:#1b1c20;--hover:#1f2024;--border:#26272c;--line:#2e2f35;--text:#d2d3e0;--title:#f7f8f8;--dim:#8a8f98;--mute:#b4b6c3;--link:#8f9bff;--code:#232429;--code-text:#e2e3ea;--chip-off:#4b4c55;--accent:#5e6ad2}
  html[data-theme=light]{color-scheme:light;--bg:#ffffff;--side:#fbfbfc;--panel:#fbfbfc;--hover:#f1f2f4;--border:#e6e7ea;--line:#dcdde1;--text:#3c3f48;--title:#1b1d22;--dim:#6f737e;--mute:#555a66;--link:#4f5bd5;--code:#f1f2f4;--code-text:#2a2d35;--chip-off:#d0d1d6;--accent:#5e6ad2}
  *{box-sizing:border-box}
  body{margin:0;font:14px/1.6 "Inter Variable",Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;background:var(--bg);color:var(--text);-webkit-font-smoothing:antialiased}
  a{color:var(--link);text-decoration:none}a:hover{text-decoration:underline}
  code{background:var(--code);border:1px solid var(--line);border-radius:4px;padding:1px 5px;font:12.5px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--code-text)}
  pre{background:var(--code);border:1px solid var(--line);border-radius:6px;padding:10px 12px;overflow:auto}
  img{max-width:100%;border-radius:6px;margin:10px 0;border:1px solid var(--line);display:block}
  /* the Linear ticket page (card.jsx App) */
  .lin{height:100%;display:flex;flex-direction:column;min-height:0}
  .lin-top{flex:0 0 auto;display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 20px;border-bottom:1px solid var(--border);font-size:13px;color:var(--dim)}
  .crumb{display:flex;align-items:center;gap:6px;min-width:0}.crumb .sep{color:var(--dim)}.crumb .mono{color:var(--mute)}
  .topr{display:flex;align-items:center;gap:10px}
  .open{color:var(--mute);font-size:12.5px;border:1px solid var(--line);border-radius:6px;padding:3px 9px}.open:hover{background:var(--hover);text-decoration:none;color:var(--title)}
  .lin-body{flex:1;min-height:0;overflow:auto;display:flex;align-items:flex-start}
  .lin-main{flex:1;min-width:0;max-width:860px;margin:0 auto;padding:28px 36px 48px}
  .lin-title{font-size:22px;line-height:1.3;font-weight:600;color:var(--title);margin:0 0 14px;letter-spacing:-.01em}
  .lin-desc{color:var(--text);font-size:14.5px}
  .desc p{margin:6px 0}.desc ul{margin:6px 0;padding-left:22px}.desc li{margin:2px 0}
  .desc h3,.desc h4,.desc h5,.desc h6{color:var(--title);font-weight:600}
  .desc h3{font-size:17px}.desc h4{font-size:15.5px}
  .lin-sec{margin-top:22px}.sec-h{font-size:12px;color:var(--dim);margin-bottom:6px;font-weight:500}
  .rel{display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:6px;color:var(--text)}.rel:hover{background:var(--hover);text-decoration:none}
  .rel .rlbl{font-size:11px;color:var(--dim);min-width:58px}.rel b{color:var(--dim);font-size:12px;font-weight:500}.rtitle{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .lin-tabs{display:flex;gap:4px;margin:30px 0 10px;border-bottom:1px solid var(--border)}
  .lt{padding:7px 10px;font-size:13px;font-weight:500;color:var(--dim);cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px;user-select:none}
  .lt.on{color:var(--title);border-bottom-color:var(--accent)}.lt .cnt{margin-left:6px;font-size:11px;color:var(--dim);background:var(--code);border-radius:999px;padding:0 6px}
  .thread{background:var(--panel);border:1px solid var(--border);border-radius:8px;margin:10px 0;overflow:hidden}
  .lc{padding:12px 14px}.lc.reply{border-top:1px solid var(--border);padding-left:44px}
  .lc-head{display:flex;align-items:center;gap:8px;margin-bottom:4px}
  .lc-author{font-weight:500;color:var(--title);font-size:13.5px}.lc-time{font-size:12px;color:var(--dim)}
  .lc-body{font-size:14px}.lc-body img{max-width:min(100%,480px);max-height:300px;width:auto;height:auto;object-fit:contain}
  .lin-desc img{max-width:min(100%,720px);max-height:460px;width:auto;height:auto;object-fit:contain}
  .av{display:inline-flex;align-items:center;justify-content:center;border-radius:50%;color:#fff;font-weight:600;flex:0 0 auto;line-height:1}
  .lin-side{flex:0 0 260px;align-self:flex-start;position:sticky;top:0;min-height:100%;border-left:1px solid var(--border);padding:22px 18px;background:var(--side);font-size:13px}
  .prop{display:flex;align-items:flex-start;gap:10px;padding:6px 0;min-height:30px}
  .plbl{flex:0 0 86px;color:var(--dim);padding-top:2px}
  .pval{flex:1;min-width:0;display:flex;align-items:center;gap:7px;color:var(--text);flex-wrap:wrap;word-break:break-word}
  .pval .mono{font-family:ui-monospace,Menlo,monospace;font-size:11.5px;color:var(--mute)}.dim{color:var(--dim)}
  .ico{width:14px;height:14px;flex:0 0 auto}
  .chips{display:flex;flex-wrap:wrap;gap:5px}
  .chip{display:inline-flex;align-items:center;gap:5px;border:1px solid var(--line);border-radius:999px;padding:1px 8px 1px 6px;font-size:12px;color:var(--text)}
  .side-sec{margin-top:14px;padding-top:12px;border-top:1px solid var(--border)}.side-sec .plbl{margin-bottom:6px}
  .slink{display:flex;align-items:center;gap:7px;padding:4px 6px;margin:0 -6px;border-radius:6px;color:var(--text);font-size:12.5px}.slink:hover{background:var(--hover);text-decoration:none}
  .slink .li{color:var(--dim);width:12px;text-align:center}.slink .lt2{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .propwrap{position:relative}
  .pval.editable{cursor:pointer;border-radius:6px;margin:-3px -6px;padding:3px 6px}.pval.editable:hover{background:var(--hover)}
  .menu{position:absolute;z-index:20;top:100%;inset-inline-end:0;min-width:220px;max-width:min(300px,92vw);background:var(--panel);border:1px solid var(--line);border-radius:8px;box-shadow:0 8px 28px rgba(0,0,0,.28);padding:4px;font-size:13px}
  .msearch{width:100%;font:inherit;background:var(--bg);color:var(--text);border:1px solid var(--line);border-radius:6px;padding:5px 8px;margin-bottom:4px;outline:none}
  .mlist{max-height:300px;overflow:auto}
  .mitem{display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:5px;cursor:pointer;color:var(--text)}.mitem:hover{background:var(--hover)}
  .mitem.on{font-weight:600}.mitem .check{margin-inline-start:auto;color:var(--accent)}.small{font-size:11.5px}
  .composer{position:relative;margin:14px 0 6px;border:1px solid var(--border);border-radius:8px;background:var(--panel);padding:8px}
  .composer.reply{margin:0;border:0;border-top:1px solid var(--border);border-radius:0;padding:10px 14px 10px 44px;background:transparent}
  .composer textarea{width:100%;resize:vertical;min-height:44px;font:14px/1.5 inherit;font-family:inherit;background:transparent;color:var(--text);border:0;outline:none}
  .composer .mentions{top:auto;bottom:calc(100% - 6px);inset-inline-start:8px}
  .crow{display:flex;justify-content:flex-end;gap:6px}
  .crow button,.replyrow button{font:500 12.5px inherit;font-family:inherit;border-radius:6px;padding:4px 12px;cursor:pointer;border:1px solid var(--line);background:transparent;color:var(--text)}
  .crow .send{background:var(--accent);border-color:var(--accent);color:#fff}.crow .send:disabled{opacity:.45;cursor:default}
  .replyrow{border-top:1px solid var(--border);padding:6px 14px 6px 44px}.replyrow button{border:0;color:var(--dim);padding:2px 0}.replyrow button:hover{color:var(--text)}
  .note{position:sticky;top:0;z-index:30;padding:6px 20px;font-size:12.5px;background:var(--panel);border-bottom:1px solid var(--border);color:var(--dim);cursor:pointer}.note.err{color:#eb5757}
  .desc img{cursor:zoom-in}
  .lbox{position:fixed;inset:0;z-index:50;background:rgba(0,0,0,.82);display:flex;align-items:center;justify-content:center;cursor:zoom-out;animation:lbin .12s ease-out}
  .lbox img{max-width:94vw;max-height:88vh;border:0;border-radius:6px;margin:0;box-shadow:0 10px 40px rgba(0,0,0,.5);cursor:default}
  .lbox .lbar{position:fixed;top:12px;inset-inline-end:14px;display:flex;gap:8px}
  .lbox .lbar a,.lbox .lbar button{font:500 12.5px system-ui;color:#fff;background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.18);border-radius:6px;padding:4px 10px;cursor:pointer;text-decoration:none}
  .lbox .lcap{position:fixed;bottom:14px;left:0;right:0;text-align:center;color:#d6d7dd;font-size:12.5px}
  @keyframes lbin{from{opacity:0}to{opacity:1}}
  /* the pull request (card.jsx GitHubTab) — GitHub's own palette in both themes */
  .gh{--g-bg:#0d1117;--g-panel:#151b23;--g-head:#151b23;--g-border:#3d444d;--g-muted:#262c36;--g-text:#f0f6fc;--g-dim:#9198a1;--g-link:#4493f8;--g-green:#238636;--g-purple:#8957e5;--g-red:#da3633;--g-gray:#656c76;--g-add-bg:rgba(46,160,67,.15);--g-add-tx:#aff5b4;--g-del-bg:rgba(248,81,73,.15);--g-del-tx:#ffdcd7;--g-hunk:#79c0ff;--g-code:#262c36;color:var(--g-text);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans",Helvetica,Arial,sans-serif}
  html[data-theme=light] .gh{--g-bg:#ffffff;--g-panel:#ffffff;--g-head:#f6f8fa;--g-border:#d1d9e0;--g-muted:#eff2f5;--g-text:#1f2328;--g-dim:#59636e;--g-link:#0969da;--g-green:#1f883d;--g-purple:#8250df;--g-red:#cf222e;--g-gray:#59636e;--g-add-bg:#dafbe1;--g-add-tx:#1f2328;--g-del-bg:#ffebe9;--g-del-tx:#1f2328;--g-hunk:#0550ae;--g-code:#eff2f5}
  .ghpage{height:100%;display:flex;flex-direction:column;background:var(--bg)}
  html[data-theme=light] .ghpage{background:#fff}html:not([data-theme=light]) .ghpage{background:#0d1117}
  .ghtop{display:flex;justify-content:space-between;align-items:center;padding:8px 20px;border-bottom:1px solid var(--border);color:var(--dim);font-size:13px}
  .ghscroll{flex:1;overflow:auto;padding:20px 24px 40px}
  .gh a{color:var(--g-link)}
  .gh code{background:var(--g-code);border:0;color:var(--g-text);border-radius:6px;padding:.15em .4em;font-size:85%}
  .ghtitle{font-size:26px;font-weight:400;line-height:1.25;margin:0 0 8px;color:var(--g-text)}.ghnum{color:var(--g-dim);font-weight:300}
  .ghmeta{display:flex;flex-wrap:wrap;align-items:center;gap:8px;color:var(--g-dim);font-size:14px;padding-bottom:14px;border-bottom:1px solid var(--g-border)}
  .ghmeta b{color:var(--g-text);font-weight:600}.ghref{color:var(--g-link)!important;background:rgba(56,139,253,.12)!important}
  .ghopen{margin-inline-start:auto;font-size:13px}
  .ghstate{display:inline-flex;align-items:center;border-radius:2em;padding:4px 12px;font-weight:500;color:#fff;font-size:14px}
  .ghstate.open{background:var(--g-green)}.ghstate.merged{background:var(--g-purple)}.ghstate.closed{background:var(--g-red)}.ghstate.draft{background:var(--g-gray)}
  .ghtabs{display:flex;align-items:center;gap:4px;border-bottom:1px solid var(--g-border);margin:14px 0 18px}
  .ghtab{padding:8px 14px;cursor:pointer;color:var(--g-dim);border-bottom:2px solid transparent;margin-bottom:-1px;user-select:none}
  .ghtab.on{color:var(--g-text);border-bottom-color:#fd8c73;font-weight:600}
  .ghcount{display:inline-block;min-width:20px;padding:0 6px;margin-inline-start:4px;border-radius:2em;background:var(--g-muted);font-size:12px;font-weight:500;text-align:center;color:var(--g-text)}
  .ghdiffstat{margin-inline-start:auto;font-size:12.5px;font-family:ui-monospace,monospace}
  .gh .add{color:#3fb950}.gh .del{color:#f85149}html[data-theme=light] .gh .add{color:#1a7f37}html[data-theme=light] .gh .del{color:#d1242f}
  .ghcols{display:flex;gap:24px;align-items:flex-start}.ghmain{flex:1;min-width:0}
  .ghside{flex:0 0 240px;font-size:12px}.ghsec{padding:0 0 14px;margin-bottom:14px;border-bottom:1px solid var(--g-border)}
  .ghsech{font-weight:600;color:var(--g-dim);margin-bottom:8px}.ghsrow{display:flex;align-items:center;gap:8px;margin:4px 0;color:var(--g-text);font-size:12.5px}
  .ghrv{margin-inline-start:auto}.ghrv.approved{color:#3fb950}.ghrv.changes_requested{color:#f85149}.ghrv.pending{color:#d29922}
  .ghlabels{display:flex;flex-wrap:wrap;gap:4px}
  .ghlabel{font-size:12px;font-weight:500;padding:0 8px;line-height:20px;border-radius:2em;border:1px solid color-mix(in srgb,var(--lc) 60%,transparent);background:color-mix(in srgb,var(--lc) 18%,transparent);color:color-mix(in srgb,var(--lc) 70%,var(--g-text))}
  .ghav{border-radius:50%;flex:0 0 auto;background:var(--g-muted);display:inline-block;margin:0;border:0}
  .ghitem{display:flex;gap:12px;margin:0 0 16px;position:relative}
  .ghbox{flex:1;min-width:0;border:1px solid var(--g-border);border-radius:6px;background:var(--g-panel);overflow:hidden}
  .ghboxh{display:flex;align-items:center;gap:6px;padding:8px 14px;background:var(--g-head);border-bottom:1px solid var(--g-border);font-size:14px;color:var(--g-text)}
  .ghdim{color:var(--g-dim);font-weight:400}.ghassoc{margin-inline-start:auto;font-size:12px;border:1px solid var(--g-border);border-radius:2em;padding:0 7px;color:var(--g-dim);text-transform:capitalize}
  .ghbody{padding:14px 16px;font-size:14px;color:var(--g-text);overflow-x:auto}
  .ghbody p{margin:0 0 12px}.ghbody p:last-child{margin-bottom:0}
  .ghbody table{border-collapse:collapse;margin:0 0 14px;display:block;width:max-content;max-width:100%;overflow:auto}
  .ghbody table,.ghbody table *{border-color:var(--g-border)!important}
  .ghbody th,.ghbody td{border:1px solid var(--g-border);padding:6px 13px}.ghbody th{font-weight:600;background:var(--g-head)}
  .ghbody tr:nth-child(2n) td{background:color-mix(in srgb,var(--g-muted) 45%,transparent)}
  .ghbody pre{background:var(--g-code);border:0;border-radius:6px;padding:14px;overflow:auto;font-size:85%}.ghbody pre code{background:none;padding:0;font-size:100%}
  .ghbody img{max-width:min(100%,560px);max-height:420px;border:0;display:inline-block}
  .ghbody blockquote{margin:0 0 12px;padding:0 1em;color:var(--g-dim);border-inline-start:.25em solid var(--g-border)}
  .ghbody ul,.ghbody ol{padding-inline-start:2em;margin:0 0 12px}.ghbody h1,.ghbody h2{border-bottom:1px solid var(--g-border);padding-bottom:.3em}
  .ghbody h1{font-size:1.6em}.ghbody h2{font-size:1.35em}.ghbody h3{font-size:1.15em}
  .ghbody details{margin:0 0 12px}.ghbody summary{cursor:pointer}.ghbody input[type=checkbox]{margin-inline-end:6px}
  .ghreview{align-items:flex-start}.ghrvicon{width:32px;height:32px;border-radius:50%;flex:0 0 32px;display:flex;align-items:center;justify-content:center;font-size:14px;color:#fff;background:var(--g-gray)}
  .ghrvicon.approved{background:var(--g-green)}.ghrvicon.changes_requested{background:var(--g-red)}
  .ghrvbody{flex:1;min-width:0;display:flex;flex-direction:column;gap:10px}.ghrvline{display:flex;align-items:center;gap:6px;min-height:32px}
  .ghthread{border:1px solid var(--g-border);border-radius:6px;overflow:hidden;background:var(--g-panel)}
  .ghthreadh{display:flex;align-items:center;gap:10px;padding:8px 14px;background:var(--g-head);border-bottom:1px solid var(--g-border);font-size:12.5px}
  .ghtc{border-top:1px solid var(--g-border)}.ghtc .ghboxh{background:transparent;border:0;padding:10px 14px 0}.ghtc .ghbody{padding:6px 14px 12px 42px}
  .ghreply{padding:8px 14px;border-top:1px solid var(--g-border)}
  .ghcompose textarea{width:100%;min-height:90px;border:0;border-bottom:1px solid var(--g-border);background:var(--g-bg);color:var(--g-text);padding:10px 12px;font:14px/1.5 inherit;font-family:inherit;resize:vertical;outline:none}
  .ghcompose.reply{border:0;border-top:1px solid var(--g-border);border-radius:0}.ghcompose.reply textarea{min-height:56px}
  .ghcrow{display:flex;align-items:center;gap:8px;padding:8px 10px;background:var(--g-head)}.ghhint{margin-inline-end:auto;font-size:12px;color:var(--g-dim)}
  .ghbtn{font:500 13px inherit;font-family:inherit;border-radius:6px;padding:4px 14px;cursor:pointer;border:1px solid var(--g-border);background:var(--g-muted);color:var(--g-text)}
  .ghbtn.primary{background:var(--g-green);border-color:rgba(240,246,252,.1);color:#fff}.ghbtn:disabled{opacity:.5;cursor:default}
  .ghchecks{padding:8px 14px}.ghck{width:16px;text-align:center;font-weight:700}.ghck.ok{color:#3fb950}.ghck.bad{color:#f85149}.ghck.pending{color:#d29922}
  details.ghfile{border:1px solid var(--g-border);border-radius:6px;margin:0 0 14px;background:var(--g-panel);overflow:hidden}
  details.ghfile>summary{display:flex;justify-content:space-between;gap:10px;padding:8px 14px;background:var(--g-head);cursor:pointer;list-style:none;font-size:12.5px;color:var(--g-text);position:sticky;top:0}
  details.ghfile>summary::-webkit-details-marker{display:none}.ghfstat{white-space:nowrap;font-family:ui-monospace,monospace}
  .gh .diff{margin:0;padding:0;border:0;border-radius:0;overflow-x:auto;font:12px/20px ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre;background:var(--g-bg);color:var(--g-text)}
  .gh .diff span{display:block;padding:0 12px}
  .gh .diff span.add{background:var(--g-add-bg);color:var(--g-add-tx)}.gh .diff span.del{background:var(--g-del-bg);color:var(--g-del-tx)}
  .gh .diff span.hunk{background:color-mix(in srgb,var(--g-link) 12%,transparent);color:var(--g-dim)}
  .gh .ghthread .diff{border-bottom:1px solid var(--g-border)}
  @media (max-width:900px){.ghcols{flex-direction:column-reverse}.ghside{flex:0 0 auto;width:100%;display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:0 16px}}
  @media (max-width:760px){
    .lin-body{flex-direction:column-reverse;align-items:stretch}
    .lin-side{flex:0 0 auto;position:static;min-height:0;border-left:0;border-bottom:1px solid var(--border);padding:12px 18px;display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));column-gap:16px}
    .lin-main{padding:20px 18px 40px}
    .side-sec{grid-column:1/-1}
  }
  blockquote.quote{margin:6px 0;padding:4px 10px;border-left:3px solid #30363d;color:#8b949e;background:#0f141a;border-radius:0 6px 6px 0}
  h3,h4,h5,h6{margin:14px 0 6px;line-height:1.3}
  html,body,#app{height:100%}
  .app{height:100%;display:flex;flex-direction:column;min-height:0}
  .head{flex:0 0 auto;background:#0d1117;padding:14px 16px 0;border-bottom:1px solid #21262d}
  .topbar{display:flex;align-items:center;justify-content:space-between;gap:10px}
  .id{font:600 12px ui-monospace,Menlo,monospace;color:#8b949e}
  .fontctl{display:flex;gap:3px;flex:0 0 auto}
  .fontctl button{background:var(--panel,#161b22);border:1px solid var(--line,#30363d);color:var(--text,#c9d1d9);border-radius:6px;cursor:pointer;font:600 11px ui-sans-serif;padding:3px 7px;line-height:1}
  .fontctl button:hover{border-color:var(--accent,#58a6ff);color:var(--title,#fff)}
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
  .resolved{font-size:11px;color:#4cb782;border:1px solid #4cb78255;border-radius:999px;padding:0 7px}
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

// GitHub renders markdown itself (tables, task lists, code, signed image links) — `full+json` hands back body_html.
const GH_HTML = ['-H', 'Accept: application/vnd.github.full+json'];
async function ghJson(pathArgs) {
  try { return JSON.parse(await execFileP('gh', ['api', ...GH_HTML, ...pathArgs])); } catch { return null; }
}
async function fetchPR(owner, repo, num) {
  const base = `${owner}/${repo}`;
  const fields = 'number,title,state,isDraft,author,headRefName,baseRefName,additions,deletions,changedFiles,url,body,reviewDecision,statusCheckRollup,files,comments,reviews,commits';
  try {
    const out = await execFileP('gh', ['pr', 'view', String(num), '--repo', base, '--json', fields]);
    const pr = JSON.parse(out);
    pr.owner = owner; pr.repo = repo;
    const [rest, issueComments, reviews, reviewComments, files] = await Promise.all([
      ghJson([`repos/${base}/pulls/${num}`]),
      ghJson([`repos/${base}/issues/${num}/comments?per_page=100`]),
      ghJson([`repos/${base}/pulls/${num}/reviews?per_page=100`]),
      ghJson([`repos/${base}/pulls/${num}/comments?per_page=100`]),
      ghJson([`repos/${base}/pulls/${num}/files?per_page=100`]),
    ]);
    pr.rest = rest || {};
    pr.issueComments = issueComments || [];
    pr.restReviews = reviews || [];
    pr.reviewComments = reviewComments || [];
    pr.fileList = files || [];
    return pr;
  } catch {
    return null;
  }
}

// GitHub's body_html is already sanitized by GitHub; this page is same-origin with the cockpit, so strip anything
// active on top of that anyway — a script here would act with the owner's session.
export function safeHtml(html) {
  return String(html || '')
    .replace(/<\s*(script|style|iframe|object|embed|form|link|meta|base)\b[\s\S]*?(<\s*\/\s*\1\s*>|\/>|$)/gi, '')
    .replace(/<\s*(script|style|iframe|object|embed|form|link|meta|base)\b[^>]*>/gi, '')
    .replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src|xlink:href|action|formaction)\s*=\s*(["']?)\s*(javascript|vbscript|data):(?!image\/)/gi, '$1=$2#blocked:')
    .replace(/<a\s/gi, '<a target="_blank" rel="noopener" ');
}

// ---- the card bundle ------------------------------------------------------------
// Built lazily from server/assets/card.jsx with Bun.build (preact), memoized.
const CARD_SRC = path.join(resourceRoot(), 'server', 'assets', 'card.jsx');
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
