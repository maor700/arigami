// A4 — bundles ship agents (server/profiles.ts): the marketing-team fixture bundle
// bundle loads with its six agents and validates clean; validate() rejects a
// malformed agents/ dir; apply creates the agents under $ARIGAMI_DIR/agents,
// is idempotent (an existing agent is the user's — untouched unless force),
// drops skills the host doesn't have, copies assets once, births the bundle's
// cron from its agent; exportBundle carries agents/ back out (no homeSessionId).
// Apply runs in a child with its own ARIGAMI_DIR (see test/_child.js).
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runInChild } from './_child.js';

const pf = await import('../server/profiles.ts');
const ROOT = path.resolve(import.meta.dir, '..');
const MT = path.join(ROOT, 'test', 'fixtures', 'bundles', 'marketing-team');
const tmp = (p = 'arigami-a4-') => fs.mkdtempSync(path.join(os.tmpdir(), p));
const SIX = ['awesome', 'fibi', 'jord', 'mila', 'reachard', 'richi'];

function writeAgentBundle(dir: string, agents: Record<string, { record?: unknown; persona?: string; assets?: Record<string, string> }>, manifest: Record<string, unknown> = {}, cron?: unknown) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'profile.json'), JSON.stringify({ name: 'agent-bundle', version: '1.0.0', ...manifest }));
  fs.writeFileSync(path.join(dir, 'README.md'), '# agent bundle\n');
  for (const [slug, a] of Object.entries(agents)) {
    const ad = path.join(dir, 'agents', slug);
    fs.mkdirSync(ad, { recursive: true });
    if (a.record !== undefined) fs.writeFileSync(path.join(ad, 'agent.json'), typeof a.record === 'string' ? a.record : JSON.stringify(a.record));
    if (a.persona !== undefined) fs.writeFileSync(path.join(ad, 'persona.md'), a.persona);
    for (const [f, c] of Object.entries(a.assets || {})) {
      fs.mkdirSync(path.join(ad, 'assets'), { recursive: true });
      fs.writeFileSync(path.join(ad, 'assets', f), c);
    }
  }
  if (cron) fs.writeFileSync(path.join(dir, 'cron.json'), JSON.stringify(cron));
  return dir;
}

// ---- load + validate --------------------------------------------------------------

test('marketing-team: six agents, three skills, personas ≤ 20 lines, every referenced skill ships, no real accounts', () => {
  const b = pf.loadBundle(MT, 'marketing-team');
  expect(b.trusted).toBe(true);
  expect(b.agents.map((a) => a.slug)).toEqual(SIX);
  expect(b.skills.map((s) => s.name)).toEqual(['campaign-brief', 'content-calendar', 'outreach-sequence']);
  const v = pf.validate(b);
  expect(v.errors).toEqual([]);
  expect(v.warnings).toEqual([]);
  const shipped = fs.readdirSync(path.join(ROOT, 'skills'));
  for (const a of b.agents) {
    const r = a.record as any;
    expect(typeof r.name).toBe('string');
    expect(r.slug).toBe(a.slug);
    expect(r.homeSessionId).toBeUndefined();
    expect(a.persona.trim().split('\n').length).toBeLessThanOrEqual(20);
    expect(a.persona).toContain('<your-product>');
    for (const sk of r.skills) expect(b.skills.some((s) => s.name === sk) || shipped.includes(sk), `${a.slug} → ${sk}`).toBe(true);
    expect(Array.isArray(r.tools) && r.tools.length > 0, `${a.slug} tools`).toBe(true);
    expect(r.budget.tokensPerDay).toBeGreaterThan(0);
  }
  expect(b.agents.find((a) => a.slug === 'jord')!.assets).toEqual(['brand-palette.md']);
  expect(b.cron[0].agent).toBe('awesome');
  expect(b.cron[0].enabled).toBe(false);
  expect(pf.summarize(b).agents).toEqual(SIX);
  expect(pf.listBundles().find((x) => x.name === 'marketing-team')?.agents).toEqual(SIX);
});

test('validate: bad slug dir, missing agent.json / name, slug mismatch, secrets, bad cron agent, unknown skill warning', () => {
  const dir = writeAgentBundle(
    tmp(),
    {
      'Bad Slug': { record: { name: 'x' } },
      'no-json': { persona: 'hi' },
      'no-name': { record: { emoji: '🤖' } },
      mismatch: { record: { name: 'M', slug: 'other' } },
      secret: { record: { name: 'S', apiKey: 'k' } },
      ok: { record: { name: 'Ok', skills: ['not-a-skill-anywhere'], homeSessionId: 'sess_x' }, persona: 'p' },
    },
    {},
    [{ name: 'j', prompt: 'do something useful now', schedule: { kind: 'interval', value: '1h' }, agent: 'Nope' }, { name: 'k', prompt: 'do something useful now', schedule: { kind: 'interval', value: '1h' }, agent: 'ghost' }]
  );
  const v = pf.validate(pf.loadBundle(dir));
  expect(v.ok).toBe(false);
  expect(v.errors.join('\n')).toMatch(/agents\/Bad Slug: invalid agent slug/);
  expect(v.errors.join('\n')).toMatch(/agents\/no-json\/agent.json missing/);
  expect(v.errors.join('\n')).toMatch(/agents\/no-name\/agent.json: "name" is required/);
  expect(v.errors.join('\n')).toMatch(/agents\/mismatch\/agent.json: "slug"/);
  expect(v.errors.join('\n')).toMatch(/agents\/secret\/agent.json: "apiKey"/);
  expect(v.errors.join('\n')).toMatch(/cron\[0\].agent must be an agent slug/);
  expect(v.warnings.join('\n')).toMatch(/cron\[1\] is born from agent "ghost"/);
  expect(v.warnings.join('\n')).toMatch(/agents\/ok: references skill "not-a-skill-anywhere"/);
  expect(v.warnings.join('\n')).toMatch(/agents\/ok\/agent.json: "homeSessionId" is instance-local/);
  expect(() => pf.loadBundle(writeAgentBundle(tmp(), { broken: { record: '{not json' } }))).toThrow(/agents\/broken\/agent.json is not valid JSON/);
});

test('profile.json "agents" is an allow-list over agents/', () => {
  const dir = writeAgentBundle(tmp(), { a: { record: { name: 'A' } }, b: { record: { name: 'B' } } }, { agents: ['b'] });
  expect(pf.loadBundle(dir).agents.map((a) => a.slug)).toEqual(['b']);
});

// ---- apply (isolated child) ---------------------------------------------------------

function applyInChild(bundleDir: string, arigamiDir: string, extra = '', force = false) {
  return runInChild(
    "const pf=await import('./server/profiles.ts');const tr=await import('./server/triggers.ts');const ag=await import('./server/agents.ts');tr.load();" +
      `const b=pf.loadBundle(${JSON.stringify(bundleDir)});` +
      extra +
      `const rep=await pf.applyBundle(b,{force:${force}});tr.flush();` +
      "const fs=require('node:fs');const path=require('node:path');" +
      'emit({rep,agents:ag.listAgentViews(),triggers:tr.listTriggers()});',
    { ARIGAMI_DIR: arigamiDir, ARIGAMI_PORT: '', ARIGAMI_STATE_FILE: path.join(arigamiDir, 'state.json') }
  );
}

test('apply marketing-team: six agents created with persona/tools/budget, skills resolved, assets copied, cron born from awesome; re-apply leaves user edits; --force restores', () => {
  const adir = tmp();
  const r = applyInChild(MT, adir);
  if (!r.ok) throw new Error(r.error);
  const { rep, agents, triggers } = r.out[0];
  expect(rep.errors).toEqual([]);
  expect(rep.skills.map((s: any) => [s.name, s.status])).toEqual([['campaign-brief', 'applied'], ['content-calendar', 'applied'], ['outreach-sequence', 'applied']]);
  expect(rep.agents.map((a: any) => [a.slug, a.status])).toEqual(SIX.map((s) => [s, 'created']));
  expect(rep.agents.find((a: any) => a.slug === 'jord').assets).toBe(1);
  expect(rep.agents.every((a: any) => !a.skippedSkills)).toBe(true); // bundle skills were staged first
  expect(agents.map((a: any) => a.slug).sort()).toEqual(SIX);
  const mila = agents.find((a: any) => a.slug === 'mila');
  expect(mila.persona).toContain('You are Mila');
  expect(mila.skills).toEqual(['campaign-brief', 'content-calendar']);
  expect(mila.tools).toEqual(['web', 'publish']); // A5 (#2): the bundle asks for `publish` explicitly
  expect(mila.budget).toEqual({ tokensPerDay: 250000 });
  expect(mila.homeSessionId).toBeNull();
  expect(fs.existsSync(path.join(adir, 'agents', 'jord', 'assets', 'brand-palette.md'))).toBe(true);
  expect(fs.existsSync(path.join(adir, 'agents', 'mila', 'agent.json'))).toBe(true);
  expect(fs.existsSync(path.join(ROOT, 'skills', 'campaign-brief'))).toBe(false); // never into the repo tree
  const cron = triggers.filter((t: any) => t.type === 'cron');
  expect(cron.length).toBe(1);
  expect(cron[0].agent).toBe('awesome');
  expect(cron[0].enabled).toBe(false);

  // the user edits Mila + replaces Jord's asset; re-apply must not touch either
  fs.writeFileSync(path.join(adir, 'agents', 'mila', 'persona.md'), 'You are MY Mila now.\n');
  fs.writeFileSync(path.join(adir, 'agents', 'jord', 'assets', 'brand-palette.md'), 'mine\n');
  const r2 = applyInChild(MT, adir);
  if (!r2.ok) throw new Error(r2.error);
  expect(r2.out[0].rep.agents.map((a: any) => a.status)).toEqual(SIX.map(() => 'unchanged'));
  expect(r2.out[0].rep.skills.map((s: any) => s.status)).toEqual(['unchanged', 'unchanged', 'unchanged']);
  expect(fs.readFileSync(path.join(adir, 'agents', 'mila', 'persona.md'), 'utf8')).toBe('You are MY Mila now.\n');
  expect(fs.readFileSync(path.join(adir, 'agents', 'jord', 'assets', 'brand-palette.md'), 'utf8')).toBe('mine\n');
  expect(r2.out[0].triggers.filter((t: any) => t.type === 'cron').length).toBe(1); // not duplicated

  // --force: the bundle wins again
  const r3 = applyInChild(MT, adir, '', true);
  if (!r3.ok) throw new Error(r3.error);
  expect(r3.out[0].rep.agents.map((a: any) => a.status)).toEqual(SIX.map(() => 'updated'));
  expect(fs.readFileSync(path.join(adir, 'agents', 'mila', 'persona.md'), 'utf8')).toContain('You are Mila');
  expect(fs.readFileSync(path.join(adir, 'agents', 'jord', 'assets', 'brand-palette.md'), 'utf8')).toContain('palette');
});

test('external bundle: the agent is created, its bundle skill is PENDING so it is dropped and reported; a missing referenced skill never fails the apply', () => {
  const adir = tmp();
  const dir = writeAgentBundle(tmp(), { bot: { record: { name: 'Bot', skills: ['zz-a4-ext-skill', 'machine-work', 'nope-nowhere'], tools: ['web'], color: '#123456' }, persona: 'I am Bot.' } });
  fs.mkdirSync(path.join(dir, 'skills', 'zz-a4-ext-skill'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'skills', 'zz-a4-ext-skill', 'SKILL.md'), '---\ndescription: ext\n---\n\n# x\n');
  const r = applyInChild(dir, adir);
  if (!r.ok) throw new Error(r.error);
  const { rep, agents } = r.out[0];
  expect(rep.trusted).toBe(false);
  expect(rep.skills[0].status).toBe('pending');
  expect(rep.agents).toEqual([{ slug: 'bot', status: 'created', skippedSkills: ['zz-a4-ext-skill', 'nope-nowhere'] }]);
  expect(agents[0].skills).toEqual(['machine-work']);
  expect(agents[0].color).toBe('#123456');
  expect(agents[0].persona).toBe('I am Bot.');
});

test('exportBundle carries agents/ (record without homeSessionId, persona, assets) and the cron agent', () => {
  const adir = tmp();
  const r = runInChild(
    "const pf=await import('./server/profiles.ts');const tr=await import('./server/triggers.ts');const ag=await import('./server/agents.ts');const bk=await import('./server/backup.ts');tr.load();" +
      `await pf.applyBundle(pf.loadBundle(${JSON.stringify(MT)}));tr.flush();` +
      "ag.updateAgent('mila',{homeSessionId:'sess_local'});" +
      "const out=bk.exportBundle({name:'roundtrip',cron:tr.listTriggers()});" +
      "const fs=require('node:fs');const path=require('node:path');" +
      "emit({out,mila:JSON.parse(fs.readFileSync(path.join(out.dir,'agents','mila','agent.json'),'utf8')),persona:fs.readFileSync(path.join(out.dir,'agents','mila','persona.md'),'utf8'),asset:fs.existsSync(path.join(out.dir,'agents','jord','assets','brand-palette.md')),cron:JSON.parse(fs.readFileSync(path.join(out.dir,'cron.json'),'utf8')),valid:pf.validate(pf.loadBundle(out.dir))});",
    { ARIGAMI_DIR: adir, ARIGAMI_PORT: '', ARIGAMI_STATE_FILE: path.join(adir, 'state.json') }
  );
  if (!r.ok) throw new Error(r.error);
  const o = r.out[0];
  expect(o.out.agents).toEqual(SIX);
  expect(o.mila.homeSessionId).toBeUndefined();
  expect(o.mila.name).toBe('Mila');
  expect(o.persona).toContain('You are Mila');
  expect(o.asset).toBe(true);
  expect(o.cron[0].agent).toBe('awesome');
  expect(o.valid.errors).toEqual([]);
});
