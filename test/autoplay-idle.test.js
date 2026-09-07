// "Auto-play sometimes doesn't play even when the session isn't working."
//
// The queue used to move ONLY at a turn-end (server/claude.js's result branch
// was the single caller of scheduleAutoPlay), so a prompt added to an already
// idle session — or the switch flipped on over a waiting queue, or a queue that
// survived a host restart — sat there forever on a session that plainly wasn't
// working. Every one of those moments is now a kickAutoPlay(); the guards
// (idle, no sticky action card, settle delay) are unchanged and live in ONE
// place, state.autoPlayHold().
//
// Pure: no claude process. claude.js exposes __setAutoPlayer so the settle timer
// records the play instead of spawning the CLI; everything else (guards, timing,
// state) is the real code path.
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runInChild } from './_child.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-autoplay-'));

// Boilerplate for every child: isolated state, a recording auto-player, and a
// sleep long enough for the 800 ms settle delay to fire.
const PRELUDE =
  "const st=await import('./server/state.ts');" +
  "const cl=await import('./server/claude.js');" +
  'const played=[];cl.__setAutoPlayer((id)=>played.push(id));' +
  'const settle=()=>new Promise(r=>setTimeout(r,1200));';

const child = (body, env = {}) => {
  const r = runInChild(PRELUDE + body, { ARIGAMI_DIR: tmp(), ARIGAMI_PORT: '', ...env });
  if (!r.ok) throw new Error(r.error);
  return r.out[0];
};

test('a prompt queued while the session is already idle plays after the settle delay', () => {
  const o = child(
    "const s=st.createSession({title:'idle'});" +
      "st.setPromptAutoPlay(s.id,true);st.addPendingPrompt(s.id,'do the thing');" +
      // what POST /sessions/:id/prompts does now
      'cl.kickAutoPlay(s.id);' +
      'const beforeSettle=played.length;' +
      'await settle();' +
      'emit({beforeSettle,played:played.length,queue:(st.getSession(s.id).pendingPrompts||[]).length});'
  );
  expect(o.beforeSettle).toBe(0); // never instant — the user may still be typing
  expect(o.played).toBe(1);
  expect(o.queue).toBe(1); // the stub player doesn't dequeue; the real one does
});

test('flipping auto-play ON over a waiting queue on an idle session plays it', () => {
  const o = child(
    "const s=st.createSession({title:'toggle'});" +
      "st.addPendingPrompt(s.id,'queued while off');" +
      'await settle();' +
      'const whileOff=played.length;' +
      'st.setPromptAutoPlay(s.id,true);cl.kickAutoPlay(s.id);' +
      'await settle();' +
      'emit({whileOff,played:played.length});'
  );
  expect(o.whileOff).toBe(0); // switch off → the queue is the human's to play
  expect(o.played).toBe(1);
});

test('a sticky action card holds the queue; answering/dismissing it releases the queue', () => {
  const o = child(
    "const s=st.createSession({title:'held'});" +
      "st.setPromptAutoPlay(s.id,true);st.addPendingPrompt(s.id,'next');" +
      "st.patchSession(s.id,{action:{id:'act_1',prompt:'ok?',buttons:[]}});" +
      'cl.kickAutoPlay(s.id);await settle();' +
      'const whileHeld=played.length;' +
      "const holdWire=st.toWireSession(st.getSession(s.id)).autoPlayHold;" +
      // action/answer + action/dismiss both clear the card and kick
      'st.patchSession(s.id,{action:null});cl.kickAutoPlay(s.id);await settle();' +
      "const clearedWire=st.toWireSession(st.getSession(s.id)).autoPlayHold;" +
      'emit({whileHeld,played:played.length,holdWire,clearedWire});'
  );
  expect(o.whileHeld).toBe(0);
  expect(o.holdWire).toBe('action'); // the cockpit can say WHY nothing moves
  expect(o.played).toBe(1);
  expect(o.clearedWire).toBeNull(); // explicit null — the client merges wire sessions
});

test('a busy session is never interrupted — the kick is a no-op until it goes idle', () => {
  const o = child(
    "const s=st.createSession({title:'busy'});" +
      "st.setPromptAutoPlay(s.id,true);st.addPendingPrompt(s.id,'later');" +
      "st.setClaude(s.id,{state:'working'});" +
      'cl.kickAutoPlay(s.id);await settle();' +
      'const whileBusy=played.length;' +
      "st.setClaude(s.id,{state:'idle'});cl.kickAutoPlay(s.id);await settle();" +
      'emit({whileBusy,played:played.length});'
  );
  expect(o.whileBusy).toBe(0);
  expect(o.played).toBe(1);
});

test('an awaiting-input session (pending permission request) is held too', () => {
  const o = child(
    "const s=st.createSession({title:'perm'});" +
      "st.setPromptAutoPlay(s.id,true);st.addPendingPrompt(s.id,'later');" +
      "st.setClaude(s.id,{state:'awaiting-input'});" +
      'cl.kickAutoPlay(s.id);await settle();' +
      'emit({played:played.length});'
  );
  expect(o.played).toBe(0);
});

test('boot: every idle session with auto-play and a waiting queue is kicked once', () => {
  const o = child(
    "const a=st.createSession({title:'a'});st.setPromptAutoPlay(a.id,true);st.addPendingPrompt(a.id,'x');" +
      "const b=st.createSession({title:'b'});st.addPendingPrompt(b.id,'x');" + // auto-play off
      "const c=st.createSession({title:'c'});st.setPromptAutoPlay(c.id,true);" + // empty queue
      "const d=st.createSession({title:'d'});st.setPromptAutoPlay(d.id,true);st.addPendingPrompt(d.id,'x');" +
      "st.patchSession(d.id,{action:{id:'act_2',prompt:'?',buttons:[]}});" + // held by a card
      'const n=cl.kickAutoPlayAll();await settle();' +
      'emit({n,played,onlyA:played.every(id=>id===a.id)});'
  );
  expect(o.n).toBe(2); // a + d were kicked
  expect(o.played.length).toBe(1); // …only a actually played
  expect(o.onlyA).toBe(true);
});

test('autoPlayHold is the single rule, and only a human-resolvable hold reaches the wire', () => {
  const o = child(
    "const mk=(over)=>({promptAutoPlay:true,pendingPrompts:[{id:'p'}],action:null,claude:{state:'idle'},...over});" +
      'emit({' +
      'clean:st.autoPlayHold(mk()),' +
      'off:st.autoPlayHold(mk({promptAutoPlay:false})),' +
      'empty:st.autoPlayHold(mk({pendingPrompts:[]})),' +
      "held:st.autoPlayHold(mk({action:{id:'a'}}))," +
      "busy:st.autoPlayHold(mk({claude:{state:'working'}}))," +
      '});'
  );
  expect(o.clean).toBeNull();
  expect(o.off).toBeNull(); // the switch is off — not a "hold", just not armed
  expect(o.empty).toBeNull();
  expect(o.held).toBe('action');
  expect(o.busy).toBe('busy');
});

// The bug class, guarded at the source: a future call site that queues a prompt
// without kicking re-introduces exactly the reported symptom.
test('every addPendingPrompt call site in api.ts kicks auto-play', () => {
  const src = fs.readFileSync(new URL('../server/api.ts', import.meta.url), 'utf8').split('\n');
  const misses = [];
  src.forEach((line, i) => {
    if (!line.includes('state.addPendingPrompt(')) return;
    const window = src.slice(i, i + 8).join('\n');
    if (!window.includes('claude.kickAutoPlay(')) misses.push(i + 1);
  });
  expect(misses).toEqual([]);
});
