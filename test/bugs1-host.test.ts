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
  fs.writeFileSync(path.join(dir, 'ORCHESTRATION.json'), JSON.stringify({ project: 'לאפיין את המשתמש', folderId: 'fld_sreFlms5wUc', nodes: [{ id: 'scan-whatsapp', session: 'sess_znWTFL3pnlA' }] }));
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

test('B33: cron triggers broadcast over WS carry nextRunAt (what the launcher renders as "ריצה הבאה")', () => {
  const { env } = isolated();
  const r = runInChild(
    `
    const t = await import('./server/triggers.js');
    t.load();
    const cron = await t.createCronTrigger({ name: 'סיכום פעילות רשתות – ערב', prompt: 'summarize', schedule: { kind: 'cron', value: '0 20 * * *' } });
    const decorated = t.withNextRun(t.listTriggers());
    emit({ raw: cron, decorated: decorated.find((x) => x.id === cron.id), nextRunFor: t.nextRunFor(cron) });
    `,
    env
  );
  expect(r.ok).toBe(true);
  const { raw, decorated, nextRunFor } = r.out[0];
  expect(raw.nextRunAt).toBeUndefined(); // the stored record stays clean
  expect(typeof decorated.nextRunAt).toBe('number');
  expect(decorated.nextRunAt).toBe(nextRunFor);
  expect(decorated.nextRunAt).toBeGreaterThan(Date.now());
  // and the WS emitter uses it (the REST list already did)
  const src = fs.readFileSync(path.join(ROOT, 'server/triggers.ts'), 'utf8');
  expect(src).toMatch(/broadcast\(\{ type: 'triggers', triggers: withNextRun\(listTriggers\(\)\) \}\)/);
});

test('B34: the ede_diagnostic result after an interrupt is a quiet system line; otherwise a worded error', () => {
  const { env } = isolated();
  const r = runInChild(
    `
    const c = await import('./server/claude.js');
    const j = { type: 'result', is_error: true, subtype: 'error_during_execution', result: '[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use', duration_ms: 1234, total_cost_usd: 0.01, num_turns: 1 };
    const now = Date.now();
    emit({
      afterEsc: c.resultChatEvent(j, { interruptedAt: now - 2000, now }),
      stale: c.resultChatEvent(j, { interruptedAt: now - 120000, now }),
      none: c.resultChatEvent(j, {}),
      normal: c.resultChatEvent({ type: 'result', is_error: false, result: 'done' }, { interruptedAt: now }),
      realError: c.resultChatEvent({ type: 'result', is_error: true, result: 'API Error: 401 OAuth access token has been revoked.' }, { interruptedAt: now }),
    });
    `,
    env
  );
  expect(r.ok).toBe(true);
  const { afterEsc, stale, none, normal, realError } = r.out[0];
  expect(afterEsc).toMatchObject({ kind: 'system', text: '⏹ interrupted', durationMs: 1234, costUsd: 0.01 });
  expect(afterEsc.detail).toContain('[ede_diagnostic]');
  expect(afterEsc.isError).toBeUndefined();
  for (const e of [stale, none]) {
    expect(e).toMatchObject({ kind: 'error', isError: true });
    expect(e.text).not.toContain('[ede_diagnostic]'); // words, not telemetry
    expect(e.detail).toContain('stop_reason=tool_use');
  }
  expect(normal).toBeNull(); // ordinary results are untouched
  expect(realError).toBeNull(); // real errors keep their own text + recovery path
  const src = fs.readFileSync(path.join(ROOT, 'server/claude.js'), 'utf8');
  expect(src).toMatch(/p\.interruptedAt = Date\.now\(\)/); // interrupt() stamps it
});
