// BUGS1 (QA audit fixes) — host side.
//   B32: the Orchestration tab shows THIS controller's plan, never another
//        project's ORCHESTRATION.json from the shared cwd
//   B33: the WS `triggers` broadcast carries nextRunAt like the REST list
//   B34: Claude Code's `[ede_diagnostic]` result after an Esc is a quiet
//        "interrupted" system line, not a raw error row
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInChild } from './_child.js';
import { resolvePlan, planBelongsTo, planFileFor } from '../server/orchestration.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isolated = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-BUGS1-'));
  return { dir, env: { ARIGAMI_DIR: dir, ARIGAMI_STATE_FILE: path.join(dir, 'state.json'), HOME: dir } };
};

test('B32: planBelongsTo — owner fields, folder, children, or no hint', () => {
  const me = { id: 'sess_me', folderId: 'fld_me' };
  const kids = new Set(['sess_kid1']);
  expect(planBelongsTo({ master: 'sess_me', nodes: [] }, me, kids)).toBe(true);
  expect(planBelongsTo({ master: 'sess_other' }, me, kids)).toBe(false);
  expect(planBelongsTo({ sessionId: 'sess_me' }, me)).toBe(true);
  expect(planBelongsTo({ folderId: 'fld_me', nodes: [] }, me)).toBe(true);
  expect(planBelongsTo({ folderId: 'fld_other' }, me)).toBe(false);
  expect(planBelongsTo({ nodes: [{ id: 'a', session: 'sess_kid1' }] }, me, kids)).toBe(true);
  expect(planBelongsTo({ nodes: [{ id: 'a', session: 'sess_stranger' }] }, me, kids)).toBe(false);
  expect(planBelongsTo({ task: 'x', nodes: [{ id: 'a', state: 'pending' }] }, me, kids)).toBeNull();
  expect(planBelongsTo(null, me)).toBeNull();
});

test('B32: resolvePlan — per-session file first; the shared file only when attributable', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-B32-'));
  const me = { id: 'sess_me', folderId: 'fld_me' };
  // the audit's situation: another controller's plan in the shared cwd
  fs.writeFileSync(path.join(dir, 'ORCHESTRATION.json'), JSON.stringify({ project: 'לאפיין את דנה', folderId: 'fld_sreFlms5wUc', nodes: [{ id: 'scan-whatsapp', session: 'sess_znWTFL3pnlA' }] }));
  const r1 = resolvePlan(dir, me, { childIds: new Set(['sess_kid']), sharedCwd: true });
  expect(r1.plan).toBeNull();
  expect(r1.planError).toMatch(/belongs to another controller/);
  expect(r1.planError).toContain('ORCHESTRATION.sess_me.json');
  // no hint + shared cwd → reported, not shown
  fs.writeFileSync(path.join(dir, 'ORCHESTRATION.json'), JSON.stringify({ task: 'anon', nodes: [{ id: 'a' }] }));
  const r2 = resolvePlan(dir, me, { sharedCwd: true });
  expect(r2.plan).toBeNull();
  expect(r2.planError).toMatch(/names no owner/);
  // no hint + nobody else in this cwd (a dispatch master in its own worktree) → shown, as before
  const r3 = resolvePlan(dir, me, { sharedCwd: false });
  expect((r3.plan as any).task).toBe('anon');
  expect(r3.file).toBe(path.join(dir, 'ORCHESTRATION.json'));
  // an attributable shared file wins even in a shared cwd
  fs.writeFileSync(path.join(dir, 'ORCHESTRATION.json'), JSON.stringify({ master: 'sess_me', task: 'mine' }));
  expect((resolvePlan(dir, me, { sharedCwd: true }).plan as any).task).toBe('mine');
  // the per-session file beats everything
  fs.writeFileSync(planFileFor(dir, 'sess_me'), JSON.stringify({ task: 'own file' }));
  const r4 = resolvePlan(dir, me, { sharedCwd: true });
  expect((r4.plan as any).task).toBe('own file');
  expect(r4.file).toBe(path.join(dir, 'ORCHESTRATION.sess_me.json'));
  // nothing there
  expect(resolvePlan(fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-B32e-')), me, {})).toEqual({ plan: null, planError: 'no ORCHESTRATION.json yet' });
});
