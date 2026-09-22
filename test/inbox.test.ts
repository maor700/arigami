// Inbox — the normalized "a person said this to us" queue (state.ts InboxItem).
//
// Two things here decide whether the feature is safe rather than merely
// working: dedup, because every poller is at-least-once and a duplicated
// comment means a duplicated reply; and the submit gate, because it is the one
// place an outgoing message is authorized and the enforcement of "never contact
// anyone on my behalf".
//
// Out-of-process: state.ts captures its paths at import time.
import { test, expect } from 'bun:test';
import { runInChild } from './_child.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-'));
  return { ARIGAMI_DIR: dir, ARIGAMI_STATE_FILE: path.join(dir, 'state.json'), ARIGAMI_CLAUDE_BIN: '/bin/true' };
}

const ITEM = (ref: string, over = '') => `{
  source: { provider: 'github', kind: 'review-comment', ref: '${ref}', author: 'reviewer', title: 'app#123' },
  body: 'Use useSafeContext instead.',
  context: { kind: 'code', path: 'a/b.ts', lines: 'L23', hunk: '@@ -1 +1 @@' },
  signal: true${over}
}`;

test('addInboxItems dedups on source.ref — an at-least-once poller cannot double-deliver', () => {
  const r = runInChild(
    `const state = await import('./server/state.js');
     const s = state.createSession({ title: 'x' });
     const first = state.addInboxItems(s.id, [${ITEM('gh:rc:1')}, ${ITEM('gh:rc:2')}]);
     // the same poll again, plus one genuinely new comment
     const second = state.addInboxItems(s.id, [${ITEM('gh:rc:1')}, ${ITEM('gh:rc:3')}]);
     emit({ first: first.length, second: second.length, total: state.listInbox(s.id).length,
            refs: state.listInbox(s.id).map((i) => i.source.ref) });`,
    sandbox()
  );
  if (!r.ok) throw new Error(r.error);
  expect(r.out[0].first).toBe(2);
  expect(r.out[0].second).toBe(1); // only gh:rc:3 was new
  expect(r.out[0].total).toBe(3);
  expect(r.out[0].refs).toEqual(['gh:rc:1', 'gh:rc:2', 'gh:rc:3']);
});

test('addInboxItems refuses an item with no ref — it would re-add itself forever', () => {
  const r = runInChild(
    `const state = await import('./server/state.js');
     const s = state.createSession({ title: 'x' });
     const added = state.addInboxItems(s.id, [
       { source: { provider: 'x', kind: 'y', ref: '' }, body: 'no ref', context: { kind: 'none' }, signal: true },
       ${ITEM('gh:rc:9')},
     ]);
     emit({ added: added.length, refs: state.listInbox(s.id).map((i) => i.source.ref) });`,
    sandbox()
  );
  if (!r.ok) throw new Error(r.error);
  expect(r.out[0].added).toBe(1);
  expect(r.out[0].refs).toEqual(['gh:rc:9']);
});

test('addInboxItems on a missing session is null, not a throw', () => {
  const r = runInChild(
    `const state = await import('./server/state.js');
     emit({ res: state.addInboxItems('sess_nope', [${ITEM('gh:rc:1')}]) });`,
    sandbox()
  );
  if (!r.ok) throw new Error(r.error);
  expect(r.out[0].res).toBe(null);
});

test('settleInbox takes only DECIDED items, records them, and clears the decision', () => {
  const r = runInChild(
    `const state = await import('./server/state.js');
     const s = state.createSession({ title: 'x' });
     state.addInboxItems(s.id, [${ITEM('a')}, ${ITEM('b')}, ${ITEM('c')}]);
     const [i1, i2] = state.listInbox(s.id);
     state.patchInboxItem(s.id, i1.id, { decision: 'reply', replyOverride: 'thanks' });
     state.patchInboxItem(s.id, i2.id, { decision: 'dismiss' });
     const settled = state.settleInbox(s.id, 'batch note');
     const after = state.listInbox(s.id);
     emit({
       settled: settled.length,
       decisions: settled.map((i) => i.decision),
       stillDecided: after.filter((i) => i.decision).length,
       settledFlags: after.map((i) => (i.settled ? i.settled.decision : null)),
       note: after.find((i) => i.settled)?.settled?.note,
       // the item stays in the list as a record — it is not deleted
       total: after.length,
     });`,
    sandbox()
  );
  if (!r.ok) throw new Error(r.error);
  const o = r.out[0];
  expect(o.settled).toBe(2);
  expect(o.decisions.sort()).toEqual(['dismiss', 'reply']);
  expect(o.stillDecided).toBe(0); // cleared, so a second submit sends nothing
  expect(o.settledFlags).toEqual(['reply', 'dismiss', null]);
  expect(o.note).toBe('batch note');
  expect(o.total).toBe(3);
});

test('settleInbox is idempotent — pressing submit twice does not resend', () => {
  // The failure this guards: a double-click that sends every approved reply a
  // second time. Nothing is "unsettled" back into the queue.
  const r = runInChild(
    `const state = await import('./server/state.js');
     const s = state.createSession({ title: 'x' });
     state.addInboxItems(s.id, [${ITEM('a')}]);
     const [i1] = state.listInbox(s.id);
     state.patchInboxItem(s.id, i1.id, { decision: 'reply' });
     emit({ first: state.settleInbox(s.id).length, second: state.settleInbox(s.id).length });`,
    sandbox()
  );
  if (!r.ok) throw new Error(r.error);
  expect(r.out[0].first).toBe(1);
  expect(r.out[0].second).toBe(0);
});

test('noteToAgent and replyOverride are separate fields — an instruction cannot become the reply', () => {
  // They are deliberately distinct in the model AND in the UI: one is text for
  // the agent that stays on the machine, the other is the exact text that goes
  // out. Collapsing them is how an internal note gets sent to a person.
  const r = runInChild(
    `const state = await import('./server/state.js');
     const s = state.createSession({ title: 'x' });
     state.addInboxItems(s.id, [${ITEM('a')}]);
     const [i1] = state.listInbox(s.id);
     const n = state.patchInboxItem(s.id, i1.id, {
       decision: 'both', replyOverride: 'Good catch — switching.', noteToAgent: "don't touch the stories file",
     });
     emit({ reply: n.replyOverride, note: n.noteToAgent, body: n.body });`,
    sandbox()
  );
  if (!r.ok) throw new Error(r.error);
  expect(r.out[0].reply).toBe('Good catch — switching.');
  expect(r.out[0].note).toBe("don't touch the stories file");
  // the person's own words are never rewritten by any of this
  expect(r.out[0].body).toBe('Use useSafeContext instead.');
});

test('clearInbox empties it without touching the rest of the session', () => {
  const r = runInChild(
    `const state = await import('./server/state.js');
     const s = state.createSession({ title: 'keep me' });
     state.addInboxItems(s.id, [${ITEM('a')}, ${ITEM('b')}]);
     state.clearInbox(s.id);
     emit({ items: state.listInbox(s.id).length, title: state.getSession(s.id).title });`,
    sandbox()
  );
  if (!r.ok) throw new Error(r.error);
  expect(r.out[0].items).toBe(0);
  expect(r.out[0].title).toBe('keep me');
});

test('enrichment fills the AGENT fields and can touch nothing else', () => {
  // The drafting run is a model writing into the operator's queue. If it could
  // set `decision` or `settled`, the submit gate would be decorative — the
  // model would be approving its own replies. It fills explanation/proposal
  // and that is all; the route whitelists the same set.
  const r = runInChild(
    `const state = await import('./server/state.js');
     const s = state.createSession({ title: 'x' });
     state.addInboxItems(s.id, [${ITEM('a')}]);
     const [i1] = state.listInbox(s.id);
     const n = state.patchInboxItem(s.id, i1.id, {
       enriching: false,
       enrichment: {
         explanation: 'הוא צודק, הקובץ כבר מייבא את זה',
         explanationDir: 'rtl',
         proposal: { fix: 'use the hook', reply: 'Good catch — switching.', replyDir: 'ltr' },
       },
     });
     emit({
       expl: n.enrichment.explanation, explDir: n.enrichment.explanationDir,
       replyDir: n.enrichment.proposal.replyDir,
       decision: n.decision ?? null, settled: n.settled ?? null, body: n.body,
     });`,
    sandbox()
  );
  if (!r.ok) throw new Error(r.error);
  const o = r.out[0];
  // A Hebrew explanation beside an English reply in one item is the case the
  // two direction fields exist for — the model picks a language per item.
  expect(o.explDir).toBe('rtl');
  expect(o.replyDir).toBe('ltr');
  expect(o.expl).toContain('צודק');
  // the enrichment decided nothing and rewrote nothing
  expect(o.decision).toBe(null);
  expect(o.settled).toBe(null);
  expect(o.body).toBe('Use useSafeContext instead.');
});

test('enrichment never picks up an item that is settled or already drafted', () => {
  // The selection rule lives in claude.js enrichInbox(); this pins the shape it
  // filters on, so a later change to the model cannot silently re-draft over a
  // reply the operator already edited and sent.
  const r = runInChild(
    `const state = await import('./server/state.js');
     const s = state.createSession({ title: 'x' });
     state.addInboxItems(s.id, [${ITEM('a')}, ${ITEM('b')}, ${ITEM('c', ", signal: false")}]);
     const [a, b, c] = state.listInbox(s.id);
     state.patchInboxItem(s.id, a.id, { enrichment: { explanation: 'done', proposal: {} } });
     state.patchInboxItem(s.id, b.id, { decision: 'dismiss' });
     state.settleInbox(s.id);
     const items = state.listInbox(s.id);
     const todo = items.filter((i) => !i.settled && !i.enrichment && i.signal);
     const forced = items.filter((i) => !i.settled && !i.enrichment);
     emit({ todo: todo.length, forced: forced.length });`,
    sandbox()
  );
  if (!r.ok) throw new Error(r.error);
  // a is drafted, b is settled, c is low-signal → nothing to do unaided…
  expect(r.out[0].todo).toBe(0);
  // …but "explain it" (force) still reaches the low-signal one.
  expect(r.out[0].forced).toBe(1);
});
