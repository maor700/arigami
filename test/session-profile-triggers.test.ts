// triggers:'own-thread' (server/session-profile.ts) — a narrow wake-up grant for restricted sessions: ONE kind of
// listener (Slack), only on the session's own recorded thread (metadata.origin, its own or its nearest ancestor's),
// only on itself, ending with the session. Cron and every other listener stay refused, with the reason.
import { test, expect, describe } from 'bun:test';
import path from 'node:path';
import * as sp from '../server/session-profile.ts';
import { runInChild } from './_child.js';
import { tmpDir } from './_tmp.js';

const P = (spec: sp.ProfileSpec, parent: string | null = null) => sp.fromSpec(spec, parent);
const OWN = { channel: 'CINCIDENT1', thread_ts: '1800000000.000100' };
const slack = (channel_id: string, thread_ts?: string) => ({ type: 'slack', channel_id, ...(thread_ts ? { thread_ts } : {}) });
const target = (b: { channel_id: string; thread_ts?: string }) => ({ channelId: b.channel_id, threadTs: b.thread_ts });

describe('the profile flag', () => {
  test('false < own-thread < true; unknown values close; narrowing takes the lower; within checks it', () => {
    expect(P({ triggers: 'own-thread' }).triggers).toBe('own-thread');
    expect(P({ triggers: 'anything' as any }).triggers).toBe(false);
    expect(sp.narrow(P({ triggers: true }), { triggers: 'own-thread' })!.triggers).toBe('own-thread');
    expect(sp.narrow(P({ triggers: 'own-thread' }), { triggers: true })!.triggers).toBe('own-thread');
    expect(sp.narrow(P({ triggers: 'own-thread' }), { triggers: false })!.triggers).toBe(false);
    expect(sp.isWithin(P({ triggers: 'own-thread' }), P({ triggers: true }))).toBe(true);
    expect(sp.isWithin(P({ triggers: true }), P({ triggers: 'own-thread' }))).toBe(false);
    expect(sp.isWithin(P({ triggers: 'own-thread' }), P({ triggers: false }))).toBe(false);
  });
  test('own-thread keeps register/list/cancel_listener and takes cron away (host cronjob and the CLI built-ins)', () => {
    const denied = sp.deniedByFlags(P({ tools: ['git'], triggers: 'own-thread' }));
    for (const t of ['register_listener', 'list_listeners', 'cancel_listener']) expect(denied).not.toContain(t);
    for (const t of ['cronjob', 'CronCreate', 'CronDelete', 'CronList']) expect(denied).toContain(t);
    expect(sp.deniedByFlags(P({ tools: ['git'] }))).toContain('register_listener');
  });
});

describe('which listener an own-thread session may arm', () => {
  const p = P({ tools: ['git'], triggers: 'own-thread' });
  const why = (b: any, own: any = OWN) => sp.ownThreadListenerRefusal(p, b, b.channel_id ? target(b) : null, own);
  test('its own thread: allowed', () => {
    expect(why(slack(OWN.channel, OWN.thread_ts))).toBeNull();
  });
  test('another thread, another channel, the whole channel, another kind of listener, no recorded thread: refused with the reason', () => {
    expect(why(slack(OWN.channel, '1800000000.000999'))).toContain('only its own incident thread');
    expect(why(slack('COTHER0001', OWN.thread_ts))).toContain('only its own incident thread');
    expect(why(slack(OWN.channel))).toContain('(whole channel)');
    expect(why({ type: 'github-pr', owner: 'o', repo: 'r', number: 1 })).toContain('not a "github-pr" listener');
    expect(why({ type: 'whatsapp' })).toContain('only a Slack listener');
    expect(why(slack(OWN.channel, OWN.thread_ts), null)).toContain('no recorded incident thread');
    expect(sp.ownThreadListenerRefusal(P({ triggers: false }), slack(OWN.channel, OWN.thread_ts), target(slack(OWN.channel, OWN.thread_ts)), OWN)).toContain('no listeners or cron');
    expect(sp.ownThreadListenerRefusal(P({ triggers: true }), { type: 'github-pr' }, null, null)).toBeNull();
  });
  test('the recorded thread is its own origin, else its nearest ancestor\'s', () => {
    const sessions: Record<string, any> = {
      root: { id: 'root', metadata: { origin: { kind: 'slack', ...OWN } } },
      mid: { id: 'mid', profile: P({}, 'root'), metadata: {} },
      kid: { id: 'kid', profile: P({}, 'mid'), metadata: {} },
      own: { id: 'own', profile: P({}, 'root'), metadata: { origin: { kind: 'slack', channel: 'CINCIDENT1', thread_ts: '1800000000.000200' } } },
      lone: { id: 'lone', profile: P({}), metadata: {} },
    };
    const get = (id: string) => sessions[id] || null;
    expect(sp.originThreadOf('kid', get)).toEqual(OWN);
    expect(sp.originThreadOf('own', get)).toEqual({ channel: 'CINCIDENT1', thread_ts: '1800000000.000200' });
    expect(sp.originThreadOf('lone', get)).toBeNull();
  });
  test('origin is host-protected: a restricted session cannot set or move it', () => {
    expect(sp.PROTECTED_METADATA).toContain('origin');
    expect((sp.sanitizeOwnPatch({ metadata: { origin: { channel: 'X' }, note: 1 } }).metadata as any).origin).toBeUndefined();
  });
});

test('no listener outlives its session: deleting (or archiving) the session ends it', () => {
  const dir = tmpDir('arigami-trig-');
  const r = runInChild(
    "const st=await import('./server/state.ts');" +
      "const s=st.createSession({title:'r',profile:{tools:['git'],triggers:'own-thread'}});" +
      "const base={type:'slack',label:'t',params:{channelId:'CINCIDENT1',threadTs:'1800000000.000100'},fireOn:['message'],watermark:{},ttlAt:Date.now()+864e5,intervalSec:60,nextPollAt:0};" +
      "st.addListener({...base,sessionId:s.id});const a=st.listListeners({sessionId:s.id}).length;" +
      "const s2=st.createSession({title:'r2',profile:{tools:['git'],triggers:'own-thread'}});st.addListener({...base,sessionId:s2.id});" +
      "st.stopListenersForSession(s2.id);const stopped=st.listListeners({sessionId:s2.id}).map(l=>l.status);" +
      "st.deleteSession(s.id);emit({a,after:st.listListeners({sessionId:s.id}).length,stopped});",
    { ARIGAMI_DIR: dir, ARIGAMI_PORT: '', ARIGAMI_STATE_FILE: path.join(dir, 'state.json'), ARIGAMI_CHAT_DIR: path.join(dir, 'chat') }
  );
  if (!r.ok) throw new Error(r.error);
  const o = r.out[0] as any;
  expect(o.a).toBe(1);
  expect(o.after).toBe(0);
  expect(o.stopped).toEqual(['stopped']);
});
