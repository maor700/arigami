// $ARIGAMI_DOCS: a session's cwd is usually some other repo's worktree, so a relative "docs/LOGIN.md" in a skill or a
// prompt block resolves against the wrong repo and finds nothing. Agents reach a doc outside their cwd reliably only
// when they are handed the ABSOLUTE directory — so every engine's spawn env carries it, the first-turn prompt states
// it, and the shipped skills name docs through it.
import { test, expect, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { runInChild } from './_child.js';
import { tmpDir } from './_tmp.js';

const ROOT = path.resolve(import.meta.dir, '..');
const dir = tmpDir('arigami-docs-');
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const env = {
  ARIGAMI_DIR: dir,
  ARIGAMI_PORT: '',
  ARIGAMI_FUNNEL_QUIET: '1',
  ARIGAMI_CODEX_HOME: path.join(dir, 'no-codex-home'),
  CLAUDE_CONFIG_DIR: path.join(dir, 'no-claude-config'),
};

function expectDocsDir(p: unknown): void {
  expect(typeof p).toBe('string');
  expect(path.isAbsolute(p as string)).toBe(true);
  expect(fs.existsSync(path.join(p as string, 'LOGIN.md'))).toBe(true);
}

test('both engines spawn with ARIGAMI_DOCS: an absolute dir that holds the host docs', () => {
  const r = runInChild(
    "const st=await import('./server/state.ts');" +
      "await import('./server/claude.js');" +
      "await import('./server/codex.ts');" +
      "const ed=await import('./server/lib/engine-driver.ts');" +
      'const out={};' +
      "for(const engine of ['claude','codex']){" +
      "  const s=st.createSession({title:engine,engine,cwd:'/tmp'});" +
      '  const b=ed.pickEngine(st.getSession(s.id)).buildSpawn(st.getSession(s.id),{resume:false,sessionId:null});' +
      '  out[engine]=b.env.ARIGAMI_DOCS;' +
      '}' +
      'emit(out);',
    env
  );
  if (!r.ok) throw new Error(r.error);
  expectDocsDir(r.out[0].claude);
  expectDocsDir(r.out[0].codex);
  expect(r.out[0].codex).toBe(r.out[0].claude);
});

test('the first-turn prompt states the absolute docs dir in one line', () => {
  const r = runInChild(
    "const pb=await import('./server/prompt-blocks.ts');" +
      "emit({claude:pb.render('first-turn',{engine:'claude'}),codex:pb.render('first-turn',{engine:'codex'})});",
    env
  );
  if (!r.ok) throw new Error(r.error);
  for (const text of [r.out[0].claude, r.out[0].codex]) {
    const lines = (text as string).split('\n').filter((l) => l.startsWith('Arigami docs: '));
    expect(lines).toHaveLength(1);
    const p = /^Arigami docs: (\S+) /.exec(lines[0])?.[1];
    expectDocsDir(p);
    expect(text).not.toContain('{{docsDir}}');
  }
});

test('shipped skills never name a host doc by a cwd-relative docs/… path', () => {
  const bad: string[] = [];
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      // templates/ are files of the extension being scaffolded; their docs/USAGE.md is the extension's own.
      if (e.isDirectory()) { if (e.name !== 'templates') walk(full); continue; }
      if (!e.name.endsWith('.md')) continue;
      fs.readFileSync(full, 'utf8').split('\n').forEach((line, i) => {
        // a host doc is UPPER-CASE.md under docs/; $ARIGAMI_DOCS/X.md (no "docs/") is the right form
        if (/(^|[^\w/$])docs\/[A-Z][\w-]*\.md/.test(line)) bad.push(`${path.relative(ROOT, full)}:${i + 1}: ${line.trim()}`);
        if (/\(Arigami repo\)|in the Arigami repo —/.test(line)) bad.push(`${path.relative(ROOT, full)}:${i + 1}: ${line.trim()}`);
      });
    }
  };
  walk(path.join(ROOT, 'skills'));
  expect(bad).toEqual([]);
});
