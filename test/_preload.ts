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
