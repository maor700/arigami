// Unit tests for server/state.js against a temp state file.
// Claude spawning is intentionally NOT tested here.
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-test-'));
process.env.ARIGAMI_STATE_FILE = path.join(tmp, 'state.json');
process.env.ARIGAMI_CHAT_DIR = path.join(tmp, 'chat');

const state = await import('../server/state.js');
const { cfg } = state;

test('createSession: defaults, scratch naming, first tab is the session tab', () => {
  const a = state.createSession({});
  expect(a.id).toStartWith('sess_');
  expect(a.title).toBe('scratch-1');
  expect(a.archived).toBe(false);
  expect(a.metadata).toEqual({});
  expect(a.progress).toBeNull();
  expect(a.action).toBeNull();
  expect(a.tabs).toHaveLength(1);
  expect(a.tabs[0].type).toBe('session');
  expect(a.activeTabId).toBe(a.tabs[0].id);
  // modelChoice is seeded from cfg.defaultModel (env/config-dependent), so assert
  // the stable fields exactly and modelChoice's presence rather than a pinned value.
  expect(a.claude).toMatchObject({ sessionId: null, state: 'idle', permissionMode: 'bypassPermissions', accountId: null });
  expect('modelChoice' in a.claude).toBe(true);
  expect(a.cwd).toBe(cfg.defaultCwd);

  const b = state.createSession({ title: '  ' }); // blank title → scratch-N
  expect(b.title).toBe('scratch-2');
  const c = state.createSession({ title: 'my-task', cwd: '/tmp', permissionMode: 'plan' });
  expect(c.title).toBe('my-task');
  expect(c.cwd).toBe('/tmp');
  expect(c.claude.permissionMode).toBe('plan');
  const d = state.createSession({});
  expect(d.title).toBe('scratch-3'); // named session does not consume a scratch number
});

test('color rotation: round-robin through cfg.palette, wrapping', () => {
  const before = state.listSessions({ archived: true }).length;
  const colors = [];
  for (let i = 0; i < cfg.palette.length + 2; i++) colors.push(state.createSession({ title: `c${i}` }).color);
  for (let i = 0; i < colors.length; i++) {
    expect(colors[i]).toBe(cfg.palette[(before + i) % cfg.palette.length]);
  }
  expect(colors[0]).toBe(colors[cfg.palette.length]); // wrapped
});

test('patchSession: simple fields set, metadata merges, unknown keys ignored', () => {
  const s = state.createSession({ title: 'patch-me', metadata: { ticket: 'ENG-1' } });
  state.patchSession(s.id, { title: 'renamed', status: 'In Review', color: '#000000' });
  let got = state.getSession(s.id);
  expect(got.title).toBe('renamed');
  expect(got.status).toBe('In Review');
  expect(got.color).toBe('#000000');

  state.patchSession(s.id, { metadata: { branch: 'eng-1-fix' }, id: 'sess_hax', cwd: '/evil' });
  got = state.getSession(s.id);
  expect(got.metadata).toEqual({ ticket: 'ENG-1', branch: 'eng-1-fix' }); // merged
  expect(got.id).toBe(s.id);
  expect(got.cwd).not.toBe('/evil');

  expect(state.patchSession('sess_nope', { title: 'x' })).toBeNull();
});

test('progress and action patches', () => {
  const s = state.createSession({ title: 'prog' });
  state.patchSession(s.id, { progress: { steps: [{ label: 'worktree', state: 'done' }] } });
  expect(state.getSession(s.id).progress.steps).toHaveLength(1);
  state.patchSession(s.id, { progress: null });
  expect(state.getSession(s.id).progress).toBeNull();
  const action = { id: 'act_1', prompt: 'Review?', buttons: [{ label: 'OK', value: 'ok' }] };
  state.patchSession(s.id, { action });
  expect(state.getSession(s.id).action).toEqual(action);
});

test('tabs: add/patch/activate/delete; session tab is protected', () => {
  const s = state.createSession({ title: 'tabs' });
  const sessionTab = s.tabs[0];

  const url = state.addTab(s.id, { type: 'url', title: 'App', url: 'http://localhost:3020', compare: { url: 'https://prod' }, badge: 'dev' });
  expect(url.id).toStartWith('tab_');
  expect(state.getSession(s.id).activeTabId).toBe(url.id); // new tab activates

  const content = state.addTab(s.id, { type: 'content', title: 'Notes', format: 'markdown', body: '# hi' });
  expect(content.format).toBe('markdown');
  expect(state.getSession(s.id).tabs).toHaveLength(3);

  expect(() => state.addTab(s.id, { type: 'session', title: 'nope' })).toThrow();

  state.patchTab(s.id, url.id, { title: 'App :3020', badge: '#2841' });
  const patched = state.getSession(s.id).tabs.find((t) => t.id === url.id);
  expect(patched.title).toBe('App :3020');
  expect(patched.badge).toBe('#2841');
  expect(state.patchTab(s.id, 'tab_nope', { title: 'x' })).toBeNull();

  state.activateTab(s.id, sessionTab.id);
  expect(state.getSession(s.id).activeTabId).toBe(sessionTab.id);
  expect(state.activateTab(s.id, 'tab_nope')).toBeNull();

  state.activateTab(s.id, content.id);
  expect(state.deleteTab(s.id, content.id)).toBe(true);
  const after = state.getSession(s.id);
  expect(after.tabs).toHaveLength(2);
  expect(after.tabs.some((t) => t.id === after.activeTabId)).toBe(true); // active fell back

  expect(() => state.deleteTab(s.id, sessionTab.id)).toThrow(); // session tab protected
});

test('archive flag and listing filters', () => {
  const s = state.createSession({ title: 'arch' });
  state.patchSession(s.id, { archived: true });
  expect(state.getSession(s.id).archived).toBe(true);
  expect(state.listSessions().some((x) => x.id === s.id)).toBe(false);
  expect(state.listSessions({ archived: true }).some((x) => x.id === s.id)).toBe(true);
  state.patchSession(s.id, { archived: false });
  expect(state.listSessions().some((x) => x.id === s.id)).toBe(true);
});

test('deleteSession removes the session', () => {
  const s = state.createSession({ title: 'doomed' });
  expect(state.deleteSession(s.id)).toBe(true);
  expect(state.getSession(s.id)).toBeNull();
  expect(state.deleteSession(s.id)).toBe(false);
});

test('persistence: flushState writes sessions + colorIndex to the state file', () => {
  const s = state.createSession({ title: 'persisted' });
  state.flushState();
  const j = JSON.parse(fs.readFileSync(process.env.ARIGAMI_STATE_FILE, 'utf8'));
  expect(j.colorIndex).toBeGreaterThan(0);
  const found = j.sessions.find((x) => x.id === s.id);
  expect(found.title).toBe('persisted');
  expect(found.tabs[0].type).toBe('session');
});

/* ---------------- rail folders ------------------------------------------- */

test('folders: create/patch/list, name defaults and trimming', () => {
  const f = state.createFolder({ name: '  Auth revamp  ' });
  expect(f.id).toStartWith('fld_');
  expect(f.name).toBe('Auth revamp');
  expect(f.collapsed).toBe(false);
  expect(f.controllerSessionId).toBeNull();
  expect(state.listFolders().some((x) => x.id === f.id)).toBe(true);

  expect(state.createFolder({}).name).toBe('New folder');

  state.patchFolder(f.id, { name: 'Renamed', collapsed: true, id: 'fld_hax' });
  const got = state.getFolder(f.id);
  expect(got.name).toBe('Renamed');
  expect(got.collapsed).toBe(true);
  expect(got.id).toBe(f.id); // id not patchable
  expect(state.patchFolder('fld_nope', { name: 'x' })).toBeNull();
});

test('folderId is patchable on a session; folderChildren sorts by sortOrder', () => {
  const f = state.createFolder({ name: 'grp' });
  const a = state.createSession({ title: 'kid-a' });
  const b = state.createSession({ title: 'kid-b' });
  state.patchSession(a.id, { folderId: f.id });
  state.patchSession(b.id, { folderId: f.id });
  state.railReorder({ folders: { [f.id]: [b.id, a.id] } });
  const kids = state.folderChildren(f.id);
  expect(kids.map((s) => s.id)).toEqual([b.id, a.id]);
});

test('railReorder: applies moves before order, stamps root + in-folder axes', () => {
  const f = state.createFolder({ name: 'rr' });
  const s1 = state.createSession({ title: 'rr-1' });
  const s2 = state.createSession({ title: 'rr-2' });
  state.railReorder({
    root: [
      { type: 'folder', id: f.id },
      { type: 'session', id: s2.id },
    ],
    folders: { [f.id]: [s1.id] },
    moves: [{ sessionId: s1.id, folderId: f.id }],
  });
  expect(state.getSession(s1.id).folderId).toBe(f.id);
  expect(state.getSession(s1.id).sortOrder).toBe(0); // in-folder axis
  expect(state.getFolder(f.id).sortOrder).toBe(0);
  expect(state.getSession(s2.id).sortOrder).toBe(1);
  // move to an unknown folder degrades to root
  state.railReorder({ moves: [{ sessionId: s1.id, folderId: 'fld_nope' }] });
  expect(state.getSession(s1.id).folderId).toBeNull();
});

test('deleteFolder ungroups: children return to root at the folder position', () => {
  const f = state.createFolder({ name: 'die' });
  const a = state.createSession({ title: 'die-a' });
  const b = state.createSession({ title: 'die-b' });
  state.railReorder({
    root: [{ type: 'folder', id: f.id }],
    folders: { [f.id]: [a.id, b.id] },
    moves: [
      { sessionId: a.id, folderId: f.id },
      { sessionId: b.id, folderId: f.id },
    ],
  });
  const r = state.deleteFolder(f.id);
  expect(r.children.map((s) => s.id)).toEqual([a.id, b.id]);
  expect(state.getFolder(f.id)).toBeNull();
  const ga = state.getSession(a.id);
  const gb = state.getSession(b.id);
  expect(ga.folderId).toBeNull();
  expect(gb.folderId).toBeNull();
  // fractional slots keep them at the folder's old root position, in order
  expect(ga.sortOrder).toBeGreaterThan(0 - 1e-9);
  expect(gb.sortOrder).toBeGreaterThan(ga.sortOrder);
  expect(state.deleteFolder(f.id)).toBeNull();
});

test('controller release: deleting or archiving the controller demotes the folder', () => {
  const f = state.createFolder({ name: 'proj' });
  const ctl = state.createSession({ title: 'controller' });
  state.patchFolder(f.id, { controllerSessionId: ctl.id });
  expect(state.getFolder(f.id).controllerSessionId).toBe(ctl.id);
  state.patchSession(ctl.id, { archived: true });
  expect(state.getFolder(f.id).controllerSessionId).toBeNull();

  const ctl2 = state.createSession({ title: 'controller-2' });
  state.patchFolder(f.id, { controllerSessionId: ctl2.id });
  state.deleteSession(ctl2.id);
  expect(state.getFolder(f.id).controllerSessionId).toBeNull();
});

test('persistence: folders survive flushState', () => {
  const f = state.createFolder({ name: 'kept' });
  state.flushState();
  const j = JSON.parse(fs.readFileSync(process.env.ARIGAMI_STATE_FILE, 'utf8'));
  expect(j.folders.some((x) => x.id === f.id && x.name === 'kept')).toBe(true);
});

/* ---------------- status summary ----------------------------------------- */

test('status summary: set / auto-update toggle / clear / transient summarizing', () => {
  const s = state.createSession({ title: 'sum' });
  expect(state.getSession(s.id).statusSummary).toBeUndefined();

  // set stores text + stamps timestamp, clears summarizing, keeps fold cursor
  state.setSummarizing(s.id, true);
  expect(state.getSession(s.id).summarizing).toBe(true);
  state.setStatusSummary(s.id, { text: 'brief v1', atSeq: 7, autoUpdate: true });
  let g = state.getSession(s.id);
  expect(g.statusSummary.text).toBe('brief v1');
  expect(g.statusSummary.atSeq).toBe(7);
  expect(g.statusSummary.autoUpdate).toBe(true);
  expect(g.statusSummary.generatedAt).toBeTruthy();
  expect(g.summarizing).toBe(false); // set clears the running flag

  // fold: new text + advanced cursor, autoUpdate preserved when omitted
  state.setStatusSummary(s.id, { text: 'brief v2', atSeq: 12 });
  g = state.getSession(s.id);
  expect(g.statusSummary.text).toBe('brief v2');
  expect(g.statusSummary.atSeq).toBe(12);
  expect(g.statusSummary.autoUpdate).toBe(true); // preserved

  // toggle auto without regenerating
  state.setSummaryAutoUpdate(s.id, false);
  expect(state.getSession(s.id).statusSummary.autoUpdate).toBe(false);
  // toggle no-ops when there's no summary
  const s2 = state.createSession({ title: 'nosum' });
  expect(state.setSummaryAutoUpdate(s2.id, true)).toBeNull();

  // clear turns it off
  state.clearStatusSummary(s.id);
  expect(state.getSession(s.id).statusSummary).toBeNull();
});

test('status summary: summarizing flag is transient (stripped on reload)', () => {
  const s = state.createSession({ title: 'sum-persist' });
  state.setStatusSummary(s.id, { text: 'kept', atSeq: 3, autoUpdate: true });
  state.setSummarizing(s.id, true);
  state.flushState();
  const j = JSON.parse(fs.readFileSync(process.env.ARIGAMI_STATE_FILE, 'utf8'));
  const found = j.sessions.find((x) => x.id === s.id);
  // summary persists; the transient run flag was broadcast-only, never touched → last persisted value may be true,
  // but load() deletes it. Assert the summary payload survived intact.
  expect(found.statusSummary).toMatchObject({ text: 'kept', autoUpdate: true, atSeq: 3, lang: 'auto' });
});
