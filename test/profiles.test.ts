// K3 profile bundles (server/profiles.ts): validation, source resolution,
// memory-seed merge (append, never overwrite), skill staging via M3
// proposals (shipped+new ⇒ applied, external ⇒ pending, existing skill ⇒
// pending even when shipped), disabled-by-default cron, provenance and the
// installer → wizard `pending-profile` hand-off.
//
// Pure helpers run in-process. Anything touching ARIGAMI_DIR (apply) runs in a
// child with its own dir (see test/_child.js) because server modules capture
// ARIGAMI_DIR at import time. Skills land in the git-tracked <repo>/skills, so
// every apply test uses a unique throwaway skill name and removes it in finally.
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runInChild } from './_child.js';

const pf = await import('../server/profiles.ts');
const ROOT = path.resolve(import.meta.dir, '..');
const tmp = (p = 'arigami-pf-') => fs.mkdtempSync(path.join(os.tmpdir(), p));

function writeBundle(dir: string, opts: { name?: string; skill?: { name: string; content: string }; memory?: string; user?: string; cron?: unknown; manifest?: Record<string, unknown> } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'profile.json'), JSON.stringify({ name: opts.name || 'test-bundle', version: '1.0.0', ...(opts.manifest || {}) }));
  fs.writeFileSync(path.join(dir, 'README.md'), '# test bundle\n');
  if (opts.skill) {
    fs.mkdirSync(path.join(dir, 'skills', opts.skill.name), { recursive: true });
    fs.writeFileSync(path.join(dir, 'skills', opts.skill.name, 'SKILL.md'), opts.skill.content);
  }
  if (opts.memory || opts.user) {
    fs.mkdirSync(path.join(dir, 'memory-seed'), { recursive: true });
    if (opts.memory) fs.writeFileSync(path.join(dir, 'memory-seed', 'MEMORY.md'), opts.memory);
    if (opts.user) fs.writeFileSync(path.join(dir, 'memory-seed', 'USER.md'), opts.user);
  }
  if (opts.cron) fs.writeFileSync(path.join(dir, 'cron.json'), JSON.stringify(opts.cron));
  return dir;
}

const SKILL = '---\ndescription: a throwaway test skill\n---\n\n# T\n\nbody\n';

// ---- pure ------------------------------------------------------------------------

test('shipped solo-dev bundle loads, validates and is trusted', () => {
  const b = pf.loadBundle(path.join(ROOT, 'profiles', 'bundles', 'solo-dev'));
  const v = pf.validate(b);
  expect(v.ok).toBe(true);
  expect(v.errors).toEqual([]);
  expect(b.trusted).toBe(true);
  expect(b.manifest.name).toBe('solo-dev');
  expect(b.skills.map((s) => s.name)).toEqual(['daily-standup']);
  expect(b.cron.length).toBe(1);
  expect(b.cron[0].enabled).toBe(false);
  expect(pf.listBundles().some((x) => x.name === 'solo-dev' && x.valid && x.trusted)).toBe(true);
});

test('validate rejects bad names, malformed skills, bad cron and unsafe repo names', () => {
  const dir = tmp();
  writeBundle(dir, {
    name: 'Bad Name',
    skill: { name: 'no-frontmatter', content: '# just text\n' },
    cron: [{ prompt: '', schedule: { kind: 'weekly', value: 'x' } }],
    manifest: { repos: [{ name: '../escape', source: '' }] },
  });
  const v = pf.validate(pf.loadBundle(dir));
  expect(v.ok).toBe(false);
  expect(v.errors.some((e) => e.includes('"name"'))).toBe(true);
  expect(v.errors.some((e) => e.includes('frontmatter'))).toBe(true);
  expect(v.errors.some((e) => e.includes('cron[0].prompt'))).toBe(true);
  expect(v.errors.some((e) => e.includes('schedule.kind'))).toBe(true);
  expect(v.errors.some((e) => e.includes('repos[0].name'))).toBe(true);
  expect(v.errors.some((e) => e.includes('repos[0].source'))).toBe(true);
});

test('loadBundle throws on missing/invalid profile.json; external dir is untrusted', () => {
  const dir = tmp();
  expect(() => pf.loadBundle(dir)).toThrow(/profile.json/);
  fs.writeFileSync(path.join(dir, 'profile.json'), '{not json');
  expect(() => pf.loadBundle(dir)).toThrow(/valid JSON/);
  writeBundle(dir, { name: 'ext' });
  expect(pf.loadBundle(dir).trusted).toBe(false);
});

test('mergeSeed appends only missing lines and never rewrites existing content', () => {
  const empty = pf.mergeSeed('', '# Notes\n\n- a\n- b\n');
  expect(empty.content).toBe('# Notes\n\n- a\n- b\n');
  expect(empty.added).toBe(3);
  const existing = '# Mine\n\n- A\n- keep me\n';
  const m = pf.mergeSeed(existing, '# Notes\n\n- a\n- c\n');
  expect(m.added).toBe(1);
  expect(m.content).toBe('# Mine\n\n- A\n- keep me\n- c\n'); // "a" deduped case-insensitively, heading skipped
  const again = pf.mergeSeed(m.content, '- a\n- c\n');
  expect(again.added).toBe(0);
  expect(again.content).toBe(m.content);
});

test('isGitUrl / nameFromUrl', () => {
  expect(pf.isGitUrl('https://github.com/o/my-bundle.git')).toBe(true);
  expect(pf.isGitUrl('git@github.com:o/my-bundle.git')).toBe(true);
  expect(pf.isGitUrl('solo-dev')).toBe(false);
  expect(pf.isGitUrl('/tmp/x')).toBe(false);
  expect(pf.nameFromUrl('https://github.com/o/My_Bundle.git')).toBe('my-bundle');
  expect(pf.nameFromUrl('git@github.com:o/ops.git')).toBe('ops');
});

test('resolveSource: dir, shipped name, unknown', () => {
  const dir = writeBundle(tmp(), { name: 'ext' });
  expect(pf.resolveSource(dir).dir).toBe(dir);
  expect(pf.resolveSource('solo-dev').dir).toBe(path.join(ROOT, 'profiles', 'bundles', 'solo-dev'));
  expect(() => pf.resolveSource('definitely-not-a-bundle')).toThrow(/no such profile bundle/);
  expect(() => pf.resolveSource('')).toThrow(/required/);
});

// ---- apply (isolated child) ----------------------------------------------------

function applyInChild(bundleDir: string, arigamiDir: string, extra = '') {
  return runInChild(
    "const pf=await import('./server/profiles.ts');const tr=await import('./server/triggers.ts');tr.load();" +
      `const b=pf.loadBundle(${JSON.stringify(bundleDir)});` +
      extra +
      'const rep=await pf.applyBundle(b);tr.flush();' +
      "const fs=require('node:fs');const path=require('node:path');" +
      'emit({rep,prov:pf.readProvenance(),pending:pf.getPending(),' +
      "mem:fs.existsSync(path.join(process.env.ARIGAMI_DIR,'memory','MEMORY.md'))?fs.readFileSync(path.join(process.env.ARIGAMI_DIR,'memory','MEMORY.md'),'utf8'):''," +
      'triggers:tr.listTriggers()});',
    { ARIGAMI_DIR: arigamiDir, ARIGAMI_PORT: '', ARIGAMI_STATE_FILE: path.join(arigamiDir, 'state.json') }
  );
}

test('external bundle: skill → pending proposal, memory appended, cron disabled, provenance written; re-apply is a no-op', () => {
  const skillName = `zz-pf-test-${Date.now().toString(36)}`;
  const adir = tmp();
  fs.mkdirSync(path.join(adir, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(adir, 'memory', 'MEMORY.md'), '- existing fact\n');
  const bdir = writeBundle(tmp(), {
    name: 'ext-bundle',
    skill: { name: skillName, content: SKILL },
    memory: '- existing fact\n- new fact from bundle\n',
    cron: [{ name: 'job', prompt: 'do it', schedule: { kind: 'interval', value: '1h' }, enabled: true }],
  });
  try {
    const r = applyInChild(bdir, adir);
    if (!r.ok) throw new Error(r.error);
    const { rep, prov, mem, triggers } = r.out[0];
    expect(rep.errors).toEqual([]);
    expect(rep.trusted).toBe(false);
    expect(rep.skills).toEqual([{ name: skillName, status: 'pending', proposalId: expect.stringMatching(/^skp_/) }]);
    expect(fs.existsSync(path.join(ROOT, 'skills', skillName))).toBe(false); // never written directly
    expect(fs.existsSync(path.join(adir, 'skill-proposals', rep.skills[0].proposalId, 'content.md'))).toBe(true);
    expect(mem).toBe('- existing fact\n- new fact from bundle\n');
    expect(rep.memory.memory).toBe(1);
    expect(rep.cron.length).toBe(1);
    expect(rep.cron[0].enabled).toBe(false); // external ⇒ never enabled
    expect(triggers.find((t: any) => t.id === rep.cron[0].id).enabled).toBe(false);
    expect(prov.name).toBe('ext-bundle');
    expect(prov.version).toBe('1.0.0');
    expect(fs.existsSync(path.join(adir, 'profile.json'))).toBe(true);

    // second apply: nothing duplicated
    const r2 = applyInChild(bdir, adir);
    if (!r2.ok) throw new Error(r2.error);
    const o2 = r2.out[0];
    expect(o2.rep.skills[0]).toEqual({ name: skillName, status: 'pending', proposalId: rep.skills[0].proposalId });
    expect(o2.mem).toBe('- existing fact\n- new fact from bundle\n');
    expect(o2.rep.memory.memory).toBe(0);
    expect(o2.triggers.filter((t: any) => t.type === 'cron').length).toBe(1);
    expect(o2.prov.history.length).toBe(1);
  } finally {
    fs.rmSync(path.join(ROOT, 'skills', skillName), { recursive: true, force: true });
  }
});

test('shipped bundle: new skill auto-applied; a CHANGE to an existing skill stays pending', () => {
  // Simulate "shipped" by placing the bundle under profiles/bundles/ (trusted by location).
  const skillName = `zz-pf-ship-${Date.now().toString(36)}`;
  const bname = `zz-tmp-${Date.now().toString(36)}`;
  const bdir = path.join(ROOT, 'profiles', 'bundles', bname);
  const adir = tmp();
  try {
    writeBundle(bdir, { name: bname, skill: { name: skillName, content: SKILL } });
    const r = applyInChild(bdir, adir);
    if (!r.ok) throw new Error(r.error);
    expect(r.out[0].rep.trusted).toBe(true);
    expect(r.out[0].rep.skills[0].status).toBe('applied');
    expect(fs.readFileSync(path.join(ROOT, 'skills', skillName, 'SKILL.md'), 'utf8')).toBe(SKILL);

    // same content again → unchanged
    const r2 = applyInChild(bdir, adir);
    expect(r2.out[0].rep.skills[0].status).toBe('unchanged');

    // changed content → pending (never overwrite a live skill silently)
    fs.writeFileSync(path.join(bdir, 'skills', skillName, 'SKILL.md'), SKILL + '\nchanged\n');
    const r3 = applyInChild(bdir, adir);
    if (!r3.ok) throw new Error(r3.error);
    expect(r3.out[0].rep.skills[0].status).toBe('pending');
    expect(fs.readFileSync(path.join(ROOT, 'skills', skillName, 'SKILL.md'), 'utf8')).toBe(SKILL);
  } finally {
    fs.rmSync(bdir, { recursive: true, force: true });
    fs.rmSync(path.join(ROOT, 'skills', skillName), { recursive: true, force: true });
  }
});

test('pending-profile hand-off: setPending → resolveSource("pending") → cleared after apply', () => {
  const adir = tmp();
  const bdir = writeBundle(tmp(), { name: 'pend', memory: '- p\n' });
  const r = runInChild(
    "const pf=await import('./server/profiles.ts');" +
      `pf.setPending(${JSON.stringify(bdir)});` +
      'const before=pf.getPending();const res=pf.resolveSource("pending");' +
      'const rep=await pf.applySource("pending",{skipCron:true});' +
      'emit({before,dir:res.dir,after:pf.getPending(),name:rep.name});',
    { ARIGAMI_DIR: adir, ARIGAMI_PORT: '' }
  );
  if (!r.ok) throw new Error(r.error);
  expect(r.out[0].before).toBe(bdir);
  expect(r.out[0].dir).toBe(bdir);
  expect(r.out[0].name).toBe('pend');
  expect(r.out[0].after).toBe(null);
});

test('invalid bundle is refused by applyBundle before touching anything', () => {
  const adir = tmp();
  const bdir = writeBundle(tmp(), { name: 'BAD', memory: '- x\n' });
  const r = runInChild(
    "const pf=await import('./server/profiles.ts');let err='';" +
      `try{await pf.applyBundle(pf.loadBundle(${JSON.stringify(bdir)}),{skipCron:true});}catch(e){err=String(e.message);}` +
      "const fs=require('node:fs');emit({err,prov:fs.existsSync(process.env.ARIGAMI_DIR+'/profile.json'),mem:fs.existsSync(process.env.ARIGAMI_DIR+'/memory/MEMORY.md')});",
    { ARIGAMI_DIR: adir, ARIGAMI_PORT: '' }
  );
  if (!r.ok) throw new Error(r.error);
  expect(r.out[0].err).toMatch(/invalid bundle/);
  expect(r.out[0].prov).toBe(false);
  expect(r.out[0].mem).toBe(false);
});
