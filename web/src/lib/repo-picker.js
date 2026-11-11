// Pure logic of the repo picker (components/setup/RepoPicker.jsx) — kept apart so it is unit-testable without a DOM.

/** The request path for one page of the account's repos filtered by `q`. */
export function reposPath(q, page = 1) {
  const qs = new URLSearchParams();
  if (q && q.trim()) qs.set('q', q.trim());
  if (page > 1) qs.set('page', String(page));
  const s = qs.toString();
  return `/onboarding/github/repos${s ? `?${s}` : ''}`;
}

/** Merge a fetched page into the list: page 1 replaces, later pages append without duplicates. */
export function mergePage(prev, items, page) {
  if (page <= 1) return items;
  const seen = new Set(prev.map((r) => r.fullName));
  return [...prev, ...items.filter((r) => !seen.has(r.fullName))];
}

/** Keyboard navigation over `count` options; -1 = nothing highlighted. Wraps around. */
export function moveActive(active, key, count) {
  if (!count) return -1;
  if (key === 'ArrowDown') return active < 0 || active >= count - 1 ? 0 : active + 1;
  if (key === 'ArrowUp') return active <= 0 ? count - 1 : active - 1;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return active;
}

/** What picking a repo fills into the add-repo form. */
export function entryFromRepo(r) {
  return { name: r.name, source: r.fullName };
}

/** The error codes that mean "GitHub is not usable from here" (the picker hides its list, the URL box stays). */
export const SOFT_ERRORS = ['no_token', 'bad_token', 'rate_limited', 'forbidden', 'unreachable', 'error'];

/**
 * The name a repository gets when the user does not type one: the last path segment of its source
 * ("github.com/acme/web-app.git" → "web-app"; "/Users/me/src/app/" → "app"), reduced to what a repo name may hold.
 */
export function repoNameFromSource(source) {
  const seg = String(source || '')
    .trim()
    .replace(/[\\/]+$/, '')
    .replace(/\.git$/i, '')
    .split(/[\\/:]/)
    .pop();
  return String(seg || '').replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[-.]+/, '').slice(0, 64);
}
