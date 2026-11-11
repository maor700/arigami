// D2 guard: the public repo carries no internal references and no private
// network identifiers. Every hit must be on the allowlist below (a legit
// placeholder, an RFC1918 example in a test). Run by
// scripts/check-public-readiness.sh too.
//
// Names, mailboxes, phone numbers and employer identifiers are NOT listed
// here — writing them down would put the very strings we are removing back
// into the repo. Those live in test/no-personal-data.test.js, which matches
// on shape plus an optional out-of-repo denylist at
// $ARIGAMI_DIR/private-terms.txt.
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SELF = 'test/no-internal-refs.test.js';

// [label, regex]
const FORBIDDEN = [
  ['placeholder org', /your-org/],
  ['FontAwesome Pro', /font-?awesome\s*pro\b|@fortawesome\/pro-/i],
  ['tailscale hostname', /\.ts\.net\b/],
  ['private IPv4', /\b(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3})\b/],
];

// [file, substring the matching line must contain, reason]
const ALLOW = [
  ['server/lib/config.ts', 'host.example.ts.net', 'placeholder in a comment'],
  ['test/desktops.test.js', "vncHost: '10.0.0.5'", 'RFC1918 example: non-loopback VNC host'],
  ['test/auth.test.js', "'10.0.0.1'", 'RFC1918 example: non-loopback bind'],
  ['test/proxy-headers.test.ts', '10.0.0.', 'RFC1918 example: non-loopback peer (C2)'],
  ['test/proxy-headers.test.ts', '172.18.0.2', 'RFC1918 example: docker-network peer (C2)'],
  ['test/proxy-headers.test.ts', 'box.ts.net', 'placeholder tailnet host in a test (C2)'],
  ['test/remote-tailscale-timeout.test.ts', 'box.example.ts.net', 'placeholder tailnet host in a test'],
  ['docs/TLS.md', '<tailnet>.ts.net', 'placeholder tailnet host in docs (C2)'],
  ['deploy/helm/arigami-tenant/values.yaml', '10.0.0.0/8', 'RFC1918 range the egress policy subtracts from 0.0.0.0/0'],
  ['deploy/helm/arigami-tenant/values.yaml', '172.16.0.0/12', 'RFC1918 range the egress policy subtracts from 0.0.0.0/0'],
  ['deploy/helm/arigami-tenant/values.yaml', '192.168.0.0/16', 'RFC1918 range the egress policy subtracts from 0.0.0.0/0'],
];

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'run', 'audit']);
const TEXT = /\.(ts|tsx|js|jsx|mjs|cjs|md|json|jsonc|sh|ps1|cmd|yml|yaml|toml|css|html|txt|env|example|npmrc|lock|conf|service|plist|py)$/;
const ROOT_FILES = /^(\.env\.example|\.npmrc|\.gitignore|\.dockerignore|Dockerfile|LICENSE|NOTICE|host|install-app|chromatic-cookies)$/;

// Gitignored runtime dirs (K8S-3: control-plane/data holds the pilot's
// sqlite/env/bundle scratch) are not part of the published repo.
const SKIP_PATHS = new Set(['control-plane/data']);

// Tracked files only: what is (or would be) published. Gitignored scratch
// (log files, .env backups, a local audit/ dir) is not part of the repo and
// scanning it would fail the gate on a perfectly clean working host.
function* files() {
  const out = execFileSync('git', ['-C', ROOT, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 32 << 20 });
  for (const rel of out.split('\0')) {
    if (!rel || rel === SELF) continue;
    if (SKIP_DIRS.has(rel.split('/')[0]) || SKIP_PATHS.has(path.dirname(rel))) continue;
    const base = path.basename(rel);
    if (TEXT.test(base) || ROOT_FILES.test(base)) yield rel;
  }
}

test('no internal references or private network identifiers anywhere in the repo', () => {
  const offenders = [];
  for (const f of files()) {
    let text;
    try { text = fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch { continue; }
    if (text.includes('\0')) continue; // binary
    text.split('\n').forEach((line, i) => {
      for (const [label, re] of FORBIDDEN) {
        if (!re.test(line)) continue;
        if (ALLOW.some(([af, needle]) => af === f && line.includes(needle))) continue;
        offenders.push(`${f}:${i + 1} [${label}]: ${line.trim().slice(0, 120)}`);
      }
    });
  }
  expect(offenders, `internal references found:\n${offenders.join('\n')}`).toEqual([]);
});

// Shipped profiles must be generic: a name, and repos that point at public
// sources. Which *specific* org must never appear is not spelled out here —
// test/no-personal-data.test.js scans profiles/ along with everything else,
// against the out-of-repo denylist.
// The product ships none (profiles/bundles/ is absent); the fixtures stand in for them and hold the same bar.
test('profiles/ ships only generic bundles', () => {
  const roots = [path.join(ROOT, 'profiles', 'bundles'), path.join(ROOT, 'test', 'fixtures', 'bundles')];
  const bundles = roots.flatMap((root) =>
    fs.existsSync(root) ? fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => ({ name: e.name, root })) : []
  );
  expect(bundles.length).toBeGreaterThan(0);
  for (const b of bundles) {
    const f = path.join(b.root, b.name, 'profile.json');
    const p = JSON.parse(fs.readFileSync(f, 'utf8'));
    expect(typeof p.name).toBe('string');
    for (const r of p.repos || []) {
      expect(typeof r.source).toBe('string');
      // Repo sources must be placeholders, not a real org: either an <angle>
      // token or a public github.com path. No SSH-only / internal hosts.
      expect(r.source, `${b.name}: repo source must be a placeholder`).toMatch(/<[^>]+>/);
    }
  }
});
