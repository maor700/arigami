// Runs once before the whole `bun test` process (bunfig.toml [test].preload).
//
// A test run started from inside an Arigami session inherits the LIVE host's
// environment — ARIGAMI_BIND=0.0.0.0, ARIGAMI_PORT=3099, ARIGAMI_URL,
// ARIGAMI_TOKEN, ARIGAMI_CLAUDE_BIN… Every host test spawns `bun server/index.ts`
// with `{ ...process.env, ARIGAMI_DIR: tmp, … }`, so anything it does not
// override leaks into the test host: with ARIGAMI_BIND=0.0.0.0 and auth off the
// test host refuses to start ("an unauthenticated host may only listen on
// loopback") and every beforeAll times out; with ARIGAMI_URL the test host could
// reach the live one. Tests set the ARIGAMI_* they need themselves — none reads
// an inherited value — so drop the whole family up front. CI has none of these;
// this makes a local run see what CI sees.
for (const k of Object.keys(process.env)) {
  if (k.startsWith('ARIGAMI_')) delete process.env[k];
}

// The product ships no example profile bundles; tests that need a real bundle use the fixtures.
// Set after the wipe above so in-process modules AND spawned hosts/children inherit it.
process.env.ARIGAMI_SHIPPED_BUNDLES_DIR = new URL('./fixtures/bundles', import.meta.url).pathname;

// A test host must keep the plain configured default engine: whether the machine running the tests happens to be
// signed in to claude / codex must not decide which engine a new session gets (see registerEngineReadiness).
process.env.ARIGAMI_ENGINE_AUTOPICK = '0';

// A login list must not depend on the everyday Chrome of the machine running the tests (lib/owner-chrome.ts):
// tests that exercise it point ARIGAMI_OWNER_CHROME at a fixture profile themselves.
process.env.ARIGAMI_OWNER_CHROME = '0';

// Web tests compare rendered Hebrew against exact literals. The UI wraps Latin runs inside Hebrew in invisible
// bidi isolates (web/src/lib/i18n.js isolateLatin); tests that exercise it call isolateLatin() directly.
(globalThis as any).__ARIGAMI_PLAIN_T = true;

// Every temp file of this run goes under one root, removed when the process
// exits (see test/_tmp.js). Set on process.env so spawned hosts and children
// inherit it; os.tmpdir() reads TMPDIR on every call. A run killed with
// SIGKILL cannot clean up after itself, so its root is removed by the next run
// — matched by the pid in its name, only once that pid is gone.
{
  const fs = require('node:fs') as typeof import('node:fs');
  const path = require('node:path') as typeof import('node:path');
  const os = require('node:os') as typeof import('node:os');
  const parent = os.tmpdir();
  const PREFIX = 'arigami-testrun-';
  for (const n of fs.readdirSync(parent)) {
    const pid = Number(n.startsWith(PREFIX) ? n.slice(PREFIX.length).split('-')[0] : NaN);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    try {
      process.kill(pid, 0);
      continue; // still running
    } catch (e: any) {
      if (e?.code === 'EPERM') continue; // alive, someone else's
    }
    fs.rmSync(path.join(parent, n), { recursive: true, force: true });
  }
  const root = fs.mkdtempSync(path.join(parent, `${PREFIX}${process.pid}-`));
  process.env.TMPDIR = root;
  process.env.TMP = root;
  process.env.TEMP = root;
  const cleanup = () => {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* the next run removes it */
    }
  };
  // `bun test` does not reliably emit 'exit' to a preload; a top-level afterAll
  // in the preload is global — it runs once, after every file.
  (require('bun:test') as typeof import('bun:test')).afterAll(cleanup);
  process.on('exit', cleanup);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const)
    process.once(sig, () => {
      cleanup();
      process.exit(128 + (sig === 'SIGINT' ? 2 : sig === 'SIGTERM' ? 15 : 1));
    });
}
