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

test('request-changes withdraws an approval: no merge (not even forced) until a fresh approve', async () => {
  const wt = await provisionChildWorktree({ parentDir: repo, subtask: 'changes-requested', reposDir: repos });
  commit(wt.dir, 'cr.txt', 'reviewed', 'reviewed');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'f7-cr-'));
  const before = sh(repo, 'git', 'rev-parse', 'HEAD');
  const r = runInChild(`
    const st=await import('./server/state.ts'); const api=await import('./server/api.ts');
    const s=st.createSession({cwd:${JSON.stringify(wt.dir)},metadata:{branch:${JSON.stringify(wt.branch)},base:'master'}});
    api.markApproved(s.id,'human');
    const approved=await api.mergeStatus(st.getSession(s.id));
    const revoked=api.markChangesRequested(s.id,'human');
    const status=await api.mergeStatus(st.getSession(s.id));
    const refused=await api.mergeSession(st.getSession(s.id),{force:true},'human');
    const review=st.getSession(s.id).metadata.review;
    api.markApproved(s.id,'human');
    const again=await api.mergeStatus(st.getSession(s.id));
    emit({approved,revoked,status,refused,review,again}); st.flushState();
  `, { ARIGAMI_DIR: dir, ARIGAMI_STATE_FILE: path.join(dir, 'state.json') });
  expect(r.ok).toBe(true);
  const o = r.out[0];
  expect(o.approved.canMerge).toBe(true);
  expect(o.revoked).toBe(true);
  expect(o.review.state).toBe('changes-requested');
  expect(o.status).toMatchObject({ approved: false, approvedSha: null, canMerge: false, reason: 'changes-requested' });
  expect(o.refused).toMatchObject({ status: 409, reason: 'changes-requested' });
  expect(o.again.canMerge).toBe(true);
  expect(sh(repo, 'git', 'rev-parse', 'HEAD')).toBe(before);
  await removeWorktree(repo, wt.dir);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- ONE approve action (docs/REVIEW-AND-MERGE.md) -----------------------------------------

test('approveSession: one path for card and Changes tab — local stamp, one message, then already-approved (no second send)', async () => {
  const wt = await provisionChildWorktree({ parentDir: repo, subtask: 'unified', reposDir: repos });
  commit(wt.dir, 'u.txt', 'reviewed', 'reviewed');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'f7-unified-'));
  const r = runInChild(`
    const st=await import('./server/state.ts'); const api=await import('./server/api.ts');
    const sent=[]; const send=(id,m)=>sent.push(m);
    const s=st.createSession({cwd:${JSON.stringify(wt.dir)},metadata:{branch:${JSON.stringify(wt.branch)},base:'master'}});
    st.patchSession(s.id,{action:{id:'act_r',at:new Date().toISOString(),kind:'review',prompt:'p',buttons:[]}});
    const first=await api.approveSession(s.id,'human',{send});
    const after=st.getSession(s.id);
    const second=await api.approveSession(s.id,'human',{send});
    const status=await api.mergeStatus(st.getSession(s.id),{kind:'user',user:{id:'u',role:'admin'},via:'cookie'});
    const asChild=await api.mergeStatus(st.getSession(s.id),{kind:'session',sessionId:s.id});
    Bun.spawnSync(['git','-C',s.cwd,'commit','--allow-empty','-m','more work']);
    const third=await api.approveSession(s.id,'human',{send});
    emit({first,second,third,sent,review:after.metadata.review,status:after.status,action:after.action||null,offer:status.offer,mode:status.mode,childOffer:asChild.offer}); st.flushState();
  `, { ARIGAMI_DIR: dir, ARIGAMI_STATE_FILE: path.join(dir, 'state.json') });
  expect(r.ok).toBe(true);
  const o = r.out[0];
  expect(o.first).toEqual({ ok: true, mode: 'local' });
  expect(o.review).toMatchObject({ state: 'approved', by: 'human' });
  expect(o.status).toBe('Approved');
  expect(o.action).toBeNull(); // the pending review card closes
  expect(o.second).toEqual({ ok: true, already: true, mode: 'local' });
  expect(o.mode).toBe('local');
  expect(o.offer).toEqual({ show: true, reason: null });
  expect(o.childOffer).toEqual({ show: false, reason: 'no-permission' }); // the child never merges itself
  expect(o.third).toEqual({ ok: true, mode: 'local' }); // new commits → a real re-approval
  expect(o.sent.length).toBe(2);
  expect(o.sent[0]).toContain('Approved');
  await removeWorktree(repo, wt.dir);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('approveSession on a PR: someone else\'s → an APPROVE review handed to the agent, never a merge; own → local stamp + GitHub merge offer; GitHub unreachable → refused', async () => {
  const wt = await provisionChildWorktree({ parentDir: repo, subtask: 'pr-modes', reposDir: repos });
  commit(wt.dir, 'p.txt', 'reviewed', 'reviewed');
  const head = sh(wt.dir, 'git', 'rev-parse', 'HEAD');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'f7-prmodes-'));
  const r = runInChild(`
    const st=await import('./server/state.ts'); const api=await import('./server/api.ts'); const ra=await import('./server/lib/review-approval.ts');
    let author='bob', down=false; const ghCalls=[];
    ra.setGhRunner(async (a)=>{ ghCalls.push(a.join(' ')); if(down) return {ok:false,out:'offline'};
      if(a[0]==='pr'&&a[1]==='view') return {ok:true,out:JSON.stringify({author:{login:author},state:'OPEN',isDraft:false,mergeable:'MERGEABLE',baseRefName:'develop',headRefOid:${JSON.stringify(head)}})};
      if(a[0]==='api') return {ok:true,out:'alice'}; if(a[0]==='repo') return {ok:true,out:'WRITE'}; return {ok:true,out:''}; });
    const sent=[]; const send=(id,m)=>sent.push(m); const admin={kind:'user',user:{id:'u',role:'admin'},via:'cookie'};
    const md={branch:${JSON.stringify(wt.branch)},pr:'https://github.com/acme/widgets/pull/42'};
    const rev=st.createSession({cwd:${JSON.stringify(wt.dir)},metadata:md});
    const a1=await api.approveSession(rev.id,'human',{send});
    const revReview=st.getSession(rev.id).metadata.review;
    const a2=await api.approveSession(rev.id,'human',{send});
    const revStatus=await api.mergeStatus(st.getSession(rev.id),admin);
    const revMerge=await api.mergeSession(st.getSession(rev.id),{},'human',admin);
    author='alice'; ra.clearPrFactsCache();
    const own=st.createSession({cwd:${JSON.stringify(wt.dir)},metadata:md});
    const o1=await api.approveSession(own.id,'human',{send});
    const ownStatus=await api.mergeStatus(st.getSession(own.id),admin);
    const ownBySession=await api.mergeSession(st.getSession(own.id),{},'x',{kind:'session',sessionId:'sess_master'});
    const ownMerge=await api.mergeSession(st.getSession(own.id),{strategy:'squash'},'human',admin);
    down=true; ra.clearPrFactsCache();
    const off=st.createSession({cwd:${JSON.stringify(wt.dir)},metadata:md});
    const d1=await api.approveSession(off.id,'human',{send});
    emit({a1,a2,revReview,revStatus,revMerge,o1,ownStatus,ownBySession,ownMerge,merged:st.getSession(own.id).metadata.merged,d1,offReview:st.getSession(off.id).metadata.review||null,sent,merges:ghCalls.filter(c=>c.startsWith('pr merge'))}); st.flushState();
  `, { ARIGAMI_DIR: dir, ARIGAMI_STATE_FILE: path.join(dir, 'state.json') });
  if (!r.ok) throw new Error(r.error);
  const o = r.out[0];
  // someone else's PR: Approve = a posted APPROVE review, stamped with the PR head; once
  expect(o.a1).toEqual({ ok: true, mode: 'pr-review', pr: 42 });
  expect(o.revReview).toMatchObject({ state: 'approved', target: 'github', pr: 42, sha: head });
  expect(o.a2).toEqual({ ok: true, already: true, mode: 'pr-review', pr: 42 });
  expect(o.sent[0]).toContain('Publish this as a GitHub PR review (event `APPROVE`)');
  // ...and nothing to merge from here: a passive reason, and the route refuses
  expect(o.revStatus).toMatchObject({ kind: 'pr', mode: 'pr-review', approved: true, base: 'develop', offer: { show: false, reason: 'not-your-pr' } });
  expect(o.revMerge).toMatchObject({ status: 409, reason: 'not-your-pr' });
  // own PR: local stamp (GitHub refuses self-approval), merge on GitHub offered into the PR base
  expect(o.o1).toEqual({ ok: true, mode: 'pr-own', pr: 42 });
  expect(o.sent[1]).toContain('Local-changes review');
  expect(o.ownStatus).toMatchObject({ kind: 'pr', mode: 'pr-own', approved: true, base: 'develop', offer: { show: true, reason: null } });
  expect(o.ownBySession).toMatchObject({ status: 403 }); // a PR is merged by a person
  expect(o.ownMerge).toMatchObject({ ok: true, pr: 42, base: 'develop', sha: head, strategy: 'squash' });
  expect(o.merged).toMatchObject({ pr: 42, sha: head });
  expect(o.merges).toEqual([`pr merge 42 --repo acme/widgets --squash --match-head-commit ${head}`]);
  // GitHub unreachable: neither a post nor a stamp
  expect(o.d1).toMatchObject({ status: 502 });
  expect(o.offReview).toBeNull();
  expect(o.sent.length).toBe(2);
  await removeWorktree(repo, wt.dir);
  fs.rmSync(dir, { recursive: true, force: true });
});
