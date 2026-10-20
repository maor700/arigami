// Deterministic session teardown (server/reap.ts and its three helpers).
//
// What these pin, in order of how bad the failure would be:
//   - a worktree holding work that exists nowhere else is NEVER removed
//   - a detached process started by a session dies with it — the leak that
//     left 4.5 GB of Storybooks running on a shared host
//   - another host's processes are never touched
//   - the whole chain works end to end: spawn env → marker → delete → gone
import { test, expect, beforeAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runInChild } from './_child.js';
import { parseMarkers, parsePsEww, ofSession, orphans } from '../server/lib/session-procs.ts';
import * as wt from '../server/lib/worktree-reap.ts';
import { tmpDir } from './_tmp.js';

const isWin = process.platform === 'win32';

function sh(cwd: string, cmd: string): string {
  const r = spawnSync('sh', ['-c', cmd], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${cmd}\n${r.stderr}`);
  return r.stdout.trim();
}

/** origin (bare) + a main clone with one pushed commit. Returns the clone. */
function repo(): { root: string; main: string } {
  const root = fs.realpathSync(tmpDir('reap-'));
  sh(root, 'git init -q --bare origin.git');
  sh(root, 'git clone -q origin.git main 2>/dev/null');
  const main = path.join(root, 'main');
  sh(main, 'git config user.email t@t && git config user.name t && git checkout -q -b main');
  sh(main, 'echo a > a.txt && git add a.txt && git commit -qm init && git push -q origin main');
  return { root, main };
}

// ---- markers ---------------------------------------------------------------

test('parseMarkers reads both markers from a NUL-separated /proc environ', () => {
  const env = 'PATH=/bin\0ARIGAMI_SESSION_ID=sess_abc_1\0ARIGAMI_HOST_ID=deadbeef00112233\0HOME=/h';
  expect(parseMarkers(env)).toEqual({ session: 'sess_abc_1', host: 'deadbeef00112233' });
});

test('parseMarkers does not match a variable that merely ends in the name', () => {
  expect(parseMarkers('X_ARIGAMI_SESSION_ID=sess_nope').session).toBe(null);
});

test('parsePsEww picks marked rows out of `ps eww` output', () => {
  const out = [
    '  101 node vite --port 3000 PATH=/bin ARIGAMI_SESSION_ID=sess_a ARIGAMI_HOST_ID=abc123',
    '  102 /usr/sbin/sshd -D',
    '  103 sleep 300 ARIGAMI_SESSION_ID=sess_b',
  ].join('\n');
  expect(parsePsEww(out)).toEqual([
    { pid: 101, session: 'sess_a', host: 'abc123' },
    { pid: 103, session: 'sess_b', host: null },
  ]);
});

test('ofSession never reaches a process another host owns', () => {
  const rows = [
    { pid: 1, session: 'sess_x', host: 'mine' },
    { pid: 2, session: 'sess_x', host: 'other' }, // same id, different instance
    { pid: 3, session: 'sess_x', host: null }, // started before host markers existed
    { pid: 4, session: 'sess_y', host: 'mine' },
  ];
  expect(ofSession(rows, 'sess_x', 'mine').map((r) => r.pid)).toEqual([1, 3]);
});

test('orphans only counts OUR processes of sessions that no longer exist', () => {
  const rows = [
    { pid: 1, session: 'sess_live', host: 'mine' },
    { pid: 2, session: 'sess_gone', host: 'mine' },
    { pid: 3, session: 'sess_gone', host: null }, // whose? unknown → not ours to kill
    { pid: 4, session: 'sess_gone', host: 'other' },
  ];
  expect(orphans(rows, new Set(['sess_live']), 'mine').map((r) => r.pid)).toEqual([2]);
});

// ---- worktree verdicts -----------------------------------------------------

test('a clean, pushed worktree is removed along with its branch', async () => {
  const { root, main } = repo();
  const dir = path.join(root, 'wt-pushed');
  sh(main, `git worktree add -q -b feat ${dir} && cd ${dir} && echo b > b.txt && git add b.txt && git commit -qm b && git push -q origin feat`);
  const r = await wt.reap(dir);
  expect(r.outcome).toBe('removed');
  expect(r.branchDeleted).toBe(true);
  expect(fs.existsSync(dir)).toBe(false);
  expect(sh(main, 'git branch --list feat')).toBe('');
});

test('uncommitted changes keep the worktree', async () => {
  const { root, main } = repo();
  const dir = path.join(root, 'wt-dirty');
  sh(main, `git worktree add -q -b dirty ${dir} && echo edit >> ${dir}/a.txt`);
  const r = await wt.reap(dir);
  expect(r.outcome).toBe('kept');
  expect(r.reasons?.[0]).toMatch(/uncommitted/);
  expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toContain('edit');
});

test('an untracked file counts as work too', async () => {
  const { root, main } = repo();
  const dir = path.join(root, 'wt-untracked');
  sh(main, `git worktree add -q -b untracked ${dir} && echo new > ${dir}/new.txt`);
  expect((await wt.reap(dir)).outcome).toBe('kept');
});

test('a committed-but-never-pushed branch is kept — the case seen in practice', async () => {
  // a feature branch whose upstream was still origin/main: never pushed at all.
  const { root, main } = repo();
  const dir = path.join(root, 'wt-local');
  sh(main, `git worktree add -q -b local ${dir} && cd ${dir} && echo c > c.txt && git add c.txt && git commit -qm c`);
  const r = await wt.reap(dir);
  expect(r.outcome).toBe('kept');
  expect(r.reasons?.join(' ')).toMatch(/1 commit not on any remote or other branch/);
  expect(sh(main, 'git branch --list local')).toContain('local');
});

test('a branch merged into local main (not pushed) is safe to remove', async () => {
  const { root, main } = repo();
  const dir = path.join(root, 'wt-merged');
  sh(main, `git worktree add -q -b merged ${dir} && cd ${dir} && echo m > m.txt && git add m.txt && git commit -qm m`);
  sh(main, 'git merge -q --ff-only merged');
  expect((await wt.reap(dir)).outcome).toBe('removed');
});

test('a detached PR checkout held by a remote-tracking ref is removed', async () => {
  // pr_prepare now fetches pull/<n>/head into refs/remotes/origin/pr/<n>.
  const { root, main } = repo();
  const sha = sh(main, 'git rev-parse HEAD');
  sh(main, `git update-ref refs/remotes/origin/pr/7 ${sha}`);
  const dir = path.join(root, 'wt-pr');
  sh(main, `git worktree add -q --detach ${dir} ${sha}`);
  expect((await wt.reap(dir)).outcome).toBe('removed');
});

test('a main checkout is never treated as a removable worktree', async () => {
  const { main } = repo();
  expect((await wt.inspect(main)).action).toBe('not-a-worktree');
  expect((await wt.reap(main)).outcome).toBe('not-a-worktree');
  expect(fs.existsSync(path.join(main, 'a.txt'))).toBe(true);
});

// ---- end to end ------------------------------------------------------------

let e2e: any = null;
beforeAll(() => {
  if (isWin) return;
  const { root, main } = repo();
  const dir = path.join(root, 'wt-session');
  sh(main, `git worktree add -q -b ticket ${dir} && cd ${dir} && git push -q origin ticket`);
  const dirtyDir = path.join(root, 'wt-dirty-session');
  sh(main, `git worktree add -q -b wip ${dirtyDir} && echo wip >> ${dirtyDir}/a.txt`);
  const sandbox = tmpDir('reap-host-');
  const envOut = path.join(root, 'env.txt');
  const pidOut = path.join(root, 'detached.pid');
  const fake = path.resolve(import.meta.dir, '_fake-claude-detach.sh');
  fs.chmodSync(fake, 0o755);

  const r = runInChild(
    `const state = await import('./server/state.js');
     const claude = await import('./server/claude.js');
     const api = await import('./server/api.js');
     const procs = await import('./server/lib/session-procs.js');
     const { pidAlive } = await import('./server/lib/platform.js');
     const fs = await import('node:fs');
     const wait = async (f) => { for (let i = 0; i < 100 && !f(); i++) await new Promise((r) => setTimeout(r, 100)); };

     const s = state.createSession({ title: 'ticket', cwd: ${JSON.stringify(dir)} });
     claude.ensureRunning(s.id);
     await wait(() => fs.existsSync(${JSON.stringify(pidOut)}) && fs.readFileSync(${JSON.stringify(pidOut)}, 'utf8').trim());
     const detached = Number(fs.readFileSync(${JSON.stringify(pidOut)}, 'utf8'));
     await wait(() => fs.existsSync(${JSON.stringify(envOut)}));
     const env = fs.readFileSync(${JSON.stringify(envOut)}, 'utf8');
     const scratchDir = (await import('./server/lib/scratch.js')).dirFor(s.id);
     await wait(() => fs.existsSync(scratchDir + '/fake-claude-scratch.txt'));
     const before = { detachedAlive: pidAlive(detached), scratchFile: fs.existsSync(scratchDir + '/fake-claude-scratch.txt') };
     const report = await api.destroySession(s.id);

     // a second session whose worktree has uncommitted work
     const d = state.createSession({ title: 'wip', cwd: ${JSON.stringify(dirtyDir)} });
     const dirtyReport = await api.destroySession(d.id);
     const kept = (await import('./server/reap.js')).keptWorktrees();

     emit({
       hostMark: procs.HOST_MARK,
       envHasHostMark: env.includes('ARIGAMI_HOST_ID=' + procs.HOST_MARK),
       envTmpdir: /^TMPDIR=(.*)$/m.exec(env)?.[1],
       scratchDir,
       before,
       detachedAliveAfter: pidAlive(detached),
       report,
       wtExists: fs.existsSync(${JSON.stringify(dir)}),
       scratchExists: fs.existsSync(scratchDir),
       gone: state.getSession(s.id) === null,
       dirtyReport, kept,
       dirtyExists: fs.existsSync(${JSON.stringify(dirtyDir)}),
     });`,
    {
      ARIGAMI_DIR: sandbox,
      ARIGAMI_STATE_FILE: path.join(sandbox, 'state.json'),
      ARIGAMI_CLAUDE_BIN: fake,
      FAKE_ENV_OUT: envOut,
      FAKE_DETACHED_PID: pidOut,
    }
  );
  if (!r.ok) throw new Error(r.error);
  e2e = r.out[0];
}, 60_000);

test.skipIf(isWin)('every session process carries the host marker and its own TMPDIR', () => {
  expect(e2e.envHasHostMark).toBe(true);
  expect(e2e.envTmpdir).toBe(e2e.scratchDir);
  expect(e2e.before.scratchFile).toBe(true); // a tool honouring TMPDIR wrote there
});

test.skipIf(isWin)('delete stops a DETACHED process the session started', () => {
  expect(e2e.before.detachedAlive).toBe(true);
  expect(e2e.detachedAliveAfter).toBe(false);
  // The agent itself is killed first (claude.kill); what the reaper still finds
  // is exactly what killing the agent never reached.
  expect(e2e.report.processes.found).toBe(1);
  expect(e2e.report.processes.survived).toEqual([]);
});

test.skipIf(isWin)('delete removes the pushed worktree, the scratch dir and the session', () => {
  expect(e2e.report.worktree.outcome).toBe('removed');
  expect(e2e.wtExists).toBe(false);
  expect(e2e.scratchExists).toBe(false);
  expect(e2e.gone).toBe(true);
});

test.skipIf(isWin)('delete keeps a worktree with uncommitted work and lists it', () => {
  expect(e2e.dirtyReport.worktree.outcome).toBe('kept');
  expect(e2e.dirtyExists).toBe(true);
  expect(e2e.kept.map((k: any) => k.title)).toEqual(['wip']);
  expect(e2e.kept[0].reasons[0]).toMatch(/uncommitted/);
});

test.skipIf(isWin)('sweep removes leftovers of deleted sessions and nothing else', () => {
  const sandbox = tmpDir('reap-sweep-');
  const r = runInChild(
    `const state = await import('./server/state.js');
     const reap = await import('./server/reap.js');
     const procs = await import('./server/lib/session-procs.js');
     const scratch = await import('./server/lib/scratch.js');
     const { CHROME_SESSIONS_DIR } = await import('./server/lib/chrome.js');
     const { pidAlive } = await import('./server/lib/platform.js');
     const fs = await import('node:fs');
     const { spawn } = await import('node:child_process');
     const live = state.createSession({ title: 'live' });
     const detached = (env) => {
       const p = spawn('bun', ['-e', 'setTimeout(() => {}, 60000)'], { env: { ...process.env, ...env }, detached: true, stdio: 'ignore' });
       p.unref();
       return p.pid;
     };
     const ghost = detached({ ARIGAMI_SESSION_ID: 'sess_ghost', ARIGAMI_HOST_ID: procs.HOST_MARK });
     const foreign = detached({ ARIGAMI_SESSION_ID: 'sess_ghost', ARIGAMI_HOST_ID: 'someoneelse0000' });
     const mine = detached({ ARIGAMI_SESSION_ID: live.id, ARIGAMI_HOST_ID: procs.HOST_MARK });
     await new Promise((r) => setTimeout(r, 500));
     scratch.ensure('sess_ghost'); scratch.ensure(live.id);
     fs.mkdirSync(CHROME_SESSIONS_DIR + '/sess_ghost', { recursive: true });
     fs.mkdirSync(CHROME_SESSIONS_DIR + '/' + live.id, { recursive: true });
     const out = await reap.sweep();
     emit({
       out,
       ghostAlive: pidAlive(ghost), foreignAlive: pidAlive(foreign), mineAlive: pidAlive(mine),
       ghostScratch: fs.existsSync(scratch.dirFor('sess_ghost')), liveScratch: fs.existsSync(scratch.dirFor(live.id)),
       ghostChrome: fs.existsSync(CHROME_SESSIONS_DIR + '/sess_ghost'), liveChrome: fs.existsSync(CHROME_SESSIONS_DIR + '/' + live.id),
     });
     for (const p of [foreign, mine]) { try { process.kill(p, 'SIGKILL'); } catch {} }`,
    { ARIGAMI_DIR: sandbox, ARIGAMI_STATE_FILE: path.join(sandbox, 'state.json') }
  );
  if (!r.ok) throw new Error(r.error);
  const o = r.out[0];
  expect(o.ghostAlive).toBe(false);
  expect(o.foreignAlive).toBe(true); // another instance's — never ours to kill
  expect(o.mineAlive).toBe(true); // its session is alive
  expect(o.ghostScratch).toBe(false);
  expect(o.liveScratch).toBe(true);
  expect(o.ghostChrome).toBe(false);
  expect(o.liveChrome).toBe(true);
  expect(o.out.processes).toBe(1);
}, 60_000);

test.skipIf(isWin)('sweep retries kept worktrees: removes the one that became clean, keeps the dirty one', () => {
  const { main } = repo();
  const sandbox = tmpDir('reap-kept-');
  const clean = path.join(path.dirname(main), 'wt-clean');
  const dirty = path.join(path.dirname(main), 'wt-dirty');
  sh(main, `git worktree add -q -b b-clean ${clean} main && git worktree add -q -b b-dirty ${dirty} main`);
  fs.writeFileSync(path.join(dirty, 'wip.txt'), 'unsaved');
  const row = (dir: string, sessionId: string) => ({ dir, sessionId, title: 't', reasons: ['1 uncommitted change'], at: new Date().toISOString() });
  fs.writeFileSync(path.join(sandbox, 'kept-worktrees.json'), JSON.stringify([row(clean, 'sess_gone1'), row(dirty, 'sess_gone2')]));
  const r = runInChild(
    `const reap = await import('./server/reap.js');
     const out = await reap.sweep();
     emit({ out, kept: reap.keptWorktrees().map((k) => k.dir) });`,
    { ARIGAMI_DIR: sandbox, ARIGAMI_STATE_FILE: path.join(sandbox, 'state.json') }
  );
  if (!r.ok) throw new Error(r.error);
  expect(r.out[0].out.worktrees).toBe(1);
  expect(fs.existsSync(clean)).toBe(false);
  expect(fs.existsSync(dirty)).toBe(true);
  expect(r.out[0].kept).toEqual([dirty]);
}, 60_000);

// ---- worktrees whose commits live in a PR on GitHub ------------------------
// The leak: review worktrees and squash-merged ticket branches read as
// "unpushed" and were kept forever, ~1.6 GB each. GitHub is never really
// asked here — the probe is injected.

const fakeGitHub = (known: Record<string, wt.PrHit[]>, calls: string[] = []): wt.GitHubProbe => async ({ slug, sha }) => {
  calls.push(`${slug}@${sha}`);
  return { ok: true, prs: known[sha] || [] };
};
const ghDown: wt.GitHubProbe = async () => ({ ok: false, err: 'gh: command not found' });

/** A PR head that exists on origin only under refs/pull/<n>/head. */
function prHead(root: string, main: string, n: number): string {
  sh(main, `git checkout -q -b tmp-pr && echo p > p.txt && git add p.txt && git commit -qm pr && git push -q origin HEAD:refs/pull/${n}/head`);
  const sha = sh(main, 'git rev-parse HEAD');
  sh(main, 'git checkout -q main && git branch -q -D tmp-pr');
  return sha;
}

test('a detached PR-review worktree (FETCH_HEAD only) is removed when GitHub has HEAD in the PR', async () => {
  const { root, main } = repo();
  const sha = prHead(root, main, 3855);
  sh(main, 'git fetch -q origin pull/3855/head');
  const dir = path.join(root, 'app-pr-3855');
  sh(main, `git worktree add -q --detach ${dir} FETCH_HEAD`);
  // Without GitHub, this is exactly the old false "unpushed work".
  expect((await wt.inspect(dir, { github: null })).action).toBe('keep');
  const calls: string[] = [];
  const r = await wt.reap(dir, { hints: { repo: 'o/app', prNumber: 3855 }, github: fakeGitHub({ [sha]: [{ number: 3855, state: 'open', merged: false }] }, calls) });
  expect(r.outcome).toBe('removed');
  expect(calls).toEqual([`o/app@${sha}`]);
  expect(fs.existsSync(dir)).toBe(false);
});

test('a PR head held by a local refs/pull/* ref needs no network', async () => {
  const { root, main } = repo();
  prHead(root, main, 12);
  sh(main, 'git fetch -q origin +refs/pull/12/head:refs/pull/12/head');
  const dir = path.join(root, 'wt-pull-ref');
  sh(main, `git worktree add -q --detach ${dir} refs/pull/12/head`);
  expect((await wt.reap(dir, { github: null })).outcome).toBe('removed');
});

test("the session's recorded PR head SHA vouches for a detached review checkout", async () => {
  const { root, main } = repo();
  const sha = prHead(root, main, 9);
  sh(main, 'git fetch -q origin pull/9/head');
  const dir = path.join(root, 'wt-reviewed');
  sh(main, `git worktree add -q --detach ${dir} FETCH_HEAD`);
  // a SHA alone, without the PR it came from, is not trusted
  expect((await wt.inspect(dir, { hints: { reviewedSha: sha }, github: null })).action).toBe('keep');
  expect((await wt.reap(dir, { hints: { prNumber: 9, reviewedSha: sha }, github: null })).outcome).toBe('removed');
});

test('a squash-merged ticket branch whose remote branch was deleted is removed, branch too', async () => {
  const { root, main } = repo();
  const dir = path.join(root, 'dem-1');
  sh(main, `git worktree add -q -b dem-1 ${dir} && cd ${dir} && echo t > t.txt && git add t.txt && git commit -qm t && git push -q origin dem-1`);
  const sha = sh(dir, 'git rev-parse HEAD');
  // GitHub squash-merges, auto-deletes the branch; the next fetch prunes it.
  sh(main, 'git push -q origin --delete dem-1 && git fetch -q --prune origin');
  expect((await wt.inspect(dir, { github: null })).action).toBe('keep');
  const r = await wt.reap(dir, { hints: { repo: 'o/app' }, github: fakeGitHub({ [sha]: [{ number: 1, state: 'closed', merged: true }] }) });
  expect(r.outcome).toBe('removed');
  expect(r.branchDeleted).toBe(true);
  expect(sh(main, 'git branch --list dem-1')).toBe('');
});

test('a genuinely unpushed commit on top of a merged PR is still kept', async () => {
  const { root, main } = repo();
  const dir = path.join(root, 'dem-2');
  sh(main, `git worktree add -q -b dem-2 ${dir} && cd ${dir} && echo t > t.txt && git add t.txt && git commit -qm t && git push -q origin dem-2`);
  const pushed = sh(dir, 'git rev-parse HEAD');
  sh(main, 'git push -q origin --delete dem-2 && git fetch -q --prune origin');
  sh(dir, 'echo more > u.txt && git add u.txt && git commit -qm "local only"');
  const r = await wt.reap(dir, { hints: { repo: 'o/app' }, github: fakeGitHub({ [pushed]: [{ number: 2, state: 'closed', merged: true }] }) });
  expect(r.outcome).toBe('kept');
  expect(r.reasons?.join(' ')).toMatch(/2 commits not on any remote or other branch \(HEAD is in no pull request on GitHub\)/);
  expect(fs.existsSync(path.join(dir, 'u.txt'))).toBe(true);
});

test('a dirty tree is kept even when its PR is merged — and GitHub is not even asked', async () => {
  const { root, main } = repo();
  const dir = path.join(root, 'dem-3');
  sh(main, `git worktree add -q -b dem-3 ${dir} && cd ${dir} && echo t > t.txt && git add t.txt && git commit -qm t && git push -q origin dem-3`);
  const sha = sh(dir, 'git rev-parse HEAD');
  sh(main, 'git push -q origin --delete dem-3 && git fetch -q --prune origin');
  sh(dir, 'echo edit >> a.txt');
  const calls: string[] = [];
  const r = await wt.reap(dir, { hints: { repo: 'o/app' }, github: fakeGitHub({ [sha]: [{ number: 3, state: 'closed', merged: true }] }, calls) });
  expect(r.outcome).toBe('kept');
  expect(r.reasons?.[0]).toMatch(/uncommitted/);
  expect(calls).toEqual([]);
});

test('no answer from GitHub keeps the worktree (fail closed)', async () => {
  const { root, main } = repo();
  const sha = prHead(root, main, 4);
  sh(main, 'git fetch -q origin pull/4/head');
  const dir = path.join(root, 'wt-offline');
  sh(main, `git worktree add -q --detach ${dir} ${sha}`);
  const r = await wt.reap(dir, { hints: { repo: 'o/app', prNumber: 4 }, github: ghDown });
  expect(r.outcome).toBe('kept');
  expect(r.reasons?.join(' ')).toMatch(/GitHub could not confirm: gh: command not found/);
});

test('hintsFrom and githubSlug read what sessions and remotes actually carry', () => {
  expect(wt.hintsFrom({ pr: 'https://github.com/mind-security/app/pull/3921' })).toEqual({ repo: 'mind-security/app', prNumber: 3921 });
  expect(wt.hintsFrom({ repo: 'a/b', prNumber: '7', reviewedSha: 'abc1234' })).toEqual({ repo: 'a/b', prNumber: 7, reviewedSha: 'abc1234' });
  expect(wt.hintsFrom({ repo: 'not a slug; rm -rf', prNumber: -1, reviewedSha: 'HEAD' })).toEqual({});
  expect(wt.hintsFrom(undefined)).toEqual({});
  expect(wt.githubSlug('https://github.com/mind-security/app.git')).toBe('mind-security/app');
  expect(wt.githubSlug('git@github.com:maor700/arigami.git')).toBe('maor700/arigami');
  expect(wt.githubSlug('/tmp/origin.git')).toBe(null);
});
