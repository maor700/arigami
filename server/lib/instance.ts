// Instance identity (T5). One arigami host == one ARIGAMI_DIR. EVERY file,
// process, port and X display the host creates or kills belongs to that
// identity and nothing else — a second instance on the same machine must be
// unable to touch the first one's state or children.
//
// This module is the single source of truth for "where is my directory" and
// "who am I". It deliberately imports nothing but platform.js so the lowest
// layers (children.ts, secrets.ts, push.ts) can use it without dragging in
// config/state.
import os from 'node:os';
import path from 'node:path';
import { HOME, tilde } from './platform.js';

/** The historical location. The default instance owns the global desktop and the unshifted port/display ranges. */
export const DEFAULT_ARIGAMI_DIR: string = path.resolve(path.join(HOME, '.arigami'));

const EXPLICIT_DIR: string | undefined = process.env.ARIGAMI_DIR?.trim() || undefined;

/**
 * Under a test runner, an unset ARIGAMI_DIR must NOT fall through to the real
 * ~/.arigami. It used to, and the damage was invisible for months: a test file
 * that isolated only ARIGAMI_STATE_FILE — or one that imported a
 * path-resolving module before another file had a chance to set the env — wrote
 * straight into the developer's live instance. Found on a real machine with 156
 * sessions and 36 folders of fixture debris in ~/.arigami/state.json
 * (`scratch-1`, `c0`..`c6`, `grp`, `rr`, `kept`, `New folder` — the last six
 * repeated exactly six times, once per suite run). It also silently broke the
 * suite itself: core.test.js asserts the first session is `scratch-1` and got
 * `scratch-6`, which read as a flake and was really this.
 *
 * `NODE_ENV=test` is set by `bun test` (verified) and by every other runner
 * worth caring about. Redirecting is deliberate rather than throwing: a throw
 * here would turn a hundred passing tests red at once for a problem none of
 * them individually caused. The warning names the escape hatch so a test that
 * genuinely wants a shared dir can say so out loud.
 */
function resolveInstanceDir(): string {
  if (EXPLICIT_DIR) return path.resolve(tilde(EXPLICIT_DIR));
  if (process.env.NODE_ENV === 'test') {
    // os.tmpdir(), not $TMPDIR: Windows sets TEMP/TMP and never TMPDIR, so the
    // env read would have fallen through to a literal '/tmp' there.
    const tmp = os.tmpdir();
    const dir = path.join(tmp, `arigami-test-instance-${process.pid}`);
    console.warn(
      `[instance] NODE_ENV=test with no ARIGAMI_DIR — using ${dir} instead of ${DEFAULT_ARIGAMI_DIR}. ` +
        'Set ARIGAMI_DIR explicitly to choose your own.',
    );
    return dir;
  }
  return path.resolve(tilde('~/.arigami'));
}

/** Where this instance keeps everything. `ARIGAMI_DIR` env, default `~/.arigami`. */
export const ARIGAMI_DIR: string = resolveInstanceDir();

/**
 * "Default instance" means "did not ask for its own directory" — NOT "resolved
 * to the default path". Those were the same thing before the test redirect
 * above existed; keeping the path comparison would have made every test a
 * non-default instance, silently shifting every port by PORT_SHIFT and every
 * display by DISPLAY_SHIFT out from under assertions that hardcode the
 * unshifted values.
 */
export const IS_DEFAULT_INSTANCE: boolean =
  !EXPLICIT_DIR || path.resolve(tilde(EXPLICIT_DIR)) === DEFAULT_ARIGAMI_DIR;

/**
 * True only when ARIGAMI_DIR *is literally* the historical ~/.arigami path.
 *
 * Deliberately NOT the same question as IS_DEFAULT_INSTANCE, and conflating
 * the two is a live trap: config.ts derives `stateFile` from a token that is
 * the string '~/.arigami' for the default instance, so a test that keeps
 * IS_DEFAULT_INSTANCE true (it must, or every port assertion shifts by 1000)
 * would still write its state into the developer's real instance. Anything
 * building a PATH wants this flag; anything computing a port/display OFFSET
 * wants IS_DEFAULT_INSTANCE.
 */
export const AT_DEFAULT_DIR: boolean = ARIGAMI_DIR === DEFAULT_ARIGAMI_DIR;

/** Offsets applied to every default port range / display base for a non-default instance, so two instances that both run on defaults still don't collide (spec T5 §3). */
export const PORT_SHIFT: number = IS_DEFAULT_INSTANCE ? 0 : 1000;
export const DISPLAY_SHIFT: number = IS_DEFAULT_INSTANCE ? 0 : 100;

/** Pure: the identity string recorded on every child record and in host.json. */
export function makeHostId(dir: string, port: number): string {
  return `${path.resolve(dir)}#${port}`;
}

export const RUN_DIR: string = path.join(ARIGAMI_DIR, 'run');
export const HOST_PID_FILE: string = path.join(RUN_DIR, 'host.pid');
export const HOST_INFO_FILE: string = path.join(RUN_DIR, 'host.json');
