// Registered-but-not-cloned repos: the clone job's git credentials, add-existing, the wizard's repo step,
// and the background clone after a profile apply. Each case runs in a fresh child (own ARIGAMI_DIR / HOME).
// Remotes are local bare repos reached through file:// — no network.
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runInChild } from './_child.js';

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-rc-'));
const env = (dir: string, extra: Record<string, string> = {}) => ({
  ARIGAMI_DIR: dir,
  ARIGAMI_FUNNEL_QUIET: '1',
  ARIGAMI_ONBOARDING_MODE: 'full',
  HOME: path.join(dir, 'home'),
  GH_TOKEN: '',
  GITHUB_TOKEN: '',
  ARIGAMI_GIT_TOKEN: '',
  ...extra,
});
const git = (cwd: string, ...a: string[]) =>
  spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=T', ...a], { cwd, encoding: 'utf8' });

/** A bare repo with one commit, usable as file://<path>. */
function bareRemote(base: string, name: string): string {
  const work = path.join(base, `${name}-work`);
  const bare = path.join(base, `${name}.git`);
  fs.mkdirSync(work, { recursive: true });
  git(work, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(work, 'README.md'), `# ${name}\n`);
  git(work, 'add', '.');
  git(work, 'commit', '-q', '-m', 'init');
  spawnSync('git', ['clone', '-q', '--bare', work, bare]);
  return `file://${bare}`;
}
const NONE =
  "const probes={hasAdmin:()=>true,claudeCli:()=>true,claudeAuth:()=>true,codexCli:()=>true,codexAuth:()=>false,gitAuth:()=>false," +
  "profileApplied:()=>null,pendingProfile:()=>null,integrations:()=>({composio:false,whatsapp:'disconnected',tailscale:false})," +
  "health:()=>undefined,unattended:()=>false,telemetry:()=>({enabled:false,reason:'config'})};";

test('the clone job runs with the read-only git token in its env (never in argv)', () => {
  const dir = tmp();
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const out = path.join(dir, 'git-seen.txt');
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\n{ env; echo "ARGV: $@"; } > "${out}"\nexit 0\n`, { mode: 0o755 });
  const r = runInChild(
    "const ob=await import('./server/onboarding.js');" +
      "ob.addRepo({name:'widgets',source:'https://github.com/acme/widgets.git'});" +
      "ob.cloneRepo('widgets');await ob.jobFor('widgets','clone').done;emit(1);",
    env(dir, { PATH: `${bin}:${process.env.PATH}`, ARIGAMI_GIT_TOKEN: 'tok_example_123' })
  );
  expect(r.ok).toBe(true);
  const seen = fs.readFileSync(out, 'utf8');
  expect(seen).toContain('GIT_CONFIG_KEY_0=http.https://github.com/.extraheader');
  expect(seen).toContain(`AUTHORIZATION: basic ${Buffer.from('x-access-token:tok_example_123').toString('base64')}`);
  expect(seen).toContain('GIT_TERMINAL_PROMPT=0');
  expect(seen.split('ARGV:')[1]).not.toContain('tok_example_123');
});

test('a private https repo with no git access fails with "connect GitHub first", not a raw git error', () => {
  const dir = tmp();
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\necho "fatal: could not read Username for 'https://github.com': terminal prompts disabled" >&2\nexit 128\n`, { mode: 0o755 });
  const r = runInChild(
    "const ob=await import('./server/onboarding.js');" +
      "ob.addRepo({name:'secret',source:'acme/secret'});" +
      "ob.cloneRepo('secret');await ob.jobFor('secret','clone').done;emit(ob.repoStatuses()[0]);",
    env(dir, { PATH: `${bin}:${process.env.PATH}` })
  );
  expect(r.ok).toBe(true);
  const s = r.out[0];
  expect(s.state).toBe('failed');
  expect(s.errorCode).toBe('git_auth_missing');
  expect(s.error).toContain('connect GitHub first');
  expect(s.error).not.toContain('terminal prompts');
});

test('adding an already-registered repo is not an error: clones when missing, says so when present', () => {
  const dir = tmp();
  const remote = bareRemote(dir, 'lib');
  const r = runInChild(
    "const ob=await import('./server/onboarding.js');" +
      `const e={name:'lib',source:${JSON.stringify(remote)}};` +
      "const first=ob.addOrClone(e);emit({existing:first.existing,state:first.state});" +
      "const second=ob.addOrClone(e);emit({existing:second.existing,state:second.state,started:second.clone?.started});" +
      "await ob.jobFor('lib','clone').done;" +
      "const third=ob.addOrClone(e);emit({existing:third.existing,state:third.state,present:third.present});",
    env(dir)
  );
  expect(r.ok).toBe(true);
  expect(r.out[0]).toEqual({ existing: false, state: 'not_cloned' });
  expect(r.out[1]).toEqual({ existing: true, state: 'cloning', started: true });
  expect(r.out[2]).toEqual({ existing: true, state: 'cloned', present: true });
});

test('wizard repo step: registered-but-not-cloned is NOT done; a cloned repo or a skip is', () => {
  const dir = tmp();
  const remote = bareRemote(dir, 'app');
  const r = runInChild(
    "const ob=await import('./server/onboarding.js');" + NONE +
      `ob.addRepo({name:'app',source:${JSON.stringify(remote)}});` +
      "const step=()=>ob.wizard(probes).steps.find(s=>s.id==='repo');" +
      "const a=step();emit({status:a.status,data:a.data});" +
      "ob.cloneRepo('app');await ob.jobFor('app','clone').done;const b=step();emit({status:b.status,present:b.data.present});" +
      "ob.removeRepo('app');ob.addRepo({name:'later',source:'file:///nonexistent/x.git'});ob.wizardAct('repo','skip','user',probes);emit(step().status);",
    env(dir)
  );
  expect(r.ok).toBe(true);
  expect(r.out[0].status).toBe('todo');
  expect(r.out[0].data).toEqual({ repos: ['app'], present: [] });
  expect(r.out[1]).toEqual({ status: 'ok', present: ['app'] });
  expect(r.out[2]).toBe('skipped');
});

test('profile apply clones registered repos in the background; a second apply does not re-clone', () => {
  const dir = tmp();
  const a = bareRemote(dir, 'alpha');
  const b = bareRemote(dir, 'beta');
  const bundle = path.join(dir, 'bundle');
  fs.mkdirSync(bundle);
  fs.writeFileSync(
    path.join(bundle, 'profile.json'),
    JSON.stringify({ name: 'acme-team', version: '1.0.0', title: 'Acme', repos: [{ name: 'alpha', source: a }, { name: 'beta', source: b }] })
  );
  const r = runInChild(
    "const ob=await import('./server/onboarding.js');const pf=await import('./server/profiles.js');" +
      `const rep=await pf.applySource(${JSON.stringify(bundle)});` +
      "emit({applied:rep.repos,errors:rep.errors});" +
      "await ob.backgroundCloneIdle();emit(ob.repoStatuses().map(s=>[s.name,s.state]));" +
      "const startedAt=ob.jobFor('alpha','clone').startedAt;" +
      `await pf.applySource(${JSON.stringify(bundle)});await ob.backgroundCloneIdle();` +
      "emit({same:ob.jobFor('alpha','clone').startedAt===startedAt});",
    env(dir)
  );
  expect(r.ok).toBe(true);
  expect(r.out[0]).toEqual({ applied: ['alpha', 'beta'], errors: [] });
  expect(r.out[1]).toEqual([['alpha', 'cloned'], ['beta', 'cloned']]);
  expect(r.out[2].same).toBe(true);
});

test('profile apply with no git access leaves remote repos registered-not-cloned; the opt-out is honoured', () => {
  const dir = tmp();
  const bundle = path.join(dir, 'bundle');
  fs.mkdirSync(bundle);
  fs.writeFileSync(path.join(bundle, 'profile.json'), JSON.stringify({ name: 'acme-team', version: '1.0.0', title: 'Acme', repos: [{ name: 'widgets', source: 'https://github.com/acme/widgets.git' }] }));
  const noAccess = runInChild(
    "const ob=await import('./server/onboarding.js');const pf=await import('./server/profiles.js');" +
      `await pf.applySource(${JSON.stringify(bundle)});await ob.backgroundCloneIdle();emit(ob.repoStatuses()[0].state);emit(ob.jobFor('widgets','clone')===undefined);`,
    env(dir)
  );
  expect(noAccess.out).toEqual(['not_cloned', true]);

  const dir2 = tmp();
  const remote = bareRemote(dir2, 'solo');
  const b2 = path.join(dir2, 'bundle');
  fs.mkdirSync(b2);
  fs.writeFileSync(path.join(b2, 'profile.json'), JSON.stringify({ name: 'acme-team', version: '1.0.0', title: 'Acme', repos: [{ name: 'solo', source: remote }] }));
  const off = runInChild(
    "const ob=await import('./server/onboarding.js');const pf=await import('./server/profiles.js');" +
      `await pf.applySource(${JSON.stringify(b2)});await ob.backgroundCloneIdle();emit(ob.repoStatuses()[0].state);`,
    env(dir2, { ARIGAMI_PROFILE_AUTOCLONE: '0' })
  );
  expect(off.out).toEqual(['not_cloned']);
});
