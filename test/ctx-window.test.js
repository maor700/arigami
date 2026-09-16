// CTX1: `ctxWindowFor` in server/claude.js claimed 200k for Sonnet 5, which
// the CLI itself reports as 1M (`claude -p "/context" --model claude-sonnet-5`).
// server/lib/ctx-window.ts replaces the guesswork with a measured table plus a
// real resolution order: per-model override > explicit [1m] tag > table >
// conservative default (flagged `assumed`). Runs out-of-process (see
// test/_child.js) so each test gets its own ARIGAMI_DIR/env without leaking
// into the shared bun:test module registry.
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runInChild } from './_child.js';

function freshDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-ctxwin-'));
}

function resolve(model, env = {}) {
  const r = runInChild(
    `const {resolveCtxWindow}=await import('./server/lib/ctx-window.js');` +
      `emit(resolveCtxWindow(${JSON.stringify(model)}));`,
    { ARIGAMI_DIR: freshDir(), ARIGAMI_PORT: '', ...env }
  );
  expect(r.ok).toBe(true);
  return r.out[0];
}

test('known table: sonnet-5 resolves to the 1M window, not assumed', () => {
  const r = resolve('claude-sonnet-5');
  expect(r).toEqual({ window: 1_000_000, assumed: false, source: 'table' });
});

test('known table: opus-5 resolves to 1M', () => {
  expect(resolve('claude-opus-5')).toEqual({ window: 1_000_000, assumed: false, source: 'table' });
});

test('known table: fable-5 resolves to 1M', () => {
  expect(resolve('claude-fable-5')).toEqual({ window: 1_000_000, assumed: false, source: 'table' });
});

test('known table: fable-5-1 (and any later fable point release) resolves to 1M via the family match', () => {
  expect(resolve('claude-fable-5-1')).toEqual({ window: 1_000_000, assumed: false, source: 'table' });
  expect(resolve('claude-fable-5-1[1m]')).toEqual({ window: 1_000_000, assumed: false, source: 'tag' });
});

test('known table: haiku-4.5 resolves to 200k, not assumed', () => {
  const r = resolve('claude-haiku-4-5-20251001');
  expect(r).toEqual({ window: 200_000, assumed: false, source: 'table' });
});

test('known table: a pre-5 sonnet id stays 200k (confident, not assumed)', () => {
  const r = resolve('claude-3-5-sonnet-20241022');
  expect(r).toEqual({ window: 200_000, assumed: false, source: 'table' });
});

test('unknown model id: conservative 200k default, flagged assumed', () => {
  const r = resolve('claude-nova-9000');
  expect(r).toEqual({ window: 200_000, assumed: true, source: 'default' });
});

test('empty/missing model: assumed default, does not throw', () => {
  expect(resolve(null)).toEqual({ window: 200_000, assumed: true, source: 'default' });
  expect(resolve('')).toEqual({ window: 200_000, assumed: true, source: 'default' });
});

test('[1m] tag forces 1M even on an id the table says is 200k', () => {
  const r = resolve('claude-3-5-sonnet-20241022[1m]');
  expect(r).toEqual({ window: 1_000_000, assumed: false, source: 'tag' });
});

test('[1m] tag on a fully unrecognized id still forces 1M', () => {
  const r = resolve('some-future-model[1m]');
  expect(r).toEqual({ window: 1_000_000, assumed: false, source: 'tag' });
});

test('resolution order: CLAUDE_CODE_MAX_CONTEXT_TOKENS env beats the [1m] tag', () => {
  const r = resolve('unknown-model[1m]', { CLAUDE_CODE_MAX_CONTEXT_TOKENS: '999' });
  expect(r).toEqual({ window: 999, assumed: false, source: 'override' });
});

test('resolution order: env override beats a known table entry too', () => {
  const r = resolve('claude-sonnet-5', { CLAUDE_CODE_MAX_CONTEXT_TOKENS: '42' });
  expect(r).toEqual({ window: 42, assumed: false, source: 'override' });
});

test('resolution order: a settings-level per-model override beats env', () => {
  const dir = freshDir();
  fs.writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify({ ctxWindowOverrides: { 'claude-sonnet-5': 12345 } })
  );
  const r = runInChild(
    `const {resolveCtxWindow}=await import('./server/lib/ctx-window.js');` +
      `emit(resolveCtxWindow('claude-sonnet-5'));`,
    { ARIGAMI_DIR: dir, ARIGAMI_PORT: '', CLAUDE_CODE_MAX_CONTEXT_TOKENS: '999' }
  );
  expect(r.ok).toBe(true);
  expect(r.out[0]).toEqual({ window: 12345, assumed: false, source: 'override' });
});

test('invalid CLAUDE_CODE_MAX_CONTEXT_TOKENS (non-numeric/zero) is ignored', () => {
  expect(resolve('claude-nova-9000', { CLAUDE_CODE_MAX_CONTEXT_TOKENS: 'nope' }).source).toBe('default');
  expect(resolve('claude-nova-9000', { CLAUDE_CODE_MAX_CONTEXT_TOKENS: '0' }).source).toBe('default');
});

function resolveCatalog(model, catalog, env = {}) {
  const r = runInChild(
    `const {resolveCtxWindow}=await import('./server/lib/ctx-window.js');` +
      `emit(resolveCtxWindow(${JSON.stringify(model)},${JSON.stringify(catalog)}));`,
    { ARIGAMI_DIR: freshDir(), ARIGAMI_PORT: '', ...env }
  );
  expect(r.ok).toBe(true);
  return r.out[0];
}

test('codex catalog: the model row\'s context window wins; the claude env knob does not apply', () => {
  const cat = [{ id: 'gpt-5.6-terra', contextWindow: 258_400 }, { id: 'gpt-5.5', contextWindow: null }];
  expect(resolveCatalog('gpt-5.6-terra', cat, { CLAUDE_CODE_MAX_CONTEXT_TOKENS: '999' })).toEqual({ window: 258_400, assumed: false, source: 'catalog' });
  expect(resolveCatalog('gpt-5.5', cat)).toEqual({ window: 200_000, assumed: true, source: 'default' });
  expect(resolveCatalog(null, cat)).toEqual({ window: 200_000, assumed: true, source: 'default' });
});
