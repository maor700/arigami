// F2: skills.ts has two roots — the shipped, git-tracked <repo>/skills
// (read-only at runtime) and $ARIGAMI_DIR/skills (user). They merge by name,
// user overriding shipped, and EVERY write path (human editor, skill-proposal
// apply, profile-bundle apply) lands in the user dir — the repo tree must stay
// clean. Runs out-of-process (test/_child.js) since skills.ts captures
// ARIGAMI_DIR at import time.
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runInChild } from './_child.js';

const ROOT = path.resolve(import.meta.dir, '..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-f2-'));
const SKILL = (body) => `---\ndescription: f2 test skill\n---\n\n# T\n\n${body}\n`;
const env = (dir) => ({ ARIGAMI_DIR: dir, ARIGAMI_PORT: '' });
const gitSkillsStatus = () =>
  spawnSync('git', ['-C', ROOT, 'status', '--porcelain', '--', 'skills/'], { encoding: 'utf8' }).stdout.trim();

function seedUserSkill(dir, name, body) {
  fs.mkdirSync(path.join(dir, 'skills', name), { recursive: true });
  fs.writeFileSync(path.join(dir, 'skills', name, 'SKILL.md'), SKILL(body));
}

test('listSkills merges shipped ∪ user, tags source, user overrides shipped by name', () => {
  const dir = tmp();
  seedUserSkill(dir, 'zz-f2-user-only', 'user only');
  seedUserSkill(dir, 'explain-changes', 'OVERRIDE of a shipped skill');
  const r = runInChild(
    "const sk=await import('./server/skills.ts');" +
      'const l=sk.listSkills();' +
      "const by=Object.fromEntries(l.skills.map(s=>[s.name,s]));" +
      "emit({names:l.skills.map(s=>s.name),by:{u:by['zz-f2-user-only'],o:by['explain-changes'],s:by['dispatch']}," +
      "read:sk.readSkill('explain-changes').content,dir:sk.skillDir('explain-changes'),src:sk.skillSource('zz-nope')," +
      'userDir:sk.USER_SKILLS_DIR});',
    env(dir)
  );
  if (!r.ok) throw new Error(r.error);
  const o = r.out[0];
  expect(o.userDir).toBe(path.join(dir, 'skills'));
  expect(o.names).toEqual([...o.names].sort());
  expect(o.names.filter((n) => n === 'explain-changes').length).toBe(1); // once, not twice
  expect(o.names).toContain('zz-f2-user-only');
  expect(o.names).toContain('dispatch');
  expect(o.by.u).toMatchObject({ source: 'user', overridesShipped: false });
  expect(o.by.o).toMatchObject({ source: 'user', overridesShipped: true });
  expect(o.by.s).toMatchObject({ source: 'shipped', overridesShipped: false });
  expect(o.read).toMatch(/OVERRIDE of a shipped skill/);
  expect(o.dir).toBe(path.join(dir, 'skills', 'explain-changes'));
  expect(o.src).toBeNull();
});

test('writeSkill on a SHIPPED skill creates an override copy in the user dir (shipped file + repo untouched)', () => {
  const dir = tmp();
  const before = fs.readFileSync(path.join(ROOT, 'skills', 'explain-changes', 'SKILL.md'), 'utf8');
  const r = runInChild(
    "const sk=await import('./server/skills.ts');" +
      "const w=sk.writeSkill('explain-changes','---\\ndescription: edited\\n---\\n\\nedited body');" +
      "emit({w,after:sk.readSkill('explain-changes').content});",
    env(dir)
  );
  if (!r.ok) throw new Error(r.error);
  expect(r.out[0].w.ok).toBe(true);
  expect(r.out[0].w.skill).toMatchObject({ source: 'user', overridesShipped: true });
  expect(r.out[0].after).toMatch(/edited body/);
  expect(fs.readFileSync(path.join(dir, 'skills', 'explain-changes', 'SKILL.md'), 'utf8')).toMatch(/edited body/);
  expect(fs.readFileSync(path.join(ROOT, 'skills', 'explain-changes', 'SKILL.md'), 'utf8')).toBe(before);
  expect(gitSkillsStatus()).toBe('');
  // no create without allowCreate; create with it → user dir
  const r2 = runInChild(
    "const sk=await import('./server/skills.ts');" +
      "emit({no:sk.writeSkill('zz-f2-new','---\\ndescription: d\\n---\\nx'),yes:sk.writeSkill('zz-f2-new','---\\ndescription: d\\n---\\nx',{allowCreate:true})});",
    env(dir)
  );
  if (!r2.ok) throw new Error(r2.error);
  expect(r2.out[0].no.error).toMatch(/no such skill/);
  expect(r2.out[0].yes.skill).toMatchObject({ name: 'zz-f2-new', source: 'user' });
  expect(fs.existsSync(path.join(dir, 'skills', 'zz-f2-new', 'SKILL.md'))).toBe(true);
  expect(fs.existsSync(path.join(ROOT, 'skills', 'zz-f2-new'))).toBe(false);
});

test('ensureUserPlugin generates $ARIGAMI_DIR/user-plugin (manifest + skills symlink) — what sessions load via --plugin-dir', () => {
  const dir = tmp();
  const r = runInChild("const sk=await import('./server/skills.ts');emit({p:sk.ensureUserPlugin(),again:sk.ensureUserPlugin()});", env(dir));
  if (!r.ok) throw new Error(r.error);
  const p = r.out[0].p;
  expect(p).toBe(path.join(dir, 'user-plugin'));
  expect(r.out[0].again).toBe(p);
  expect(JSON.parse(fs.readFileSync(path.join(p, '.claude-plugin', 'plugin.json'), 'utf8')).name).toBe('arigami-user');
  expect(fs.readlinkSync(path.join(p, 'skills'))).toBe(path.join(dir, 'skills'));
  seedUserSkill(dir, 'zz-via-link', 'x');
  expect(fs.existsSync(path.join(p, 'skills', 'zz-via-link', 'SKILL.md'))).toBe(true);
});

test('skill-proposal apply writes to the user dir (edit of a shipped skill ⇒ override copy)', () => {
  const dir = tmp();
  const r = runInChild(
    "const sp=await import('./server/skill-proposals.ts');const sk=await import('./server/skills.ts');" +
      "const res=sp.proposeSkill({name:'explain-changes',content:'---\\ndescription: proposed\\n---\\n\\nproposed body',rationale:'r'});" +
      'const a=sp.applyProposal(res.proposal.id);' +
      "emit({a,src:sk.skillSource('explain-changes'),content:sk.readSkillContent('explain-changes')});",
    env(dir)
  );
  if (!r.ok) throw new Error(r.error);
  expect(r.out[0].a.ok).toBe(true);
  expect(r.out[0].src).toBe('user');
  expect(r.out[0].content).toMatch(/proposed body/);
  expect(fs.existsSync(path.join(dir, 'skills', 'explain-changes', 'SKILL.md'))).toBe(true);
  expect(gitSkillsStatus()).toBe('');
});

test('profile apply (shipped bundle, new skill) lands in the user dir and the repo tree stays clean', () => {
  const dir = tmp();
  const bname = `zz-f2-${Date.now().toString(36)}`;
  const bdir = path.join(ROOT, 'profiles', 'bundles', bname); // under profiles/bundles ⇒ trusted
  const skillName = `${bname}-skill`;
  try {
    fs.mkdirSync(path.join(bdir, 'skills', skillName), { recursive: true });
    fs.writeFileSync(path.join(bdir, 'profile.json'), JSON.stringify({ name: bname, version: '1.0.0' }));
    fs.writeFileSync(path.join(bdir, 'skills', skillName, 'SKILL.md'), SKILL('from bundle'));
    const r = runInChild(
      "const pf=await import('./server/profiles.ts');" +
        `const b=pf.loadBundle(${JSON.stringify(bdir)});const rep=await pf.applyBundle(b,{skipRepos:true});emit({rep});`,
      env(dir)
    );
    if (!r.ok) throw new Error(r.error);
    expect(r.out[0].rep.skills[0].status).toBe('applied');
    expect(fs.readFileSync(path.join(dir, 'skills', skillName, 'SKILL.md'), 'utf8')).toBe(SKILL('from bundle'));
    expect(fs.existsSync(path.join(ROOT, 'skills', skillName))).toBe(false);
    expect(gitSkillsStatus()).toBe('');
    // and it's visible to the merged list + the session plugin
    expect(fs.existsSync(path.join(dir, 'user-plugin', 'skills', skillName, 'SKILL.md'))).toBe(true);
  } finally {
    fs.rmSync(bdir, { recursive: true, force: true });
  }
});
