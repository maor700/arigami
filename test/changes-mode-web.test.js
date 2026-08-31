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
