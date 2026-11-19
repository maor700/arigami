// github_checkout (extensions/gatekeeper): a restricted session gets the ONE configured repo's source into its own
// directory from the gatekeeper's mirror — no token in the checkout, no tokenized remote, nothing outside its dir, no
// other repo — and github_push still works from that checkout. End to end in a child process (the gatekeeper's store
// dir is fixed at import), with a local bare repo standing in for GitHub.
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runInChild } from './_child.js';
import { tmpDir } from './_tmp.js';

const git = (args: string[], cwd?: string) => {
  const r = spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

test('checkout, refuse other repo / outside paths, no token in .git, refresh by bundle, push from the checkout', () => {
  const root = tmpDir('gk-co-');
  const web = path.join(root, 'web');
  const upstream = path.join(web, 'o', 'app.git');
  const work = path.join(root, 'work', 's1');
  const outside = path.join(root, 'outside');
  const gk = path.join(root, 'gk');
  for (const d of [path.dirname(upstream), work, outside, gk]) fs.mkdirSync(d, { recursive: true });
  // "GitHub": a bare repo with main, a feature branch and a tag
  const seed = path.join(root, 'seed');
  git(['init', '-q', seed]);
  fs.writeFileSync(path.join(seed, 'README.md'), 'app v1\n');
  git(['add', '-A'], seed);
  git(['commit', '-qm', 'v1'], seed);
  git(['tag', 'v1'], seed);
  git(['checkout', '-qb', 'feature'], seed);
  fs.writeFileSync(path.join(seed, 'feature.txt'), 'f\n');
  git(['add', '-A'], seed);
  git(['commit', '-qm', 'feature'], seed);
  git(['checkout', '-q', 'main'], seed);
  git(['clone', '-q', '--bare', seed, upstream]);
  fs.symlinkSync(outside, path.join(work, 'escape'));
  const TOKEN = 'ghs_CANARYTOKENcheckout0000000000';

  const body = `
    const crypto = await import('node:crypto');
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { execFileSync } = await import('node:child_process');
    const gk = process.env.GK, work = process.env.WORK, web = process.env.WEB;
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    fs.writeFileSync(path.join(gk, 'identities.json'), JSON.stringify({ github: { appId: '1', installationId: '2', privateKey: privateKey.export({ type: 'pkcs1', format: 'pem' }) } }));
    fs.writeFileSync(path.join(gk, 'config.json'), JSON.stringify({ github: { repo: 'o/app', apiUrl: 'https://gh.test', webUrl: 'file://' + web } }));
    const svc = await import('./extensions/gatekeeper/lib/services.ts');
    svc.setFetch(async (url) => {
      const u = String(url);
      const ok = (j) => new Response(JSON.stringify(j), { status: 200, headers: { 'content-type': 'application/json' } });
      if (u.includes('/access_tokens')) return ok({ token: process.env.TOKEN, expires_at: new Date(Date.now() + 3600e3).toISOString() });
      if (u.endsWith('/repos/o/app')) return ok({ full_name: 'o/app', default_branch: 'main' });
      return new Response('{}', { status: 404 });
    });
    const mod = await import('./extensions/gatekeeper/tools/module.ts');
    const tool = (n) => mod._test.sessionTools.find((t) => t.name === n);
    const caller = (grants) => ({ session: 's1', shared: true, hostCall: false, profile: { name: 'r', grants: grants.map((g) => 'gatekeeper:' + g), parent: null }, lineage: [], cwd: work });
    const run = async (n, a, grants = ['github.read', 'github.push']) => {
      const r = await tool(n).run(a, { caller: caller(grants) });
      return r;
    };
    const g = (args, cwd) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' }).trim();
    emit({ k: 'noGrant', r: await run('github_checkout', {}, ['github.push']) });
    emit({ k: 'otherRepo', r: await run('github_checkout', { repo: 'o/gitops' }) });
    emit({ k: 'dotdot', r: await run('github_checkout', { path: '../outside/x' }) });
    emit({ k: 'abs', r: await run('github_checkout', { path: process.env.OUTSIDE + '/y' }) });
    emit({ k: 'symlink', r: await run('github_checkout', { path: 'escape/z' }) });
    emit({ k: 'fresh', r: await run('github_checkout', {}) });
    emit({ k: 'tag', r: await run('github_checkout', { ref: 'v1', path: 'at-tag' }) });
    emit({ k: 'branch', r: await run('github_checkout', { ref: 'feature', path: 'feat' }) });
    fs.mkdirSync(path.join(work, 'busy')); fs.writeFileSync(path.join(work, 'busy', 'keep.txt'), 'mine');
    emit({ k: 'busy', r: await run('github_checkout', { path: 'busy' }) });
    // work in the checkout, push it back through the gatekeeper
    const co = path.join(work, 'app');
    g(['checkout', '-qb', 'fix/x'], co);
    fs.writeFileSync(path.join(co, 'fix.txt'), 'fixed\\n');
    g(['add', '-A'], co); g(['commit', '-qm', 'fix'], co);
    emit({ k: 'push', r: await run('github_push', { branch: 'fix/x', path: 'app' }) });
    // upstream moves on; a second checkout call refreshes by bundle and the session fetches it itself
    const up2 = path.join(process.env.ROOT, 'seed');
    fs.writeFileSync(path.join(up2, 'README.md'), 'app v2\\n'); g(['commit', '-qam', 'v2'], up2); g(['push', '-q', path.join(web, 'o', 'app.git'), 'main'], up2);
    const again = await run('github_checkout', {});
    emit({ k: 'refresh', r: again });
    execFileSync('sh', ['-c', again.next], { cwd: work });
    emit({ k: 'after', originMain: g(['rev-parse', 'origin/main'], co), upstreamMain: g(['--git-dir', path.join(web, 'o', 'app.git'), 'rev-parse', 'main']) });
    emit({ k: 'cfg', config: fs.readFileSync(path.join(co, '.git', 'config'), 'utf8'), url: g(['remote', 'get-url', 'origin'], co) });
  `;
  const out = runInChild(body, { GK: gk, GATEKEEPER_DIR: gk, WORK: work, WEB: web, OUTSIDE: outside, TOKEN, ROOT: root });
  expect(out.error).toBeUndefined();
  const by = Object.fromEntries((out.out as any[]).map((o) => [o.k, o]));
  // refusals
  expect(by.noGrant.r).toMatchObject({ ok: false, decision: 'refused' });
  expect(by.otherRepo.r.ok).toBe(false);
  expect(by.otherRepo.r.error).toMatch(/only the configured repo o\/app/);
  for (const k of ['dotdot', 'abs', 'symlink']) {
    expect(by[k].r.ok).toBe(false);
    expect(by[k].r.error).toMatch(/inside the session's own directory/);
  }
  expect(fs.readdirSync(outside)).toEqual([]);
  // the checkouts
  expect(by.fresh.r).toMatchObject({ ok: true, created: true, path: 'app', branch: 'main' });
  expect(fs.readFileSync(path.join(work, 'app', 'README.md'), 'utf8')).toBe('app v1\n');
  expect(by.tag.r).toMatchObject({ ok: true, branch: null });
  expect(fs.existsSync(path.join(work, 'feat', 'feature.txt'))).toBe(true);
  expect(by.busy.r.ok).toBe(false);
  expect(fs.readFileSync(path.join(work, 'busy', 'keep.txt'), 'utf8')).toBe('mine');
  // no token anywhere in the session's tree, a plain remote, no credential config
  const all: string[] = [];
  const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.isFile()) all.push(p); } };
  walk(path.join(work, 'app'));
  for (const f of all) expect(fs.readFileSync(f).includes(TOKEN)).toBe(false);
  expect(by.cfg.url).toBe(`file://${web}/o/app.git`);
  expect(by.cfg.config).not.toMatch(/extraheader|credential|x-access-token|ghs_/i);
  // push from the checkout, refresh by bundle
  expect(by.push.r).toMatchObject({ ok: true, branch: 'fix/x' });
  expect(git(['--git-dir', upstream, 'rev-parse', 'fix/x'])).toBe(git(['-C', path.join(work, 'app'), 'rev-parse', 'fix/x']));
  expect(by.refresh.r).toMatchObject({ ok: true, refreshed: true });
  expect(by.after.originMain).toBe(by.after.upstreamMain);
});
