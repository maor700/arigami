// Pure status mapping behind the repo screens (web/src/lib/repo-status.js) + the add-existing outcome.
import { test, expect } from 'bun:test';
import { repoRowModel, anyCloned, anyCloning, newlyCloned, addOutcome } from '../web/src/lib/repo-status.js';

test('each server state maps to a pill, an action and (for failures) a reason', () => {
  expect(repoRowModel({ state: 'cloned' })).toMatchObject({ pill: 'ok', canClone: false });
  expect(repoRowModel({ state: 'not_cloned' })).toMatchObject({ pill: 'todo', canClone: true, cloneKey: 'setup.repo.download' });
  expect(repoRowModel({ state: 'not_cloned', local: true }).cloneKey).toBe('setup.repo.copy');
  expect(repoRowModel({ state: 'cloning', progress: 'Receiving objects: 40%' })).toMatchObject({ pill: 'running', canClone: false, progress: 'Receiving objects: 40%' });
  const miss = repoRowModel({ state: 'failed', errorCode: 'git_auth_missing', error: 'x' });
  expect(miss).toMatchObject({ pill: 'failed', canClone: true, cloneKey: 'setup.repo.retry', needsGit: true, errorKey: 'setup.repo.err.gitMissing' });
  const raw = repoRowModel({ state: 'failed', errorCode: 'clone_failed', error: 'fatal: boom' });
  expect(raw).toMatchObject({ needsGit: false, errorKey: null, errorRaw: 'fatal: boom' });
});

test('the repo step is done only when a repo is actually cloned', () => {
  expect(anyCloned([{ state: 'not_cloned' }, { state: 'failed' }])).toBe(false);
  expect(anyCloned([{ state: 'not_cloned' }, { state: 'cloned' }])).toBe(true);
  expect(anyCloned([])).toBe(false);
});

test('polling and transition detection', () => {
  expect(anyCloning([{ state: 'cloned' }, { state: 'cloning' }])).toBe(true);
  expect(anyCloning([{ state: 'failed' }])).toBe(false);
  expect(newlyCloned([{ name: 'a', state: 'cloning' }], [{ name: 'a', state: 'cloned' }])).toEqual(['a']);
  expect(newlyCloned(null, [{ name: 'a', state: 'cloned' }])).toEqual([]);
  expect(newlyCloned([{ name: 'a', state: 'cloned' }], [{ name: 'a', state: 'cloned' }])).toEqual([]);
});

test('add outcome: new, already cloned, already registered (now cloning)', () => {
  expect(addOutcome({ existing: false, state: 'not_cloned' })).toBe('added');
  expect(addOutcome({ existing: true, state: 'cloned', present: true })).toBe('already');
  expect(addOutcome({ existing: true, state: 'cloning' })).toBe('cloning-existing');
});
