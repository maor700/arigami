// The shared desktop's lease (server/lib/shared-desktop.ts) — the pure state machine, on a fake clock:
//   - one holder, a FIFO queue, the next one woken with a "[host] …" line (never polled)
//   - idle release, delete, explicit and owner release
//   - a holder waiting on the human is PARKED and comes back at the head of the queue
//   - the owner's input pauses the holder, and the queue waits for them
// and the input guards for the owner's screen.
import { test, expect } from 'bun:test';
import {
  SharedDesktopLease,
  IDLE_MS,
  GRANT_GRACE_MS,
  HUMAN_QUIET_MS,
  checkKey,
  checkType,
  checkLaunch,
  typedUrl,
  leaseSite,
  foreignInput,
} from '../server/lib/shared-desktop.ts';

function rig() {
  let t = 1_000_000;
  const msgs: { id: string; text: string }[] = [];
  const waiting = new Set<string>();
  const L = new SharedDesktopLease({
    now: () => t,
    notify: (id, text) => msgs.push({ id, text }),
    waitingOnHuman: (id) => waiting.has(id),
  });
  return {
    L,
    msgs,
    waiting,
    advance(ms: number) {
      t += ms;
      L.tick();
    },
    woken: () => msgs.filter((m) => /^\[host\] Your turn/.test(m.text)).map((m) => m.id),
  };
}

test('one holder; the rest queue in order and are woken one by one', () => {
  const r = rig();
  const a = r.L.acquire('A', 'todoist.com', 'sign up');
  const b = r.L.acquire('B', 'ticktick.com');
  const c = r.L.acquire('C', 'notion.so');
  expect('granted' in a && a.granted).toBe(true);
  expect('queued' in b && b.position).toBe(1);
  expect('queued' in c && c.position).toBe(2);
  expect(r.L.check('A', 'input').ok).toBe(true);
  expect(r.L.check('B', 'input')).toMatchObject({ ok: false, queued: 1 });
  expect(r.L.check('C', 'look')).toMatchObject({ ok: false, queued: 2 });
  expect(r.L.check('Z', 'input')).toMatchObject({ ok: false, error: expect.stringMatching(/shared_desktop_acquire/) });
  expect(r.msgs).toEqual([]); // nobody is messaged while nothing changes hands

  r.L.release('A');
  expect(r.L.holder?.sessionId).toBe('B');
  expect(r.woken()).toEqual(['B']);
  expect(r.L.check('A', 'input').ok).toBe(false);
  expect(r.L.check('C', 'input')).toMatchObject({ queued: 1 });

  r.L.release('B');
  expect(r.woken()).toEqual(['B', 'C']);
  expect(r.L.holder?.site).toBe('notion.so');
  r.L.release('C');
  expect(r.L.holder).toBe(null);
  expect(r.L.active()).toBe(false);
});

test('a second acquire by the same session is idempotent — never a second place in the queue', () => {
  const r = rig();
  r.L.acquire('A', 'x.com');
  r.L.acquire('B', 'y.com');
  expect(r.L.acquire('A', 'x.com')).toMatchObject({ granted: true, already: true });
  expect(r.L.acquire('B', 'y.com')).toMatchObject({ queued: true, position: 1 });
  expect(r.L.queue.length).toBe(1);
});

test('an idle holder loses the lease after IDLE_MS; its next action says why', () => {
  const r = rig();
  r.L.acquire('A', 'x.com');
  r.L.acquire('B', 'y.com');
  r.advance(IDLE_MS - 1000);
  r.L.touch('A'); // an action restarts the clock
  r.advance(IDLE_MS - 1000);
  expect(r.L.holder?.sessionId).toBe('A');
  r.advance(2000);
  expect(r.L.holder?.sessionId).toBe('B');
  expect(r.woken()).toEqual(['B']);
  expect(r.L.check('A', 'input')).toMatchObject({ ok: false, expired: true });
});

test('a session woken from the queue gets the longer grace for its first action', () => {
  const r = rig();
  r.L.acquire('A', 'x.com');
  r.L.acquire('B', 'y.com');
  r.L.release('A');
  r.advance(IDLE_MS + 5000); // past the plain idle limit, inside the grace
  expect(r.L.holder?.sessionId).toBe('B');
  r.advance(GRANT_GRACE_MS - IDLE_MS);
  expect(r.L.holder).toBe(null);
});

test('a deleted session holds and waits for nothing', () => {
  const r = rig();
  r.L.acquire('A', 'x.com');
  r.L.acquire('B', 'y.com');
  r.L.acquire('C', 'z.com');
  r.L.forget('B'); // queued one goes
  expect(r.L.queue.map((w) => w.sessionId)).toEqual(['C']);
  r.L.forget('A'); // holder goes → next
  expect(r.L.holder?.sessionId).toBe('C');
  expect(r.woken()).toEqual(['C']);
});

test('the owner takes it back from the cockpit: the holder is told, the next one woken', () => {
  const r = rig();
  r.L.acquire('A', 'x.com');
  r.L.acquire('B', 'y.com');
  expect(r.L.forceRelease()).toBe('A');
  expect(r.msgs[0]).toMatchObject({ id: 'A', text: expect.stringMatching(/owner took the shared desktop back/) });
  expect(r.L.holder?.sessionId).toBe('B');
  expect(r.L.forceRelease()).toBe('B');
  expect(r.L.forceRelease()).toBe(null);
});

test('parked on the human: others use the machine; the holder comes back at the HEAD of the queue', () => {
  const r = rig();
  r.L.acquire('A', 'todoist.com');
  r.L.acquire('B', 'ticktick.com');
  r.waiting.add('A');
  expect(r.L.park('A', 'request_screen')).toBe(true);
  expect(r.L.holder?.sessionId).toBe('B'); // B uses the machine meanwhile
  expect(r.woken()).toEqual(['B']);
  expect(r.L.check('A', 'look').ok).toBe(true); // A may look at its window
  expect(r.L.check('A', 'input')).toMatchObject({ ok: false, parked: true });
  r.L.acquire('C', 'notion.so'); // a newcomer queues behind
  // the human takes a long time; B keeps acting
  for (let i = 0; i < 5; i++) {
    r.advance(30_000);
    r.L.touch('B');
  }
  expect(r.L.parked.has('A')).toBe(true);
  // the human answers
  r.waiting.delete('A');
  r.advance(1000);
  expect(r.L.queue.map((w) => w.sessionId)).toEqual(['A', 'C']); // A first, ahead of C who asked earlier
  expect(r.msgs.find((m) => m.id === 'A' && /first in line/.test(m.text))?.text).toMatch(/redo that step yourself/);
  r.L.release('B');
  expect(r.L.holder?.sessionId).toBe('A');
  expect(r.L.holder?.site).toBe('todoist.com'); // its job is kept
  expect(r.woken()).toEqual(['B', 'A']);
});

test('parked with nobody waiting: the human answers and the holder simply has it again', () => {
  const r = rig();
  r.L.acquire('A', 'x.com');
  r.waiting.add('A');
  r.L.park('A', 'request_screen');
  expect(r.L.holder).toBe(null);
  r.waiting.delete('A');
  expect(r.L.check('A', 'input').ok).toBe(true); // the action itself notices the answer
  expect(r.L.holder?.sessionId).toBe('A');
  expect(r.msgs).toEqual([]);
});

test('an idle holder that is waiting on a card is parked, not released', () => {
  const r = rig();
  r.L.acquire('A', 'x.com');
  r.L.acquire('B', 'y.com');
  r.waiting.add('A');
  r.advance(IDLE_MS + 1);
  expect(r.L.parked.has('A')).toBe(true);
  expect(r.L.holder?.sessionId).toBe('B');
});

test("the owner's input pauses the holder; the agent is told when they are done", () => {
  const r = rig();
  r.L.acquire('A', 'x.com');
  r.L.noteHumanInput();
  expect(r.L.check('A', 'input')).toMatchObject({ ok: false, paused: true });
  expect(r.L.check('A', 'look').ok).toBe(true);
  // a long pause does not count against the holder's idle clock
  for (let i = 0; i < 10; i++) {
    r.advance(HUMAN_QUIET_MS - 1000);
    r.L.noteHumanInput();
  }
  expect(r.L.holder?.sessionId).toBe('A');
  r.advance(HUMAN_QUIET_MS + 1);
  expect(r.L.check('A', 'input').ok).toBe(true);
  expect(r.msgs).toEqual([{ id: 'A', text: expect.stringMatching(/owner is done/) }]);
});

test('while the owner is on the screen, the queue waits for them', () => {
  const r = rig();
  r.L.acquire('A', 'x.com');
  r.L.acquire('B', 'y.com');
  r.L.noteHumanInput();
  r.L.release('A');
  expect(r.L.holder).toBe(null); // not handed to B under the owner's hands
  expect(r.woken()).toEqual([]);
  r.advance(HUMAN_QUIET_MS + 1);
  expect(r.L.holder?.sessionId).toBe('B');
  expect(r.woken()).toEqual(['B']);
});

test('status is what the cockpit shows: holder, queue, parked, owner', () => {
  const r = rig();
  r.L.acquire('A', 'x.com', 'sign up');
  r.L.acquire('B', 'y.com');
  const st = r.L.status();
  expect(st.holder).toMatchObject({ sessionId: 'A', site: 'x.com', reason: 'sign up', expiresInMs: IDLE_MS });
  expect(st.queue.map((w) => w.sessionId)).toEqual(['B']);
  expect(st.humanActive).toBe(false);
});

// ---- the owner's input, told apart from the agents' ---------------------------------------------------------------

test("foreignInput: an input event after the last agent action is the owner's", () => {
  const now = 100_000;
  const since = 0;
  expect(foreignInput(now, 50_000, { agentBusy: 0, agentLastEnd: 49_000, since })).toBe(true); // input at 50 000, agent at 49 000
  expect(foreignInput(now, 51_000, { agentBusy: 0, agentLastEnd: 49_000, since })).toBe(false); // input at 49 000 = the agent's
  expect(foreignInput(now, 50_800, { agentBusy: 0, agentLastEnd: 49_000, since })).toBe(false); // within the slack
  expect(foreignInput(now, 0, { agentBusy: 1, agentLastEnd: 0, since })).toBe(false); // an agent action is running
  expect(foreignInput(now, 1000, { agentBusy: 0, agentLastEnd: 0, since: now })).toBe(false); // older than the watcher
});

// ---- input guards on the owner's screen ---------------------------------------------------------------------------

test('keys: navigation yes; paste, closing and quitting no', () => {
  for (const k of ['Return', 'Tab', 'shift+Tab', 'Escape', 'ctrl+l', 'ctrl+t', 'F5', 'Down', 'BackSpace']) expect(checkKey(k)).toBe(null);
  expect(checkKey('ctrl+v')).toMatch(/no pasting/);
  expect(checkKey('shift+Insert')).toMatch(/no pasting/);
  for (const k of ['alt+F4', 'ctrl+w', 'ctrl+q', 'ctrl+shift+n', 'super']) expect(checkKey(k)).toMatch(/not allowed/);
});

test('typing: the leased site, a sign-in provider, the identity email, or what the human gave', () => {
  const ctx = { site: 'todoist.com', identityEmail: 'owner@example.com' };
  expect(typedUrl('todoist.com/auth/login')).toBe('https://todoist.com/auth/login');
  expect(typedUrl('hello world')).toBe(null);
  expect(typedUrl('owner@example.com')).toBe(null);
  expect(checkType('https://app.todoist.com/app', ctx)).toBe(null);
  expect(checkType('todoist.com', ctx)).toBe(null);
  expect(checkType('https://accounts.google.com/signin', ctx)).toBe(null);
  expect(checkType('Owner@Example.com', ctx)).toBe(null);
  expect(checkType('mail.google.com', ctx)).toMatch(/outside todoist.com/);
  expect(checkType('evil.example/phish', ctx)).toMatch(/outside todoist.com/);
  expect(checkType('hunter2', ctx)).toMatch(/never a password/);
  expect(checkType('123456', ctx)).toMatch(/never a password/);
  expect(checkType('123456', { ...ctx, fromHuman: true })).toBe(null);
  expect(checkType('todoist.com', { site: null })).toMatch(/say which site/);
});

test('launch: only a browser, as it is', () => {
  expect(checkLaunch('google-chrome-stable', [])).toBe(null);
  expect(checkLaunch('/usr/bin/google-chrome', ['https://todoist.com'])).toBe(null);
  expect(checkLaunch('xterm', [])).toMatch(/only a browser/);
  expect(checkLaunch('google-chrome', ['--remote-debugging-port=9222'])).toMatch(/as it is/);
  expect(checkLaunch('google-chrome', ['--user-data-dir=/tmp/x'])).toMatch(/as it is/);
});

test('leaseSite: a url, a host or a bare domain → the registrable site', () => {
  expect(leaseSite('https://app.todoist.com/auth/login')).toBe('todoist.com');
  expect(leaseSite('ticktick.com')).toBe('ticktick.com');
  expect(leaseSite('')).toBe(null);
});
