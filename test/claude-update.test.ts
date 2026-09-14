// UPD1: server/lib/claude-update.js — version compare, the "defer under memory
// pressure" rule, the apply path against a STUB runner (the real `claude
// update` is never run here), and the models-cache invalidation that must fire
// after a successful update (the picker learns the new build's models without a
// host restart).
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runInChild } from './_child.js';
import { compareVersions, parseVersion, isNewer, createUpdater, DEFAULT_MIN_FREE_MB } from '../server/lib/claude-update.js';

// ---- version compare ------------------------------------------------------------

test('parseVersion pulls the semver out of `claude --version` and the release pointer', () => {
  expect(parseVersion('2.1.258 (Claude Code)')).toBe('2.1.258');
  expect(parseVersion('2.1.258\n')).toBe('2.1.258');
  expect(parseVersion('v2.1.0-beta.1')).toBe('2.1.0-beta.1');
  expect(parseVersion('garbage')).toBeNull();
  expect(parseVersion('')).toBeNull();
});

test('compareVersions is numeric per segment, pre-release sorts below release', () => {
  expect(compareVersions('2.1.258', '2.1.251')).toBe(1);
  expect(compareVersions('2.1.251', '2.1.258')).toBe(-1);
  expect(compareVersions('2.1.258 (Claude Code)', '2.1.258')).toBe(0);
  expect(compareVersions('2.1.9', '2.1.10')).toBe(-1); // not a string compare
  expect(compareVersions('2.2.0', '2.1.999')).toBe(1);
  expect(compareVersions('3.0.0', '2.9.9')).toBe(1);
  expect(compareVersions('2.1.0-beta', '2.1.0')).toBe(-1);
  expect(compareVersions('2.1.0', '2.1.0-beta')).toBe(1);
  expect(compareVersions('junk', '2.1.0')).toBe(0); // unparseable → "can't tell", never "newer"
  expect(isNewer('2.1.258', '2.1.251')).toBe(true);
  expect(isNewer('2.1.251', '2.1.258')).toBe(false);
  expect(isNewer('2.1.258', '2.1.258')).toBe(false);
  expect(isNewer(null, '2.1.258')).toBe(false);
});

// ---- harness ----------------------------------------------------------------------

function harness(o: { installed?: string; latest?: string; mem?: number; auto?: boolean; run?: () => Promise<any>; store?: string } = {}) {
  let now = 1_700_000_000_000;
  let installed = o.installed ?? '2.1.251';
  let latest = o.latest ?? '2.1.258';
  let mem = o.mem ?? 2000;
  let auto = o.auto ?? true;
  const events: any[] = [];
  const notes: any[] = [];
  const log: string[] = [];
  const updated: any[] = [];
  let runs = 0;
  let fetches = 0;
  let probes = 0;
  const run = o.run ?? (async () => { installed = latest; return { code: 0, output: `Current version: ${o.installed ?? '2.1.251'}\nChecking for updates to latest version...\nUpdating to ${latest}...\nSuccessfully updated from ${o.installed ?? '2.1.251'} to version ${latest}` }; });
  const u = createUpdater({
    installed: async () => { probes++; return installed; },
    fetchLatest: async () => { fetches++; return latest; },
    run: async () => { runs++; return run(); },
    memAvailableMb: () => mem,
    minFreeMb: DEFAULT_MIN_FREE_MB,
    auto: () => auto,
    onUpdated: async (x: any) => { updated.push(x); },
    emit: (e: any) => events.push(e),
    notify: (title: string, body: string) => notes.push({ title, body }),
    now: () => now,
    log: (l: string) => log.push(l),
    store: o.store ?? null,
  });
  return {
    u, events, notes, log, updated,
    get runs() { return runs; }, get fetches() { return fetches; }, get probes() { return probes; },
    set installed(v: string) { installed = v; }, set latest(v: string) { latest = v; },
    set mem(v: number) { mem = v; }, set auto(v: boolean) { auto = v; },
    tick(ms: number) { now += ms; }, get now() { return now; },
  };
}

// ---- check ----------------------------------------------------------------------------

test('check: installed vs the release pointer → updateAvailable; daily window, force bypasses it', async () => {
  const h = harness();
  const s1 = await h.u.check();
  expect(s1).toMatchObject({ installed: '2.1.251', latest: '2.1.258', updateAvailable: true, checkedAt: h.now, auto: true });
  expect(h.fetches).toBe(1);
  h.tick(60 * 60 * 1000);
  await h.u.check(); // inside the daily window: no network
  expect(h.fetches).toBe(1);
  await h.u.check({ force: true }); // the cockpit's "check" button
  expect(h.fetches).toBe(2);
  h.tick(25 * 60 * 60 * 1000);
  await h.u.check(); // the window lapsed
  expect(h.fetches).toBe(3);
});

test('check: a failed pointer fetch keeps the last known latest and reports checkError', async () => {
  const h = harness();
  await h.u.check();
  let fail = true;
  const u2 = createUpdater({
    installed: async () => '2.1.251',
    fetchLatest: async () => { if (fail) throw new Error('HTTP 503'); return '2.1.260'; },
    memAvailableMb: () => 2000,
  });
  const s = await u2.check();
  expect(s.checkError).toBe('HTTP 503');
  expect(s.latest).toBeNull();
  expect(s.updateAvailable).toBe(false);
  fail = false;
  const s2 = await u2.check({ force: true });
  expect(s2).toMatchObject({ checkError: null, latest: '2.1.260', updateAvailable: true });
});

// ---- defer under memory pressure ------------------------------------------------------

test('apply defers (no runner call) when MemAvailable is below the floor, and runs once RAM is back', async () => {
  const h = harness({ mem: 350 });
  await h.u.check();
  const r = await h.u.apply({ reason: 'manual' });
  expect(r).toMatchObject({ deferred: true, reason: 'memory', availableMb: 350, minFreeMb: DEFAULT_MIN_FREE_MB });
  expect(h.runs).toBe(0);
  expect(h.u.status().deferred).toMatchObject({ reason: 'memory', availableMb: 350 });
  expect(h.u.status().lastUpdate).toBeNull(); // deferral is not a failure
  expect(h.events.map((e) => e.kind)).toEqual(['claude-update-deferred']); // manual → told the cockpit
  expect(h.notes).toEqual([]); // ...but no push: nothing broke
  // the scheduler keeps retrying quietly
  h.tick(15 * 60 * 1000);
  expect(await h.u.tick()).toMatchObject({ deferred: true, reason: 'memory' });
  expect(h.runs).toBe(0);
  expect(h.events.map((e) => e.kind)).toEqual(['claude-update-deferred']); // auto deferrals stay silent
  h.mem = 1500;
  h.tick(15 * 60 * 1000);
  const r2 = await h.u.tick();
  expect(r2).toMatchObject({ ok: true, from: '2.1.251', to: '2.1.258' });
  expect(h.runs).toBe(1);
  expect(h.u.status().deferred).toBeNull();
});

test('exactly the floor is enough; a meminfo failure (null) never blocks', async () => {
  const h = harness({ mem: DEFAULT_MIN_FREE_MB });
  await h.u.check();
  expect(await h.u.apply()).toMatchObject({ ok: true });
  const u2 = createUpdater({ installed: async () => '2.1.258', fetchLatest: async () => '2.1.258', run: async () => ({ code: 0, output: 'Successfully updated from 2.1.251 to version 2.1.258' }), memAvailableMb: () => { throw new Error('no /proc'); } });
  await u2.check();
  expect(u2.status().availableMb).toBeNull();
  const r2 = await u2.apply();
  expect(r2.ok).toBe(true);
  expect(r2.deferred).toBeUndefined();
});

// ---- apply against the stub runner ------------------------------------------------------

test('apply: success → lastUpdate{from,to,ok,log}, host event, push, and the models cache is refetched', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-cu-'));
  const store = path.join(dir, 'claude-update.json');
  const h = harness({ store });
  await h.u.check();
  const r = await h.u.apply({ reason: 'manual' });
  expect(r).toMatchObject({ ok: true, from: '2.1.251', to: '2.1.258', error: null });
  const s = h.u.status();
  expect(s.installed).toBe('2.1.258');
  expect(s.updateAvailable).toBe(false);
  expect(s.lastUpdate).toMatchObject({ from: '2.1.251', to: '2.1.258', ok: true, error: null, reason: 'manual', at: h.now });
  expect(s.lastUpdate.log.at(-1)).toBe('Successfully updated from 2.1.251 to version 2.1.258');
  expect(h.updated).toEqual([{ from: '2.1.251', to: '2.1.258' }]); // models.js getModels(true) hook
  expect(h.events.map((e) => e.kind)).toEqual(['claude-update-started', 'claude-update-done']);
  expect(h.events[1]).toMatchObject({ from: '2.1.251', to: '2.1.258' });
  expect(h.notes).toEqual([{ title: 'Claude CLI updated', body: '2.1.251 → 2.1.258' }]);
  // persisted for the next boot (a fresh updater reads it back)
  const again = createUpdater({ store, installed: async () => '2.1.258', fetchLatest: async () => '2.1.258', memAvailableMb: () => 2000 });
  expect(again.status().lastUpdate).toMatchObject({ from: '2.1.251', to: '2.1.258', ok: true });
  expect(again.status().latest).toBe('2.1.258');
});

test('apply: a non-zero exit / timeout is a failure with the captured output, and is not retried every tick', async () => {
  const h = harness({ run: async () => ({ code: 1, output: 'Error: EACCES: permission denied, rename ...', error: 'Command failed' }) });
  await h.u.check();
  const r = await h.u.apply({ reason: 'auto' });
  expect(r.ok).toBe(false);
  expect(r.error).toBe('Command failed');
  expect(h.u.status().lastUpdate).toMatchObject({ ok: false, from: '2.1.251', reason: 'auto' });
  expect(h.u.status().lastUpdate.log).toEqual(['Error: EACCES: permission denied, rename ...']);
  expect(h.events.map((e) => e.kind)).toEqual(['claude-update-started', 'claude-update-failed']);
  expect(h.notes[0].title).toBe('Claude CLI update failed');
  expect(h.updated).toEqual([]); // nothing changed → no refetch
  // the scheduler backs off for this version instead of hammering
  h.tick(15 * 60 * 1000);
  expect(await h.u.tick()).toBeNull();
  expect(h.runs).toBe(1);
  // ...but a manual retry is always allowed
  await h.u.apply({ reason: 'manual' });
  expect(h.runs).toBe(2);

  const t = harness({ run: async () => ({ code: 1, output: '', timedOut: true, error: 'killed' }) });
  await t.u.check();
  const rt = await t.u.apply();
  expect(rt.ok).toBe(false);
  expect(rt.error).toMatch(/timed out/);
});

test('apply: exit 0 but the binary still answers the old version is NOT a success', async () => {
  const h = harness({ run: async () => ({ code: 0, output: 'Checking for updates to latest version...' }) }); // installed never changes
  await h.u.check();
  const r = await h.u.apply();
  expect(r.ok).toBe(false);
  expect(r.error).toMatch(/still 2\.1\.251/);
  expect(h.updated).toEqual([]);
});

test('apply refuses a second concurrent run (409) and tick never overlaps', async () => {
  let release: () => void = () => {};
  const h = harness({ run: () => new Promise((res) => { release = () => res({ code: 0, output: 'Successfully updated from 2.1.251 to version 2.1.258' }); }) });
  await h.u.check();
  const p = h.u.apply();
  await expect(h.u.apply()).rejects.toMatchObject({ status: 409 });
  expect(await h.u.tick()).toBeNull();
  release();
  await p;
  expect(h.runs).toBe(1);
});

// ---- policy ----------------------------------------------------------------------------

test('auto policy: tick applies by itself when on, only checks when off; manual still works when off', async () => {
  const off = harness({ auto: false });
  expect(await off.u.tick()).toBeNull();
  expect(off.u.status()).toMatchObject({ updateAvailable: true, auto: false });
  expect(off.runs).toBe(0);
  expect(await off.u.apply({ reason: 'manual' })).toMatchObject({ ok: true });
  const on = harness({ auto: true });
  expect(await on.u.tick()).toMatchObject({ ok: true, to: '2.1.258' });
  expect(on.runs).toBe(1);
  expect(await on.u.tick()).toBeNull(); // up to date now
  expect(on.runs).toBe(1);
});

// ---- models-cache invalidation, end to end ----------------------------------------------------
// A stub `claude` on PATH answers --version and the initialize handshake (same
// stand-in as test/models-cli-update.test.js). The runner stub "installs" the
// new build by rewriting that file — the real `claude update` is never run.
// With the default one-minute version memo, a PASSIVE getModels() right after
// the update must already return the new build's list.

function writeStub(dir: string, version: string, modelIds: string[]) {
  const models = modelIds.map((id) => ({ value: `${id}[1m]`, resolvedModel: id, displayName: id, description: `${id} · stub` }));
  const src = `#!/usr/bin/env bun
if (process.argv.includes('--version')) { process.stdout.write(${JSON.stringify(version + ' (Claude Code)\n')}); process.exit(0); }
process.stdin.on('data', () => {
  process.stdout.write(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: 'req_1', response: { models: ${JSON.stringify(models)} } } }) + '\\n');
});
setTimeout(() => process.exit(0), 5000);
`;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'claude'), src, { mode: 0o755 });
}

test('after a successful update the picker sees the new CLI\'s models without a restart (passive GET, inside the memo)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-cu-models-'));
  const bin = path.join(dir, 'bin');
  writeStub(bin, '2.1.251', ['claude-opus-5', 'claude-fable-5']);
  const stubPath = path.join(bin, 'claude');
  const r = runInChild(
    `
    console.log = (...a) => console.error(...a);
    const fs = await import('node:fs');
    const { getModels } = await import('./server/models.js');
    const { createUpdater } = await import('./server/lib/claude-update.js');
    const first = await getModels();
    emit({ ids: first.models.map((m) => m.resolvedModel), cliVersion: first.cliVersion });
    const u = createUpdater({
      fetchLatest: async () => '2.1.258',
      memAvailableMb: () => 5000,
      // the "runner": swap the binary in place, like claude update re-pointing the symlink
      run: async () => {
        fs.writeFileSync(${JSON.stringify(stubPath)}, fs.readFileSync(${JSON.stringify(stubPath)}, 'utf8').replace('2.1.251', '2.1.258').replaceAll('claude-fable-5', 'claude-fable-5-1'), { mode: 0o755 });
        return { code: 0, output: 'Successfully updated from 2.1.251 to version 2.1.258' };
      },
      onUpdated: async () => { await getModels(true); },
    });
    await u.check();
    const applied = await u.apply({ reason: 'auto' });
    const second = await getModels(); // passive — no force, well inside the 60s version memo
    emit({ applied: { ok: applied.ok, from: applied.from, to: applied.to }, status: u.status().installed, ids: second.models.map((m) => m.resolvedModel), cliVersion: second.cliVersion });
    `,
    {
      ARIGAMI_DIR: dir,
      ARIGAMI_PORT: '',
      ARIGAMI_CLAUDE_BIN: '',
      ARIGAMI_CLI_RECHECK_MS: '', // default cadence: the memo is what would hide the change
      PATH: [bin, path.dirname(process.execPath)].join(path.delimiter),
    }
  );
  expect(r.ok, r.error).toBe(true);
  const [first, second] = r.out;
  expect(first).toEqual({ ids: ['claude-opus-5', 'claude-fable-5'], cliVersion: '2.1.251' });
  expect(second.applied).toEqual({ ok: true, from: '2.1.251', to: '2.1.258' });
  expect(second.status).toBe('2.1.258');
  expect(second.cliVersion).toBe('2.1.258');
  expect(second.ids).toEqual(['claude-opus-5', 'claude-fable-5-1']);
});

// ---- P1-10: codex CLI row + no claude binary --------------------------------------------

test('codex: doctor update line → latest; else GitHub tag; else installed when doctor is clean', async () => {
  const { parseDoctorUpdate, codexLatest } = await import('../server/lib/codex-update.js');
  expect(parseDoctorUpdate('   ↑ updates      0.154.0 available (current 0.153.4)')).toBe('0.154.0');
  expect(parseDoctorUpdate('  ✓ updates      up to date')).toBeNull();
  const ok = (output: string) => async () => ({ code: 0, output });
  expect(await codexLatest({ doctor: ok('↑ updates 0.154.0 available'), github: async () => '9.9.9', installed: async () => '0.153.4' })).toBe('0.154.0');
  expect(await codexLatest({ doctor: ok('✓ updates'), github: async () => '0.155.0', installed: async () => '0.153.4' })).toBe('0.155.0');
  expect(await codexLatest({ doctor: ok('✓ updates'), github: async () => { throw new Error('rate limited'); }, installed: async () => '0.153.4' })).toBe('0.153.4');
  await expect(codexLatest({ doctor: async () => { throw new Error('ENOENT'); }, github: async () => null, installed: async () => null })).rejects.toThrow(/latest codex/);
});

test('codex updater: events and notification carry the codex name; never auto-applies', async () => {
  const events: any[] = [];
  const notes: any[] = [];
  let installed = '0.153.4';
  const u = createUpdater({
    name: 'codex',
    installed: async () => installed,
    fetchLatest: async () => '0.154.0',
    run: async () => { installed = '0.154.0'; return { code: 0, output: 'updated' }; },
    memAvailableMb: () => 4000,
    auto: () => false,
    emit: (e: any) => events.push(e),
    notify: (title: string) => notes.push(title),
  });
  expect(await u.tick()).toBeNull(); // auto off: tick only checks
  expect(u.status().updateAvailable).toBe(true);
  const r = await u.apply({ reason: 'manual' });
  expect(r.ok).toBe(true);
  expect(events.map((e) => e.kind)).toEqual(['codex-update-started', 'codex-update-done']);
  expect(notes).toEqual(['Codex CLI updated']);
});

test('startClaudeUpdater does not arm the daily check when no claude binary resolves', async () => {
  const { startClaudeUpdater } = await import('../server/lib/claude-update.js');
  expect(await startClaudeUpdater({ bin: 'claude' })).toBeNull();
});
