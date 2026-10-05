import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runInChild } from './_child.js';

function fixture(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'state-durability-'));
  const file = path.join(dir, 'state.json');
  try { run(file, { ARIGAMI_DIR: dir, ARIGAMI_STATE_FILE: file }); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('missing state starts fresh; atomic saves keep the previous good database', () => fixture((file, env) => {
  const r = runInChild(`
    const fs = await import('node:fs'); const st = await import('./server/state.ts');
    st.createSession({title:'first'}); st.flushState();
    const first = fs.readFileSync(process.env.ARIGAMI_STATE_FILE, 'utf8');
    st.createSession({title:'second'}); st.flushState();
    emit({ first, backup: fs.readFileSync(process.env.ARIGAMI_STATE_FILE+'.bak','utf8'), current: JSON.parse(fs.readFileSync(process.env.ARIGAMI_STATE_FILE,'utf8')) });
  `, env);
  expect(r.ok).toBe(true);
  expect(r.out[0].backup).toBe(r.out[0].first);
  expect(r.out[0].current.sessions.map(s => s.title)).toEqual(['first', 'second']);
  expect(fs.existsSync(file + '.tmp')).toBe(false);
}));

test('failed replacement leaves the complete database and backup intact', () => fixture((file, env) => {
  const r = runInChild(`
    const fs = (await import('node:fs')).default; const st = await import('./server/state.ts');
    st.createSession({title:'saved'}); st.flushState();
    const before = fs.readFileSync(process.env.ARIGAMI_STATE_FILE,'utf8');
    const rename = fs.renameSync;
    fs.renameSync = (from,to) => { if(to === process.env.ARIGAMI_STATE_FILE) throw new Error('simulated interrupted replacement'); return rename(from,to); };
    st.createSession({title:'unsaved'}); st.flushState();
    emit({before, after:fs.readFileSync(process.env.ARIGAMI_STATE_FILE,'utf8'), backup:fs.readFileSync(process.env.ARIGAMI_STATE_FILE+'.bak','utf8')});
  `, env);
  expect(r.ok).toBe(true);
  expect(r.out[0].after).toBe(r.out[0].before);
  expect(r.out[0].backup).toBe(r.out[0].before);
}));

test('corrupt existing state is fatal and retained, with an explicit backup recovery path', () => fixture((file, env) => {
  for (const bytes of ['{"sessions": [', 'null', '[]']) {
    fs.writeFileSync(file, bytes);
    fs.writeFileSync(file + '.bak', '{"sessions":[]}');
    const r = runInChild("await import('./server/state.ts');", env);
    expect(r.ok).toBe(false);
    expect(r.error).toContain(file + '.bak');
    expect(fs.readFileSync(file, 'utf8')).toBe(bytes);
    expect(fs.readFileSync(file + '.bak', 'utf8')).toBe('{"sessions":[]}');
  }
}));

test('an existing unreadable state path is not treated as a missing database', () => fixture((file, env) => {
  fs.mkdirSync(file);
  const r = runInChild("await import('./server/state.ts');", env);
  expect(r.ok).toBe(false);
  expect(r.error).toContain('Cannot load');
  expect(fs.statSync(file).isDirectory()).toBe(true);
}));
