// Deterministic session teardown (server/reap.ts and its three helpers).
//
// What these pin, in order of how bad the failure would be:
//   - a worktree holding work that exists nowhere else is NEVER removed
//   - a detached process started by a session dies with it — the leak that
//     left 4.5 GB of Storybooks running on the cloud host
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

const isWin = process.platform === 'win32';

function sh(cwd: string, cmd: string): string {
  const r = spawnSync('sh', ['-c', cmd], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${cmd}\n${r.stderr}`);
  return r.stdout.trim();
}

/** origin (bare) + a main clone with one pushed commit. Returns the clone. */
function repo(): { root: string; main: string } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reap-')));
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

test('a clean, pushed worktree is removed along with its branch', () => {
  const { root, main } = repo();
  const dir = path.join(root, 'wt-pushed');
  sh(main, `git worktree add -q -b feat ${dir} && cd ${dir} && echo b > b.txt && git add b.txt && git commit -qm b && git push -q origin feat`);
  const r = wt.reap(dir);
  expect(r.outcome).toBe('removed');
  expect(r.branchDeleted).toBe(true);
  expect(fs.existsSync(dir)).toBe(false);
  expect(sh(main, 'git branch --list feat')).toBe('');
});

test('uncommitted changes keep the worktree', () => {
  const { root, main } = repo();
  const dir = path.join(root, 'wt-dirty');
  sh(main, `git worktree add -q -b dirty ${dir} && echo edit >> ${dir}/a.txt`);
  const r = wt.reap(dir);
  expect(r.outcome).toBe('kept');
  expect(r.reasons?.[0]).toMatch(/uncommitted/);
  expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toContain('edit');
});

test('an untracked file counts as work too', () => {
  const { root, main } = repo();
  const dir = path.join(root, 'wt-untracked');
  sh(main, `git worktree add -q -b untracked ${dir} && echo new > ${dir}/new.txt`);
  expect(wt.reap(dir).outcome).toBe('kept');
});

test('a committed-but-never-pushed branch is kept — the real case on the cloud host', () => {
  // abc-19666 had upstream origin/main: it was never pushed at all.
  const { root, main } = repo();
  const dir = path.join(root, 'wt-local');
  sh(main, `git worktree add -q -b local ${dir} && cd ${dir} && echo c > c.txt && git add c.txt && git commit -qm c`);
  const r = wt.reap(dir);
  expect(r.outcome).toBe('kept');
  expect(r.reasons?.join(' ')).toMatch(/1 commit not on any remote or other branch/);
  expect(sh(main, 'git branch --list local')).toContain('local');
});

test('a branch merged into local main (not pushed) is safe to remove', () => {
  const { root, main } = repo();
  const dir = path.join(root, 'wt-merged');
  sh(main, `git worktree add -q -b merged ${dir} && cd ${dir} && echo m > m.txt && git add m.txt && git commit -qm m`);
  sh(main, 'git merge -q --ff-only merged');
  expect(wt.reap(dir).outcome).toBe('removed');
});

test('a detached PR checkout held by a remote-tracking ref is removed', () => {
  // pr_prepare now fetches pull/<n>/head into refs/remotes/origin/pr/<n>.
  const { root, main } = repo();
  const sha = sh(main, 'git rev-parse HEAD');
  sh(main, `git update-ref refs/remotes/origin/pr/7 ${sha}`);
  const dir = path.join(root, 'wt-pr');
  sh(main, `git worktree add -q --detach ${dir} ${sha}`);
  expect(wt.reap(dir).outcome).toBe('removed');
});

test('a main checkout is never treated as a removable worktree', () => {
  const { main } = repo();
  expect(wt.inspect(main).action).toBe('not-a-worktree');
  expect(wt.reap(main).outcome).toBe('not-a-worktree');
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
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'reap-host-'));
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
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'reap-sweep-'));
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
