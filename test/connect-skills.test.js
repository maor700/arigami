// S3 guard: every connect-* playbook is well-formed and stays inside the JIT-setup
// security contract — frontmatter (description/triggers/capability/allowlist),
// an allowlist drawn only from the approved domain set, the "never type
// passwords" rule, the take-over + evidence + report_setup steps, and the
// shared helpers (connect.sh / xinput.py) it relies on. Also checks the
// orchestration skills teach `needs_setup → request_setup`.
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKILLS = path.join(ROOT, 'skills');
const LIB = path.join(SKILLS, '_lib');

// The only hosts a playbook may navigate (spec "כללי אוטומציה" §2 + provider
// domains for non-Google Composio toolkits). Extend deliberately, never ad hoc.
const APPROVED_DOMAINS = new Set([
  'accounts.google.com', 'myaccount.google.com', 'google.com',
  'claude.ai', 'claude.com', 'platform.claude.com', 'console.anthropic.com',
  'backend.composio.dev', 'composio.dev',
  'login.tailscale.com', 'tailscale.com',
  'github.com',
  'slack.com', 'linear.app', 'notion.so',
]);
const CAPABILITY_RE = /^(identity|claude|git|remote|whatsapp|desktop|push|telemetry|repo:<name>|composio:<toolkit>)$/;

function frontmatter(content) {
  const m = content.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return null;
  const out = {};
  for (const line of m[1].split('\n')) {
    const mm = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (mm) out[mm[1]] = mm[2].trim();
  }
  return out;
}

const playbooks = fs.readdirSync(SKILLS).filter((d) => d.startsWith('connect-')).sort();

test('the five JIT-setup playbooks ship', () => {
  expect(playbooks).toEqual(['connect-claude', 'connect-composio', 'connect-github', 'connect-identity', 'connect-tailscale']);
});

for (const name of playbooks) {
  const file = path.join(SKILLS, name, 'SKILL.md');
  const content = fs.readFileSync(file, 'utf8');
  const fm = frontmatter(content);

  test(`${name}: frontmatter has description, triggers, capability, allowlist`, () => {
    expect(fm).not.toBeNull();
    expect(fm.description?.length).toBeGreaterThan(40);
    expect(fm.triggers?.length).toBeGreaterThan(10);
    expect(fm.triggers).toMatch(/request_setup/);
    expect(fm.capability).toMatch(CAPABILITY_RE);
    expect(fm.allowlist?.length).toBeGreaterThan(0);
  });

  test(`${name}: allowlist domains are all approved and exported as CONNECT_ALLOW`, () => {
    const domains = fm.allowlist.split(/\s+/).filter(Boolean);
    for (const d of domains) expect(APPROVED_DOMAINS.has(d)).toBe(true);
    // The body must export exactly these domains (Composio adds a provider domain per toolkit).
    const m = content.match(/export CONNECT_ALLOW="([^"]+)"/);
    expect(m).not.toBeNull();
    const exported = m[1].replace(/<[^>]*>/g, "").split(/\s+/).filter(Boolean);
    for (const d of exported) expect(domains).toContain(d);
    expect(content).not.toMatch(/https?:\/\/(localhost|127\.0\.0\.1)/);
  });

  test(`${name}: never-type-passwords rule, take-over, evidence and report_setup are all present`, () => {
    expect(content).toMatch(/\*\*Never type passwords/i);
    expect(content).toMatch(/request_screen\(/);
    expect(content).toMatch(/capture_screen\(/);
    expect(content).toMatch(/publish_artifact/);
    expect(content).toMatch(/report_setup\(\{capability:"[^"]+", ok:true, evidence:/);
    expect(content).toMatch(/report_setup\(\{ok:false/);
    expect(content).toMatch(/skills\/_lib\/connect\.sh/);
    expect(content).toMatch(/skills\/machine-work\/SKILL\.md/);
    expect(content).toMatch(/## Failure handling/);
    expect(content).toMatch(/≤ 2 attempts/);
  });

  test(`${name}: no secrets / personal identifiers in the playbook`, () => {
    expect(content).not.toMatch(/@gmail\.com|\.ts\.net|\b\d{1,3}(\.\d{1,3}){3}\b/);
    expect(content).not.toMatch(/(api[_-]?key|token)\s*[:=]\s*["'][A-Za-z0-9_-]{16,}/i);
  });
}

test('shared helpers exist, are executable and parse', () => {
  for (const f of ['connect.sh', 'chrome.sh', 'xinput.py']) {
    const p = path.join(LIB, f);
    expect(fs.existsSync(p)).toBe(true);
    expect(fs.statSync(p).mode & 0o111).not.toBe(0);
  }
  expect(spawnSync('bash', ['-n', path.join(LIB, 'connect.sh')]).status).toBe(0);
  const py = spawnSync('python3', ['-m', 'py_compile', path.join(LIB, 'xinput.py')], { encoding: 'utf8' });
  expect(py.status).toBe(0);
});

test('connect.sh allowlist: exact + subdomain match only, refuses empty list and look-alikes', () => {
  const sh = path.join(LIB, 'connect.sh');
  const env = { ...process.env, ARIGAMI_SESSION_ID: 'sess_test', ARIGAMI_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'connect-')) };
  const run = (allow, url) => spawnSync('bash', [sh, 'allowed', url], { env: { ...env, CONNECT_ALLOW: allow }, encoding: 'utf8' }).status;
  expect(run('accounts.google.com google.com', 'https://accounts.google.com/signin')).toBe(0);
  expect(run('google.com', 'https://myaccount.google.com/')).toBe(0);
  expect(run('google.com', 'https://GOOGLE.com:443/x')).toBe(0);
  expect(run('google.com', 'https://google.com.evil.net/')).toBe(1);
  expect(run('google.com', 'https://evilgoogle.com/')).toBe(1);
  expect(run('google.com', 'https://user@evil.net/?x=google.com')).toBe(1);
  expect(run('', 'https://google.com/')).toBe(1);
  // open/nav refuse an off-list host before touching the browser (no host running here).
  const r = spawnSync('bash', [sh, 'open', 'https://evil.net/'], { env: { ...env, CONNECT_ALLOW: 'google.com' }, encoding: 'utf8' });
  expect(r.status).toBe(1);
  expect(r.stderr).toMatch(/refusing to open evil\.net/);
  const r2 = spawnSync('bash', [sh, 'nav', 'https://google.com/'], { env: { ...env, CONNECT_ALLOW: '' }, encoding: 'utf8' });
  expect(r2.status).toBe(1);
  expect(r2.stderr).toMatch(/CONNECT_ALLOW is empty/);
});

test('machine-work, dispatch and project-manager teach needs_setup → request_setup and forbid workarounds', () => {
  for (const s of ['machine-work', 'dispatch', 'project-manager']) {
    const c = fs.readFileSync(path.join(SKILLS, s, 'SKILL.md'), 'utf8');
    expect(c).toMatch(/needs_setup/);
    expect(c).toMatch(/request_setup\(\{capability, why\}\)/);
    expect(c).toMatch(/\{state:"auto"\}/);
    expect(c).toMatch(/Never work around a missing capability/);
    for (const p of playbooks) expect(c).toContain(p);
  }
});

test('docs/CONNECT.md documents every playbook and the security model', () => {
  const c = fs.readFileSync(path.join(ROOT, 'docs', 'CONNECT.md'), 'utf8');
  for (const p of playbooks) expect(c).toContain(p);
  expect(c).toMatch(/## Security model/);
  expect(c).toMatch(/never types secrets/i);
  for (const d of APPROVED_DOMAINS) expect(c).toContain(d);
});
