// Stable identity of a Profile-Bundle cron job across export → import hops
// (F4 #2). Lives here, import-free, because backup.ts and profiles.ts both
// need it and backup.ts is also a CLI entry (a dynamic import of a module
// that is still awaiting its own top level deadlocks).

/** "[bundle-name] " prefix profiles.ts puts on registered cron triggers. */
export const CRON_TAG_RE = /^\[[a-z0-9-]+\]\s+/;

/** "<bundle>/<slug of name>", e.g. "solo-dev/standup". */
export function cronBundleKey(bundle: string, name: string): string {
  const slug = String(name || 'cron').replace(CRON_TAG_RE, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'cron';
  return `${bundle}/${slug}`;
}
