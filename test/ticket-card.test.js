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
