// D12: the Orchestration "Needs you" row shows the child's open request and ONE next action,
// wired to the existing permission/answer endpoint (no new server capability).
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { pendingRequestOf, nextAction, summarizeInput } = await import(path.join(ROOT, 'web/src/lib/orch-pending.js'));

const perm = (id, input = { command: 'git push origin HEAD' }, toolName = 'Bash') => ({ kind: 'permission-request', requestId: id, toolName, input });

test('an open permission request is Approve / Deny with the command in one line', () => {
  const p = pendingRequestOf([{ kind: 'user', text: 'go' }, perm('r1')]);
  expect(p).toEqual({ type: 'permission', requestId: 'r1', tool: 'Bash', summary: 'git push origin HEAD' });
  expect(nextAction(p, { claude_state: 'awaiting-input' })).toBe('approve');
});

test('answered, answered-in-place, or moved-on requests are closed', () => {
  expect(pendingRequestOf([perm('r1'), { kind: 'permission-answer', requestId: 'r1', behavior: 'allow' }])).toBeNull();
  expect(pendingRequestOf([{ ...perm('r1'), answered: 'deny' }])).toBeNull();
  expect(pendingRequestOf([perm('r1'), { kind: 'result' }])).toBeNull();
  expect(pendingRequestOf([])).toBeNull();
  expect(pendingRequestOf(null)).toBeNull();
});

test('only the newest unanswered request counts; a question is Answer, not Approve', () => {
  const q = { kind: 'permission-request', requestId: 'q1', toolName: 'AskUserQuestion', input: { questions: [{ question: 'Open a PR?' }] } };
  const p = pendingRequestOf([perm('old'), { kind: 'permission-answer', requestId: 'old' }, q]);
  expect(p).toEqual({ type: 'question', text: 'Open a PR?' });
  expect(nextAction(p, {})).toBe('answer');
});

test('review is the next action of a finished, unapproved branch; nothing otherwise', () => {
  expect(nextAction(null, { branch: 'b', result: { state: 'done' }, review: null })).toBe('review');
  expect(nextAction(null, { branch: 'b', result: { state: 'done' }, review: { state: 'approved' } })).toBeNull();
  expect(nextAction(null, { claude_state: 'working' })).toBeNull();
  expect(summarizeInput({ file_path: '/a/b.js' })).toBe('/a/b.js');
});

test('the row goes through the existing answerPermission → POST /sessions/:id/permission/answer; one primary per view', () => {
  const tab = fs.readFileSync(path.join(ROOT, 'web/src/components/OrchestrationTab.jsx'), 'utf8');
  expect(tab).toContain("answerPermission(n.id, pending.requestId, behavior)");
  expect(tab).toContain("variant={first ? 'primary' : 'outline'}");
  expect(fs.readFileSync(path.join(ROOT, 'web/src/lib/store.js'), 'utf8')).toContain('/permission/answer');
  // no new server route was added for this
  expect(fs.readFileSync(path.join(ROOT, 'server/api.ts'), 'utf8')).not.toMatch(/orchestration[^\n]*approve/i);
});
