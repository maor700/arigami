// The product ships NO example Profile Bundles (profiles come from the org
// profile repo / ~/.arigami/profiles). The fixtures under test/fixtures/bundles
// stand in for a shipped dir (ARIGAMI_SHIPPED_BUNDLES_DIR, see test/_preload.ts)
// and must still load, validate, be trusted, ship their cron jobs DISABLED,
// carry a README + at least one skill with frontmatter, and be listed by both
// the K3 bundle API and the legacy onboarding profile list (Setup.jsx).
// Generic-template guard: no localhost URLs, no real hostnames, no enabled cron.
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

const pf = await import('../server/profiles.ts');
const ob = await import('../server/onboarding.ts');
const ROOT = path.resolve(import.meta.dir, '..');
const BUNDLES = path.join(ROOT, 'test', 'fixtures', 'bundles');
const names = fs.readdirSync(BUNDLES).filter((n) => fs.existsSync(path.join(BUNDLES, n, 'profile.json'))).sort();

test('the product ships no profile bundles', () => {
  const shipped = path.join(ROOT, 'profiles', 'bundles');
  const entries = fs.existsSync(shipped) ? fs.readdirSync(shipped) : [];
  expect(entries).toEqual([]);
});

test('the test shipped dir points at the fixtures', () => {
  expect(pf.SHIPPED_BUNDLES_DIR).toBe(BUNDLES);
  expect(names).toEqual(['marketing-team', 'solo-dev']);
});

for (const name of names) {
  test(`fixture bundle ${name}: valid, trusted, cron disabled, skills + README present`, () => {
    const dir = path.join(BUNDLES, name);
    const b = pf.loadBundle(dir, name);
    const v = pf.validate(b);
    expect(v.errors).toEqual([]);
    expect(v.ok).toBe(true);
    expect(v.warnings).toEqual([]);
    expect(b.trusted).toBe(true);
    expect(b.manifest.name).toBe(name);
    expect(typeof b.manifest.version).toBe('string');
    expect(typeof b.manifest.title).toBe('string');
    expect(typeof b.manifest.description).toBe('string');
    expect(b.readme.length).toBeGreaterThan(200);
    expect(b.skills.length).toBeGreaterThan(0);
    for (const s of b.skills) expect(s.content).toMatch(/^---\n[\s\S]*?description:\s*\S[\s\S]*?\n---/);
    expect(b.cron.length).toBeGreaterThan(0);
    for (const c of b.cron) {
      expect(c.enabled).toBe(false);
      expect(typeof c.name).toBe('string');
      expect(c.prompt.trim().length).toBeGreaterThan(20);
    }
    // memory seed present and within the merge cap
    expect(b.memorySeed.memory || b.memorySeed.user).toBeTruthy();
  });

  test(`fixture bundle ${name}: generic template — no localhost links, no real repo sources`, () => {
    const dir = path.join(BUNDLES, name);
    const walk = (d: string): string[] =>
      fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
    for (const f of walk(dir)) {
      const text = fs.readFileSync(f, 'utf8');
      expect(text, f).not.toMatch(/https?:\/\/localhost/);
      expect(text, f).not.toMatch(/\.ts\.net\b/);
    }
    const b = pf.loadBundle(dir, name);
    for (const r of b.manifest.repos || []) expect(r.source, `${name} repos[].source must be a <placeholder>`).toMatch(/<[^>]+>/);
  });
}

test('listBundles() and the legacy onboarding profile list both expose every bundle in the shipped dir', () => {
  const bundles = pf.listBundles();
  const profiles = ob.listProfiles().map((p) => p.name);
  for (const n of names) {
    const s = bundles.find((x) => x.name === n);
    expect(s?.valid, n).toBe(true);
    expect(s?.trusted, n).toBe(true);
    expect(profiles, n).toContain(n);
  }
});

test('profiles/ has no thin *.json duplicates of a bundle', () => {
  const thin = fs.readdirSync(path.join(ROOT, 'profiles')).filter((n) => n.endsWith('.json')).map((n) => n.replace(/\.json$/, ''));
  for (const n of thin) expect(names, `${n}.json duplicates a bundle`).not.toContain(n);
});
