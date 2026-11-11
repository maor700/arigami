// Ticket launcher — the host makes the workspace the plan panel promises.
//   naming:   feat/<id>-<slug> branch, <repo>-wt-<id> worktree beside the repo
//   ports:    the plan reserves a port that is really free (no session owns it,
//             nothing listens on it); the create path claims that same port, or
//             the next free one with a note when it was taken meanwhile
//   provision: worktree + branch in a ready repo regardless of skill; a relaunch
//             reuses the branch's existing worktree; no ready repo → reported
//   e2e:      POST /__api/sessions with `provision` → metadata.port set, and the
//             FIRST chat event is the provisioning report
import { test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runInChild } from './_child.js';
import { ticketBranch, ticketWorktreeDir, pickFreePort, portFree, provisionReport, provisionPromptBlock } from '../server/ticket-provision.js';
import { tmpDir } from './_tmp.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('naming: ticket branch and worktree dir', () => {
  expect(ticketBranch('ENG-42', 'Fix the Login button!')).toBe('feat/eng-42-fix-the-login-button');
  expect(ticketBranch('ENG-42', '')).toBe('feat/eng-42');
  expect(ticketBranch('ENG-42', 'ENG-42')).toBe('feat/eng-42'); // a pasted ticket: title = id
  expect(ticketBranch('ENG-42', 'ENG-42 Fix login')).toBe('feat/eng-42-fix-login');
  expect(ticketBranch('ENG-42', 'סשן בעברית')).toBe('feat/eng-42'); // no latin slug → id only
  expect(ticketWorktreeDir('/r', 'web-app', 'ENG-42')).toBe(path.join('/r', 'web-app-wt-eng-42'));
});

test('ports: pickFreePort skips owned/reserved ports and ports something listens on', async () => {
  const busy = new Set([3201, 3203]);
  const probe = async (p: number) => !busy.has(p);
  expect(await pickFreePort([3200, 3205], new Set([3200]), probe)).toBe(3202);
  expect(await pickFreePort([3200, 3201], new Set([3200]), probe)).toBeNull();
  // the real probe sees a real listener
  const srv = net.createServer();
  await new Promise<void>((r) => srv.listen(0, () => r()));
  const used = (srv.address() as net.AddressInfo).port;
  expect(await portFree(used)).toBe(false);
  await new Promise<void>((r) => srv.close(() => r()));
  expect(await portFree(used)).toBe(true);
});

test('report: the first chat line and the prompt block say what really happened', () => {
  const ok = { ok: true, repo: 'web', dir: '/r/web-wt-eng-1', branch: 'feat/eng-1', base: 'main', reused: false, port: 3201, notes: [] };
  expect(provisionReport(ok)).toBe('⤷ Workspace ready — created worktree /r/web-wt-eng-1 on branch feat/eng-1 (from main), dev server port :3201 ($PORT).');
  expect(provisionPromptBlock(ok)).toContain('Dev server port: 3201, exported as $PORT');
  expect(provisionPromptBlock(ok)).toContain('Do not create another worktree');
  const bad = { ok: false, repo: null, dir: null, branch: 'feat/eng-1', base: null, reused: false, port: 3202, error: 'no ready repo', notes: ['port 3201 was taken meanwhile'] };
  expect(provisionReport(bad)).toBe('⚠ No worktree — no ready repo. The session starts in its working folder, dev server port :3202 ($PORT). Note: port 3201 was taken meanwhile.');
  expect(provisionPromptBlock(bad)).toContain('No worktree could be created: no ready repo');
});

function isolatedEnv() {
  const dir = tmpDir('arigami-TPROV-');
  const repos = path.join(dir, 'repos');
  fs.mkdirSync(repos, { recursive: true });
  return {
    dir,
    repos,
    env: {
      ARIGAMI_DIR: dir,
      ARIGAMI_STATE_FILE: path.join(dir, 'state.json'),
      HOME: dir,
      ARIGAMI_REPOS_DIR: repos,
      ARIGAMI_WORKTREE_INSTALL: '0',
      GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com',
    },
  };
}

function gitRepo(at: string) {
  fs.mkdirSync(at, { recursive: true });
  const g = (...a: string[]) => spawnSync('git', ['-C', at, ...a], { encoding: 'utf8' });
  g('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(at, 'README.md'), 'x\n');
  g('add', '.');
  g('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'init');
}

test('reservations: the plan holds its port; the claim gets it, or the next free one with a note', () => {
  const { env } = isolatedEnv();
  const r = runInChild(
    `
    const tp = await import('./server/ticket-provision.ts');
    const { cfg } = await import('./server/state.js');
    const [lo] = cfg.dispatcher.portRange;
    const busy = new Set();
    const probe = async (p) => !busy.has(p);
    const a = await tp.reservePort('ENG-1', null, probe);
    const again = await tp.reservePort('ENG-1', a.reservation, probe);       // re-plan keeps it
    const b = await tp.reservePort('ENG-2', null, probe);                    // another launcher can't get it
    const reservedNow = [...tp.reservedPorts()];
    const claimA = await tp.claimPort('ENG-1', a.reservation, probe);       // shown → used
    busy.add(b.port);                                                       // something grabbed ENG-2's port
    const claimB = await tp.claimPort('ENG-2', b.reservation, probe);
    emit({ lo, a, again, b, reservedNow, claimA, claimB, left: [...tp.reservedPorts()] });
    `,
    env
  );
  expect(r.ok).toBe(true);
  const { lo, a, again, b, reservedNow, claimA, claimB, left } = r.out[0];
  expect(a.port).toBe(lo);
  expect(again).toEqual(a);
  expect(b.port).toBe(lo + 1);
  expect(reservedNow.sort()).toEqual([lo, lo + 1]);
  expect(claimA).toEqual({ port: lo });
  expect(claimB.port).not.toBe(b.port);
  expect(claimB.note).toBe(`port ${b.port} was taken meanwhile`);
  expect(left).toEqual([]); // claims consume their reservation
});

test('provision: worktree + branch in a ready repo, whatever the skill; relaunch reuses it; no repo is reported', () => {
  const { env, repos } = isolatedEnv();
  gitRepo(path.join(repos, 'web'));
  const r = runInChild(
    `
    const tp = await import('./server/ticket-provision.ts');
    const path = await import('node:path');
    const fs = await import('node:fs');
    const deps = { repos: async () => ['web'], repoDir: async (n) => path.join(${JSON.stringify(repos)}, n), probe: async () => true };
    const plan = await tp.planTicket({ ticket: 'eng-7', title: 'Add dark mode' }, deps);
    const first = await tp.provisionTicket({ ticket: 'ENG-7', title: 'Add dark mode', repo: plan.repo, reservation: plan.reservation }, deps);
    const head = (await import('node:child_process')).spawnSync('git', ['-C', first.dir, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
    const replan = await tp.planTicket({ ticket: 'ENG-7', title: 'Add dark mode' }, deps);
    const second = await tp.provisionTicket({ ticket: 'ENG-7', title: 'Add dark mode' }, deps);
    const none = await tp.provisionTicket({ ticket: 'ENG-8', title: 'x' }, { ...deps, repos: async () => [] });
    emit({ plan, first, head, exists: fs.existsSync(first.dir), replan, second, none });
    `,
    env
  );
  expect(r.ok).toBe(true);
  const { plan, first, head, exists, replan, second, none } = r.out[0];
  const wt = path.join(repos, 'web-wt-eng-7');
  expect(plan).toMatchObject({ ticket: 'ENG-7', repos: ['web'], repo: 'web', dir: wt, branch: 'feat/eng-7-add-dark-mode', base: 'main', reuse: false });
  expect(typeof plan.port).toBe('number');
  // what the plan showed is what was made
  expect(first).toMatchObject({ ok: true, repo: 'web', dir: wt, branch: plan.branch, reused: false, port: plan.port, notes: [] });
  expect(exists).toBe(true);
  expect(head).toBe('feat/eng-7-add-dark-mode');
  expect(replan).toMatchObject({ dir: wt, reuse: true });
  expect(second).toMatchObject({ ok: true, dir: wt, reused: true });
  expect(none).toMatchObject({ ok: false, error: 'no ready repo', dir: null });
  expect(typeof none.port).toBe('number'); // the port is still the session's
});

// ---- e2e: the create path ------------------------------------------------------
let host: ChildProcess;
let base: string;
let hostDir: string;
const freePort = (): Promise<number> =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
async function api(method: string, p: string, body?: unknown): Promise<any> {
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  hostDir = tmpDir('arigami-TPROV-host-');
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const home = path.join(hostDir, 'home');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(hostDir, 'repos'), { recursive: true });
  const stub = path.join(hostDir, 'claude-stub.sh');
  fs.writeFileSync(stub, '#!/bin/sh\nexec sleep 3600\n', { mode: 0o755 });
  host = spawn('bun', ['server/index.ts'], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOME: home,
      ARIGAMI_DIR: hostDir,
      ARIGAMI_PORT: String(port),
      ARIGAMI_AUTH: 'off',
      ARIGAMI_SCREEN_ENABLED: '0',
      ARIGAMI_CLAUDE_BIN: stub,
      ARIGAMI_WA_DATA_DIR: path.join(hostDir, 'wa'),
      ARIGAMI_TELEMETRY: '0',
      ARIGAMI_REPOS_DIR: path.join(hostDir, 'repos'),
      ARIGAMI_DEFAULT_CWD: path.join(hostDir, 'repos'),
      COMPOSIO_API_KEY: '',
      GH_TOKEN: '',
      GITHUB_TOKEN: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const t0 = Date.now();
  while (Date.now() - t0 < 20000) {
    try {
      if ((await fetch(base + '/__api/agents')).ok) return;
    } catch {}
    await sleep(100);
  }
  throw new Error('host did not start');
}, 30000);

afterAll(() => {
  host?.kill('SIGKILL');
});

test('e2e: plan → create with provision → port held, first chat event is the report', async () => {
  const plan = (await api('POST', '/__api/ticket-plan', { ticket: 'ENG-9', title: 'Sample ticket' })).json;
  expect(plan.ticket).toBe('ENG-9');
  expect(plan.branch).toBe('feat/eng-9-sample-ticket');
  expect(typeof plan.port).toBe('number');
  expect(plan.reservation).toMatch(/^rsv_/);
  // a needs_server allocation meanwhile must not take the port the panel shows
  const other = (await api('POST', '/__api/sessions', { title: 'other', cwd: path.join(hostDir, 'repos') })).json;
  const patched = (await api('PATCH', `/__api/sessions/${other.id}`, { metadata: { needs_server: true } })).json;
  expect(patched.metadata.port).not.toBe(plan.port);

  const created = await api('POST', '/__api/sessions', {
    title: 'Sample ticket',
    metadata: { ticket: 'ENG-9' },
    permissionMode: 'acceptEdits',
    provision: { reservation: plan.reservation },
  });
  expect(created.status).toBe(201);
  const s = created.json;
  expect(s.metadata.port).toBe(plan.port);
  expect(s.permissionMode || s.claude?.permissionMode).toBe('acceptEdits');
  const events = (await api('GET', `/__api/sessions/${s.id}/chat`)).json;
  const list = Array.isArray(events) ? events : events.events;
  expect(list[0].kind).toBe('system');
  // this isolated host has no ready repo, and says so instead of promising one
  expect(list[0].text).toBe(`⚠ No worktree — no ready repo. The session starts in its working folder, dev server port :${plan.port} ($PORT).`);
  expect(list[0].provision).toMatchObject({ ok: false, port: plan.port });
  // the agent's first message carries the same facts
  const user = list.find((e: any) => e.kind === 'user');
  expect(user.text).toContain('Work on ENG-9.');
  expect(user.text).toContain(`Dev server port: ${plan.port}, exported as $PORT.`);

  // without `provision` nothing is set up and nothing is claimed
  const plain = (await api('POST', '/__api/sessions', { title: 'plain', metadata: { ticket: 'ENG-10' } })).json;
  expect(plain.metadata.port).toBeUndefined();
  for (const id of [s.id, other.id, plain.id]) await api('DELETE', `/__api/sessions/${id}`);
}, 30000);
