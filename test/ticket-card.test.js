// The Linear ticket page's data (server/pages.js): comments arrive with the issue (the MCP's get_issue has none, so the
// live fetcher adds list_comments), threads are oldest-first with replies under their parent, and the sidebar lists
// the ticket's properties in Linear's order. Imports config → in a child.
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { runInChild } from './_child.js';
import { tmpDir } from './_tmp.js';

test('an MCP issue + its comments become a Linear-like page: sidebar props and oldest-first threads', () => {
  const r = runInChild(
    "const p=await import('./server/pages.js');" +
      "const t=p.mcpIssueToTicket({id:'X-1',title:'T',description:'![shot](https://uploads.linear.app/a?signature=s)',priority:{value:2,name:'High'},status:'In Review',statusType:'started',labels:['Blog'],assignee:'Jane Doe',team:'Web',createdBy:'jo.smith@x.test',createdAt:'2026-01-01T00:00:00Z'," +
      "comments:[{id:'b',body:'reply',createdAt:'2026-01-03T00:00:00Z',parentId:'a',author:{name:'Jane Doe'}},{id:'a',body:'first',createdAt:'2026-01-02T00:00:00Z',parentId:null,author:{name:'jo.smith@x.test'}},{id:'c',body:'later',createdAt:'2026-01-04T00:00:00Z',parentId:null,author:{name:'Jane Doe'}}]});" +
      "emit(p.ticketData(t,'X-1',null).ticket);",
    { ARIGAMI_DIR: tmpDir('arigami-ticket-'), ARIGAMI_PORT: '' }
  );
  if (!r.ok) throw new Error(r.error);
  const t = r.out[0];
  expect(t.props.map((p) => p.key)).toEqual(['status', 'priority', 'assignee', 'labels', 'team', 'creator', 'created']);
  expect(t.props[0]).toMatchObject({ value: 'In Review', kind: 'started', color: '#f2c94c' });
  expect(t.props[1]).toMatchObject({ value: 'High', level: 2 });
  expect(t.props[2]).toMatchObject({ value: 'Jane Doe', initials: 'JD' });
  expect(t.props.find((p) => p.key === 'creator').value).toBe('jo.smith'); // an email login reads as its name part
  expect(t.comments.map((c) => c.author)).toEqual(['jo.smith', 'Jane Doe']);
  expect(t.comments[0].replies.map((c) => c.bodyHtml)).toEqual(['<p>reply</p>']);
  expect(t.descriptionHtml).toContain('<img alt="shot" src="https://uploads.linear.app/a?signature=s"');
});

test('the live fetcher asks for the comments alongside the issue (get_issue carries none)', () => {
  const src = fs.readFileSync(path.resolve(import.meta.dir, '../server/index.ts'), 'utf8');
  expect(src).toMatch(/Promise\.all\(\[mcp\.getIssue\(id\), mcp\.listComments\(id\)\.catch\(\(\) => \[\]\)\]\)/);
});

test("Linear's <linear-image> tags render as images (and other uploads as links)", () => {
  const r = runInChild(
    "const p=await import('./server/pages.js');" +
      "emit(p.mdToHtml('before\\n<linear-image>{\"type\":\"image\",\"attrs\":{\"src\":\"https://uploads.linear.app/a/b?signature=s.t\",\"alt\":\"Shot 1.png\"}}</linear-image>\\n<linear-file>{\"type\":\"file\",\"attrs\":{\"href\":\"https://uploads.linear.app/c\",\"title\":\"log.txt\"}}</linear-file>\\n<linear-image>{not json}</linear-image>'));",
    { ARIGAMI_DIR: tmpDir('arigami-ticket-img-'), ARIGAMI_PORT: '' }
  );
  if (!r.ok) throw new Error(r.error);
  const html = r.out[0];
  expect(html).toContain('<img alt="Shot 1.png" src="https://uploads.linear.app/a/b?signature=s.t"');
  expect(html).toContain('<a href="https://uploads.linear.app/c" target="_blank" rel="noopener">log.txt</a>');
  expect(html).toContain('&lt;linear-image&gt;{not json}'); // unparseable: shown as it came, escaped
});

test('the ticket page follows the cockpit theme (same-origin prefs, live) and zooms images', () => {
  const card = fs.readFileSync(path.resolve(import.meta.dir, '../server/assets/card.jsx'), 'utf8');
  const pages = fs.readFileSync(path.resolve(import.meta.dir, '../server/pages.js'), 'utf8');
  expect(card).toContain("localStorage.getItem('arigami-prefs')");
  expect(card).toMatch(/addEventListener\('storage'/);
  expect(card).toContain('<Lightbox />');
  expect(pages).toMatch(/html\[data-theme=light\]\{color-scheme:light;--bg:/);
  // no hard-coded dark colour left in the Linear page rules
  const lin = pages.slice(pages.indexOf('/* the Linear ticket page'), pages.indexOf('@media (max-width:760px)'));
  expect(lin).not.toMatch(/#(16171a|18191c|1b1c20|26272c|d2d3e0|f7f8f8)/i);
});

test("GitHub's rendered HTML is used, with anything active stripped (this page shares the cockpit's origin)", () => {
  const r = runInChild(
    "const p=await import('./server/pages.js');" +
      "emit(p.safeHtml('<p>ok</p><table><tr><td>x</td></tr></table><script>alert(1)</script><img src=x onerror=\"alert(2)\"><a href=\"javascript:alert(3)\">l</a><iframe src=\"//evil\"></iframe><style>body{}</style><img src=\"data:image/png;base64,AA\">'));",
    { ARIGAMI_DIR: tmpDir('arigami-safehtml-'), ARIGAMI_PORT: '' }
  );
  if (!r.ok) throw new Error(r.error);
  const h = r.out[0];
  expect(h).toContain('<p>ok</p><table>');
  expect(h).not.toMatch(/<script|onerror|javascript:|<iframe|<style/i);
  expect(h).toContain('src="data:image/png'); // an inline image is not active content
});

test('the PR model: GitHub-rendered body, a timeline of comments and reviews with their threads, reviewers', () => {
  const r = runInChild(
    "const p=await import('./server/pages.js');" +
      "emit(p.prViewModel({number:7,owner:'o',repo:'r',state:'OPEN',baseRefName:'main',headRefName:'feat',statusCheckRollup:[{name:'ci',conclusion:'SUCCESS'},{name:'lint',conclusion:'FAILURE'}]," +
      "rest:{title:'T',body_html:'<table><tr><td>a</td></tr></table>',user:{login:'al',avatar_url:'https://a/x'},labels:[{name:'bug',color:'d73a4a'}],requested_reviewers:[{login:'bo'}]}," +
      "issueComments:[{id:1,user:{login:'cy'},created_at:'2026-01-02T00:00:00Z',body_html:'<p>hi</p>'}]," +
      "restReviews:[{id:9,user:{login:'di'},state:'APPROVED',submitted_at:'2026-01-03T00:00:00Z',body:''}]," +
      "reviewComments:[{id:20,pull_request_review_id:9,user:{login:'di'},path:'a.ts',line:4,diff_hunk:'@@ -1 +1 @@\\n-a\\n+b',created_at:'2026-01-03T00:00:00Z',body_html:'<p>nit</p>'},{id:21,in_reply_to_id:20,user:{login:'al'},created_at:'2026-01-04T00:00:00Z',body_html:'<p>done</p>'}],fileList:[{filename:'a.ts',additions:1,deletions:1,patch:'@@ -1 +1 @@\\n-a\\n+b'}]}));",
    { ARIGAMI_DIR: tmpDir('arigami-prvm-'), ARIGAMI_PORT: '' }
  );
  if (!r.ok) throw new Error(r.error);
  const m = r.out[0];
  expect(m).toMatchObject({ title: 'T', state: 'open', base: 'main', head: 'feat', stateLabel: 'Open' });
  expect(m.bodyHtml).toContain('<table>');
  expect(m.timeline.map((e) => [e.kind, e.login])).toEqual([['comment', 'cy'], ['review', 'di']]);
  expect(m.timeline[1].threads[0].comments.map((c) => c.login)).toEqual(['di', 'al']); // the reply stays in its thread
  expect(m.reviewers.map((u) => [u.login, u.state])).toEqual([['di', 'approved'], ['bo', 'pending']]);
  expect(m.checks).toMatchObject({ total: 2, ok: 1, bad: 1 });
  expect(m.files[0].threads).toHaveLength(1);
  expect(m.labels[0]).toEqual({ name: 'bug', color: '#d73a4a' });
});

test('a failed job log comes down to its ##[error] lines and what led to them', async () => {
  const gc = await import('../server/lib/gh-checks.ts');
  const raw = ['2026-10-25T16:42:09.1Z setup', ...Array.from({ length: 30 }, (_, i) => `2026-10-25T16:42:10.${i}Z line ${i}`), '2026-10-25T16:42:11.0Z \x1b[31m##[error]Process completed with exit code 1.\x1b[0m', '2026-10-25T16:42:12.0Z cleanup'].join('\n');
  const ex = gc.logExcerpt(raw, 3);
  expect(ex.errors).toBe(1);
  expect(ex.lines).toEqual(['line 27', 'line 28', 'line 29', '✕ Process completed with exit code 1.']);
  expect(gc.logExcerpt('a\nb\n').lines).toEqual(['a', 'b']);
  expect(gc.actionsIds('https://github.com/o/r/actions/runs/12/job/34')).toEqual({ runId: '12', jobId: '34' });
  expect(gc.actionsIds('https://vercel.com/x')).toBeNull();
});
