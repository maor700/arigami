// The wizard's "add a repository" step connects the bare id `repo`; the host has no such capability (only
// `repo:<name>`), so it must go straight to POST /__api/onboarding/repos instead of /__api/setup/repo.
import { test, expect, afterEach } from 'bun:test';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch; // other test files in this process use fetch
});

test('connect("repo") adds the repository through /onboarding/repos, not /setup/repo', async () => {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: init?.method, body: init?.body });
    return new Response(JSON.stringify({ ok: true }), { status: 201, headers: { 'content-type': 'application/json' } });
  };
  const { connect } = await import('../web/src/lib/setup-api.js');
  await connect('repo', { entry: { name: 'app', source: 'github.com/org/app' } });
  expect(calls.length).toBe(1);
  expect(calls[0].url).toContain('/onboarding/repos');
  expect(calls[0].url).not.toContain('/setup/');
  expect(JSON.parse(calls[0].body)).toEqual({ name: 'app', source: 'github.com/org/app' });
});
