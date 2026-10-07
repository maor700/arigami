// Profile bundles that carry extensions + org-scoped cron + the read-only git token.
//
// What these pin:
//   - the org's token goes only to https URLs on an allow-listed host, never into the URL itself
//   - extensions/<name>/ in a bundle is picked up, validated (name matches, no secret-looking settings)
//   - only a TRUSTED bundle installs extensions (they run code); an external one reports them skipped
//   - re-applying the same bundle changes nothing; a changed extension is updated in place; settings the user
//     already has are never overwritten
//   - a `scope: org` cron job is registered on the organisation host only, so N tenants do not run it N times
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runInChild } from './_child.js';
import { gitAuthEnv } from '../server/lib/git-auth.ts';

const pf = await import('../server/profiles.ts');
const tmp = (p = 'arigami-pfx-') => fs.mkdtempSync(path.join(os.tmpdir(), p));

// ---- git auth ------------------------------------------------------------------

test('the git token is sent only to https URLs on an allowed host, as a header — never in the URL', () => {
  const env = { ARIGAMI_GIT_TOKEN: 'tok123' } as NodeJS.ProcessEnv;
  const ok = gitAuthEnv('https://github.com/acme/profile.git', env);
  expect(ok.GIT_CONFIG_KEY_0).toBe('http.https://github.com/.extraheader');
  expect(ok.GIT_CONFIG_VALUE_0).toBe('AUTHORIZATION: basic ' + Buffer.from('x-access-token:tok123').toString('base64'));
  expect(JSON.stringify(ok)).not.toContain('tok123'); // base64 only — and not in any URL
  expect(gitAuthEnv('https://evil.example.com/acme/profile.git', env)).toEqual({});
  expect(gitAuthEnv('git@github.com:acme/profile.git', env)).toEqual({});
  expect(gitAuthEnv('http://github.com/acme/profile.git', env)).toEqual({});
  expect(gitAuthEnv('https://github.com/acme/profile.git', {} as NodeJS.ProcessEnv)).toEqual({});
  expect(gitAuthEnv('https://git.acme.io/p.git', { ...env, ARIGAMI_GIT_TOKEN_HOSTS: 'git.acme.io', ARIGAMI_GIT_TOKEN_USER: 'ci' } as NodeJS.ProcessEnv).GIT_CONFIG_VALUE_0).toBe('AUTHORIZATION: basic ' + Buffer.from('ci:tok123').toString('base64'));
});

// ---- bundle shape --------------------------------------------------------------

function ext(dir: string, name: string, extra: Record<string, unknown> = {}, body = 'v1') {
  fs.mkdirSync(path.join(dir, 'extensions', name), { recursive: true });
  fs.writeFileSync(path.join(dir, 'extensions', name, 'manifest.json'), JSON.stringify({ name, version: '1.0.0', apiVersion: 1, description: 'test ext', ...extra }));
  fs.writeFileSync(path.join(dir, 'extensions', name, 'README.md'), body);
}
function bundle(manifest: Record<string, unknown> = {}, cron?: unknown) {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'profile.json'), JSON.stringify({ name: 'org-profile', version: '1.0.0', ...manifest }));
  fs.writeFileSync(path.join(dir, 'README.md'), '# org\n');
  if (cron) fs.writeFileSync(path.join(dir, 'cron.json'), JSON.stringify(cron));
  return dir;
}

test('extensions/<name>/ in a bundle is loaded and merged with manifest entries', () => {
  const d = bundle({ extensions: [{ name: 'alpha', settings: { mode: 'x' } }, { name: 'remote-one', source: 'https://github.com/acme/ext.git', ref: 'v1.2.0' }] });
  ext(d, 'alpha');
  const b = pf.loadBundle(d);
  expect(b.extensions.map((e) => e.name).sort()).toEqual(['alpha', 'remote-one']);
  const alpha = b.extensions.find((e) => e.name === 'alpha')!;
  expect(alpha.dir).toContain(path.join('extensions', 'alpha'));
  expect(alpha.settings).toEqual({ mode: 'x' });
  expect(b.extensions.find((e) => e.name === 'remote-one')!.dir).toBe(null);
  expect(pf.validate(b).ok).toBe(true);
});

test('validation: directory name must match the manifest, a ref must be sane, settings may not carry secrets, cron scope is user|org', () => {
  const d = bundle({ extensions: [{ name: 'a-ext', settings: { apiKey: 'k' } }, { name: 'b-ext', source: 'https://x/y.git', ref: '--upload-pack=evil' }, { name: 'c-ext' }] }, [
    { name: 'j', prompt: 'p', schedule: { kind: 'interval', value: '1h' }, scope: 'everyone' },
  ]);
  ext(d, 'a-ext');
  ext(d, 'c-ext', { name: 'something-else' });
  const v = pf.validate(pf.loadBundle(d));
  expect(v.ok).toBe(false);
  const all = v.errors.join('\n');
  expect(all).toContain('settings."apiKey" looks like a secret');
  expect(all).toContain('"ref" must be a tag, branch or commit');
  expect(all).toContain('must match the directory name');
  expect(all).toContain('scope must be "user" or "org"');
});

// ---- apply ---------------------------------------------------------------------

function apply(bdir: string, adir: string, trusted: boolean, env: Record<string, string> = {}, again = false) {
  return runInChild(
    `const pf=await import('./server/profiles.ts');const tr=await import('./server/triggers.ts');const ex=await import('./server/extensions.ts');tr.load();` +
      `const b=pf.loadBundle(${JSON.stringify(bdir)});` +
      `const rep=await pf.applyBundle({...b,trusted:${trusted}});tr.flush();` +
      `emit({rep,ext:ex.readState().settings,cron:tr.listTriggers().map(t=>t.name)});`,
    { ARIGAMI_DIR: adir, ARIGAMI_PORT: '', ARIGAMI_STATE_FILE: path.join(adir, 'state.json'), ...env }
  );
}

test('only a trusted bundle installs extensions; a second apply is a no-op; a changed one is updated; settings are seeded once', () => {
  const adir = tmp();
  const bdir = bundle({ extensions: [{ name: 'alpha', settings: { mode: 'seed' } }] });
  ext(bdir, 'alpha', {}, 'v1');

  const ext0 = apply(bdir, tmp(), false);
  if (!ext0.ok) throw new Error(ext0.error);
  expect(ext0.out[0].rep.extensions[0].status).toBe('skipped');

  const r1 = apply(bdir, adir, true);
  if (!r1.ok) throw new Error(r1.error);
  expect(r1.out[0].rep.errors).toEqual([]);
  expect(r1.out[0].rep.extensions).toEqual([{ name: 'alpha', status: 'installed' }]);
  expect(fs.existsSync(path.join(adir, 'user', 'extensions', 'alpha', 'manifest.json'))).toBe(true);
  expect(r1.out[0].ext.alpha).toEqual({ mode: 'seed' });

  // a user edits the settings; re-applying the identical bundle changes nothing
  const st = JSON.parse(fs.readFileSync(path.join(adir, 'extensions.json'), 'utf8'));
  st.settings.alpha = { mode: 'mine' };
  fs.writeFileSync(path.join(adir, 'extensions.json'), JSON.stringify(st));
  const r2 = apply(bdir, adir, true);
  if (!r2.ok) throw new Error(r2.error);
  expect(r2.out[0].rep.extensions[0].status).toBe('unchanged');
  expect(r2.out[0].ext.alpha).toEqual({ mode: 'mine' }); // never overwritten

  // the org ships a new version: updated in place, settings still the user's
  ext(bdir, 'alpha', {}, 'v2');
  const r3 = apply(bdir, adir, true);
  if (!r3.ok) throw new Error(r3.error);
  expect(r3.out[0].rep.extensions[0].status).toBe('updated');
  expect(fs.readFileSync(path.join(adir, 'user', 'extensions', 'alpha', 'README.md'), 'utf8')).toBe('v2');
  expect(r3.out[0].ext.alpha).toEqual({ mode: 'mine' });
}, 120_000);

test('a `scope: org` cron job is registered on the organisation host only', () => {
  const cron = [
    { name: 'per-user', prompt: 'mine', schedule: { kind: 'interval', value: '1h' } },
    { name: 'org-wide', prompt: 'shared', schedule: { kind: 'interval', value: '1h' }, scope: 'org' },
  ];
  const bdir = bundle({}, cron);
  const tenant = apply(bdir, tmp(), true);
  if (!tenant.ok) throw new Error(tenant.error);
  expect(tenant.out[0].cron.some((n: string) => /per-user/.test(n))).toBe(true);
  expect(tenant.out[0].cron.some((n: string) => /org-wide/.test(n))).toBe(false);
  expect(tenant.out[0].rep.cronSkipped[0].name).toContain('org-wide');

  const orgHost = apply(bdir, tmp(), true, { ARIGAMI_ORG_HOST: '1' });
  if (!orgHost.ok) throw new Error(orgHost.error);
  expect(orgHost.out[0].cron.some((n: string) => /org-wide/.test(n))).toBe(true);
  expect(orgHost.out[0].rep.cronSkipped).toBeUndefined();
}, 120_000);

// ---- export --------------------------------------------------------------------

test('export: an extension with no remote is vendored, a git one becomes a pinned ref (credentials stripped), settings lose secret-looking keys', () => {
  const adir = tmp();
  const root = path.join(adir, 'user', 'extensions');
  ext(path.join(adir, 'user'), 'alpha');
  fs.mkdirSync(path.join(root, 'alpha', 'node_modules', 'junk'), { recursive: true });
  fs.writeFileSync(path.join(root, 'alpha', 'node_modules', 'junk', 'x.js'), 'x');
  fs.mkdirSync(path.join(root, 'gitext'), { recursive: true });
  fs.writeFileSync(path.join(root, 'gitext', 'manifest.json'), JSON.stringify({ name: 'gitext', version: '1.0.0', apiVersion: 1 }));
  const sh = (c: string) => Bun.spawnSync(['sh', '-c', c], { cwd: path.join(root, 'gitext') });
  sh('git init -q && git config user.email t@t && git config user.name t && git add -A && git commit -qm i && git remote add origin https://bot:s3cr3t@github.com/acme/gitext.git');
  const head = new TextDecoder().decode(sh('git rev-parse HEAD').stdout).trim();
  fs.writeFileSync(path.join(adir, 'extensions.json'), JSON.stringify({ schemaVersion: 1, enabled: {}, settings: { alpha: { mode: 'x', apiKey: 'k' } } }));
  const out = path.join(tmp(), 'bundle');
  const r = runInChild(
    `const bk=await import('./server/backup.ts');const res=bk.exportBundle({out:${JSON.stringify(out)},name:'org-profile',cron:[],memory:false});emit({res});`,
    { ARIGAMI_DIR: adir, ARIGAMI_PORT: '' }
  );
  if (!r.ok) throw new Error(r.error);
  expect(r.out[0].res.extensions).toEqual(['alpha', 'gitext']);
  const manifest = JSON.parse(fs.readFileSync(path.join(out, 'profile.json'), 'utf8'));
  const alpha = manifest.extensions.find((e: any) => e.name === 'alpha');
  const gitext = manifest.extensions.find((e: any) => e.name === 'gitext');
  expect(alpha.settings).toEqual({ mode: 'x' }); // apiKey dropped
  expect(alpha.source).toBeUndefined();
  expect(fs.existsSync(path.join(out, 'extensions', 'alpha', 'manifest.json'))).toBe(true);
  expect(fs.existsSync(path.join(out, 'extensions', 'alpha', 'node_modules'))).toBe(false);
  expect(gitext.source).toBe('https://github.com/acme/gitext.git'); // no bot:s3cr3t@
  expect(gitext.ref).toBe(head);
  expect(fs.existsSync(path.join(out, 'extensions', 'gitext'))).toBe(false);
  expect(JSON.stringify(manifest)).not.toContain('s3cr3t');
  // and the exported bundle loads and validates as-is
  const v = pf.validate(pf.loadBundle(out));
  expect(v.errors).toEqual([]);
}, 120_000);
