// CHG1: pure decision logic for the Changes tab's mode selection — split out
// of ChangesTab.jsx so it's testable without rendering React (state.js has no
// server-independent test harness for hooks-over-time).

// The mode a session's Changes tab should open on when nothing was chosen yet.
// A host-managed child worktree (F7: metadata.base + metadata.worktree) has a
// canonical "this session's work" view (base..HEAD + working tree) — anything
// else is a plain session and keeps today's default. A PR review session opens on 'pr'.
export function defaultChangesMode(session) {
  // A review session created from a PR (metadata.pr / prNumber): the changes that matter
  // are the PR's — head vs the branch it targets.
  if (session?.metadata?.prNumber || session?.metadata?.pr) return 'pr';
  return session?.metadata?.base && session?.metadata?.worktree ? 'work' : 'uncommitted';
}

// The most recently generated explanation across all modes, or null.
export function newestExplanation(explanations) {
  return (
    ['work', 'uncommitted', 'pr']
      .map((m) => explanations?.[m])
      .filter(Boolean)
      .sort((a, b) => (b.generatedAt || '').localeCompare(a.generatedAt || ''))[0] || null
  );
}

// Whether a fresh explanation should be OFFERED to the user (never applied
// automatically — the tab must never jump out from under someone mid-read).
// `explanations` is session.changesExplanations ({uncommitted,pr,work} →
// {mode, generatedAt, ...}); `current` is the mode currently being viewed;
// `lastSeenAt` is the generatedAt this hook last acted on (undefined = first
// run / mount, which must never itself trigger an offer).
// Returns {mode, generatedAt} to offer, or null.
export function explanationSwitchOffer(explanations, current, lastSeenAt) {
  const newest = newestExplanation(explanations);
  const g = newest?.generatedAt || null;
  if (lastSeenAt === undefined) return null; // mount baseline — no offer
  if (!g || g === lastSeenAt) return null; // nothing new
  if (newest.mode === current) return null; // already viewing it — no offer needed
  return { mode: newest.mode, generatedAt: g };
}

// ---- base picker -----------------------------------------------------------
// Which ref the pr/work diff is compared against. '' = "server default", which
// follows the session's PR target or original parent. Saved choices belong to
// one session; the old browser-wide choice must not leak into other sessions.
export const CHANGES_BASE_KEY = 'arigami-changes-base';

export function loadDefaultBase(storage = globalThis.localStorage, sessionId) {
  try {
    return sessionId ? String(storage?.getItem(`${CHANGES_BASE_KEY}:${sessionId}`) || '') : '';
  } catch {
    return '';
  }
}

export function saveDefaultBase(base, storage = globalThis.localStorage, sessionId) {
  try {
    if (!sessionId) return;
    const key = `${CHANGES_BASE_KEY}:${sessionId}`;
    if (base) storage?.setItem(key, base);
    else storage?.removeItem(key);
  } catch {
    /* private mode / quota — the pick still applies for this tab */
  }
}

// Query string for /changes, /changes/diff and /changes/refs. The base only
// applies to the pr/work comparisons — 'uncommitted' is always vs HEAD.
export function changesQuery(mode, base) {
  const q = `mode=${encodeURIComponent(mode)}`;
  return base && mode !== 'uncommitted' ? `${q}&base=${encodeURIComponent(base)}` : q;
}

// Case-insensitive substring filter for the base picker's search box.
export function filterBaseRefs(refs, query) {
  const q = String(query || '').trim().toLowerCase();
  return q ? (refs || []).filter((r) => r.toLowerCase().includes(q)) : refs || [];
}
