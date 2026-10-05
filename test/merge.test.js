// F7 — host-managed child worktrees + host-executed merge after approval.
// git.ts / merge.ts are free of the state singleton, so they run in-process on
// a throwaway repo; the approval stamp (markApproved) touches state → child proc.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runInChild } from './_child.js';

const { provisionChildWorktree, removeWorktree } = await import('../server/git.js');
const { mergeBranch, baseStatus, mergeMessage, deleteBranch } = await import('../server/merge.js');

const out = (b) => Buffer.from(b).toString().trim();
function sh(cwd, ...args) {
  const p = Bun.spawnSync(args, { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (p.exitCode !== 0) throw new Error(`${args.join(' ')} → ${out(p.stderr)}`);
  return out(p.stdout);
}
const commit = (dir, file, content, msg) => {
  fs.writeFileSync(path.join(dir, file), content);
  sh(dir, 'git', 'add', '-A');
  sh(dir, 'git', 'commit', '-q', '-m', msg);
};

let repos, repo;
beforeAll(() => {
  repos = fs.mkdtempSync(path.join(os.tmpdir(), 'f7-repos-'));
  repo = path.join(repos, 'proj');
  fs.mkdirSync(repo);
  sh(repo, 'git', 'init', '-q', '-b', 'master');
  sh(repo, 'git', 'config', 'user.email', 't@t.io');
  sh(repo, 'git', 'config', 'user.name', 'T');
  commit(repo, 'README.md', '# hi\n', 'init');
});
afterAll(() => { try { fs.rmSync(repos, { recursive: true, force: true }); } catch {} });

// ---- worktree helper ----------------------------------------------------

test('provisionChildWorktree: <reposDir>/<repo>-wt-<subtask> on child/<subtask>-<id> off the parent branch', async () => {
  const r = await provisionChildWorktree({ parentDir: repo, subtask: 'F7 gap', reposDir: repos, suffix: 'ab12' });
  expect(r.ok).toBe(true);
  expect(r.dir).toBe(path.join(repos, 'proj-wt-F7-gap'));
  expect(r.branch).toBe('child/F7-gap-ab12');
  expect(r.base).toBe('master');
  expect(sh(r.dir, 'git', 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('child/F7-gap-ab12');
  // a second provision with the same subtask must not collide on the dir
  const r2 = await provisionChildWorktree({ parentDir: repo, subtask: 'F7 gap', reposDir: repos, suffix: 'cd34' });
  expect(r2.ok).toBe(true);
  expect(r2.dir).toBe(path.join(repos, 'proj-wt-F7-gap-cd34'));
  expect((await removeWorktree(repo, r.dir)).ok).toBe(true);
  expect((await removeWorktree(repo, r2.dir)).ok).toBe(true);
  expect(fs.existsSync(r.dir)).toBe(false);
});

test('provisionChildWorktree: explicit dir/branch/prefix/base + non-repo failure', async () => {
  const dir = path.join(repos, 'explicit');
  const r = await provisionChildWorktree({ parentDir: repo, subtask: 'x', dir, prefix: 'feat', base: 'master', suffix: 'z9' });
  expect(r.ok).toBe(true);
  expect(r.dir).toBe(dir);
  expect(r.branch).toBe('feat/x-z9');
  const d = await provisionChildWorktree({ parentDir: repo, subtask: 'y', branch: 'dispatch/y', reposDir: repos });
  expect(d.branch).toBe('dispatch/y');
  await removeWorktree(repo, r.dir);
  await removeWorktree(repo, d.dir);
  const bad = await provisionChildWorktree({ parentDir: fs.mkdtempSync(path.join(os.tmpdir(), 'norepo-')), subtask: 'q' });
  expect(bad.ok).toBe(false);
  expect(bad.error).toMatch(/not a git repository/);
});

// ---- merge ---------------------------------------------------------------

test('mergeBranch --no-ff: merge commit on base, child worktree untouched', async () => {
  const r = await provisionChildWorktree({ parentDir: repo, subtask: 'ok', reposDir: repos, suffix: 'm1' });
  commit(r.dir, 'a.txt', 'A\n', 'child work');
  const st = await baseStatus(repo, 'master', r.branch);
  expect(st).toMatchObject({ repo: true, head: 'master', checkedOut: true, dirty: false, branchExists: true, ahead: 1 });
  const m = await mergeBranch({ repoRoot: repo, branch: r.branch, base: 'master', strategy: 'no-ff', message: mergeMessage({ branch: r.branch, base: 'master', title: 'ok child', sessionId: 's1', strategy: 'no-ff' }) });
  expect(m.ok).toBe(true);
  expect(m.sha).toBe(sh(repo, 'git', 'rev-parse', 'HEAD'));
  expect(sh(repo, 'git', 'log', '-1', '--format=%P').split(' ').length).toBe(2); // a real merge commit
  expect(sh(repo, 'git', 'log', '-1', '--format=%s')).toBe(`Merge ${r.branch}: ok child`);
  expect(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8')).toBe('A\n');
  // nothing-to-merge afterwards
  const again = await mergeBranch({ repoRoot: repo, branch: r.branch, base: 'master', message: 'x' });
  expect(again.ok).toBe(false);
  expect(again.reason).toBe('nothing-to-merge');
  // a checked-out branch can't be deleted; after the worktree goes it can
  expect((await deleteBranch(repo, r.branch)).ok).toBe(false);
  await removeWorktree(repo, r.dir);
  expect((await deleteBranch(repo, r.branch)).ok).toBe(true);
});

test('mergeBranch squash: one commit, no second parent', async () => {
  const r = await provisionChildWorktree({ parentDir: repo, subtask: 'sq', reposDir: repos, suffix: 'm2' });
  commit(r.dir, 'b.txt', 'B\n', 'one');
  commit(r.dir, 'b.txt', 'BB\n', 'two');
  const m = await mergeBranch({ repoRoot: repo, branch: r.branch, base: 'master', strategy: 'squash', message: 'Squash sq' });
  expect(m.ok).toBe(true);
  expect(sh(repo, 'git', 'log', '-1', '--format=%P').split(' ').length).toBe(1);
  expect(sh(repo, 'git', 'log', '-1', '--format=%s')).toBe('Squash sq');
  expect(fs.readFileSync(path.join(repo, 'b.txt'), 'utf8')).toBe('BB\n');
  await removeWorktree(repo, r.dir);
});

test('mergeBranch refuses a dirty base (tracked changes) and leaves it alone; untracked files do not count', async () => {
  const r = await provisionChildWorktree({ parentDir: repo, subtask: 'dirty', reposDir: repos, suffix: 'm3' });
  commit(r.dir, 'c.txt', 'C\n', 'c');
  fs.writeFileSync(path.join(repo, 'README.md'), '# changed\n');
  const m = await mergeBranch({ repoRoot: repo, branch: r.branch, base: 'master', message: 'x' });
  expect(m.ok).toBe(false);
  expect(m.reason).toBe('dirty');
  expect(m.files).toEqual(['README.md']);
  expect(fs.existsSync(path.join(repo, 'c.txt'))).toBe(false);
  sh(repo, 'git', 'checkout', '--', 'README.md');
  fs.writeFileSync(path.join(repo, 'untracked.tmp'), 'x');
  const ok = await mergeBranch({ repoRoot: repo, branch: r.branch, base: 'master', message: 'x' });
  expect(ok.ok).toBe(true);
  fs.unlinkSync(path.join(repo, 'untracked.tmp'));
  await removeWorktree(repo, r.dir);
});

test('mergeBranch refuses when base is not the checkout of repoRoot', async () => {
  const r = await provisionChildWorktree({ parentDir: repo, subtask: 'wrongbase', reposDir: repos, suffix: 'm4' });
  commit(r.dir, 'd.txt', 'D\n', 'd');
  const m = await mergeBranch({ repoRoot: repo, branch: r.branch, base: 'main', message: 'x' });
  expect(m.ok).toBe(false);
  expect(m.reason).toBe('base-not-checked-out');
  const nb = await mergeBranch({ repoRoot: repo, branch: 'child/nope', base: 'master', message: 'x' });
  expect(nb.reason).toBe('no-branch');
  await removeWorktree(repo, r.dir);
});

test('mergeBranch conflict: aborted, base clean, conflicting files listed', async () => {
  const r = await provisionChildWorktree({ parentDir: repo, subtask: 'conf', reposDir: repos, suffix: 'm5' });
  commit(r.dir, 'README.md', '# child version\n', 'child edits readme');
  commit(repo, 'README.md', '# base version\n', 'base edits readme');
  const m = await mergeBranch({ repoRoot: repo, branch: r.branch, base: 'master', message: 'x' });
  expect(m.ok).toBe(false);
  expect(m.conflict).toBe(true);
  expect(m.files).toEqual(['README.md']);
  expect(sh(repo, 'git', 'status', '--porcelain')).toBe('');
  expect(fs.existsSync(path.join(repo, '.git', 'MERGE_HEAD'))).toBe(false);
  expect(fs.readFileSync(path.join(repo, 'README.md'), 'utf8')).toBe('# base version\n');
  await removeWorktree(repo, r.dir);
});

// ---- approval stamp (state) ----------------------------------------------

test('markApproved stamps the reviewed SHA and repository only on sessions that own a real branch ≠ base', async () => {
  const wt = await provisionChildWorktree({ parentDir: repo, subtask: 'approve', reposDir: repos, suffix: 'a1' });
  commit(wt.dir, 'approved.txt', 'reviewed', 'reviewed');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'f7-state-'));
  const r = runInChild(
    "const st=await import('./server/state.ts');const api=await import('./server/api.js');" +
      `const a=st.createSession({title:"a",cwd:${JSON.stringify(wt.dir)},metadata:{branch:${JSON.stringify(wt.branch)},base:"master"}});` +
      "const b=st.createSession({title:'b'});" +
      "const c=st.createSession({title:'c',metadata:{branch:'master',base:'master'}});" +
      "const d=st.createSession({title:'d',metadata:{branch:'child/y',merged:{sha:'abc'}}});" +
      "emit({a:api.markApproved(a.id,'human@x'),b:api.markApproved(b.id,'h'),c:api.markApproved(c.id,'h'),d:api.markApproved(d.id,'h'),ra:st.getSession(a.id).metadata.review,rb:st.getSession(b.id).metadata.review||null});",
    { ARIGAMI_DIR: dir, ARIGAMI_STATE_FILE: path.join(dir, 'state.json'), ARIGAMI_PORT: '' }
  );
  if (!r.ok) throw new Error(r.error);
  const o = r.out[0];
  expect(o.a).toBe(true);
  expect(o.b).toBe(false);
  expect(o.c).toBe(false);
  expect(o.d).toBe(false);
  expect(o.ra.state).toBe('approved');
  expect(o.ra.sha).toBe(sh(wt.dir, 'git', 'rev-parse', 'HEAD'));
  expect(o.ra.repo).toBe(fs.realpathSync(path.join(repo, '.git')));
  await removeWorktree(repo, wt.dir);
  expect(o.ra.by).toBe('human@x');
  expect(typeof o.ra.at).toBe('string');
  expect(o.rb).toBeNull();
});

test('mayMerge: admin, the master, or the folder controller — never the child itself or a stranger', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'f7-guard-'));
  const r = runInChild(
    "const st=await import('./server/state.ts');const api=await import('./server/api.js');" +
      "const master=st.createSession({title:'m'});const child=st.createSession({title:'c',metadata:{master:master.id,branch:'child/x-1'}});" +
      "const ctl=st.createSession({title:'ctl'});const f=st.createFolder({name:'p'});st.patchFolder(f.id,{controllerSessionId:ctl.id});st.patchSession(child.id,{folderId:f.id});" +
      "const c=st.getSession(child.id);const S=(sid)=>({kind:'session',sessionId:sid,user:null});" +
      "emit({admin:api.mayMerge({kind:'user',user:{id:'u',role:'admin'},via:'cookie'},c),off:api.mayMerge({kind:'off',user:null},c),host:api.mayMerge({kind:'host',user:null},c)," +
      "master:api.mayMerge(S(master.id),c),ctl:api.mayMerge(S(ctl.id),c),self:api.mayMerge(S(child.id),c),stranger:api.mayMerge(S('sess_nope'),c),member:api.mayMerge({kind:'user',user:{id:'u2',role:'member'},via:'cookie'},c),none:api.mayMerge(null,c)});",
    { ARIGAMI_DIR: dir, ARIGAMI_STATE_FILE: path.join(dir, 'state.json'), ARIGAMI_PORT: '' }
  );
  if (!r.ok) throw new Error(r.error);
  expect(r.out[0]).toEqual({ admin: true, off: true, host: true, master: true, ctl: true, self: false, stranger: false, member: false, none: false });
});

test('mergeBranch refuses a changed tip and merges only the approved SHA for both strategies', async () => {
  for (const strategy of ['no-ff', 'squash']) {
    const wt = await provisionChildWorktree({ parentDir: repo, subtask: `pinned-${strategy}`, reposDir: repos });
    commit(wt.dir, `pinned-${strategy}.txt`, 'reviewed', 'reviewed');
    const approvedSha = sh(wt.dir, 'git', 'rev-parse', 'HEAD');
    const before = sh(repo, 'git', 'rev-parse', 'HEAD');
    commit(wt.dir, `pinned-${strategy}.txt`, 'unreviewed', 'later commit');
    const refused = await mergeBranch({ repoRoot: repo, branch: wt.branch, base: 'master', approvedSha, strategy, message: 'reviewed only' });
    expect(refused).toMatchObject({ ok: false, reason: 'approval-stale' });
    expect(sh(repo, 'git', 'rev-parse', 'HEAD')).toBe(before);
    sh(wt.dir, 'git', 'reset', '--hard', approvedSha);
    const merged = await mergeBranch({ repoRoot: repo, branch: wt.branch, base: 'master', approvedSha, strategy, message: 'reviewed only' });
    expect(merged.ok).toBe(true);
    expect(fs.readFileSync(path.join(repo, `pinned-${strategy}.txt`), 'utf8')).toBe('reviewed');
    await removeWorktree(repo, wt.dir);
  }
});

test('mergeSession rejects a changed commit even with force; legacy approval needs a new review', async () => {
  const wt = await provisionChildWorktree({ parentDir: repo, subtask: 'stale-review', reposDir: repos });
  commit(wt.dir, 'stale.txt', 'reviewed', 'reviewed');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'f7-stale-'));
  const before = sh(repo, 'git', 'rev-parse', 'HEAD');
  const r = runInChild(`
    const st=await import('./server/state.ts'); const api=await import('./server/api.ts');
    const s=st.createSession({cwd:${JSON.stringify(wt.dir)},metadata:{branch:${JSON.stringify(wt.branch)},base:'master'}});
    const approved=api.markApproved(s.id,'human');
    Bun.spawnSync(['git','-C',s.cwd,'commit','--allow-empty','-m','unreviewed']);
    const status=await api.mergeStatus(st.getSession(s.id));
    const refused=await api.mergeSession(st.getSession(s.id),{force:true},'human');
    st.patchSession(s.id,{metadata:{review:{state:'approved',at:new Date().toISOString(),by:'legacy'}}});
    const legacy=await api.mergeStatus(st.getSession(s.id));
    emit({approved,status,refused,legacy}); st.flushState();
  `, { ARIGAMI_DIR: dir, ARIGAMI_STATE_FILE: path.join(dir, 'state.json') });
  expect(r.ok).toBe(true);
  expect(r.out[0].approved).toBe(true);
  expect(r.out[0].status).toMatchObject({ approved: false, canMerge: false, reason: 'approval-stale' });
  expect(r.out[0].refused).toMatchObject({ status: 409, reason: 'approval-stale' });
  expect(r.out[0].legacy.canMerge).toBe(false);
  expect(sh(repo, 'git', 'rev-parse', 'HEAD')).toBe(before);
  await removeWorktree(repo, wt.dir);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a commit added during a merge gate is refused; gates receive the approved SHA', async () => {
  const wt = await provisionChildWorktree({ parentDir: repo, subtask: 'gate-change', reposDir: repos });
  commit(wt.dir, 'gate.txt', 'reviewed', 'reviewed');
  const approvedSha = sh(wt.dir, 'git', 'rev-parse', 'HEAD');
  const before = sh(repo, 'git', 'rev-parse', 'HEAD');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'f7-gate-'));
  const extension = path.join(dir, 'fixture');
  fs.mkdirSync(extension);
  fs.writeFileSync(path.join(extension, 'manifest.json'), JSON.stringify({ name: 'gate-test', version: '0.1.0', apiVersion: 1, title: 'Gate test', hooks: { module: 'hooks.ts', gates: ['merge.before'] } }));
  fs.writeFileSync(path.join(extension, 'hooks.ts'), `export const hooks={gates:{'merge.before':async(ev)=>{globalThis.gateSha=ev.sha;Bun.spawnSync(['git','-C',${JSON.stringify(wt.dir)},'commit','--allow-empty','-m','during gate']);return {ok:true}}}};`);
  const r = runInChild(`
    const st=await import('./server/state.ts'); const api=await import('./server/api.ts');
    const ext=await import('./server/extensions.ts'); await ext.addExtension(${JSON.stringify(extension)}); await ext.reload();
    const s=st.createSession({cwd:${JSON.stringify(wt.dir)},metadata:{branch:${JSON.stringify(wt.branch)},base:'master'}});
    api.markApproved(s.id,'human');
    const result=await api.mergeSession(st.getSession(s.id),{},'human');
    emit({result,sha:globalThis.gateSha}); st.flushState();
  `, { ARIGAMI_DIR: dir, ARIGAMI_STATE_FILE: path.join(dir, 'state.json') });
  expect(r.ok).toBe(true);
  expect(r.out[0].sha).toBe(approvedSha);
  expect(r.out[0].result).toMatchObject({ status: 409, reason: 'approval-stale' });
  expect(sh(repo, 'git', 'rev-parse', 'HEAD')).toBe(before);
  await removeWorktree(repo, wt.dir);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('concurrent merge requests recheck metadata inside the repository lock', async () => {
  const wt = await provisionChildWorktree({ parentDir: repo, subtask: 'locked', reposDir: repos });
  commit(wt.dir, 'locked.txt', 'reviewed', 'reviewed');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'f7-lock-'));
  const r = runInChild(`
    const st=await import('./server/state.ts'); const api=await import('./server/api.ts');
    const s=st.createSession({cwd:${JSON.stringify(wt.dir)},metadata:{branch:${JSON.stringify(wt.branch)},base:'master'}});
    api.markApproved(s.id,'human');
    emit(await Promise.all([api.mergeSession(st.getSession(s.id),{},'human'),api.mergeSession(st.getSession(s.id),{},'human')])); st.flushState();
  `, { ARIGAMI_DIR: dir, ARIGAMI_STATE_FILE: path.join(dir, 'state.json') });
  expect(r.ok).toBe(true);
  expect(r.out[0].filter(x => x.ok)).toHaveLength(1);
  expect(r.out[0].find(x => !x.ok)).toMatchObject({ status: 409 });
  expect(r.out[0].find(x => !x.ok).error).toContain('already merged');
  await removeWorktree(repo, wt.dir);
  fs.rmSync(dir, { recursive: true, force: true });
});
