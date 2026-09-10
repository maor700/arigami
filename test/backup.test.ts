// B4-full (server/backup.ts): full backup manifest + exclusions, profile-bundle
// export that never carries secrets, export-bundle → profile-apply round-trip,
// import refusing newer format/major version, unsafe archive paths, the
// stop-the-world guard, and the .bak swap on restore.
//
// Pure helpers run in-process. Anything that reads ARIGAMI_DIR runs in a child
// with its own throwaway dir (test/_child.js) because server modules capture
// ARIGAMI_DIR at import time. Nothing here touches ~/.arigami.
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runInChild } from './_child.js';

const bk = await import('../server/backup.ts');
const tmp = (p = 'arigami-bk-') => fs.mkdtempSync(path.join(os.tmpdir(), p));
const tarList = (f: string) => spawnSync('tar', ['-tzf', f], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean).map((e) => e.replace(/^\.\//, ''));

const SKILL = '---\ndescription: a throwaway exported skill\n---\n\n# Exported\n\nbody\n';

/** A fake, fully populated instance dir — every file is synthetic. */
function fakeInstance(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
  const w = (rel: string, content: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  };
  w('config.json', JSON.stringify({ port: 3099, defaultModel: 'sonnet', voiceLang: 'en', groqApiKey: 'gsk_FAKE', composioApiKey: 'ck_FAKE' }));
  w('accounts.json', JSON.stringify({ claude: { token: 'sk-ant-FAKE-NOT-REAL' } }));
  w('secrets.env', 'ANTHROPIC_API_KEY=sk-ant-FAKE\n');
  w('users.json', JSON.stringify([{ id: 'u1', email: 'someone@example.com', role: 'admin' }]));
  w('share-secret', 'deadbeef');
  w('repos.json', JSON.stringify([{ name: 'demo-app', source: 'github.com/example/demo-app', branch: 'main', installCmd: 'bun install', envSource: { kind: 'copy', files: ['/home/someone/.env'] } }]));
  w('state.json', JSON.stringify({ sessions: [{ id: 's1', title: 'secret chat' }] }));
  w('sessions.json', '[]');
  w('chat/s1.jsonl', '{"role":"user","text":"private"}\n');
  w('memory/USER.md', '- The user is a test fixture\n- Prefers tabs\n');
  w('memory/MEMORY.md', '- test project uses bun\n');
  w('memory/memory.sqlite', 'not really sqlite');
  w('skills/exported-skill/SKILL.md', SKILL);
  w('skills/exported-skill/notes.md', 'extra file inside the skill dir\n');
  w('uploads/a.txt', 'upload');
  w('triggers.json', JSON.stringify({
    triggers: [
      { id: 'c1', type: 'cron', name: '[old-bundle] morning', prompt: 'say hi', schedule: { kind: 'cron', value: '0 9 * * *' }, enabled: true, autonomous: true, sessionMode: 'existing:s1', deliver: { push: true, whatsapp: '972500000000@s.whatsapp.net', master: 's1' }, createdAt: 'x', lastRun: null, runs: [] },
      { id: 'l1', type: 'linear-filter', name: 'not cron' },
    ],
  }));
  // things a full backup must leave out
  w('run/host.pid', '12345');
  w('run/host.json', '{}');
  w('chrome-sessions/s1/Default/Cookies', 'cookies');
  w('chrome-base/Default/Cookies', 'cookies');
  w('logs/host.log', 'log');
  w('config.json.bak-1', '{}');
  w('mcp-logs.txt', 'root-level log (F4 #7)');
  w('wa-logs.txt', 'root-level log (F4 #7)');
  w('uploads/keep-logs.txt', 'an upload that merely ends in -logs.txt — must survive');
  // M1: connection RECORDS are portable (names/URLs), the OAuth grants behind
  // them are not — a `.credentials.json` anywhere under the instance dir is a
  // machine-local plaintext secret and must never reach an archive.
  w('mcp-connections.json', JSON.stringify([{ cap: 'mcp:linear', slug: 'linear', name: 'linear', url: 'https://mcp.linear.app/mcp', auth: 'oauth', at: '2026-08-30T00:00:00.000Z' }]));
  w('agents/sales/connections.json', JSON.stringify([{ cap: 'mcp:notion', slug: 'notion', name: 'notion--sales', url: 'https://mcp.notion.com/mcp', auth: 'oauth', at: '2026-08-30T00:00:00.000Z' }]));
  w('.credentials.json', JSON.stringify({ mcpOAuth: { 'linear|abc': { accessToken: 'mcp-token-FAKE-NOT-REAL' } } }));
  w('claude-config/.credentials.json', JSON.stringify({ mcpOAuth: { 'linear|abc': { accessToken: 'mcp-token-FAKE-NOT-REAL' } } }));
  return dir;
}

// ---- pure ----------------------------------------------------------------------------

test('checkManifest: accepts same major, refuses newer format and newer major version', () => {
  const ok = bk.checkManifest({ kind: 'arigami-backup', format: 1, version: '0.1.0' }, { format: 1, version: '0.4.0' });
  expect(ok.version).toBe('0.1.0');
  expect(() => bk.checkManifest({ kind: 'arigami-backup', format: 2, version: '0.1.0' }, { format: 1, version: '0.1.0' })).toThrow(/newer/);
  expect(() => bk.checkManifest({ kind: 'arigami-backup', format: 1, version: '2.0.0' }, { format: 1, version: '1.9.0' })).toThrow(/newer/);
  expect(() => bk.checkManifest({ kind: 'nope' })).toThrow(/not an Arigami backup/);
  expect(() => bk.checkManifest({ kind: 'arigami-backup', version: '1.0.0' })).toThrow(/format/);
  try { bk.checkManifest({ kind: 'arigami-backup', format: 9, version: '0.1.0' }); } catch (e) { expect((e as any).status).toBe(409); }
}, 60_000);

test('assertSafeEntries refuses absolute and parent-escaping paths', () => {
  bk.assertSafeEntries(['./config.json', 'memory/USER.md', 'a/..b/c']);
  expect(() => bk.assertSafeEntries(['../evil'])).toThrow(/unsafe/);
  expect(() => bk.assertSafeEntries(['./a/b/../c'])).toThrow(/unsafe/); // any ".." segment is refused, inside or not
  expect(() => bk.assertSafeEntries(['/etc/passwd'])).toThrow(/unsafe/);
  expect(() => bk.assertSafeEntries(['./ok', 'x/../../evil'])).toThrow(/unsafe/);
}, 60_000);

// Platform-bugs fix: tarArgs()'s --no-wildcards-match-slash/--wildcards-
// match-slash are GNU-tar-only. macOS/Windows ship BSD tar (libarchive),
// which rejects those flags — parseTarFlavor() is the pure classifier behind
// the runtime `tar --version` probe that decides whether to run (GNU,
// unchanged) or block with a clear reason (BSD/unknown) instead of silently
// building a wrong archive.
test('parseTarFlavor: classifies real-world `tar --version` banners', () => {
  expect(bk.parseTarFlavor('tar (GNU tar) 1.35\nCopyright (C) 2023 Free Software Foundation, Inc.')).toBe('gnu');
  expect(bk.parseTarFlavor('bsdtar 3.5.3 - libarchive 3.5.3 zlib/1.2.11 liblzma/5.2.5')).toBe('bsd');
  expect(bk.parseTarFlavor('tar (Busybox) 1.35.0')).toBe('unknown');
  expect(bk.parseTarFlavor('')).toBe('unknown');
});

test('bundleCronFromTrigger strips the bundle tag, existing:<session> mode and personal delivery', () => {
  const c = bk.bundleCronFromTrigger({ name: '[old-bundle] morning', prompt: 'hi', schedule: { kind: 'cron', value: '0 9 * * *' }, enabled: true, autonomous: true, sessionMode: 'existing:s1', deliver: { push: true, whatsapp: '1@s.whatsapp.net', master: 's1' } });
  expect(c).toEqual({ name: 'morning', key: 'exported-host/morning', prompt: 'hi', schedule: { kind: 'cron', value: '0 9 * * *' }, enabled: true, autonomous: true, deliver: { push: true } });
  // a trigger that came from a bundle keeps that bundle's key, whatever the export is called
  expect(bk.bundleCronFromTrigger({ name: '[solo-dev] standup', prompt: 'x', schedule: { kind: 'cron', value: '0 9 * * 1-5' }, bundleKey: 'solo-dev/standup' }, 'team-x').key).toBe('solo-dev/standup');
  expect(bk.cronBundleKey('exported-host', '[old] Morning Report!')).toBe('exported-host/morning-report');
  expect(bk.bundleCronFromTrigger({ name: 'x', prompt: 'p', schedule: { kind: 'interval', value: 3600 }, sessionMode: 'isolated' }).sessionMode).toBe('isolated');
}, 60_000);

test('bundleRepoFromEntry drops local env-file paths; portableSettings is an allow-list', () => {
  const r = bk.bundleRepoFromEntry({ name: 'a', source: 'github.com/x/a', branch: 'main', envSource: { kind: 'copy', files: ['/home/me/.env'] } });
  expect(r).toEqual({ name: 'a', source: 'github.com/x/a', branch: 'main' });
  expect(bk.bundleRepoFromEntry({ name: 'b', source: 's', envSource: { kind: 'command', value: 'vercel env pull' } }).envSource).toEqual({ kind: 'command', value: 'vercel env pull' });
  const s = bk.portableSettings({ defaultModel: 'sonnet', groqApiKey: 'gsk', composioApiKey: 'ck', publicUrl: 'https://example.com', voiceLang: 'he' });
  expect(s).toEqual({ defaultModel: 'sonnet', voiceLang: 'he' });
}, 60_000);

// ---- full export ------------------------------------------------------------------------

test('full export: manifest at the root, secrets kept as-is, run/chrome/logs/.bak excluded', () => {
  const dir = fakeInstance(path.join(tmp(), 'inst'));
  const out = path.join(tmp(), 'full.tgz');
  const r = runInChild(
    `const bk = await import('./server/backup.ts');
     const m = await bk.exportFullToFile(${JSON.stringify(out)});
     emit({ m, tmpLeft: (await import('node:fs')).readdirSync(${JSON.stringify(path.join(dir, 'tmp'))}) });`,
    { ARIGAMI_DIR: dir },
  );
  expect(r.ok).toBe(true);
  const { m, tmpLeft } = r.out[0];
  expect(m.kind).toBe('arigami-backup');
  expect(m.format).toBe(bk.BACKUP_FORMAT);
  expect(typeof m.version).toBe('string');
  expect(m.createdAt).toMatch(/^\d{4}-/);
  expect(m.host.platform).toBe(process.platform);
  expect(tmpLeft).toEqual([]); // scratch dir cleaned up
  const entries = tarList(out);
  expect(entries).toContain(bk.MANIFEST_NAME);
  for (const f of ['config.json', 'accounts.json', 'secrets.env', 'users.json', 'chat/s1.jsonl', 'memory/USER.md', 'skills/exported-skill/SKILL.md', 'uploads/a.txt', 'state.json', 'triggers.json'])
    expect(entries).toContain(f);
  expect(entries).toContain('uploads/keep-logs.txt');
  expect(entries).not.toContain('mcp-logs.txt');
  expect(entries).not.toContain('wa-logs.txt');
  // M1 (§4.5): mcpOAuth grants are machine-local plaintext — excluded wherever
  // they sit. The ownership records ride along; they hold no secret and the
  // capability check simply reports "needs authentication" on the new machine.
  expect(entries.filter((e) => e.endsWith('.credentials.json'))).toEqual([]);
  expect(entries).toContain('mcp-connections.json');
  expect(entries).toContain('agents/sales/connections.json');
  for (const bad of entries) {
    expect(bad.startsWith('run/') || bad === 'run').toBe(false);
    expect(bad.startsWith('chrome-sessions') || bad.startsWith('chrome-base') || bad.startsWith('logs') || bad.startsWith('tmp')).toBe(false);
    expect(/\.bak-/.test(bad)).toBe(false);
  }
}, 60_000);

test('full export --include limits the archive to the named top-level entries', () => {
  const dir = fakeInstance(path.join(tmp(), 'inst'));
  const out = path.join(tmp(), 'part.tgz');
  const r = runInChild(
    `const bk = await import('./server/backup.ts');
     emit(await bk.exportFullToFile(${JSON.stringify(out)}, { include: ['memory', 'skills', 'run', 'nope'] }));`,
    { ARIGAMI_DIR: dir },
  );
  expect(r.ok).toBe(true);
  expect(r.out[0].include).toEqual(['memory', 'skills', 'run', 'nope']);
  const entries = tarList(out);
  expect(entries).toContain('memory/USER.md');
  expect(entries).toContain('skills/exported-skill/SKILL.md');
  expect(entries).toContain(bk.MANIFEST_NAME);
  expect(entries.some((e) => e.startsWith('accounts') || e.startsWith('chat') || e.startsWith('run'))).toBe(false);
}, 60_000);

// ---- bundle export ------------------------------------------------------------------------

test('bundle export: profile.json + skills + memory-seed + cron + README, and NO secrets/chat/state', () => {
  const dir = fakeInstance(path.join(tmp(), 'inst'));
  const out = path.join(tmp(), 'bundle');
  const r = runInChild(
    `const bk = await import('./server/backup.ts');
     const tr = await import('./server/triggers.ts'); tr.load();
     const b = bk.exportBundle({ out: ${JSON.stringify(out)}, cron: tr.listTriggers() });
     const pf = await import('./server/profiles.ts');
     const loaded = pf.loadBundle(b.dir);
     emit({ b, v: pf.validate(loaded), manifest: loaded.manifest, skills: loaded.skills.map(s => s.name), cron: loaded.cron, seed: loaded.memorySeed, trusted: loaded.trusted });`,
    { ARIGAMI_DIR: dir },
  );
  expect(r.ok).toBe(true);
  const o = r.out[0];
  expect(o.b.name).toBe('exported-host');
  expect(o.b.skills).toEqual(['exported-skill']);
  expect(o.b.cron).toBe(1);
  expect(o.b.repos).toBe(1);
  expect(o.b.memorySeed).toEqual(['USER.md', 'MEMORY.md']);
  expect(o.v.ok).toBe(true);
  expect(o.trusted).toBe(false); // an exported bundle is external ⇒ skills go through proposals
  expect(o.manifest.repos).toEqual([{ name: 'demo-app', source: 'github.com/example/demo-app', branch: 'main', installCmd: 'bun install' }]);
  expect(o.manifest.settings).toEqual({ defaultModel: 'sonnet', voiceLang: 'en' });
  expect(JSON.stringify(o.manifest)).not.toMatch(/FAKE|gsk_|ck_|someone/);
  expect(o.cron).toEqual([{ name: 'morning', key: 'exported-host/morning', prompt: 'say hi', schedule: { kind: 'cron', value: '0 9 * * *' }, enabled: true, autonomous: true, deliver: { push: true } }]);
  expect(o.seed.user).toContain('Prefers tabs');

  // files on disk: whole skill dir copied, nothing else leaked
  const all: string[] = [];
  const walk = (d: string, rel = '') => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(rel, e.name); if (e.isDirectory()) walk(path.join(d, e.name), p); else all.push(p); } };
  walk(out);
  expect(all.sort()).toEqual(['README.md', 'cron.json', 'memory-seed/MEMORY.md', 'memory-seed/USER.md', 'profile.json', 'skills/exported-skill/SKILL.md', 'skills/exported-skill/notes.md']);
  for (const f of bk.SECRET_FILES) expect(all).not.toContain(f);
  expect(all.some((f) => /^(chat|uploads|run|state)/.test(f))).toBe(false);
  const readme = fs.readFileSync(path.join(out, 'README.md'), 'utf8');
  expect(readme).toContain('exported-skill');
  expect(readme).not.toMatch(/FAKE|someone/);

  // the tarball form, as the UI downloads it
  const tgz = path.join(tmp(), 'bundle.tgz');
  const r2 = runInChild(
    `const bk = await import('./server/backup.ts'); const fs = await import('node:fs');
     const t = bk.tarDir(${JSON.stringify(out)}, 'b.tgz'); const w = fs.createWriteStream(${JSON.stringify(tgz)}); t.stream.pipe(w);
     await t.done; await new Promise(r => w.on('finish', r)); emit((await bk.detectArchive(${JSON.stringify(tgz)})).kind);`,
    { ARIGAMI_DIR: dir },
  );
  expect(r2.ok).toBe(true);
  expect(r2.out[0]).toBe('bundle');
  const entries = tarList(tgz);
  for (const f of ['accounts.json', 'secrets.json', 'secrets.env', 'users.json', 'config.json', 'state.json', 'sessions.json']) expect(entries).not.toContain(f);
  expect(entries).toContain('profile.json');
}, 60_000);

test('bundle export: name is exported-host (or --name) — never the last applied bundle\'s provenance; --no-memory drops memory-seed/', () => {
  const dir = fakeInstance(path.join(tmp(), 'inst'));
  // an instance that had "il-whatsapp-business" applied last
  fs.writeFileSync(path.join(dir, 'profile.json'), JSON.stringify({ name: 'il-whatsapp-business', title: 'IL WA', appliedAt: 'x' }));
  const r = runInChild(
    `const bk = await import('./server/backup.ts'); const fs = await import('node:fs');
     const a = bk.exportBundle({ out: ${JSON.stringify(path.join(tmp(), 'a'))} }); const b = bk.exportBundle({ out: ${JSON.stringify(path.join(tmp(), 'b'))}, name: 'My Setup!' }); const c = bk.exportBundle({ out: ${JSON.stringify(path.join(tmp(), 'c'))}, memory: false });
     const cron = JSON.parse(fs.readFileSync(a.dir + '/cron.json', 'utf8'));
     emit({ a: { name: a.name, mf: JSON.parse(fs.readFileSync(a.dir + '/profile.json', 'utf8')), seed: a.memorySeed, warn: a.memoryWarning, readme: fs.readFileSync(a.dir + '/README.md', 'utf8'), cron },
            b: b.name, c: { seed: c.memorySeed, warn: c.memoryWarning, hasDir: fs.existsSync(c.dir + '/memory-seed'), readme: fs.readFileSync(c.dir + '/README.md', 'utf8') } });`,
    { ARIGAMI_DIR: dir },
  );
  expect(r.ok).toBe(true);
  const { a, b, c } = r.out[0];
  expect(a.name).toBe('exported-host');
  expect(a.mf.name).toBe('exported-host');
  expect(a.mf.title).not.toBe('IL WA');
  expect(b).toBe('my-setup');
  expect(a.seed).toEqual(['USER.md', 'MEMORY.md']);
  expect(a.warn).toBe(true);
  expect(a.readme).toMatch(/review before sharing/);
  expect(a.cron).toEqual([expect.objectContaining({ name: 'morning', key: 'exported-host/morning' })]);
  expect(c.seed).toEqual([]);
  expect(c.warn).toBe(false);
  expect(c.hasDir).toBe(false);
  expect(c.readme).not.toMatch(/review before sharing/);
}, 60_000);

test('full export of a multi-MB dir returns promptly (file finish before tar close must not hang)', async () => {
  // F4 #1: on a big archive the write stream finished BEFORE tar's close
  // settled `done`; the CLI then awaited a 'finish' that had already fired.
  const dir = fakeInstance(path.join(tmp(), 'inst'));
  fs.mkdirSync(path.join(dir, 'uploads'), { recursive: true });
  for (let i = 0; i < 4; i++) fs.writeFileSync(path.join(dir, 'uploads', `blob${i}.bin`), Buffer.from(Array.from({ length: 2 * 1024 * 1024 }, () => (Math.random() * 256) | 0)));
  const out = path.join(tmp(), 'big.tgz');
  const tgz = path.join(tmp(), 'bundle.tgz');
  const t0 = Date.now();
  const r = runInChild(
    `const bk = await import('./server/backup.ts'); const tr = await import('./server/triggers.ts'); tr.load();
     const m = await bk.exportFullToFile(${JSON.stringify(out)});
     const b = bk.exportBundle({ cron: tr.listTriggers() }); const t = bk.tarDir(b.dir, 'bundle.tgz');
     const code = await bk.exportToFile(t, ${JSON.stringify(tgz)}); t.cleanup();
     emit({ kind: m.kind, code });`,
    { ARIGAMI_DIR: dir },
  );
  expect(r.ok).toBe(true);
  expect(r.out[0]).toEqual({ kind: 'arigami-backup', code: 0 });
  expect(Date.now() - t0).toBeLessThan(20_000); // the child harness times out at 30 s; the old code hung forever
  expect(fs.statSync(out).size).toBeGreaterThan(4 * 1024 * 1024);
  expect((await bk.detectArchive(tgz)).kind).toBe('bundle');
}, 60_000);

test('bundle export refuses to write inside $ARIGAMI_DIR (other than tmp/)', () => {
  const dir = fakeInstance(path.join(tmp(), 'inst'));
  const r = runInChild(
    `const bk = await import('./server/backup.ts');
     let e1 = ''; try { bk.exportBundle({ out: ${JSON.stringify(path.join(dir, 'skills'))} }); } catch (e) { e1 = e.message; }
     const ok = bk.exportBundle({}); emit({ e1, okDir: ok.dir });`,
    { ARIGAMI_DIR: dir },
  );
  expect(r.ok).toBe(true);
  expect(r.out[0].e1).toMatch(/refusing/);
  expect(r.out[0].okDir.startsWith(path.join(dir, 'tmp'))).toBe(true);
}, 60_000);

// ---- round trip: export bundle → profile apply on a fresh instance ---------------------------

test('round-trip: an exported bundle applies on a clean instance (repos, skill proposal, memory seed, disabled cron)', () => {
  const src = fakeInstance(path.join(tmp(), 'src'));
  const out = path.join(tmp(), 'bundle');
  const r1 = runInChild(
    `const bk = await import('./server/backup.ts'); const tr = await import('./server/triggers.ts'); tr.load();
     emit(bk.exportBundle({ out: ${JSON.stringify(out)}, cron: tr.listTriggers() }));`,
    { ARIGAMI_DIR: src },
  );
  expect(r1.ok).toBe(true);

  const dst = path.join(tmp(), 'dst');
  fs.mkdirSync(dst, { recursive: true });
  const r2 = runInChild(
    `const pf = await import('./server/profiles.ts'); const tr = await import('./server/triggers.ts'); tr.load();
     const rep = await pf.applySource(${JSON.stringify(out)}); tr.flush();
     const fs = await import('node:fs'); const path = await import('node:path');
     const sp = await import('./server/skill-proposals.ts');
     const pending = sp.listProposals().filter(p => p.status === 'pending').map(p => ({ name: p.name, content: fs.readFileSync(path.join(sp.PROPOSALS_DIR, p.id, 'content.md'), 'utf8') }));
     emit({ rep, repos: JSON.parse(fs.readFileSync(path.join(${JSON.stringify(dst)}, 'repos.json'), 'utf8')),
            user: fs.readFileSync(path.join(${JSON.stringify(dst)}, 'memory/USER.md'), 'utf8'),
            memory: fs.readFileSync(path.join(${JSON.stringify(dst)}, 'memory/MEMORY.md'), 'utf8'),
            triggers: tr.listTriggers().filter(t => t.type === 'cron').map(t => ({ name: t.name, enabled: t.enabled, prompt: t.prompt, autonomous: t.autonomous })),
            pending, prov: JSON.parse(fs.readFileSync(path.join(${JSON.stringify(dst)}, 'profile.json'), 'utf8')).name,
            leaked: ['accounts.json','secrets.env','users.json','state.json','chat'].filter(f => fs.existsSync(path.join(${JSON.stringify(dst)}, f))) });`,
    { ARIGAMI_DIR: dst },
  );
  expect(r2.ok).toBe(true);
  const o = r2.out[0];
  expect(o.rep.errors).toEqual([]);
  expect(o.rep.repos).toEqual(['demo-app']);
  expect(o.repos.map((x: any) => x.name)).toEqual(['demo-app']);
  expect(o.repos[0].envSource).toBeUndefined();
  expect(o.rep.skills).toEqual([{ name: 'exported-skill', status: 'pending', proposalId: expect.any(String) }]);
  expect(o.pending).toEqual([{ name: 'exported-skill', content: SKILL }]);
  expect(o.user).toContain('Prefers tabs');
  expect(o.memory).toContain('test project uses bun');
  expect(o.triggers).toEqual([{ name: '[exported-host] morning', enabled: false, prompt: 'say hi', autonomous: false }]);
  expect(o.prov).toBe('exported-host');
  expect(o.leaked).toEqual([]);

  // re-exporting the applied instance keeps the cron name un-nested (tag stripped again)
  const r3 = runInChild(
    `const bk = await import('./server/backup.ts'); const tr = await import('./server/triggers.ts'); tr.load();
     const b = bk.exportBundle({ cron: tr.listTriggers() }); const fs = await import('node:fs');
     emit(JSON.parse(fs.readFileSync(b.dir + '/cron.json', 'utf8')).map(c => c.name));`,
    { ARIGAMI_DIR: dst },
  );
  expect(r3.ok).toBe(true);
  expect(r3.out[0]).toEqual(['morning']);
}, 60_000);

test('round-trip is idempotent for cron: apply → export → import into the SAME instance leaves the trigger count unchanged', () => {
  const dir = fakeInstance(path.join(tmp(), 'inst')); // has one hand-made cron "[old-bundle] morning"
  const bundle = path.join(tmp(), 'bundle');
  const r = runInChild(
    `const pf = await import('./server/profiles.ts'); const tr = await import('./server/triggers.ts'); const bk = await import('./server/backup.ts'); tr.load();
     const cron = () => tr.listTriggers().filter(t => t.type === 'cron').map(t => ({ name: t.name, key: t.bundleKey, enabled: t.enabled, prompt: t.prompt })).sort((a, b) => a.name.localeCompare(b.name));
     // 1. apply the shipped solo-dev bundle → +1 trigger "[solo-dev] standup"
     const a1 = await pf.applySource('solo-dev'); const after1 = cron();
     // 2. export this instance, 3. import the export back into the same instance
     const b = bk.exportBundle({ out: ${JSON.stringify(bundle)}, cron: tr.listTriggers() });
     const a2 = await pf.applySource(b.dir); const after2 = cron();
     // 4. and once more, with a changed schedule in the bundle → update in place
     const fs = await import('node:fs'); const cj = JSON.parse(fs.readFileSync(b.dir + '/cron.json', 'utf8'));
     cj.find(c => c.name === 'standup').schedule.value = '0 10 * * 1-5'; fs.writeFileSync(b.dir + '/cron.json', JSON.stringify(cj));
     const a3 = await pf.applySource(b.dir); const after3 = cron(); tr.flush();
     emit({ errs: [...a1.errors, ...a2.errors, ...a3.errors], after1, after2, after3, exported: cj.map(c => ({ name: c.name, key: c.key })), sched: tr.listTriggers().find(t => t.name === '[solo-dev] standup').schedule.value, prov: JSON.parse(fs.readFileSync(${JSON.stringify(path.join(dir, 'profile.json'))}, 'utf8')).name });`,
    { ARIGAMI_DIR: dir },
  );
  expect(r.ok).toBe(true);
  const o = r.out[0];
  expect(o.errs).toEqual([]);
  expect(o.after1.map((c: any) => c.name)).toEqual(['[old-bundle] morning', '[solo-dev] standup']);
  expect(o.after1.find((c: any) => c.name === '[solo-dev] standup').key).toBe('solo-dev/standup');
  expect(o.exported).toEqual([{ name: 'morning', key: 'exported-host/morning' }, { name: 'standup', key: 'solo-dev/standup' }]);
  // re-import: same two triggers, nothing added; the hand-made one picked up a bundleKey, tags were kept
  expect(o.after2.map((c: any) => c.name)).toEqual(['[old-bundle] morning', '[solo-dev] standup']);
  expect(o.after2.map((c: any) => c.key)).toEqual(['exported-host/morning', 'solo-dev/standup']);
  expect(o.after3.length).toBe(2);
  expect(o.sched).toBe('0 10 * * 1-5'); // updated in place
  expect(o.prov).toBe('exported-host');
}, 60_000);

// ---- import -------------------------------------------------------------------------------------

function makeArchive(files: Record<string, string>, manifest: unknown, extraTar: string[] = []): string {
  const root = tmp('arigami-arch-');
  const src = path.join(root, 'src');
  fs.mkdirSync(src, { recursive: true });
  for (const [rel, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(src, rel)), { recursive: true }); fs.writeFileSync(path.join(src, rel), c); }
  if (manifest !== undefined) fs.writeFileSync(path.join(src, bk.MANIFEST_NAME), JSON.stringify(manifest));
  const out = path.join(root, 'a.tgz');
  const r = spawnSync('tar', ['-czf', out, '-C', src, '.', ...extraTar], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  return out;
}

const goodManifest = (over: Record<string, unknown> = {}) => ({ kind: 'arigami-backup', format: bk.BACKUP_FORMAT, version: '0.0.1', commit: 'abc', createdAt: 'now', host: {}, include: null, excludes: [], ...over });

test('import refuses a newer major version / newer format / non-backup / unsafe paths', async () => {
  const newer = makeArchive({ 'config.json': '{}' }, goodManifest({ version: '99.0.0' }));
  await expect(bk.readManifestFromArchive(newer)).rejects.toThrow(/newer than this host/);
  const fmt = makeArchive({ 'config.json': '{}' }, goodManifest({ format: bk.BACKUP_FORMAT + 1 }));
  await expect(bk.readManifestFromArchive(fmt)).rejects.toThrow(/newer than this host/);
  const none = makeArchive({ 'config.json': '{}' }, undefined);
  await expect(bk.readManifestFromArchive(none)).rejects.toThrow(/not an Arigami backup/);
  await expect(bk.detectArchive(none)).rejects.toThrow(/neither/);
  // a bundle archive is recognised as such
  const bundle = makeArchive({ 'profile.json': '{"name":"x"}' }, undefined);
  expect((await bk.detectArchive(bundle)).kind).toBe('bundle');
  // an entry escaping the root
  const root = tmp('arigami-esc-');
  fs.mkdirSync(path.join(root, 'in'));
  fs.writeFileSync(path.join(root, 'evil'), 'x');
  fs.writeFileSync(path.join(root, 'in', bk.MANIFEST_NAME), JSON.stringify(goodManifest()));
  const esc = path.join(root, 'esc.tgz');
  spawnSync('tar', ['-P', '-czf', esc, '-C', path.join(root, 'in'), '.', '../evil']);
  await expect(bk.readManifestFromArchive(esc)).rejects.toThrow(/unsafe path/);
}, 60_000);

test('importFull: stop-the-world guard (409 unless force)', async () => {
  const arch = makeArchive({ 'config.json': '{"a":1}' }, goodManifest());
  const dir = path.join(tmp(), 'inst');
  fakeInstance(dir);
  let status = 0;
  try { await bk.importFull(arch, { dir, busyCount: () => 2 }); } catch (e) { status = (e as any).status; expect((e as Error).message).toMatch(/2 session\(s\) are working/); }
  expect(status).toBe(409);
  expect(fs.readFileSync(path.join(dir, 'accounts.json'), 'utf8')).toContain('FAKE'); // untouched
  const r = await bk.importFull(arch, { dir, busyCount: () => 2, force: true });
  expect(r.restartRequired).toBe(true);
  expect(JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'))).toEqual({ a: 1 });
}, 60_000);

test('importFull: restores, keeps a timestamped .bak of the previous dir, carries run/ over, records the manifest', async () => {
  const dir = path.join(tmp(), 'inst');
  fakeInstance(dir);
  const arch = makeArchive(
    { 'config.json': '{"restored":true}', 'memory/USER.md': '- restored user\n', 'accounts.json': '{"from":"backup"}', 'run/host.pid': '999', 'chrome-sessions/x': 'y' },
    goodManifest({ version: '0.0.9' }),
  );
  const now = new Date('2026-08-30T12:34:56Z');
  const r = await bk.importFull(arch, { dir, busyCount: () => 0, now: () => now });
  expect(r.manifest.version).toBe('0.0.9');
  expect(r.restoredTo).toBe(dir);
  expect(r.backupDir).toBe(`${dir}.bak-20260830T123456Z`);
  expect(fs.existsSync(r.backupDir!)).toBe(true);
  // previous data intact in the .bak
  expect(fs.readFileSync(path.join(r.backupDir!, 'accounts.json'), 'utf8')).toContain('FAKE');
  expect(fs.existsSync(path.join(r.backupDir!, 'chat/s1.jsonl'))).toBe(true);
  // new data in place
  expect(JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'))).toEqual({ restored: true });
  expect(fs.readFileSync(path.join(dir, 'memory/USER.md'), 'utf8')).toBe('- restored user\n');
  expect(fs.readFileSync(path.join(dir, 'accounts.json'), 'utf8')).toContain('backup');
  expect(fs.existsSync(path.join(dir, 'chat/s1.jsonl'))).toBe(false);
  // run/ is THIS host's, not the archive's; chrome-sessions from the archive are dropped
  expect(fs.readFileSync(path.join(dir, 'run/host.pid'), 'utf8')).toBe('12345');
  expect(fs.existsSync(path.join(dir, 'chrome-sessions'))).toBe(false);
  // manifest kept as provenance
  const kept = JSON.parse(fs.readFileSync(path.join(dir, bk.MANIFEST_NAME), 'utf8'));
  expect(kept.version).toBe('0.0.9');
  expect(kept.importedAt).toMatch(/^\d{4}-/);
  // staging dir gone
  expect(fs.readdirSync(path.dirname(dir)).filter((n) => n.includes('.import-'))).toEqual([]);
  // a second restore makes a second .bak and doesn't clobber the first
  const r2 = await bk.importFull(arch, { dir, busyCount: () => 0, now: () => new Date('2026-08-30T12:35:00Z') });
  expect(r2.backupDir).toBe(`${dir}.bak-20260830T123500Z`);
  expect(fs.existsSync(r.backupDir!)).toBe(true);
}, 60_000);

test('importFull into a missing dir just creates it', async () => {
  const dir = path.join(tmp(), 'fresh');
  const arch = makeArchive({ 'config.json': '{"x":1}' }, goodManifest());
  const r = await bk.importFull(arch, { dir, busyCount: () => 0 });
  expect(r.backupDir).toBeNull();
  expect(fs.existsSync(path.join(dir, 'config.json'))).toBe(true);
}, 60_000);

test('full export → importFull round-trips a whole instance', async () => {
  const src = fakeInstance(path.join(tmp(), 'src'));
  const out = path.join(tmp(), 'full.tgz');
  const r = runInChild(`const bk = await import('./server/backup.ts'); emit(await bk.exportFullToFile(${JSON.stringify(out)}));`, { ARIGAMI_DIR: src });
  expect(r.ok).toBe(true);
  const dst = path.join(tmp(), 'dst');
  await bk.importFull(out, { dir: dst, busyCount: () => 0 });
  for (const f of ['config.json', 'accounts.json', 'secrets.env', 'users.json', 'chat/s1.jsonl', 'memory/USER.md', 'memory/memory.sqlite', 'skills/exported-skill/SKILL.md', 'uploads/a.txt', 'state.json', 'triggers.json', 'repos.json'])
    expect(fs.readFileSync(path.join(dst, f), 'utf8')).toBe(fs.readFileSync(path.join(src, f), 'utf8'));
  expect(fs.existsSync(path.join(dst, 'chrome-sessions'))).toBe(false);
  expect(fs.existsSync(path.join(dst, 'logs'))).toBe(false);
}, 60_000);

// ---- ARIGAMI_TAR=js (dispatch/js-tar) ------------------------------------------------------------
// The pure-JS tar (server/lib/tar.ts) behind the ARIGAMI_TAR=js flag — its own
// unit tests live in test/tar-js.test.ts (glob-exclude parity with real GNU
// tar, byte-level create/extract interop). These prove it end-to-end through
// backup.ts's public API: the exact same fixtures/assertions as the system-tar
// tests above, just with the flag on, so a regression in the wiring (not the
// tar engine itself) shows up here.

test('ARIGAMI_TAR=js: full export → importFull round-trips a whole instance, same as the system-tar path', async () => {
  const src = fakeInstance(path.join(tmp(), 'src'));
  const out = path.join(tmp(), 'full-js.tgz');
  const r = runInChild(`const bk = await import('./server/backup.ts'); emit(await bk.exportFullToFile(${JSON.stringify(out)}));`, { ARIGAMI_DIR: src, ARIGAMI_TAR: 'js' });
  expect(r.ok).toBe(true);
  // the archive itself is real GNU-tar-openable, not just JS-readable
  expect(tarList(out)).toContain(bk.MANIFEST_NAME);

  const dst = path.join(tmp(), 'dst-js');
  const prev = process.env.ARIGAMI_TAR;
  process.env.ARIGAMI_TAR = 'js';
  try {
    await bk.importFull(out, { dir: dst, busyCount: () => 0 });
  } finally {
    if (prev === undefined) delete process.env.ARIGAMI_TAR; else process.env.ARIGAMI_TAR = prev;
  }
  for (const f of ['config.json', 'accounts.json', 'secrets.env', 'users.json', 'chat/s1.jsonl', 'memory/USER.md', 'memory/memory.sqlite', 'skills/exported-skill/SKILL.md', 'uploads/a.txt', 'state.json', 'triggers.json', 'repos.json'])
    expect(fs.readFileSync(path.join(dst, f), 'utf8')).toBe(fs.readFileSync(path.join(src, f), 'utf8'));
  expect(fs.existsSync(path.join(dst, 'chrome-sessions'))).toBe(false);
  expect(fs.existsSync(path.join(dst, 'logs'))).toBe(false);
  expect(fs.existsSync(path.join(dst, '.credentials.json'))).toBe(false);
}, 60_000);

test('ARIGAMI_TAR=js: bundle export → tarDir → unpackBundle round-trips (and the tarball opens with real tar)', async () => {
  const dir = fakeInstance(path.join(tmp(), 'inst'));
  const tgz = path.join(tmp(), 'bundle-js.tgz');
  const r = runInChild(
    `const bk = await import('./server/backup.ts'); const tr = await import('./server/triggers.ts'); tr.load();
     const b = bk.exportBundle({ cron: tr.listTriggers() }); const t = bk.tarDir(b.dir, 'b.tgz');
     const code = await bk.exportToFile(t, ${JSON.stringify(tgz)}); t.cleanup();
     emit({ code, kind: (await bk.detectArchive(${JSON.stringify(tgz)})).kind });`,
    { ARIGAMI_DIR: dir, ARIGAMI_TAR: 'js' },
  );
  expect(r.ok).toBe(true);
  expect(r.out[0]).toEqual({ code: 0, kind: 'bundle' });
  expect(tarList(tgz)).toContain('profile.json'); // real GNU tar can read what we wrote

  const dst = path.join(tmp(), 'dst-bundle-js');
  fs.mkdirSync(dst, { recursive: true });
  const r2 = runInChild(
    `const bk = await import('./server/backup.ts'); const pf = await import('./server/profiles.ts'); const tr = await import('./server/triggers.ts'); tr.load();
     const u = await bk.unpackBundle(${JSON.stringify(tgz)}); const rep = await pf.applySource(u.dir); tr.flush();
     emit(rep);`,
    { ARIGAMI_DIR: dst, ARIGAMI_TAR: 'js' },
  );
  expect(r2.ok).toBe(true);
  expect(r2.out[0].errors).toEqual([]);
  expect(r2.out[0].repos).toEqual(['demo-app']);
}, 60_000);

test('ARIGAMI_TAR=js: an archive made by real system tar (an old, pre-migration backup) still imports correctly', async () => {
  const dir = path.join(tmp(), 'inst');
  fakeInstance(dir);
  const arch = makeArchive(
    { 'config.json': '{"restored":true}', 'memory/USER.md': '- restored user\n', 'run/host.pid': '999', 'chrome-sessions/x': 'y' },
    goodManifest({ version: '0.0.9' }),
  );
  const prev = process.env.ARIGAMI_TAR;
  process.env.ARIGAMI_TAR = 'js';
  let r: Awaited<ReturnType<typeof bk.importFull>>;
  try {
    r = await bk.importFull(arch, { dir, busyCount: () => 0 });
  } finally {
    if (prev === undefined) delete process.env.ARIGAMI_TAR; else process.env.ARIGAMI_TAR = prev;
  }
  expect(r.manifest.version).toBe('0.0.9');
  expect(JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'))).toEqual({ restored: true });
  expect(fs.readFileSync(path.join(dir, 'memory/USER.md'), 'utf8')).toBe('- restored user\n');
  // run/ from the archive is dropped in favor of this host's own — same exclude semantics as the system-tar path
  expect(fs.existsSync(path.join(dir, 'chrome-sessions'))).toBe(false);
}, 60_000);

test('non-GNU system tar: the JS implementation is used automatically instead of the old hard block (base-branch regression: this used to throw "needs GNU tar")', () => {
  const fakeBinDir = tmp('fake-bsdtar-');
  // A stand-in for macOS/Windows' tar: answers --version like libarchive's
  // bsdtar, and hard-fails anything else so this test proves the real `tar`
  // binary is never invoked for the actual archive work.
  fs.writeFileSync(
    path.join(fakeBinDir, 'tar'),
    '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "bsdtar 3.5.3 - libarchive 3.5.3 zlib/1.2.11"; exit 0; fi\necho "FAKE TAR MUST NOT BE INVOKED FOR ARCHIVE OPS: $*" >&2\nexit 99\n'
  );
  fs.chmodSync(path.join(fakeBinDir, 'tar'), 0o755);
  const dir = fakeInstance(path.join(tmp(), 'inst'));
  const ROOT = path.resolve(import.meta.dir, '..');
  const env = { ...process.env, PATH: `${fakeBinDir}:${process.env.PATH}`, ARIGAMI_DIR: dir };
  delete (env as any).ARIGAMI_TAR; // no explicit flag — only the non-GNU tar should trigger the JS fallback
  const full = path.join(tmp(), 'nongnu.tgz');
  const r = spawnSync('bun', ['server/backup.ts', 'export', '--full', full], { cwd: ROOT, encoding: 'utf8', env, timeout: 30_000 });
  expect(r.stderr).not.toMatch(/needs GNU tar/);
  expect(r.stderr).not.toMatch(/FAKE TAR MUST NOT BE INVOKED/);
  expect(r.status).toBe(0);
  const parsed = JSON.parse(r.stdout);
  expect(parsed.ok).toBe(true);
  // produced with the fake tar poisoning PATH — verify with the REAL system tar (absolute path), unpoisoned
  const realTar = spawnSync('/usr/bin/tar', ['-tzf', full], { encoding: 'utf8' });
  expect(realTar.status).toBe(0);
  expect(realTar.stdout).toMatch(new RegExp(bk.MANIFEST_NAME.replace('.', '\\.')));

  const inspect = spawnSync('bun', ['server/backup.ts', 'inspect', full], { cwd: ROOT, encoding: 'utf8', env, timeout: 30_000 });
  expect(inspect.status).toBe(0);
  expect(JSON.parse(inspect.stdout).kind).toBe('full');
}, 60_000);

// ---- B4 backup portability: WhatsApp auth, keychain accounts, cross-platform config paths ---------

test('sanitizeAccountsForExport: marks keychain accounts needsReauth (renamed off "keychain" so seed() can adopt a real login elsewhere), clears activeId when it pointed there, leaves oauth-token and no-op shapes untouched', () => {
  const raw = {
    activeId: 'kc1',
    accounts: [
      { id: 'kc1', type: 'keychain', label: 'Default (macOS login)', pool: true, addedAt: 'x' },
      { id: 'tok1', type: 'oauth-token', label: 'Work', pool: true, token: { v: 0, t: 'sk-ant-x' } },
    ],
  };
  const out = bk.sanitizeAccountsForExport(raw);
  expect(out.activeId).toBeNull();
  expect(out.accounts[0]).toEqual({ id: 'kc1', type: 'keychain-stale', label: 'Default (macOS login)', pool: false, addedAt: 'x', needsReauth: true });
  expect(out.accounts[1]).toBe(raw.accounts[1]); // oauth-token untouched, same reference
  // no keychain account at all → nothing to rewrite, same top-level reference
  const noKeychain = { activeId: 'tok1', accounts: [raw.accounts[1]] };
  expect(bk.sanitizeAccountsForExport(noKeychain)).toBe(noKeychain);
  // an activeId pointing elsewhere survives untouched
  const other = { activeId: 'tok1', accounts: [raw.accounts[0], raw.accounts[1]] };
  expect(bk.sanitizeAccountsForExport(other).activeId).toBe('tok1');
  // malformed/foreign shape (e.g. the test fixture's accounts.json) passes through as-is
  const malformed = { claude: { token: 'x' } };
  expect(bk.sanitizeAccountsForExport(malformed)).toBe(malformed);
  expect(bk.sanitizeAccountsForExport(null)).toBeNull();
}, 60_000);

test('resolveConfigPathsForImport: drops absolute reposDir/defaultCwd only on a genuine cross-platform import; tilde paths, same-platform imports and archives with no host.platform are untouched', () => {
  const other = process.platform === 'linux' ? 'darwin' : 'linux';
  const raw = { reposDir: '/Users/owner/Desktop/repos', defaultCwd: '~/.arigami/workspace', port: 3099 };
  const resolved = bk.resolveConfigPathsForImport(raw, other)!;
  expect(resolved.reposDir).toBeUndefined();
  expect(resolved.defaultCwd).toBe('~/.arigami/workspace'); // portable already — left alone
  expect(resolved.port).toBe(3099);
  expect(bk.resolveConfigPathsForImport(raw, process.platform)).toBe(raw); // same platform — untouched
  expect(bk.resolveConfigPathsForImport(raw, undefined)).toBe(raw); // no host.platform recorded — treated as "same", not "different"
  expect(bk.resolveConfigPathsForImport(raw, '')).toBe(raw);
  const onlyTilde = { reposDir: '~/repos', defaultCwd: '~/work' };
  expect(bk.resolveConfigPathsForImport(onlyTilde, other)).toBe(onlyTilde); // nothing absolute to drop
  // a Windows-shaped absolute path is recognized even when this test runs on POSIX
  const win = { reposDir: 'C:\\Users\\owner\\repos' };
  expect(bk.resolveConfigPathsForImport(win, other)!.reposDir).toBeUndefined();
}, 60_000);

test('full export: WhatsApp auth (whatsapp/auth_info) excluded by default; whatsapp:true opts in and returns the "will log out" warning', () => {
  const dir = fakeInstance(path.join(tmp(), 'inst'));
  fs.mkdirSync(path.join(dir, 'whatsapp', 'auth_info'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'whatsapp', 'auth_info', 'creds.json'), '{"me":{"id":"972500000000@s.whatsapp.net"}}');
  const outDefault = path.join(tmp(), 'no-wa.tgz');
  const outOpt = path.join(tmp(), 'with-wa.tgz');
  const r = runInChild(
    `const bk = await import('./server/backup.ts');
     const a = bk.exportFull({});
     await bk.exportToFile(a, ${JSON.stringify(outDefault)}); a.cleanup();
     const b = bk.exportFull({ whatsapp: true });
     await bk.exportToFile(b, ${JSON.stringify(outOpt)}); b.cleanup();
     emit({ warningsA: a.warnings, warningsB: b.warnings });`,
    { ARIGAMI_DIR: dir },
  );
  expect(r.ok).toBe(true);
  expect(r.out[0].warningsA).toEqual([]);
  expect(r.out[0].warningsB.length).toBe(1);
  expect(r.out[0].warningsB[0]).toMatch(/one linked device/);
  const entriesDefault = tarList(outDefault);
  expect(entriesDefault.some((e) => e.startsWith('whatsapp/auth_info'))).toBe(false);
  const entriesOpt = tarList(outOpt);
  expect(entriesOpt).toContain('whatsapp/auth_info/creds.json');
}, 60_000);

test('importFull: WhatsApp auth in the archive is skipped by default (whatsappSkipped=true, protects the target\'s own live pairing); whatsapp:true restores it', async () => {
  const arch = makeArchive({ 'config.json': '{"a":1}', 'whatsapp/auth_info/creds.json': '{"me":{}}' }, goodManifest());
  const dir1 = path.join(tmp(), 'inst1');
  const r1 = await bk.importFull(arch, { dir: dir1, busyCount: () => 0 });
  expect(r1.whatsappSkipped).toBe(true);
  expect(fs.existsSync(path.join(dir1, 'whatsapp', 'auth_info', 'creds.json'))).toBe(false);
  const dir2 = path.join(tmp(), 'inst2');
  const r2 = await bk.importFull(arch, { dir: dir2, busyCount: () => 0, whatsapp: true });
  expect(r2.whatsappSkipped).toBe(false);
  expect(fs.existsSync(path.join(dir2, 'whatsapp', 'auth_info', 'creds.json'))).toBe(true);
  // an archive with no WhatsApp auth at all reports nothing skipped
  const clean = makeArchive({ 'config.json': '{}' }, goodManifest());
  const r3 = await bk.importFull(clean, { dir: path.join(tmp(), 'inst3'), busyCount: () => 0 });
  expect(r3.whatsappSkipped).toBe(false);
}, 60_000);

test('full export: a migrated skills symlink ($ARIGAMI_DIR/skills → user/skills) is left out of a default export — extensions.ts rebuilds it every boot; the real content under user/skills still ships; an explicit --include skills is a deliberate ask and is kept', () => {
  const dir = path.join(tmp(), 'inst');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), '{}');
  fs.mkdirSync(path.join(dir, 'user', 'skills', 'real-skill'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'user', 'skills', 'real-skill', 'SKILL.md'), SKILL);
  fs.symlinkSync(path.join(dir, 'user', 'skills'), path.join(dir, 'skills'), 'dir');
  const out = path.join(tmp(), 'sym.tgz');
  const r = runInChild(`const bk = await import('./server/backup.ts'); emit(await bk.exportFullToFile(${JSON.stringify(out)}));`, { ARIGAMI_DIR: dir });
  expect(r.ok).toBe(true);
  const entries = tarList(out);
  expect(entries).not.toContain('skills');
  expect(entries).toContain('user/skills/real-skill/SKILL.md');

  const out2 = path.join(tmp(), 'sym-include.tgz');
  const r2 = runInChild(
    `const bk = await import('./server/backup.ts'); emit(await bk.exportFullToFile(${JSON.stringify(out2)}, { include: ['skills'] }));`,
    { ARIGAMI_DIR: dir },
  );
  expect(r2.ok).toBe(true);
  expect(tarList(out2)).toContain('skills');
}, 60_000);

test('full export: accounts.json in a real archive ships with keychain accounts marked needsReauth (not just the pure function)', () => {
  const dir = path.join(tmp(), 'inst');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), '{}');
  fs.writeFileSync(
    path.join(dir, 'accounts.json'),
    JSON.stringify({
      activeId: 'acc_kc',
      accounts: [
        { id: 'acc_kc', type: 'keychain', label: 'Default (macOS login)', pool: true, addedAt: 'x' },
        { id: 'acc_tok', type: 'oauth-token', label: 'Work', pool: true, token: { v: 0, t: 'sk-ant-fake' } },
      ],
    }),
  );
  const out = path.join(tmp(), 'acct.tgz');
  const r = runInChild(`const bk = await import('./server/backup.ts'); emit(await bk.exportFullToFile(${JSON.stringify(out)}));`, { ARIGAMI_DIR: dir });
  expect(r.ok).toBe(true);
  const staging = path.join(tmp(), 'extracted-acct');
  fs.mkdirSync(staging, { recursive: true });
  spawnSync('tar', ['-xzf', out, '-C', staging]);
  const written = JSON.parse(fs.readFileSync(path.join(staging, 'accounts.json'), 'utf8'));
  expect(written.activeId).toBeNull();
  expect(written.accounts[0]).toEqual({ id: 'acc_kc', type: 'keychain-stale', label: 'Default (macOS login)', pool: false, addedAt: 'x', needsReauth: true });
  expect(written.accounts[1]).toEqual({ id: 'acc_tok', type: 'oauth-token', label: 'Work', pool: true, token: { v: 0, t: 'sk-ant-fake' } });
}, 60_000);

test('importFull: an absolute reposDir/defaultCwd from a DIFFERENT-platform archive is dropped (config.ts falls back to its own default); same-platform archives are untouched', async () => {
  const other = process.platform === 'linux' ? 'darwin' : 'linux';
  const cfg = JSON.stringify({ reposDir: '/Users/owner/Desktop/repos', defaultCwd: '~/.arigami/workspace', port: 3099 });
  const archCross = makeArchive({ 'config.json': cfg }, goodManifest({ host: { platform: other } }));
  const dirCross = path.join(tmp(), 'cross');
  await bk.importFull(archCross, { dir: dirCross, busyCount: () => 0 });
  const gotCross = JSON.parse(fs.readFileSync(path.join(dirCross, 'config.json'), 'utf8'));
  expect(gotCross.reposDir).toBeUndefined();
  expect(gotCross.defaultCwd).toBe('~/.arigami/workspace');
  expect(gotCross.port).toBe(3099);

  const archSame = makeArchive({ 'config.json': cfg }, goodManifest({ host: { platform: process.platform } }));
  const dirSame = path.join(tmp(), 'same');
  await bk.importFull(archSame, { dir: dirSame, busyCount: () => 0 });
  const gotSame = JSON.parse(fs.readFileSync(path.join(dirSame, 'config.json'), 'utf8'));
  expect(gotSame.reposDir).toBe('/Users/owner/Desktop/repos');
}, 60_000);

test('bun server/backup.ts export --full --whatsapp / import --whatsapp CLI flags', () => {
  const dir = fakeInstance(path.join(tmp(), 'inst'));
  fs.mkdirSync(path.join(dir, 'whatsapp', 'auth_info'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'whatsapp', 'auth_info', 'creds.json'), '{}');
  const ROOT = path.resolve(import.meta.dir, '..');
  const run = (args: string[], env: Record<string, string> = {}) =>
    spawnSync('bun', ['server/backup.ts', ...args], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ARIGAMI_DIR: dir, ...env }, timeout: 30_000 });

  const withWa = path.join(tmp(), 'cli-wa.tgz');
  let r = run(['export', '--full', withWa, '--whatsapp']);
  expect(r.status).toBe(0);
  expect(tarList(withWa)).toContain('whatsapp/auth_info/creds.json');

  const noWa = path.join(tmp(), 'cli-no-wa.tgz');
  r = run(['export', '--full', noWa]);
  expect(r.status).toBe(0);
  expect(tarList(noWa).some((e) => e.startsWith('whatsapp/auth_info'))).toBe(false);

  const dst = path.join(tmp(), 'cli-dst-default');
  fs.mkdirSync(dst);
  r = run(['import', withWa], { ARIGAMI_DIR: dst });
  expect(r.status).toBe(0);
  expect(JSON.parse(r.stdout).whatsappSkipped).toBe(true);
  expect(fs.existsSync(path.join(dst, 'whatsapp', 'auth_info', 'creds.json'))).toBe(false);

  const dst2 = path.join(tmp(), 'cli-dst-wa');
  fs.mkdirSync(dst2);
  r = run(['import', withWa, '--whatsapp'], { ARIGAMI_DIR: dst2 });
  expect(r.status).toBe(0);
  expect(JSON.parse(r.stdout).whatsappSkipped).toBe(false);
  expect(fs.existsSync(path.join(dst2, 'whatsapp', 'auth_info', 'creds.json'))).toBe(true);
}, 60_000);

// ---- CLI ----------------------------------------------------------------------------------------

test('bun server/backup.ts export/inspect/import CLI', () => {
  const dir = fakeInstance(path.join(tmp(), 'inst'));
  const ROOT = path.resolve(import.meta.dir, '..');
  const run = (args: string[], env: Record<string, string> = {}) => spawnSync('bun', ['server/backup.ts', ...args], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ARIGAMI_DIR: dir, ...env }, timeout: 30_000 });
  const full = path.join(tmp(), 'cli.tgz');
  let r = run(['export', '--full', full]);
  expect(r.status).toBe(0);
  expect(JSON.parse(r.stdout).manifest.kind).toBe('arigami-backup');
  r = run(['inspect', full]);
  expect(JSON.parse(r.stdout).kind).toBe('full');
  const bundle = path.join(tmp(), 'cli-bundle.tgz');
  r = run(['export', '--bundle', bundle, '--name', 'My Setup']);
  expect(r.status).toBe(0);
  expect(JSON.parse(r.stdout).name).toBe('my-setup');
  expect(tarList(bundle)).toContain('profile.json');
  expect(tarList(bundle)).not.toContain('accounts.json');
  r = run(['inspect', bundle]);
  expect(JSON.parse(r.stdout).kind).toBe('bundle');
  // import a newer-major backup → exit 3
  const newer = makeArchive({ 'config.json': '{}' }, goodManifest({ version: '99.0.0' }));
  r = run(['import', newer]);
  expect(r.status).toBe(3);
  expect(r.stderr).toMatch(/newer/);
  // import a bundle applies it (fresh dir)
  const dst = path.join(tmp(), 'dst');
  fs.mkdirSync(dst);
  r = run(['import', bundle], { ARIGAMI_DIR: dst });
  expect(r.status).toBe(0);
  const rep = JSON.parse(r.stdout);
  expect(rep.kind).toBe('bundle');
  expect(rep.repos).toEqual(['demo-app']);
  expect(fs.existsSync(path.join(dst, 'profiles', 'my-setup', 'profile.json'))).toBe(true);
  r = run([]);
  expect(r.status).toBe(2);
}, 60_000);

// A restored session carries the absolute folder it was created in. Import a
// Linux VPS onto a Mac and every one of them reads /home/arigami/repos, which
// is nowhere here — and spawning claude with a cwd that does not exist fails
// with ENOENT naming the BINARY, not the folder ("claude failed to start:
// ENOENT … posix_spawn '/…/claude'"). Reported live.
test('localizeSessionsForImport: clears folders that do not exist here and every stale Claude conversation id, keeps what is real, and leaves a same-platform restore alone', () => {
  const other = process.platform === 'linux' ? 'darwin' : 'linux';
  const here = tmp('arigami-cwd-'); // a folder that really is on this machine

  const write = () => {
    const dir = tmp('arigami-staging-');
    fs.writeFileSync(
      path.join(dir, 'state.json'),
      JSON.stringify({
        sessions: [
          { id: 'a', cwd: '/home/arigami/repos', claude: { sessionId: 'a2ce2c55-cad9-45dd-b7eb-7f457bf21b33', modelChoice: 'opus' } },
          { id: 'b', cwd: here },
          { id: 'c', cwd: '~/repos' },
          { id: 'd', cwd: '/home/arigami/repos', metadata: { worktree: '/home/arigami/repos/.dispatch-worktrees/x', agent: 'chief' } },
          { id: 'e' },
        ],
      }, null, 2),
    );
    return dir;
  };

  const dir = write();
  expect(bk.localizeSessionsForImport(dir, other)).toEqual({ cwds: 3, conversations: 1 }); // a.cwd, d.cwd, d.metadata.worktree
  const out = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).sessions;
  expect(out[0].cwd).toBeUndefined();
  expect(out[1].cwd).toBe(here); // exists → kept
  expect(out[2].cwd).toBe('~/repos'); // tilde is this host's home already
  expect(out[3].cwd).toBeUndefined();
  expect(out[3].metadata.worktree).toBeUndefined();
  expect(out[3].metadata.agent).toBe('chief'); // only the path keys are touched
  expect(out[4].cwd).toBeUndefined();
  // the conversation lives in ~/.claude, which no backup carries — resuming it
  // here only produces "No conversation found with session ID: …"
  expect(out[0].claude.sessionId).toBeNull();
  expect(out[0].claude.modelChoice).toBe('opus'); // only the id is dropped

  // same platform, and an archive with no host.platform: byte-identical
  const same = write();
  const before = fs.readFileSync(path.join(same, 'state.json'), 'utf8');
  expect(bk.localizeSessionsForImport(same, process.platform)).toEqual({ cwds: 0, conversations: 0 });
  expect(bk.localizeSessionsForImport(same, null)).toEqual({ cwds: 0, conversations: 0 });
  expect(fs.readFileSync(path.join(same, 'state.json'), 'utf8')).toBe(before);
});
