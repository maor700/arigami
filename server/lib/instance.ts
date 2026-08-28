// Instance identity (T5). One arigami host == one ARIGAMI_DIR. EVERY file,
// process, port and X display the host creates or kills belongs to that
// identity and nothing else — a second instance on the same machine must be
// unable to touch the first one's state or children.
//
// This module is the single source of truth for "where is my directory" and
// "who am I". It deliberately imports nothing but platform.js so the lowest
// layers (children.ts, secrets.ts, push.ts) can use it without dragging in
// config/state.
import path from 'node:path';
import { HOME, tilde } from './platform.js';

/** Where this instance keeps everything. `ARIGAMI_DIR` env, default `~/.arigami`. */
export const ARIGAMI_DIR: string = path.resolve(tilde(process.env.ARIGAMI_DIR || '~/.arigami'));

/** The historical location. The default instance owns the global desktop and the unshifted port/display ranges. */
export const DEFAULT_ARIGAMI_DIR: string = path.resolve(path.join(HOME, '.arigami'));

export const IS_DEFAULT_INSTANCE: boolean = ARIGAMI_DIR === DEFAULT_ARIGAMI_DIR;

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
