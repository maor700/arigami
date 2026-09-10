#!/usr/bin/env bun
// `bun run release <patch|minor|major|X.Y.Z|auto> [--dry-run] [--no-commit] [--since <ref>]`
//
// The one place a version is minted. Source of truth: package.json `version`,
// mirrored to VERSION (a plain file the host / Docker builds read without
// parsing JSON) and to every other file that carries the number — see
// MIRRORED: the web + control-plane packages, the desktop app's
// tauri.conf.json (what the About dialog and the installers say) and the
// control-plane chart's appVersion. CHANGELOG.md gets a section
// rendered from the conventional commits since the last `v*` tag
// (feat/fix/refactor/docs/test/chore/perf/ci/build…, subjects verbatim — the
// Hebrew titles in this repo stay as they are). Then one commit
// `chore(release): vX.Y.Z` and an annotated tag `vX.Y.Z`. A human running this
// still has to `git push --follow-tags` themselves; the tag push is what makes
// .github/workflows/release.yml publish the GitHub Release + images.
//
// `auto` picks the bump from the same conventional commits instead of the
// human naming it: any breaking-change commit → major, else any `feat` →
// minor, else `patch`. It exits 3 (no files touched) when there is nothing
// releasable since the last tag — that is not an error, just "skip". This is
// what .github/workflows/version-bump.yml runs unattended on every push to
// master: it commits + tags with the bot's own git identity, pushes with
// `--follow-tags`, then `gh workflow run release.yml --ref vX.Y.Z` (a
// workflow_dispatch call — the one event GITHUB_TOKEN pushes are still
// allowed to trigger — because the tag push itself, being GITHUB_TOKEN-
// authored, does NOT auto-fire release.yml's `on.push.tags`).
//
// `bun scripts/release.ts notes vX.Y.Z` prints that version's CHANGELOG
// section (what release.yml uses as the GitHub Release body).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export type Bump = 'patch' | 'minor' | 'major';
export interface Commit { sha: string; subject: string; body: string }
export interface Parsed extends Commit { type: string; scope: string | null; breaking: boolean; title: string }

// section order + heading per conventional type; anything else → 'other'.
export const SECTIONS: { key: string; title: string; types: string[] }[] = [
  { key: 'breaking', title: 'Breaking', types: [] },
  { key: 'feat', title: 'Features', types: ['feat'] },
  { key: 'fix', title: 'Fixes', types: ['fix', 'hotfix'] },
  { key: 'perf', title: 'Performance', types: ['perf'] },
  { key: 'refactor', title: 'Refactoring', types: ['refactor', 'style'] },
  { key: 'docs', title: 'Docs', types: ['docs'] },
  { key: 'test', title: 'Tests', types: ['test'] },
  { key: 'chore', title: 'Chores', types: ['chore', 'build', 'ci', 'deps'] },
  { key: 'other', title: 'Other', types: [] },
];

/**
 * Every file that carries the version, package.json first (the source of
 * truth). A `Chart.yaml` gets its `appVersion` rewritten, everything else its
 * `"version"` field. Missing files are skipped, so this list is safe to keep
 * ahead of the repo. `deploy/helm/arigami-tenant` is deliberately absent: its
 * appVersion is "latest" on purpose.
 */
export const MIRRORED = [
  'package.json',
  'web/package.json',
  'control-plane/package.json',
  'desktop/src-tauri/tauri.conf.json', // the desktop app's user-visible version
  'desktop/src-tauri/Cargo.toml', // the desktop crate itself
  'desktop/src-tauri/Cargo.lock', // ...and its own entry in the lock, so a build does not dirty it
  'deploy/helm/arigami-control-plane/Chart.yaml', // appVersion only
];

export function isSemver(s: string): boolean { return /^\d+\.\d+\.\d+$/.test(s); }

/** Pick a bump from conventional commits: any breaking → major, else any feat → minor, else patch. */
export function autoBump(commits: Commit[]): Bump {
  const parsed = commits.filter((c) => !isNoise(c)).map(parseConventional);
  if (parsed.some((p) => p.breaking)) return 'major';
  if (parsed.some((p) => p.type === 'feat')) return 'minor';
  return 'patch';
}

/**
 * While the major is 0 nothing is promised to be stable, so a breaking change
 * moves the minor (0.1.x → 0.2.0) instead of minting 1.0.0. Calling something
 * 1.0.0 is a statement about the project, not about one commit — it stays a
 * human decision (`bun run release major`), never the bot's.
 */
export function clampZeroVer(bump: Bump, current: string): Bump {
  return bump === 'major' && /^0\./.test(current) ? 'minor' : bump;
}

export function bumpVersion(current: string, bump: Bump | string): string {
  if (isSemver(bump)) return bump;
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(current);
  if (!m) throw new Error(`current version is not semver: ${current}`);
  const [maj, min, pat] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (bump === 'major') return `${maj + 1}.0.0`;
  if (bump === 'minor') return `${maj}.${min + 1}.0`;
  if (bump === 'patch') return `${maj}.${min}.${pat + 1}`;
  throw new Error(`unknown bump "${bump}" — patch | minor | major | X.Y.Z`);
}

/** "feat(ext)!: title" → {type, scope, breaking, title}; a non-conventional subject → type 'other'. */
export function parseConventional(c: Commit): Parsed {
  const m = /^([A-Za-z]+)(?:\(([^)]*)\))?(!)?:\s+(.+)$/.exec(c.subject.trim());
  const breakingBody = /(^|\n)BREAKING[ -]CHANGE/i.test(c.body || '');
  if (!m) return { ...c, type: 'other', scope: null, breaking: breakingBody, title: c.subject.trim() };
  return { ...c, type: m[1].toLowerCase(), scope: m[2] || null, breaking: !!m[3] || breakingBody, title: m[4].trim() };
}

/** Skip merge commits (their parts are listed on their own) and the release commits themselves. */
export function isNoise(c: Commit): boolean {
  const s = c.subject.trim();
  return /^Merge\b/.test(s) || /^chore\(release\):/.test(s);
}

export function groupCommits(commits: Commit[]): Map<string, Parsed[]> {
  const out = new Map<string, Parsed[]>();
  for (const c of commits) {
    if (isNoise(c)) continue;
    const p = parseConventional(c);
    const key = p.breaking ? 'breaking' : (SECTIONS.find((s) => s.types.includes(p.type))?.key ?? 'other');
    if (!out.has(key)) out.set(key, []);
    out.get(key)!.push(p);
  }
  return out;
}

export interface RenderOpts { version: string; date: string; previousTag: string | null; repoUrl: string | null }

export function renderSection(commits: Commit[], o: RenderOpts): string {
  const groups = groupCommits(commits);
  const tag = `v${o.version}`;
  const compare = o.repoUrl && o.previousTag ? ` — [${o.previousTag}...${tag}](${o.repoUrl}/compare/${o.previousTag}...${tag})` : '';
  const lines = [`## ${tag} — ${o.date}${compare}`, ''];
  let any = false;
  for (const s of SECTIONS) {
    const items = groups.get(s.key);
    if (!items?.length) continue;
    any = true;
    lines.push(`### ${s.title}`, '');
    for (const p of items) {
      const scope = p.scope ? `**${p.scope}:** ` : '';
      const link = o.repoUrl ? `[${p.sha.slice(0, 7)}](${o.repoUrl}/commit/${p.sha})` : p.sha.slice(0, 7);
      lines.push(`- ${scope}${p.title} (${link})`);
    }
    lines.push('');
  }
  if (!any) lines.push('_No changes since the previous release._', '');
  return lines.join('\n');
}

export const CHANGELOG_HEADER = '# Changelog\n\nAll notable changes to Arigami. Generated by `bun run release` from conventional commits; newest first.\n\n';

/** Insert a new section right above the first existing `## ` heading (or at the end). */
export function insertSection(changelog: string, section: string): string {
  const base = changelog.trim() ? changelog : CHANGELOG_HEADER;
  const i = base.search(/^## /m);
  if (i < 0) return base.replace(/\s*$/, '\n\n') + section;
  return base.slice(0, i) + section + '\n' + base.slice(i);
}

/** The `## vX.Y.Z …` block of an existing CHANGELOG.md (for the GitHub Release body). */
export function extractSection(changelog: string, version: string): string | null {
  const v = version.replace(/^v/, '');
  const re = new RegExp(`^## v${v.replace(/\./g, '\\.')}\\b[^\\n]*\\n`, 'm');
  const m = re.exec(changelog);
  if (!m) return null;
  const rest = changelog.slice(m.index + m[0].length);
  const next = rest.search(/^## /m);
  return (m[0] + (next < 0 ? rest : rest.slice(0, next))).trim() + '\n';
}

/** Replace the first `"version": "…"` in a package.json text, keeping its formatting. */
export function setPackageVersion(text: string, version: string): string {
  return text.replace(/("version"\s*:\s*")[^"]*(")/, `$1${version}$2`);
}

/**
 * Helm's `appVersion` is "the version of the app this chart deploys", so it
 * should follow the release — but ONLY when it is a version. The tenant chart
 * deliberately says `appVersion: "latest"` (it tracks the rolling image, not a
 * number) and pinning that to a release would quietly change what the chart
 * deploys. So: rewrite a semver, leave anything else exactly as it is.
 * The chart's own `version:` is untouched — that is the chart's revision, a
 * different thing that the chart's maintainer bumps.
 */
export function setChartAppVersion(text: string, version: string): string {
  // [ \t] and not \s: \s includes \n, and a greedy \s*$ would swallow the
  // file's trailing newline when appVersion is the last line.
  return text.replace(/^(appVersion:[ \t]*"?)(\d+\.\d+\.\d+[^"\s]*)("?)[ \t]*$/m, `$1${version}$3`);
}

/**
 * The desktop crate's own `version` in Cargo.toml. Line-anchored and first
 * match only: `[package]` opens the file, and a dependency's version is never
 * at the start of a line (it lives inside `name = { version = "..." }`), so
 * this cannot reach one.
 */
export function setCargoVersion(text: string, version: string): string {
  return text.replace(/^(version[ \t]*=[ \t]*")[^"]*(")/m, `$1${version}$2`);
}

/**
 * The same crate's entry in Cargo.lock. Only that one entry — every other
 * `version =` in the file belongs to a dependency. Without this, the first
 * `cargo build` after a release rewrites the lock itself and leaves the
 * checkout dirty (and `--locked` would simply fail).
 */
export function setCargoLockVersion(text: string, version: string, crate = 'arigami-desktop'): string {
  return text.replace(
    new RegExp(`(\\[\\[package\\]\\]\\nname = "${crate}"\\nversion = ")[^"]*(")`),
    `$1${version}$2`,
  );
}

/** Which rewriter a MIRRORED path needs — package.json shape unless it is something else. */
function rewriterFor(sub: string): (text: string, version: string) => string {
  if (sub.endsWith('Chart.yaml')) return setChartAppVersion;
  if (sub.endsWith('Cargo.toml')) return setCargoVersion;
  if (sub.endsWith('Cargo.lock')) return setCargoLockVersion;
  return setPackageVersion;
}

export function repoUrlFromPackage(pkg: { repository?: { url?: string } | string }): string | null {
  const raw = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url || '';
  const m = /github\.com[/:]([^/]+)\/([^/.]+)/.exec(raw);
  return m ? `https://github.com/${m[1]}/${m[2]}` : null;
}

/** YYYY-MM-DD in the machine's local zone (the day the human is on, not UTC's). */
export function localDate(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ---- git plumbing --------------------------------------------------------------

function git(args: string[], cwd: string): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${(r.stderr || '').trim()}`);
  return r.stdout;
}

export function lastTag(cwd: string): string | null {
  const r = spawnSync('git', ['describe', '--tags', '--abbrev=0', '--match', 'v*'], { cwd, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() || null : null;
}

/** The commit that last wrote VERSION — where the version now in package.json was minted. */
export function lastVersionCommit(cwd: string): string | null {
  const r = spawnSync('git', ['log', '--format=%H', '-1', '--', 'VERSION'], { cwd, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() || null : null;
}

/**
 * Where "since the last release" starts, for `auto`. Normally the last `v*`
 * tag. But a version can exist without a tag — this repo's own v0.1.0 was
 * hand-written into VERSION/CHANGELOG by the VER1 commit and never tagged, and
 * with no tag `commitsSince(null)` means the entire history, which would make
 * the first automated release render a changelog of everything ever. So when
 * there is no tag, fall back to the commit that last wrote VERSION: the
 * changelog then covers exactly what landed since the current version was
 * minted. Only `auto` uses this; a human's explicit `--since` always wins, and
 * the manual `bun run release patch` path is unchanged.
 */
export function releaseBoundary(cwd: string): { ref: string | null; fromTag: boolean } {
  const tag = lastTag(cwd);
  if (tag) return { ref: tag, fromTag: true };
  return { ref: lastVersionCommit(cwd), fromTag: false };
}

export function commitsSince(cwd: string, since: string | null): Commit[] {
  const range = since ? `${since}..HEAD` : 'HEAD';
  const out = git(['log', range, '--format=%H%x1f%s%x1f%b%x1e'], cwd);
  return out.split('\x1e').map((s) => s.trim()).filter(Boolean).map((rec) => {
    const [sha, subject, body] = rec.split('\x1f');
    return { sha, subject: subject || '', body: body || '' };
  });
}

function dirtyTracked(cwd: string): string[] {
  return git(['status', '--porcelain'], cwd).split('\n').filter((l) => l.trim() && !l.startsWith('??'));
}

// ---- CLI -----------------------------------------------------------------------

export function usage(): string {
  return [
    'usage: bun run release <patch|minor|major|X.Y.Z|auto> [--dry-run] [--no-commit] [--since <ref>]',
    '       bun scripts/release.ts notes <vX.Y.Z>',
    '',
    '  auto         pick patch/minor/major from the conventional commits since the last tag;',
    '               exits 3 (nothing written) when there is nothing releasable',
    '  --dry-run    print the CHANGELOG section + what would change; touch nothing',
    '  --no-commit  write the files, skip the commit + tag',
    '  --since REF  changelog from REF instead of the last v* tag (first release: --since <sha>)',
  ].join('\n');
}

/** `auto` found nothing releasable. Exit code, not an error — version-bump.yml treats it as a skip. */
export const NOTHING_TO_RELEASE = 3;

export function main(argv: string[], root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')): number {
  const args = [...argv];
  const flag = (name: string) => { const i = args.indexOf(name); if (i < 0) return false; args.splice(i, 1); return true; };
  const opt = (name: string) => { const i = args.indexOf(name); if (i < 0) return null; const v = args[i + 1] ?? null; args.splice(i, 2); return v; };
  const dryRun = flag('--dry-run');
  const noCommit = flag('--no-commit');
  const since = opt('--since');
  const [cmd, arg] = args;

  const pkgPath = path.join(root, 'package.json');
  const pkgText = fs.readFileSync(pkgPath, 'utf8');
  const pkg = JSON.parse(pkgText);
  const changelogPath = path.join(root, 'CHANGELOG.md');
  const changelog = fs.existsSync(changelogPath) ? fs.readFileSync(changelogPath, 'utf8') : '';

  if (cmd === 'notes') {
    if (!arg) { console.error(usage()); return 2; }
    const s = extractSection(changelog, arg);
    if (!s) { console.error(`no CHANGELOG.md section for ${arg}`); return 1; }
    process.stdout.write(s);
    return 0;
  }
  if (!cmd || cmd === '--help' || cmd === '-h') { console.log(usage()); return cmd ? 0 : 2; }

  const current = String(pkg.version || '0.0.0');
  // `auto` falls back to the commit that minted VERSION when no v* tag exists;
  // every other path keeps the original "last tag, or the whole history" rule.
  const boundary = cmd === 'auto' ? releaseBoundary(root) : { ref: lastTag(root), fromTag: true };
  const prev = since ?? boundary.ref;
  const commits = commitsSince(root, prev);

  let bump: string = cmd;
  if (cmd === 'auto') {
    const releasable = commits.filter((c) => !isNoise(c));
    const from = since ? since : (boundary.ref ? (boundary.fromTag ? boundary.ref : `${boundary.ref.slice(0, 7)} (VERSION was last written there — no v* tag yet)`) : 'the first commit');
    if (!releasable.length) {
      console.log(`nothing to release since ${from} — skipping`);
      return NOTHING_TO_RELEASE;
    }
    const raw = autoBump(commits);
    bump = clampZeroVer(raw, current);
    if (bump !== raw) console.log(`auto: a breaking change, but ${current} is pre-1.0 — minor, not major (1.0.0 stays a human call)`);
    console.log(`auto: ${releasable.length} commit(s) since ${from} → ${bump}`);
  }

  const next = bumpVersion(current, bump);
  const tag = `v${next}`;
  // A compare link needs a tag on both ends; a raw-SHA boundary gets no link.
  const section = renderSection(commits, { version: next, date: localDate(), previousTag: since || !boundary.fromTag ? null : prev, repoUrl: repoUrlFromPackage(pkg) });

  const files = [...MIRRORED, 'VERSION', 'CHANGELOG.md'].filter((f) => f === 'VERSION' || f === 'CHANGELOG.md' || fs.existsSync(path.join(root, f)));
  console.log(`release: ${current} → ${next} (${tag})`);
  console.log(`changelog: ${commits.filter((c) => !isNoise(c)).length} commits since ${prev ?? 'the first commit'}`);
  console.log(`files: ${files.join(', ')}`);
  console.log('');
  console.log(section);

  if (dryRun) { console.log('(dry run — nothing written, no commit, no tag)'); return 0; }

  if (!noCommit) {
    const dirty = dirtyTracked(root);
    if (dirty.length) { console.error(`refusing: uncommitted changes —\n${dirty.join('\n')}`); return 1; }
    if (spawnSync('git', ['rev-parse', '-q', '--verify', `refs/tags/${tag}`], { cwd: root }).status === 0) { console.error(`refusing: tag ${tag} already exists`); return 1; }
  }

  fs.writeFileSync(pkgPath, setPackageVersion(pkgText, next));
  for (const sub of MIRRORED.slice(1)) {
    const p = path.join(root, sub);
    if (!fs.existsSync(p)) continue;
    const rewrite = rewriterFor(sub);
    fs.writeFileSync(p, rewrite(fs.readFileSync(p, 'utf8'), next));
  }
  fs.writeFileSync(path.join(root, 'VERSION'), `${next}\n`);
  fs.writeFileSync(changelogPath, insertSection(changelog, section));

  if (noCommit) { console.log('written (no commit, no tag)'); return 0; }
  git(['add', ...files], root);
  git(['commit', '-q', '-m', `chore(release): ${tag}`], root);
  git(['tag', '-a', tag, '-m', `${tag}\n\n${section}`], root);
  console.log(`committed + tagged ${tag}. Not pushed — when ready: git push --follow-tags`);
  return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
