// The shared desktop (:99 on Linux — the owner's own screen, with their real Chrome on it) is ONE machine that every
// session and the owner (over VNC) could otherwise click into at once. This is the host-owned lease on it:
//
//   - one HOLDER at a time; the rest wait in a FIFO queue and are woken with a "[host] …" message when their turn
//     comes — they never poll;
//   - the lease goes after IDLE_MS with no action, on an explicit release, when the session is deleted, and when the
//     owner presses "Release" in the cockpit;
//   - a holder waiting on the human (request_screen, any card) is PARKED: the machine passes to the next in line, the
//     holder's window stays where it is, and when the human answers the holder is back at the HEAD of the queue;
//   - the owner's own input on the screen PAUSES whoever holds it, until they have been quiet for HUMAN_QUIET_MS.
//
// The state machine below is pure (clock, messages and "is it waiting on a human?" are injected) so it is tested
// without a display. The host wiring — the X idle watcher, the [host] messages, the cockpit broadcast — is at the
// bottom. Input guards (keys, typing, launching) live here too: what an agent may do on the owner's screen.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { allowed as ssoAllowed, siteOf } from './sso.js';
import { hostOf } from './login-sites.js';

export const IDLE_MS = 60_000;
/** A session woken from the queue may be mid-turn; it gets longer for its first action. */
export const GRANT_GRACE_MS = 120_000;
/** The owner's input pauses the agent until they have been quiet this long. */
export const HUMAN_QUIET_MS = 8_000;
/** A parked holder whose human never answers loses its place after this (request_screen times out at ~30 min). */
export const PARK_MAX_MS = 40 * 60_000;

export interface Holder {
  sessionId: string;
  site: string | null;
  reason: string;
  since: number;
  lastAction: number;
  expiresAt: number;
}
interface Waiter {
  sessionId: string;
  site: string | null;
  reason: string;
  at: number;
  /** Back from a park: keeps its place at the head. */
  resume: boolean;
}
interface Parked {
  sessionId: string;
  site: string | null;
  reason: string;
  at: number;
  why: string;
}

export interface LeaseDeps {
  now: () => number;
  /** A "[host] …" line to a session (deliverToSession: now when idle, queued after the turn when busy). */
  notify: (sessionId: string, text: string) => void;
  /** Is the session waiting on the human — a request_screen or a card? */
  waitingOnHuman: (sessionId: string) => boolean;
  /** Something the cockpit shows changed. */
  changed?: (status: LeaseStatus) => void;
}

export interface LeaseStatus {
  holder: (Omit<Holder, 'expiresAt'> & { expiresInMs: number }) | null;
  queue: { sessionId: string; site: string | null; reason: string; at: number; resume: boolean }[];
  parked: { sessionId: string; site: string | null; reason: string; at: number; why: string }[];
  humanActive: boolean;
}

export type Gate =
  | { ok: true }
  | { ok: false; error: string; queued?: number; paused?: boolean; parked?: boolean; expired?: boolean };

export type AcquireResult =
  | { granted: true; already?: boolean; paused?: boolean; note: string }
  | { queued: true; position: number; holder: string; note: string };

const WAKE = (site: string | null) =>
  `[host] Your turn on the shared desktop${site ? ` (for ${site})` : ''}: you hold it now. ` +
  'The screen may have changed while you waited — take a desktop_screenshot({shared:true}) before acting. ' +
  `It goes back to the queue after ${IDLE_MS / 1000}s without an action; call shared_desktop_release as soon as you are done.`;

export class SharedDesktopLease {
  holder: Holder | null = null;
  queue: Waiter[] = [];
  parked = new Map<string, Parked>();
  humanUntil = 0;
  /** Sessions refused while the owner was on the screen: told when the owner is done. */
  private pausedSessions = new Set<string>();
  /** Sessions whose lease went idle: their next action says so instead of "acquire first". */
  private expired = new Set<string>();

  constructor(private deps: LeaseDeps) {}

  private now(): number {
    return this.deps.now();
  }

  humanActive(): boolean {
    return this.humanUntil > this.now();
  }

  private emit(): void {
    try {
      this.deps.changed?.(this.status());
    } catch {
      /* the cockpit view must not break the lease */
    }
  }

  private grant(w: { sessionId: string; site: string | null; reason: string }, grace = GRANT_GRACE_MS): Holder {
    const t = this.now();
    this.expired.delete(w.sessionId);
    this.holder = { sessionId: w.sessionId, site: w.site, reason: w.reason, since: t, lastAction: t, expiresAt: t + grace };
    return this.holder;
  }

  /** Hand the free machine to the head of the queue, and wake it. Waits while the owner is on the screen. */
  private advance(): void {
    if (this.holder || this.humanActive()) return;
    const next = this.queue.shift();
    if (!next) return;
    this.grant(next);
    this.deps.notify(next.sessionId, WAKE(next.site));
  }

  position(sessionId: string): number {
    return this.queue.findIndex((w) => w.sessionId === sessionId) + 1;
  }

  acquire(sessionId: string, site: string | null, reason = ''): AcquireResult {
    let out: AcquireResult;
    if (this.parked.has(sessionId)) this.unpark(sessionId);
    if (this.holder?.sessionId === sessionId) {
      if (site) this.holder.site = site;
      if (reason) this.holder.reason = reason;
      this.touch(sessionId);
      out = { granted: true, already: true, note: 'you already hold the shared desktop' };
    } else if (this.position(sessionId)) {
      const w = this.queue[this.position(sessionId) - 1];
      if (site) w.site = site;
      if (reason) w.reason = reason;
      out = this.queuedResult(sessionId);
    } else if (!this.holder && !this.queue.length) {
      this.grant({ sessionId, site, reason }, IDLE_MS);
      if (this.humanActive()) {
        this.pausedSessions.add(sessionId);
        out = { granted: true, paused: true, note: 'yours — but the owner is using the screen right now: stop and wait for the [host] message that they are done' };
      } else out = { granted: true, note: `yours: act with shared:true; it goes back after ${IDLE_MS / 1000}s without an action; shared_desktop_release when done` };
    } else {
      this.queue.push({ sessionId, site, reason, at: this.now(), resume: false });
      out = this.queuedResult(sessionId);
    }
    this.emit();
    return out;
  }

  private queuedResult(sessionId: string): AcquireResult {
    return {
      queued: true,
      position: this.position(sessionId),
      holder: this.holder?.sessionId || '',
      note: 'Another session has the shared desktop. Stop here and end your turn: the host messages you "[host] Your turn…" when it is yours. Do not poll, do not use xinput on it meanwhile.',
    };
  }

  /** An action of the holder happened: restart its idle clock. */
  touch(sessionId: string): void {
    if (this.holder?.sessionId !== sessionId) return;
    const t = this.now();
    this.holder.lastAction = t;
    this.holder.expiresAt = Math.max(this.holder.expiresAt, t + IDLE_MS);
  }

  /** May this session act (`input`) or look (`look`) on the shared desktop now? */
  check(sessionId: string, kind: 'input' | 'look'): Gate {
    const p = this.parked.get(sessionId);
    if (p && !this.deps.waitingOnHuman(sessionId)) this.unpark(sessionId);
    if (this.holder?.sessionId === sessionId) {
      if (kind === 'input' && this.humanActive()) {
        this.pausedSessions.add(sessionId);
        return { ok: false, paused: true, error: 'the owner is using the shared desktop right now — stop and end your turn; the host messages you "[host] …" when they are done' };
      }
      return { ok: true };
    }
    if (this.parked.has(sessionId)) {
      if (kind === 'look') return { ok: true };
      return { ok: false, parked: true, error: 'your lease is parked while the human answers you — wait for their answer; you get the desktop back first' };
    }
    const pos = this.position(sessionId);
    if (pos) return { ok: false, queued: pos, error: `you are #${pos} in the queue for the shared desktop — stop and wait for the "[host] Your turn…" message` };
    if (this.expired.has(sessionId))
      return { ok: false, expired: true, error: `your shared-desktop lease went back after ${IDLE_MS / 1000}s without an action — call shared_desktop_acquire again` };
    return { ok: false, error: 'you do not hold the shared desktop — call shared_desktop_acquire({site, reason}) first' };
  }

  release(sessionId: string): boolean {
    let did = false;
    if (this.holder?.sessionId === sessionId) {
      this.holder = null;
      did = true;
    }
    const before = this.queue.length;
    this.queue = this.queue.filter((w) => w.sessionId !== sessionId);
    did = this.parked.delete(sessionId) || did || this.queue.length !== before;
    this.pausedSessions.delete(sessionId);
    this.expired.delete(sessionId);
    this.advance();
    this.emit();
    return did;
  }

  /** The session is gone (deleted/archived): it holds and waits for nothing. */
  forget(sessionId: string): void {
    this.release(sessionId);
  }

  /** The owner pressed "Release" in the cockpit. */
  forceRelease(): string | null {
    const h = this.holder;
    if (!h) return null;
    this.holder = null;
    this.expired.add(h.sessionId);
    this.deps.notify(h.sessionId, '[host] The owner took the shared desktop back from you (Release in the cockpit). Do not act on it; call shared_desktop_acquire again if you still need it.');
    this.advance();
    this.emit();
    return h.sessionId;
  }

  /** The holder is waiting on the human: let others use the machine meanwhile. */
  park(sessionId: string, why: string): boolean {
    if (this.holder?.sessionId !== sessionId) return this.parked.has(sessionId);
    const h = this.holder;
    this.parked.set(sessionId, { sessionId, site: h.site, reason: h.reason, at: this.now(), why });
    this.holder = null;
    this.advance();
    this.emit();
    return true;
  }

  /** The human answered: back at the head of the queue (behind only others coming back from a park). */
  unpark(sessionId: string): void {
    const p = this.parked.get(sessionId);
    if (!p) return;
    this.parked.delete(sessionId);
    if (!this.holder && !this.queue.length && !this.humanActive()) {
      this.grant(p);
    } else {
      const at = this.queue.findIndex((w) => !w.resume);
      const w: Waiter = { sessionId, site: p.site, reason: p.reason, at: this.now(), resume: true };
      if (at < 0) this.queue.push(w);
      else this.queue.splice(at, 0, w);
      this.deps.notify(
        sessionId,
        `[host] While the human answered you, another session used the shared desktop; you are #${this.position(sessionId)} and first in line to get it back. ` +
          'Stop and wait for "[host] Your turn…". Your window was left open — if its sign-in page expired meanwhile, redo that step yourself.'
      );
    }
    this.emit();
  }

  /** Input on the screen that was not an agent's: the owner is driving. */
  noteHumanInput(): void {
    const was = this.humanActive();
    this.humanUntil = this.now() + HUMAN_QUIET_MS;
    if (!was) this.emit();
  }

  /** Timers: idle release / park, the end of a human pause, parked holders whose human answered. */
  tick(): void {
    const t = this.now();
    let dirty = false;
    if (this.humanUntil && t >= this.humanUntil) {
      this.humanUntil = 0;
      dirty = true;
      if (this.holder) this.holder.expiresAt = Math.max(this.holder.expiresAt, t + IDLE_MS);
      for (const id of this.pausedSessions)
        if (this.holder?.sessionId === id)
          this.deps.notify(id, '[host] The owner is done on the shared desktop — it is yours again. Take a desktop_screenshot({shared:true}) first: they may have moved things.');
      this.pausedSessions.clear();
      this.advance();
    }
    if (this.holder && this.humanActive()) this.holder.expiresAt = Math.max(this.holder.expiresAt, t + 1000);
    if (this.holder && t >= this.holder.expiresAt) {
      const id = this.holder.sessionId;
      if (this.deps.waitingOnHuman(id)) this.park(id, 'waiting on the human');
      else {
        this.holder = null;
        this.expired.add(id);
        this.advance();
      }
      dirty = true;
    }
    for (const p of [...this.parked.values()]) {
      if (t - p.at > PARK_MAX_MS) {
        this.parked.delete(p.sessionId);
        dirty = true;
      } else if (!this.deps.waitingOnHuman(p.sessionId)) {
        this.unpark(p.sessionId);
        dirty = true;
      }
    }
    if (dirty) this.emit();
  }

  /** Anything to watch: a holder, a queue or a parked holder. */
  active(): boolean {
    return !!(this.holder || this.queue.length || this.parked.size);
  }

  status(): LeaseStatus {
    const t = this.now();
    const h = this.holder;
    return {
      holder: h ? { sessionId: h.sessionId, site: h.site, reason: h.reason, since: h.since, lastAction: h.lastAction, expiresInMs: Math.max(0, h.expiresAt - t) } : null,
      queue: this.queue.map((w) => ({ ...w })),
      parked: [...this.parked.values()].map((p) => ({ ...p })),
      humanActive: this.humanActive(),
    };
  }
}

// ---- what an agent may do on the owner's screen -----------------------------------------------------------------
// The shared desktop shows the owner's REAL browser, driven by pixels (no DevTools port to read a url or a field
// from). So the guard is on what goes IN: navigation keys, URLs of the site the lease was taken for (or a sign-in
// provider), the owner's identity email — and text the human gave in the chat themselves. No passwords, no pastes.

const ALLOWED_KEYS = new Set([
  'return', 'enter', 'kp_enter', 'tab', 'shift+tab', 'escape', 'esc', 'backspace', 'delete', 'space',
  'up', 'down', 'left', 'right', 'home', 'end', 'pageup', 'pagedown', 'prior', 'next',
  'ctrl+l', 'alt+d', 'f6', 'ctrl+t', 'ctrl+a', 'ctrl+c', 'ctrl+f', 'f5', 'ctrl+r', 'alt+left', 'alt+right',
  'ctrl+tab', 'ctrl+shift+tab', 'ctrl+plus', 'ctrl+minus', 'ctrl+0', 'ctrl+equal',
]);

export function checkKey(key: string): string | null {
  const k = String(key || '').trim().toLowerCase().replace(/\s+/g, '');
  if (ALLOWED_KEYS.has(k)) return null;
  if (/(^|\+)(v|insert)$/.test(k) && /ctrl|shift/.test(k)) return 'no pasting on the shared desktop — the clipboard may hold the owner\'s secrets';
  return `"${key}" is not allowed on the shared desktop (navigation keys only: Return, Tab, Escape, arrows, ctrl+l, ctrl+t, F5…) — closing or quitting the owner's windows is theirs`;
}

/** A URL as typed into an address bar: https://… or a bare host[/path]. Null when the text is not one. */
export function typedUrl(text: string): string | null {
  const s = String(text || '').trim();
  if (/\s/.test(s)) return null;
  if (/^https?:\/\//i.test(s)) return s;
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?(\/\S*)?$/i.test(s) && !/@/.test(s)) return `https://${s}`;
  return null;
}

export function checkType(text: string, ctx: { site: string | null; identityEmail?: string | null; fromHuman?: boolean }): string | null {
  const s = String(text || '');
  if (ctx.fromHuman) return null;
  if (ctx.identityEmail && s.trim().toLowerCase() === ctx.identityEmail.trim().toLowerCase()) return null;
  const url = typedUrl(s);
  if (url) {
    if (!ctx.site) return 'say which site you are signing in to: shared_desktop_acquire({site}) — only its pages and the sign-in providers can be typed';
    if (ssoAllowed(ctx.site, url)) return null;
    return `${hostOf(url)} is outside ${ctx.site} and the sign-in providers — not typed on the shared desktop`;
  }
  return (
    'on the shared desktop you can type only a URL of the site you took it for, a sign-in provider, or the owner\'s account email — ' +
    'never a password or code. Text the human gave you in the chat for this: pass from_human:true. Anything else: finish the sign-in here, then request_login it into your own browser and type there.'
  );
}

const CHROME_CMD = /(?:^|\/)(?:google-chrome(?:-stable|-beta|-unstable)?|chrome|chromium(?:-browser)?|arigami-chrome)$/;

export function checkLaunch(command: string, args: string[]): string | null {
  if (!CHROME_CMD.test(command)) return 'only a browser can be started on the shared desktop';
  if (args.some((a) => /^--(remote-debugging|user-data-dir|load-extension|disable-web-security)/.test(a)))
    return 'the owner\'s browser is started as it is — no debugging port, profile or extension flags';
  return null;
}

/** The lease's site from what the agent passed: a url, a host or a name with a dot. */
export function leaseSite(input: unknown): string | null {
  const raw = String(input || '').trim();
  if (!raw) return null;
  const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw.replace(/^\/+/, '')}/`;
  try {
    return siteOf(new URL(url).hostname) || null;
  } catch {
    return null;
  }
}

// ---- host wiring -------------------------------------------------------------------------------------------------

let lease: SharedDesktopLease | null = null;
let deps: Omit<LeaseDeps, 'now'> | null = null;
let ticker: ReturnType<typeof setInterval> | null = null;

/** api.ts hands in how to message a session, how to tell it waits on a human, and how to tell the cockpit. */
export function wire(d: Omit<LeaseDeps, 'now'>): SharedDesktopLease {
  deps = d;
  lease = new SharedDesktopLease({
    now: () => Date.now(),
    notify: (id, text) => deps!.notify(id, text),
    waitingOnHuman: (id) => deps!.waitingOnHuman(id),
    changed: (st) => {
      deps!.changed?.(st);
      schedule();
    },
  });
  return lease;
}

export function get(): SharedDesktopLease {
  if (!lease) wire({ notify: () => {}, waitingOnHuman: () => false });
  return lease!;
}

/** Tick and watch the screen only while there is something to watch. */
function schedule(): void {
  const l = lease;
  if (!l) return;
  if (l.active()) {
    if (!ticker) {
      ticker = setInterval(() => {
        l.tick();
        if (!l.active()) schedule();
      }, 1000);
      ticker.unref?.();
    }
    startWatcher();
  } else {
    if (ticker) clearInterval(ticker);
    ticker = null;
    stopWatcher();
  }
}

// The owner's input is told apart from the agents' by the X server's idle counter (XScreenSaver): every input event
// resets it, XTEST ones included. The agents' input on this display goes through the host (agentInput below), so an
// event later than the last agent action is someone else's — the owner over VNC (or a stray raw xinput).
let agentBusy = 0;
let agentLastEnd = 0;
let watcher: ChildProcess | null = null;
let watcherSince = 0;
const SLACK_MS = 400;

export const XIDLE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'xidle.py');

export async function agentInput<T>(fn: () => Promise<T>): Promise<T> {
  agentBusy++;
  try {
    return await fn();
  } finally {
    agentBusy--;
    agentLastEnd = Date.now();
  }
}

/** Pure: given an idle reading, was the last input someone other than an agent? */
export function foreignInput(now: number, idleMs: number, o: { agentBusy: number; agentLastEnd: number; since: number }): boolean {
  if (o.agentBusy > 0) return false;
  const lastInput = now - idleMs;
  return lastInput > o.agentLastEnd + SLACK_MS && lastInput > o.since;
}

let watchDisplay = '';
export function setDisplay(display: string): void {
  watchDisplay = display;
}

function startWatcher(): void {
  if (watcher || !watchDisplay || process.platform !== 'linux' || !fs.existsSync(XIDLE)) return;
  try {
    const p = spawn('python3', [XIDLE, '500'], { env: { ...process.env, DISPLAY: watchDisplay }, stdio: ['ignore', 'pipe', 'ignore'] });
    watcher = p;
    watcherSince = Date.now();
    let buf = '';
    p.stdout!.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        const idle = Number(line);
        if (!Number.isFinite(idle) || !lease) continue;
        if (foreignInput(Date.now(), idle, { agentBusy, agentLastEnd, since: watcherSince })) lease.noteHumanInput();
      }
    });
    p.on('exit', () => {
      if (watcher === p) watcher = null;
    });
  } catch {
    watcher = null;
  }
}

function stopWatcher(): void {
  if (!watcher) return;
  try {
    watcher.kill('SIGTERM');
  } catch {
    /* gone */
  }
  watcher = null;
}
