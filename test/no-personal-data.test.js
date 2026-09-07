// Guard: no personal data anywhere in the tracked repo.
//
// This is the structural half of the leak gate — it knows the *shapes* of
// personal data (Israeli phone numbers, WhatsApp JIDs, real mailboxes) but
// deliberately knows no actual names, addresses or handles. The specific
// strings for a given host live OUTSIDE the repo, in
// `$ARIGAMI_DIR/private-terms.txt` (mode 0600, one term per line); that file
// is optional, and when it is absent only the structural rules run. Putting
// the owner's name into a test in order to test for the owner's name would
// defeat the whole point.
//
// `scripts/check-personal-data.sh` implements the same rules in shell for use
// as a pre-commit hook. See CONTRIBUTING.md.
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SELF = 'test/no-personal-data.test.js';

// The public project slug. It is the repo's own address (github.com/… and
// ghcr.io/…) and stays; strip it before matching so a denylist term that
// happens to be a substring of it cannot fire on every install doc.
const PUBLIC_SLUG = /(?:github\.com|ghcr\.io|raw\.githubusercontent\.com)\/[A-Za-z0-9-]+\/arigami/g;

// A phone/JID placeholder: after the operator prefix everything is zeros,
// except at most two trailing digits used to tell two examples apart.
// 972500000000 / 0500000000 / 0730000001 pass; a real subscriber number does not.
const PLACEHOLDER_DIGITS = /^(?:972|0)\d{2}0{5,}\d{0,2}$/;
const isPlaceholderNumber = (s) => PLACEHOLDER_DIGITS.test(s.replace(/\D/g, ''));

// Israeli phone numbers: +972 / 0 prefix, mobile (5x) or landline (2/3/4/8/9, 7x).
const PHONE_RE = /(?:\+?972[-\s]?|\b0)(?:5\d|7\d|[23489])[-\s]?\d{3}[-\s]?\d{4}\b/g;
// WhatsApp JIDs, in every form the bridge produces.
const JID_RE = /\b(\d{6,})@(?:lid|s\.whatsapp\.net|g\.us)\b/g;
// Mailboxes.
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g;

// Group JIDs are opaque ids, not phone numbers — an explicit placeholder set.
const JID_PLACEHOLDERS = new Set(['1234567890', '1234567891', '120363000000000000']);

// Reserved / non-routable mail domains are always fine (RFC 2606 + .local).
const RESERVED_MAIL = /(?:^|\.)(?:example\.(?:com|org|net)|example|test|invalid|localhost|local|arpa)$/i;
// Everything else needs to be listed here, on purpose. Free-mail providers
// (gmail, outlook, …) are never listed — that is the point of the rule.
const ALLOWED_MAIL_DOMAINS = new Set([
  'github.com',        // git@github.com / %s@github.com — the SSH/token form, not a person
  'arigami.local',     // the product's own synthetic push sender
  's.whatsapp.net', 'g.us', // WhatsApp JID suffixes, matched as addresses by the regex
  'evil.com', 'evil.net', 'notexample.com', 'example.com.evil.net', // adversary placeholders in the auth/redirect tests
  't.io',              // short throwaway address used across the host tests
  'anthropic.com',     // noreply@anthropic.com in commit trailers / docs
  'consumer-idp.example',
]);

// [file, substring the matching line must contain, reason]
const ALLOW = [
  ['mcp/host-mcp.js', '+972500000000', 'documented placeholder phone in a tool description'],
  ['server/listeners-whatsapp.ts', '972500000000', 'documented placeholder phone in a comment'],
];

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'run', 'audit']);
const TEXT = /\.(ts|tsx|js|jsx|mjs|cjs|md|json|jsonc|sh|ps1|cmd|yml|yaml|toml|css|html|txt|env|example|npmrc|lock|conf|service|plist|py)$/;
const ROOT_FILES = /^(\.env\.example|\.npmrc|\.gitignore|\.dockerignore|Dockerfile|LICENSE|NOTICE|host|install-app|chromatic-cookies)$/;
const SKIP_FILES = new Set(['bun.lock', path.join('web', 'bun.lock'), SELF]);
const SKIP_PATHS = new Set(['control-plane/data']);

// Tracked files only: what is (or would be) published. Gitignored scratch —
// .env backups, *-logs.txt, a local audit/ dir — is none of the gate's
// business, and scanning it would fail the suite on a working host.
function* files() {
  const out = execFileSync('git', ['-C', ROOT, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 32 << 20 });
  for (const rel of out.split('\0')) {
    if (!rel || SKIP_FILES.has(rel)) continue;
    const first = rel.split('/')[0];
    if (SKIP_DIRS.has(first) || SKIP_PATHS.has(path.dirname(rel))) continue;
    const base = path.basename(rel);
    if (TEXT.test(base) || ROOT_FILES.test(base)) yield rel;
  }
}

// One term per line, `#` comments and blanks ignored. Absent file → no terms.
export function loadPrivateTerms() {
  const dir = process.env.ARIGAMI_DIR || path.join(os.homedir(), '.arigami');
  let raw;
  try { raw = fs.readFileSync(path.join(dir, 'private-terms.txt'), 'utf8'); } catch { return []; }
  return raw.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
}

export function scanLine(line, terms = []) {
  const hits = [];
  const stripped = line.replace(PUBLIC_SLUG, '');
  for (const m of stripped.matchAll(PHONE_RE)) {
    if (!isPlaceholderNumber(m[0])) hits.push('israeli phone number');
  }
  for (const m of stripped.matchAll(JID_RE)) {
    if (!isPlaceholderNumber(m[1]) && !JID_PLACEHOLDERS.has(m[1])) hits.push('whatsapp JID');
  }
  for (const m of stripped.matchAll(EMAIL_RE)) {
    const domain = m[1].toLowerCase();
    if (RESERVED_MAIL.test(domain) || ALLOWED_MAIL_DOMAINS.has(domain)) continue;
    hits.push('personal mailbox');
  }
  const lower = stripped.toLowerCase();
  for (const t of terms) if (lower.includes(t.toLowerCase())) hits.push('private denylist term');
  return [...new Set(hits)];
}

const eachLine = (fn) => {
  for (const f of files()) {
    let text;
    try { text = fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch { continue; }
    if (text.includes('\0')) continue; // binary
    text.split('\n').forEach((line, i) => {
      if (ALLOW.some(([af, needle]) => af === f && line.includes(needle))) return;
      fn(f, i + 1, line);
    });
  }
};

test('no personal data (phones, WhatsApp JIDs, mailboxes) in tracked files', () => {
  const offenders = [];
  eachLine((f, n, line) => {
    for (const kind of scanLine(line)) offenders.push(`${f}:${n} [${kind}]: ${line.trim().slice(0, 120)}`);
  });
  expect(offenders, `personal data found:\n${offenders.join('\n')}`).toEqual([]);
});

// The denylist is host-local and optional. When it exists, every term in it
// must be absent from the repo — that is the check the structural rules above
// cannot do without carrying the terms themselves.
test('no term from $ARIGAMI_DIR/private-terms.txt appears in tracked files', () => {
  const terms = loadPrivateTerms();
  if (!terms.length) return; // nothing configured on this host — structural rules stand alone
  const offenders = [];
  eachLine((f, n, line) => {
    const lower = line.replace(PUBLIC_SLUG, '').toLowerCase();
    // Report the file and line only — never the term itself, so a failure
    // message cannot become the leak it is guarding against.
    if (terms.some((t) => lower.includes(t.toLowerCase()))) offenders.push(`${f}:${n}`);
  });
  expect(offenders, `private denylist terms found at:\n${offenders.join('\n')}`).toEqual([]);
});

test('the rules themselves: real values are caught, zeroed examples are not', () => {
  expect(isPlaceholderNumber('+972500000000')).toBe(true);
  expect(isPlaceholderNumber('050-0000000')).toBe(true);
  expect(isPlaceholderNumber('073-0000001')).toBe(true);
  expect(isPlaceholderNumber('+972521234567')).toBe(false);
  expect(isPlaceholderNumber('050-1234567')).toBe(false);
  expect(scanLine('call me on 054-7654321')).toEqual(['israeli phone number']);
  expect(scanLine('jid 972541234567@s.whatsapp.net')).toContain('whatsapp JID');
  expect(scanLine('jid 1234567890@lid')).toEqual([]);
  expect(scanLine('mail someone@gmail.com')).toEqual(['personal mailbox']);
  expect(scanLine('mail dev@example.com and dev@fake-org.test')).toEqual([]);
  // the public repo slug survives a denylist term that is a substring of it
  expect(scanLine('git clone https://github.com/someone/arigami', ['someone'])).toEqual([]);
  expect(scanLine('hello Someone', ['someone'])).toEqual(['private denylist term']);
});
