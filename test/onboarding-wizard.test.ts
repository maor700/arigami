// B3 — wizard state machine + funnel file. onboarding.ts captures CONFIG_DIR at
// import, so every case runs in a fresh child with its own ARIGAMI_DIR
// (test/_child.js). Probes are injected — no gh / claude / host needed.
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runInChild } from './_child.js';

const fresh = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-wiz-'));
const env = (dir: string, extra: Record<string, string> = {}) => ({
  ARIGAMI_DIR: dir,
  ARIGAMI_FUNNEL_QUIET: '1',
  HOME: path.join(dir, 'home'),
  ...extra,
});

// Probes that make NOTHING pass — the "fresh container" baseline.
const NONE =
  "const probes={hasAdmin:()=>false,claudeCli:()=>true,claudeAuth:()=>false,gitAuth:()=>false," +
  "profileApplied:()=>null,pendingProfile:()=>null,integrations:()=>({composio:false,whatsapp:'disconnected',tailscale:false})," +
  "repos:()=>[],health:()=>undefined,unattended:()=>false,telemetry:()=>({enabled:false,reason:'config'})};";

const readFunnel = (dir: string): any[] =>
  fs.existsSync(path.join(dir, 'funnel.jsonl'))
    ? fs.readFileSync(path.join(dir, 'funnel.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    : [];

test('fresh instance: every step todo, current=pair, not done; one funnel event per step', () => {
  const dir = fresh();
  const r = runInChild(
    `const ob=await import('./server/onboarding.js');${NONE}` +
      'const v1=ob.wizard(probes);const v2=ob.wizard(probes);emit({v1,v2});',
    env(dir)
  );
  expect(r.ok).toBe(true);
  const { v1, v2 } = r.out[0];
  expect(v1.steps.map((s: any) => s.id)).toEqual(['pair', 'claude', 'git', 'profile', 'integrations', 'repo', 'telemetry', 'health']);
  expect(v1.current).toBe('pair');
  expect(v1.done).toBe(false);
  expect(v1.steps.every((s: any) => s.status === 'todo')).toBe(true);
  expect(v1.steps.find((s: any) => s.id === 'pair').skippable).toBe(false);
  expect(v1.steps.find((s: any) => s.id === 'claude').skippable).toBe(false);
  expect(v1.steps.find((s: any) => s.id === 'git').skippable).toBe(true);
  // Second read = same view, and NO new events (emitted once per transition).
  expect(v2.steps.map((s: any) => s.status)).toEqual(v1.steps.map((s: any) => s.status));
  const ev = readFunnel(dir);
  expect(ev.filter((e) => e.name === 'onboarding.step').length).toBe(8);
  expect(ev.every((e) => typeof e.at === 'string' && e.step && e.status)).toBe(true);
  // onboarding.json persisted with the emitted map.
  const file = JSON.parse(fs.readFileSync(path.join(dir, 'onboarding.json'), 'utf8'));
  expect(file.version).toBe(1);
  expect(Object.keys(file.emitted).length).toBe(8);
});

test('probe-ok wins, skip/complete records persist, done flips exactly once', () => {
  const dir = fresh();
  const r = runInChild(
    `const ob=await import('./server/onboarding.js');${NONE}` +
      "probes.hasAdmin=()=>true;probes.claudeAuth=()=>true;" +
      "const a=ob.wizard(probes);" +
      "let threw=false;try{ob.wizardAct('claude','skip','user',probes);}catch{threw=true;}" +
      "const b=ob.wizardAct('git','skip','user',probes);" +
      "ob.wizardAct('profile','skip','user',probes);ob.wizardAct('integrations','complete','user',probes);" +
      "ob.wizardAct('repo','skip','user',probes);ob.wizardAct('telemetry','skip','user',probes);" +
      "const c=ob.wizardAct('health','skip','user',probes);" +
      "const d=ob.wizard(probes);" +
      "let bad=false;try{ob.wizardAct('nope','skip');}catch{bad=true;}" +
      "emit({a:a.current,threw,bStatus:b.steps.find(s=>s.id==='git').status,c,d,bad});",
    env(dir)
  );
  expect(r.ok).toBe(true);
  const o = r.out[0];
  expect(o.a).toBe('git'); // pair + claude satisfied by probes
  expect(o.threw).toBe(true); // claude is not skippable
  expect(o.bStatus).toBe('skipped');
  expect(o.c.done).toBe(true);
  expect(o.c.current).toBe(null);
  expect(o.c.completedAt).toBeTruthy();
  expect(o.d.done).toBe(true);
  expect(o.bad).toBe(true);
  const ev = readFunnel(dir);
  expect(ev.filter((e) => e.name === 'onboarding.done').length).toBe(1);
  const gitEv = ev.filter((e) => e.name === 'onboarding.step' && e.step === 'git').map((e) => e.status);
  expect(gitEv).toEqual(['todo', 'skipped']);
  // Records survive a fresh import (new process).
  const r2 = runInChild(
    `const ob=await import('./server/onboarding.js');${NONE}probes.hasAdmin=()=>true;probes.claudeAuth=()=>true;emit(ob.wizard(probes));`,
    env(dir)
  );
  expect(r2.ok).toBe(true);
  expect(r2.out[0].done).toBe(true);
  expect(r2.out[0].steps.find((s: any) => s.id === 'repo').status).toBe('skipped');
  expect(r2.out[0].steps.find((s: any) => s.id === 'repo').by).toBe('user');
  // No new events on the re-read.
  expect(readFunnel(dir).length).toBe(ev.length);
});

test('reset forgets decisions but probes still decide', () => {
  const dir = fresh();
  const r = runInChild(
    `const ob=await import('./server/onboarding.js');${NONE}probes.hasAdmin=()=>true;probes.claudeAuth=()=>true;probes.repos=()=>['app'];` +
      "for(const s of ['git','profile','integrations','telemetry','health'])ob.wizardAct(s,'skip','user',probes);" +
      "const before=ob.wizard(probes);const after=ob.wizardReset(probes);emit({before:before.done,after});",
    env(dir)
  );
  expect(r.ok).toBe(true);
  expect(r.out[0].before).toBe(true);
  expect(r.out[0].after.done).toBe(false);
  expect(r.out[0].after.current).toBe('git');
  expect(r.out[0].after.steps.find((s: any) => s.id === 'repo').status).toBe('ok'); // probe
});

test('unattended pre-completes skippable steps only; pairing stays open', () => {
  const dir = fresh();
  const r = runInChild(
    `const ob=await import('./server/onboarding.js');${NONE}probes.unattended=()=>true;probes.claudeAuth=()=>true;` +
      "const v=ob.unattendedPrecomplete(probes);" +
      "probes.hasAdmin=()=>true;const v2=ob.wizard(probes);emit({v,v2});",
    env(dir)
  );
  expect(r.ok).toBe(true);
  const { v, v2 } = r.out[0];
  expect(v.unattended).toBe(true);
  expect(v.done).toBe(false);
  expect(v.current).toBe('pair');
  for (const id of ['git', 'profile', 'integrations', 'repo', 'telemetry', 'health']) {
    const s = v.steps.find((x: any) => x.id === id);
    expect(s.status).toBe('skipped');
    expect(s.by).toBe('unattended');
  }
  expect(v2.done).toBe(true); // the moment pairing lands
  // Not unattended → a no-op (null).
  const r2 = runInChild(`const ob=await import('./server/onboarding.js');${NONE}emit({v:ob.unattendedPrecomplete(probes)});`, env(fresh()));
  expect(r2.out[0].v).toBe(null);
});

test('health: injected deps → result persisted; claude failure fails the step', () => {
  const dir = fresh();
  const r = runInChild(
    `const ob=await import('./server/onboarding.js');${NONE}probes.hasAdmin=()=>true;probes.claudeAuth=()=>true;` +
      "const good=await ob.runHealth({claudePing:async()=>'pong',desktopDisplay:()=>null,chromeVersion:()=>null,whatsapp:()=>'disconnected',screenEnabled:()=>false});" +
      "const v=ob.wizard({...probes,health:()=>ob.readOnboardingFile().health});" +
      "const bad=await ob.runHealth({claudePing:async()=>{throw new Error('Not logged in')},desktopDisplay:()=>':99',chromeVersion:()=>'Chrome 1',whatsapp:()=>'connected',screenEnabled:()=>true});" +
      "emit({good,v:v.steps.find(s=>s.id==='health'),bad});",
    env(dir)
  );
  expect(r.ok).toBe(true);
  const { good, v, bad } = r.out[0];
  expect(good.ok).toBe(true);
  expect(good.checks.map((c: any) => c.id)).toEqual(['claude', 'desktop', 'chrome', 'whatsapp']);
  expect(v.status).toBe('ok');
  expect(bad.ok).toBe(false);
  expect(bad.checks.find((c: any) => c.id === 'claude').detail).toMatch(/Not logged in/);
  expect(bad.checks.find((c: any) => c.id === 'desktop').required).toBe(true);
  const file = JSON.parse(fs.readFileSync(path.join(dir, 'onboarding.json'), 'utf8'));
  expect(file.health.ok).toBe(false);
});

test('funnel: firstTime is idempotent across processes; readEvents parses the file', () => {
  const dir = fresh();
  const body = "const f=await import('./server/funnel.js');emit({first:f.firstTime('session.first'),again:f.firstTime('session.first'),n:f.readEvents().length});";
  const a = runInChild(body, env(dir));
  const b = runInChild(body, env(dir));
  expect(a.out[0]).toEqual({ first: true, again: false, n: 1 });
  expect(b.out[0]).toEqual({ first: false, again: false, n: 1 });
  const ev = readFunnel(dir);
  expect(ev).toHaveLength(1);
  expect(ev[0].name).toBe('session.first');
});

test('git token → ~/.git-credentials (0600, one line per host); junk rejected', () => {
  const dir = fresh();
  fs.mkdirSync(path.join(dir, 'home'), { recursive: true });
  const r = runInChild(
    "const ob=await import('./server/onboarding.js');const fs=await import('node:fs');const path=await import('node:path');" +
      "let junk=false;try{ob.setGitToken('short');}catch{junk=true;}" +
      "const r1=ob.setGitToken('ghp_0123456789abcdefghijklmnopqrstuv');const r2=ob.setGitToken('ghp_ZZZZ56789abcdefghijklmnopqrstuvwx');" +
      "const txt=fs.readFileSync(r2.file,'utf8');const mode=fs.statSync(r2.file).mode&0o777;emit({junk,txt,mode,gh:process.env.GH_TOKEN});",
    env(dir)
  );
  expect(r.ok).toBe(true);
  const o = r.out[0];
  expect(o.junk).toBe(true);
  expect(o.txt.trim().split('\n')).toHaveLength(1); // same host replaced, not appended
  expect(o.txt).toContain('x-access-token:ghp_ZZZZ');
  expect(o.mode).toBe(0o600);
  expect(o.gh).toBe('ghp_ZZZZ56789abcdefghijklmnopqrstuvwx');
});

test('doctor output lists the same steps in order', () => {
  const r = runInChild(
    `const ob=await import('./server/onboarding.js');${NONE}emit({txt:ob.formatDoctor(ob.wizard(probes))});`,
    env(fresh())
  );
  const lines = r.out[0].txt.split('\n');
  expect(lines.slice(0, 8).map((l: string) => l.trim().split(/\s+/)[1])).toEqual(['pair', 'claude', 'git', 'profile', 'integrations', 'repo', 'telemetry', 'health']);
  expect(lines[8]).toContain('current step → pair');
});
