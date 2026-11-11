// MODEL1: the model picker must follow the `claude` CLI as it updates under a
// RUNNING host — the list ships with the CLI, so "new model shipped" is exactly
// "CLI version changed". Two ways that happens, both reproduced here against a
// stub `claude` (no network, no real CLI):
//
//   1. in place — the same path starts answering a newer `--version`
//      (native install re-pointing its symlink). server/models.js's version
//      key must notice on the next GET, inside the 24h TTL.
//   2. at a NEW path — a newer claude appears earlier on PATH (`npm i -g` next
//      to a native install). This is how Fable 5.1 went missing on the live
//      host: server/claude.js resolved an absolute path ONCE at boot, so every
//      spawn — and every model refresh, manual included — kept asking the old
//      binary. lib/claude-bin.js now re-resolves.
//
// Server modules capture ARIGAMI_DIR at import, so each scenario runs in a
// fresh bun process (test/_child.js) with its own PATH of stub dirs.
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runInChild } from './_child.js';
import { tmpDir } from './_tmp.js';

const tmp = (tag) => tmpDir(`arigami-models-${tag}-`);

// A `claude` stand-in: answers `--version` and the stream-json `initialize`
// handshake (the only two things server/models.js asks of the CLI) from
// literals baked into the file, so "the CLI updated" is just rewriting it.
function writeStub(dir, version, modelIds) {
  const models = modelIds.map((id) => ({ value: `${id}[1m]`, resolvedModel: id, displayName: id, description: `${id} · stub` }));
  const src = `#!/usr/bin/env bun
if (process.argv.includes('--version')) { process.stdout.write(${JSON.stringify(version + ' (Claude Code)\n')}); process.exit(0); }
process.stdin.on('data', () => {
  process.stdout.write(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: 'req_1', response: { models: ${JSON.stringify(models)} } } }) + '\\n');
});
setTimeout(() => process.exit(0), 5000);
`;
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, 'claude');
  fs.writeFileSync(p, src, { mode: 0o755 });
  return p;
}

// A `claude` that answers like the real one does per auth: signed out (no
// CLAUDE_CODE_OAUTH_TOKEN) → tokenSource "none" + the baked-in list with a pinned
// Fable; signed in → the account's list, where `fable` is an alias.
function writeAuthStub(dir, version) {
  const row = (value, resolvedModel) => ({ value, resolvedModel, displayName: resolvedModel });
  const out = [row('default', 'claude-opus-5-5'), row('claude-fable-5-1[1m]', 'claude-fable-5-1')];
  const inn = [row('default', 'claude-opus-5-5'), row('fable', 'claude-fable-5-2'), row('claude-fable-5-1', 'claude-fable-5-1')];
  const src = `#!/usr/bin/env bun
if (process.argv.includes('--version')) { process.stdout.write(${JSON.stringify(version + ' (Claude Code)\n')}); process.exit(0); }
const tok = process.env.CLAUDE_CODE_OAUTH_TOKEN;
const response = tok ? { models: ${JSON.stringify(inn)}, account: { tokenSource: 'CLAUDE_CODE_OAUTH_TOKEN' } } : { models: ${JSON.stringify(out)}, account: { tokenSource: 'none' } };
process.stdin.on('data', () => {
  process.stdout.write(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: 'req_1', response } }) + '\\n');
});
setTimeout(() => process.exit(0), 5000);
`;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'claude'), src, { mode: 0o755 });
}
const SIGNED_OUT = ['default', 'claude-fable-5-1[1m]'];
const SIGNED_IN = ['default', 'fable', 'claude-fable-5-1'];
const ADD_ACCOUNT = "const acc = (await import('./server/accounts.js')).addTokenAccount({ label: 't', token: 'sk-ant-oat01-stub', trusted: true });";

// PATH for the child: the stub dirs first (so `which claude` finds a stub, not
// the machine's real CLI), then bun's own dir so the stubs' `#!/usr/bin/env bun`
// shebang resolves. No ARIGAMI_CLAUDE_BIN — that would pin the path for good.
function childEnv(dir, binDirs, extra = {}) {
  return {
    ARIGAMI_DIR: dir,
    ARIGAMI_PORT: '',
    ARIGAMI_CLAUDE_BIN: '',
    ARIGAMI_CLI_RECHECK_MS: '0', // tests only: re-resolve + re-probe on every call
    PATH: [...binDirs, path.dirname(process.execPath)].join(path.delimiter),
    ...extra,
  };
}

// The host logs its re-resolve/refetch decisions on stdout; keep the child's
// stdout for the JSON result.
const QUIET = 'console.log = (...a) => console.error(...a);';

test('in-place CLI update: a new --version refreshes the picker inside the 24h TTL', () => {
  const dir = tmp('inplace');
  const bin = path.join(dir, 'bin');
  writeStub(bin, '2.1.251', ['claude-opus-5', 'claude-fable-5']);
  const r = runInChild(
    `
    ${QUIET}
    const { getModels } = await import('./server/models.js');
    const first = await getModels();
    emit({ ids: first.models.map((m) => m.resolvedModel), cliVersion: first.cliVersion, fetchedAt: first.fetchedAt });
    // the CLI self-updates underneath the running host: same path, newer build
    await Bun.write(${JSON.stringify(path.join(bin, 'claude'))}, (await Bun.file(${JSON.stringify(path.join(bin, 'claude'))}).text())
      .replace('2.1.251', '2.1.257').replaceAll('claude-fable-5', 'claude-fable-5-1'));
    const second = await getModels();
    emit({ ids: second.models.map((m) => m.resolvedModel), cliVersion: second.cliVersion, fetchedAt: second.fetchedAt });
    `,
    childEnv(dir, [bin])
  );
  expect(r.ok, r.error).toBe(true);
  const [first, second] = r.out;
  expect(first.cliVersion).toBe('2.1.251');
  expect(first.ids).toEqual(['claude-opus-5', 'claude-fable-5']);
  expect(second.cliVersion).toBe('2.1.257');
  expect(second.ids).toEqual(['claude-opus-5', 'claude-fable-5-1']);
  expect(second.fetchedAt).toBeGreaterThan(first.fetchedAt); // a real refetch, not the cache
  // and it persisted, keyed on the new version, for the next boot
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'models.json'), 'utf8'));
  expect(onDisk.cliVersion).toBe('2.1.257');
});

test('CLI reinstalled at a NEW path (npm -g shadowing a native install) is picked up without a restart', () => {
  const dir = tmp('newpath');
  const oldBin = path.join(dir, 'native-bin'); // ~/.local/bin — what the host found at boot
  const newBin = path.join(dir, 'usr-bin'); // /usr/bin — appears later, earlier on PATH
  fs.mkdirSync(newBin, { recursive: true });
  writeStub(oldBin, '2.1.251', ['claude-opus-5', 'claude-fable-5']);
  const r = runInChild(
    `
    ${QUIET}
    const { getModels } = await import('./server/models.js');
    const { claudeBin } = await import('./server/lib/claude-bin.js');
    const first = await getModels();
    emit({ ids: first.models.map((m) => m.resolvedModel), bin: claudeBin(), cliBin: first.cliBin });
    // a newer claude lands at a path that precedes the old one on PATH
    ${`await import('node:fs').then((fs) => fs.writeFileSync(${JSON.stringify(path.join(newBin, 'claude'))}, ${JSON.stringify(
      fs.readFileSync(path.join(oldBin, 'claude'), 'utf8').replace('2.1.251', '2.1.257').replaceAll('claude-fable-5', 'claude-fable-5-1')
    )}, { mode: 0o755 }));`}
    const second = await getModels();
    emit({ ids: second.models.map((m) => m.resolvedModel), bin: claudeBin(), cliBin: second.cliBin, env: process.env.ARIGAMI_CLAUDE_BIN });
    `,
    childEnv(dir, [newBin, oldBin])
  );
  expect(r.ok, r.error).toBe(true);
  const [first, second] = r.out;
  expect(first.bin).toBe(path.join(oldBin, 'claude'));
  expect(first.cliBin).toBe(path.join(oldBin, 'claude'));
  expect(first.ids).toEqual(['claude-opus-5', 'claude-fable-5']);
  expect(second.bin).toBe(path.join(newBin, 'claude'));
  expect(second.cliBin).toBe(path.join(newBin, 'claude'));
  expect(second.ids).toEqual(['claude-opus-5', 'claude-fable-5-1']);
  // sibling spawners (mcp-auth, oneshot) read the published path — it moved too
  expect(second.env).toBe(path.join(newBin, 'claude'));
});

test('manual refresh re-resolves the binary even inside the re-check window', () => {
  const dir = tmp('force');
  const oldBin = path.join(dir, 'native-bin');
  const newBin = path.join(dir, 'usr-bin');
  fs.mkdirSync(newBin, { recursive: true });
  writeStub(oldBin, '2.1.251', ['claude-fable-5']);
  const r = runInChild(
    `
    ${QUIET}
    const { getModels } = await import('./server/models.js');
    const first = await getModels();
    ${`await import('node:fs').then((fs) => fs.writeFileSync(${JSON.stringify(path.join(newBin, 'claude'))}, ${JSON.stringify(
      fs.readFileSync(path.join(oldBin, 'claude'), 'utf8').replace('2.1.251', '2.1.257').replaceAll('claude-fable-5', 'claude-fable-5-1')
    )}, { mode: 0o755 }));`}
    const passive = await getModels(); // within the 60s memo: still the old answer, by design
    const forced = await getModels(true); // the picker's refresh button
    emit({ first: first.cliVersion, passive: passive.cliVersion, forced: forced.cliVersion, ids: forced.models.map((m) => m.resolvedModel) });
    `,
    childEnv(dir, [newBin, oldBin], { ARIGAMI_CLI_RECHECK_MS: '' }) // default 60s cadence
  );
  expect(r.ok, r.error).toBe(true);
  const [o] = r.out;
  expect(o.first).toBe('2.1.251');
  expect(o.passive).toBe('2.1.251');
  expect(o.forced).toBe('2.1.257');
  expect(o.ids).toEqual(['claude-fable-5-1']);
});

test('ARIGAMI_CLAUDE_BIN set by the operator stays pinned across re-checks', () => {
  const dir = tmp('pin');
  const pinned = path.join(dir, 'pinned');
  const shadow = path.join(dir, 'shadow');
  writeStub(pinned, '2.1.251', ['claude-fable-5']);
  writeStub(shadow, '2.1.257', ['claude-fable-5-1']);
  const r = runInChild(
    `
    ${QUIET}
    const { claudeBin } = await import('./server/lib/claude-bin.js');
    emit({ a: claudeBin(), b: claudeBin({ force: true }) });
    `,
    childEnv(dir, [shadow], { ARIGAMI_CLAUDE_BIN: path.join(pinned, 'claude') })
  );
  expect(r.ok, r.error).toBe(true);
  expect(r.out[0]).toEqual({ a: path.join(pinned, 'claude'), b: path.join(pinned, 'claude') });
});

// ---- the list is the ACCOUNT's, not the signed-out fallback ---------------------
// How Fable 5.2 went missing: the handshake ran without the pooled account's
// token, so the CLI answered its baked-in list (pinned claude-fable-5-1[1m]).

test('the handshake runs as the account a new session gets', () => {
  const dir = tmp('auth');
  const bin = path.join(dir, 'bin');
  writeAuthStub(bin, '2.1.322');
  const r = runInChild(
    `
    ${QUIET}
    ${ADD_ACCOUNT}
    const { getModels } = await import('./server/models.js');
    const m = await getModels();
    emit({ values: m.models.map((x) => x.value), authed: m.authed, sameAccount: m.accountId === acc.id });
    `,
    childEnv(dir, [bin])
  );
  expect(r.ok, r.error).toBe(true);
  expect(r.out[0]).toEqual({ values: SIGNED_IN, authed: true, sameAccount: true });
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'models.json'), 'utf8'));
  expect(onDisk.authed).toBe(true);
  expect(JSON.stringify(onDisk)).not.toContain('sk-ant-'); // the cache names the account, never its token
});

test('no account: the signed-out list is served, marked degraded, and a stray env token is not used', () => {
  const dir = tmp('noauth');
  const bin = path.join(dir, 'bin');
  writeAuthStub(bin, '2.1.322');
  const r = runInChild(
    `
    ${QUIET}
    const { getModels } = await import('./server/models.js');
    const a = await getModels();
    const b = await getModels(); // nothing to wait for: no refetch inside the TTL
    emit({ values: a.models.map((x) => x.value), authed: a.authed, accountId: a.accountId, cached: a.fetchedAt === b.fetchedAt });
    `,
    childEnv(dir, [bin], { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-stray' })
  );
  expect(r.ok, r.error).toBe(true);
  expect(r.out[0]).toEqual({ values: SIGNED_OUT, authed: false, accountId: null, cached: true });
});

test('a cache built signed out is refetched once an account exists (same CLI version, inside the TTL)', () => {
  const dir = tmp('upgrade');
  const bin = path.join(dir, 'bin');
  writeAuthStub(bin, '2.1.322');
  // what the live host had on disk: today's signed-out list, no account key
  fs.writeFileSync(
    path.join(dir, 'models.json'),
    JSON.stringify({ models: SIGNED_OUT.map((value) => ({ value })), fetchedAt: Date.now(), cliVersion: '2.1.322', cliBin: path.join(bin, 'claude') })
  );
  const r = runInChild(
    `
    ${QUIET}
    ${ADD_ACCOUNT}
    const { getModels } = await import('./server/models.js');
    const m = await getModels();
    emit({ values: m.models.map((x) => x.value), authed: m.authed });
    `,
    childEnv(dir, [bin])
  );
  expect(r.ok, r.error).toBe(true);
  expect(r.out[0]).toEqual({ values: SIGNED_IN, authed: true });
});

test('a signed-out answer never replaces a signed-in list — not even on manual refresh', () => {
  const dir = tmp('keep');
  const bin = path.join(dir, 'bin');
  writeAuthStub(bin, '2.1.322');
  const r = runInChild(
    `
    ${QUIET}
    ${ADD_ACCOUNT}
    const { getModels } = await import('./server/models.js');
    const first = await getModels();
    (await import('./server/accounts.js')).removeAccount(acc.id); // the login is gone: the CLI now answers signed out
    const passive = await getModels();
    const forced = await getModels(true);
    emit({ passive: passive.models.map((x) => x.value), forced: forced.models.map((x) => x.value), authed: forced.authed, error: forced.error, kept: forced.fetchedAt === first.fetchedAt });
    `,
    childEnv(dir, [bin])
  );
  expect(r.ok, r.error).toBe(true);
  const [o] = r.out;
  expect(o.passive).toEqual(SIGNED_IN);
  expect(o.forced).toEqual(SIGNED_IN);
  expect(o.authed).toBe(true);
  expect(o.kept).toBe(true);
  expect(o.error).toMatch(/signed out/);
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'models.json'), 'utf8'));
  expect(onDisk.models.map((x) => x.value)).toEqual(SIGNED_IN);
});
