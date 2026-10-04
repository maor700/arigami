// CHG1 — pure decision logic behind the Changes tab's mode switching, tested
// without rendering React: an arriving explanation must never silently switch
// the view the user is looking at, only OFFER a switch (see ChangesTab.jsx's
// switchOffer). defaultChangesMode governs which mode a fresh tab opens on.
import { test, expect } from 'bun:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { defaultChangesMode, explanationSwitchOffer, newestExplanation } = await import(
  path.join(ROOT, 'web/src/lib/changesMode.js')
);

// ---- defaultChangesMode -----------------------------------------------------

test('defaultChangesMode: "work" only for a session with both metadata.base and metadata.worktree', () => {
  expect(defaultChangesMode({ metadata: { base: 'master', worktree: '/x' } })).toBe('work');
  expect(defaultChangesMode({ metadata: { base: 'master' } })).toBe('uncommitted'); // no worktree
  expect(defaultChangesMode({ metadata: { worktree: '/x' } })).toBe('uncommitted'); // no base
  expect(defaultChangesMode({ metadata: {} })).toBe('uncommitted');
  expect(defaultChangesMode({})).toBe('uncommitted');
  expect(defaultChangesMode(null)).toBe('uncommitted');
});

// ---- explanationSwitchOffer: never auto-switches ----------------------------

const at = (iso, mode) => ({ generatedAt: iso, mode });

test('mount baseline (lastSeenAt undefined) never offers a switch, even with an existing explanation', () => {
  const explanations = { pr: at('2026-08-31T10:00:00Z', 'pr') };
  expect(explanationSwitchOffer(explanations, 'uncommitted', undefined)).toBeNull();
});

test('a fresh explanation for a DIFFERENT mode than the one being viewed offers a switch — does not apply one', () => {
  const explanations = { work: at('2026-08-31T10:00:00Z', 'work') };
  const offer = explanationSwitchOffer(explanations, 'uncommitted', null);
  expect(offer).toEqual({ mode: 'work', generatedAt: '2026-08-31T10:00:00Z' });
});

test('a fresh explanation for the mode ALREADY being viewed offers nothing (no jump needed)', () => {
  const explanations = { uncommitted: at('2026-08-31T10:00:00Z', 'uncommitted') };
  expect(explanationSwitchOffer(explanations, 'uncommitted', null)).toBeNull();
});

test('an explanation already seen (same generatedAt) offers nothing again', () => {
  const explanations = { pr: at('2026-08-31T10:00:00Z', 'pr') };
  expect(explanationSwitchOffer(explanations, 'uncommitted', '2026-08-31T10:00:00Z')).toBeNull();
});

test('no explanations at all offers nothing', () => {
  expect(explanationSwitchOffer({}, 'uncommitted', null)).toBeNull();
  expect(explanationSwitchOffer(undefined, 'uncommitted', null)).toBeNull();
});

test('when several modes have explanations, the offer is the newest one — and only if it differs from the current view', () => {
  const explanations = {
    uncommitted: at('2026-08-31T09:00:00Z', 'uncommitted'),
    pr: at('2026-08-31T11:00:00Z', 'pr'),
    work: at('2026-08-31T10:00:00Z', 'work'),
  };
  expect(explanationSwitchOffer(explanations, 'work', null)).toEqual({ mode: 'pr', generatedAt: '2026-08-31T11:00:00Z' });
  expect(explanationSwitchOffer(explanations, 'pr', null)).toBeNull(); // newest IS what's showing
});

test('newestExplanation picks the latest generatedAt across modes, or null when empty', () => {
  expect(newestExplanation({})).toBeNull();
  const explanations = { uncommitted: at('2026-08-31T09:00:00Z', 'uncommitted'), pr: at('2026-08-31T11:00:00Z', 'pr') };
  expect(newestExplanation(explanations)).toEqual({ generatedAt: '2026-08-31T11:00:00Z', mode: 'pr' });
});

// ---- base picker ------------------------------------------------------------

const { changesQuery, loadDefaultBase, saveDefaultBase } = await import(path.join(ROOT, 'web/src/lib/changesMode.js'));

test('changesQuery adds base only for pr/work, never for uncommitted', () => {
  expect(changesQuery('pr', '')).toBe('mode=pr');
  expect(changesQuery('pr', 'origin/main')).toBe('mode=pr&base=origin%2Fmain');
  expect(changesQuery('work', 'release/1.0')).toBe('mode=work&base=release%2F1.0');
  expect(changesQuery('uncommitted', 'origin/main')).toBe('mode=uncommitted');
});

test('default base round-trips through storage; empty clears it', () => {
  const mem = new Map();
  const storage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v), removeItem: (k) => mem.delete(k) };
  expect(loadDefaultBase(storage)).toBe('');
  saveDefaultBase('origin/develop', storage);
  expect(loadDefaultBase(storage)).toBe('origin/develop');
  saveDefaultBase('', storage);
  expect(loadDefaultBase(storage)).toBe('');
});

const { filterBaseRefs } = await import(path.join(ROOT, 'web/src/lib/changesMode.js'));

test('filterBaseRefs: case-insensitive substring match; empty query returns everything', () => {
  const refs = ['origin/main', 'origin/Release/1.0', 'feat/picker'];
  expect(filterBaseRefs(refs, '')).toEqual(refs);
  expect(filterBaseRefs(refs, '  REL ')).toEqual(['origin/Release/1.0']);
  expect(filterBaseRefs(refs, 'zzz')).toEqual([]);
  expect(filterBaseRefs(undefined, 'a')).toEqual([]);
});
