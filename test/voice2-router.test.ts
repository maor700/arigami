// VOICE2 host: the router's plan carries a `kind` the client loop can branch
// on. `ask` (and the old `clarify`) / `end_conversation` are control words —
// they set the kind and are STRIPPED from `actions`, so a VOICE1 client never
// queues them as if they were an inject. Everything else keeps its shape.
import { test, expect, beforeAll, afterAll } from 'bun:test';

let voice: any, origFetch: any;
const sent: any[] = [];

beforeAll(async () => {
  process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || 'gsk_test';
  origFetch = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => {
    const body = JSON.parse(init.body);
    sent.push({ url: String(url), body });
    const content = JSON.stringify({ actions: [{ type: 'ask' }], say: 'לאיזה שם?' });
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as any;
  voice = await import('../server/voice.js');
});
afterAll(() => { globalThis.fetch = origFetch; });

test('normalizePlan: ask/clarify → kind ask with the question; stripped from actions', () => {
  const a = voice.normalizePlan({ actions: [{ type: 'ask' }], say: 'Which session?' }, 'rename it');
  expect(a).toEqual({ transcript: 'rename it', actions: [], say: 'Which session?', kind: 'ask', question: 'Which session?' });
  const c = voice.normalizePlan({ actions: [{ type: 'clarify' }], say: ' לאיזה? ' }, 'x');
  expect(c.kind).toBe('ask');
  expect(c.question).toBe('לאיזה?');
  expect(c.actions).toEqual([]);
  // an explicit `question` field also works when say is empty
  expect(voice.normalizePlan({ actions: [{ type: 'ask' }], question: 'Name?' }, 'x')).toMatchObject({ kind: 'ask', question: 'Name?', say: 'Name?' });
});

test('normalizePlan: real actions → act (control words dropped alongside); say-only → answer; end_conversation → end; nothing → noop', () => {
  const act = voice.normalizePlan({ actions: [{ type: 'select_session', sessionId: 's1' }, { type: 'ask' }], say: 'switching' }, 'go');
  expect(act.kind).toBe('act');
  expect(act.actions).toEqual([{ type: 'select_session', sessionId: 's1' }]);
  expect(voice.normalizePlan({ actions: [], say: 'It finished the tests.' }, 'q')).toMatchObject({ kind: 'answer', actions: [], question: '' });
  expect(voice.normalizePlan({ actions: [{ type: 'end_conversation' }], say: 'ok' }, 'זהו')).toMatchObject({ kind: 'end', actions: [] });
  expect(voice.normalizePlan({}, 'hm')).toEqual({ transcript: 'hm', actions: [], say: '', kind: 'noop', question: '' });
  // junk actions (no type) never leak through
  expect(voice.normalizePlan({ actions: [null, 'x', { text: 'no type' }] }, 'j').actions).toEqual([]);
});

test('route: prior turns go to the model as history (the answer is routed WITH the question), and the reply is a typed plan', async () => {
  sent.length = 0;
  const plan = await voice.route({
    transcript: 'תשנה את השם',
    context: { sessions: [{ id: 's1', label: 'A', selected: true }], history: [
      { role: 'user', content: 'תשנה את השם של הסשן' },
      { role: 'assistant', content: 'לאיזה שם?' },
    ] },
  });
  expect(plan.kind).toBe('ask');
  expect(plan.question).toBe('לאיזה שם?');
  const msgs = sent[0].body.messages;
  expect(msgs.map((m: any) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
  expect(msgs[3].content).toBe('תשנה את השם');
  // the prompt teaches the conversational rules + the new control words
  expect(msgs[0].content).toContain('- ask {}');
  expect(msgs[0].content).toContain('- end_conversation {}');
  expect(msgs[0].content).toContain('NEVER use inject_prompt as a fallback');
});
