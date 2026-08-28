#!/usr/bin/env bun
// Fake `claude` binary for server/lib/oneshot.ts tests — no network, no real
// credentials needed. Behavior is controlled entirely by env vars the test
// sets (FAKE_CLAUDE_MODE); on success it echoes back what it actually
// received (env + argv) inside the normal --output-format json envelope, so
// tests can assert on env-construction (strip-then-inject) without spawning
// the real CLI.
if (process.env.FAKE_CLAUDE_MODE === 'fail') {
  process.stderr.write(process.env.FAKE_CLAUDE_STDERR || 'simulated failure\n');
  process.exit(1);
}
// Mirrors what the REAL `claude -p --output-format json` does on an auth
// failure: exit 1, EMPTY stderr, and the actual message ("Not logged in ·
// Please run /login") inside the JSON envelope on stdout (is_error:true).
if (process.env.FAKE_CLAUDE_MODE === 'fail-envelope') {
  process.stdout.write(JSON.stringify({ is_error: true, result: process.env.FAKE_CLAUDE_RESULT || 'Not logged in · Please run /login' }));
  process.exit(1);
}
const payload = {
  token: process.env.CLAUDE_CODE_OAUTH_TOKEN || null,
  apiKey: process.env.ANTHROPIC_API_KEY || null,
  argv: process.argv.slice(2),
};
process.stdout.write(JSON.stringify({ result: JSON.stringify(payload) }));
