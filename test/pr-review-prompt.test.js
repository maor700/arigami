// The pr-review extension's first message can be replaced by a template from
// Settings › Extensions ({{prUrl}} / {{checkout}}); blank = built-in prompt.
import { test, expect } from 'bun:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { fillPromptTemplate, reviewPrompt } = await import(path.join(ROOT, 'examples/extensions/pr-review/tools/module.ts'));

const URL = 'https://github.com/o/r/pull/7';

test('blank template falls back to the built-in prompt', () => {
  expect(fillPromptTemplate('  \n', { prUrl: URL, checkout: 'x' })).toBeNull();
  expect(reviewPrompt(URL, 'worktree', '')).toContain(`Review the pull request ${URL}.`);
  expect(reviewPrompt(URL, 'worktree')).toBe(reviewPrompt(URL, 'worktree', ''));
});

test('a template substitutes {{prUrl}} and {{checkout}} (spacing tolerant, repeated) and leaves unknown placeholders', () => {
  const out = reviewPrompt(URL, 'nocheckout', 'Look at {{prUrl}} and {{ prUrl }}.\n{{checkout}}\n{{other}}');
  expect(out).toContain(`Look at ${URL} and ${URL}.`);
  expect(out).toContain('NOT checked out');
  expect(out).toContain('{{other}}');
  expect(out).not.toContain('Do not modify, stage'); // the built-in text is replaced entirely
});
