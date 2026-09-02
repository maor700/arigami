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

const tmp = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `arigami-models-${tag}-`));

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
