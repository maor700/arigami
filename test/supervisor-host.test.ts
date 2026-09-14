// RES1 §5 — the supervisor end-to-end against an ISOLATED host (tmp ARIGAMI_DIR,
// own port, auth off, a stub `claude` that speaks stream-json and can be told to
// die or to fail with a quota/auth error). One test per row of the spec's
// integration list:
//   · proc death            → respawn + replay of the last user message
//   · limit                 → account switch → model downgrade → restore
//   · a child that goes terminal without report_to_master → synthesized report
//   · a WAITING_HUMAN session → never nudged, never respawned, only queued for
//     the human in the "waiting for you" queue
import { test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let host: ChildProcess;
let dir: string;
let base: string;
let argvDir: string;
let ws: string;

const freePort = (): Promise<number> =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });

async function api(method: string, p: string, body?: unknown): Promise<any> {
  const r = await fetch(base + p, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  try {
    return { status: r.status, json: JSON.parse(text) };
  } catch {
    return { status: r.status, json: { raw: text } };
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => Promise<T | null | undefined | false>, ms = 15000): Promise<T> {
  const t0 = Date.now();
  let last: unknown;
  while (Date.now() - t0 < ms) {
    const v = await fn();
    if (v) return v as T;
    last = v;
    await sleep(60);
  }
  throw new Error(`condition not met in ${ms}ms (last: ${JSON.stringify(last)})`);
}

const session = async (sid: string) => (await api('GET', `/__api/sessions/${sid}`)).json;
const chatText = async (sid: string): Promise<string> =>
  ((await api('GET', `/__api/sessions/${sid}/chat`)).json as any[]).map((e) => `${e.kind}:${e.text || ''}`).join('\n');
/** Every `claude` spawn for a session, oldest first (one JSON line per spawn). */
const spawns = (sid: string): string[][] => {
  const f = path.join(argvDir, `${sid}.jsonl`);
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
};
const modelOf = (argv: string[]): string | null => {
  const i = argv.indexOf('--model');
  return i >= 0 ? argv[i + 1] : null;
};
const incidents = (): any[] => {
  const f = path.join(dir, 'incidents.jsonl');
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
};

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-RES1-host-'));
  argvDir = path.join(dir, 'argv');
  fs.mkdirSync(argvDir, { recursive: true });
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-RES1-ws-'));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });

  // A stream-json stub that records every spawn's argv and reacts to keywords in
  // the user message: DIE (exit once, then behave), LIMIT (quota error with a
  // reset time), AUTHFAIL (revoked token). Anything else answers normally.
  const stub = path.join(dir, 'claude-stub.js');
  fs.writeFileSync(
    stub,
    `#!/usr/bin/env bun
const fs=require('node:fs');
const AD=${JSON.stringify(argvDir)};
const sid0=process.env.ARIGAMI_SESSION_ID;
fs.appendFileSync(AD+'/'+sid0+'.jsonl',JSON.stringify(process.argv.slice(2))+'\\n');
const sidIdx=process.argv.indexOf('--session-id');const rsIdx=process.argv.indexOf('--resume');
const sid=sidIdx>0?process.argv[sidIdx+1]:rsIdx>0?process.argv[rsIdx+1]:'stub';
const out=(o)=>process.stdout.write(JSON.stringify(o)+'\\n');
out({type:'system',subtype:'init',session_id:sid,model:'claude-stub',tools:['Bash'],mcp_servers:[{name:'arigami',status:'connected'}]});
const once=(k)=>{const f=AD+'/'+sid0+'.'+k;if(fs.existsSync(f))return false;fs.writeFileSync(f,'1');return true;};
let cost=0;let buf='';
process.stdin.on('data',(d)=>{buf+=d;let i;while((i=buf.indexOf('\\n'))>=0){const line=buf.slice(0,i);buf=buf.slice(i+1);if(!line.trim())continue;
  let j={};try{j=JSON.parse(line);}catch{}
  if(j.type!=='user')continue;
  const txt=(j.message&&j.message.content||[]).map((c)=>c.text||'').join(' ');
  if(txt.includes('DIE')&&once('died')){process.exit(3);}
  if(txt.includes('LIMIT')){
    out({type:'result',subtype:'error',session_id:sid,is_error:true,result:'You have hit your usage limit. Your limit resets 3am.',duration_ms:5,num_turns:1,total_cost_usd:cost});
    continue;
  }
  if(txt.includes('MODELGONE')){
    out({type:'result',subtype:'error',session_id:sid,is_error:true,result:'API Error: model claude-fable-5 is not available',duration_ms:5,num_turns:1,total_cost_usd:cost});
    continue;
  }
  if(txt.includes('AUTHFAIL')){
    out({type:'result',subtype:'error',session_id:sid,is_error:true,result:'authentication_error: OAuth token revoked',duration_ms:5,num_turns:1,total_cost_usd:cost});
    continue;
  }
  if(txt.includes('HANG')){
    // SUP1: stays 'working' forever (never emits a result) — stands in for a
    // child that is genuinely still busy, well past any stall threshold.
    continue;
  }
  if(txt.includes('SLOW')){
    // RES2: stays 'working' for a couple seconds — the window a test forces a
    // supervisor-initiated respawn (model-restore) into, to prove it replays.
    setTimeout(()=>{cost+=0.01;
      out({type:'assistant',message:{role:'assistant',content:[{type:'text',text:'ok: '+txt.slice(-40)}],usage:{input_tokens:10,output_tokens:5,cache_creation_input_tokens:0,cache_read_input_tokens:0}}});
      out({type:'result',subtype:'success',session_id:sid,is_error:false,result:'ok',duration_ms:2500,num_turns:1,total_cost_usd:cost});
    },2500);
    continue;
  }
  cost+=0.01;
  out({type:'assistant',message:{role:'assistant',content:[{type:'text',text:'ok: '+txt.slice(-40)}],usage:{input_tokens:10,output_tokens:5,cache_creation_input_tokens:0,cache_read_input_tokens:0}}});
  out({type:'result',subtype:'success',session_id:sid,is_error:false,result:'ok',duration_ms:5,num_turns:1,total_cost_usd:cost});
}});
setInterval(()=>{},1e6);
`,
    { mode: 0o755 }
  );

  host = spawn('bun', ['server/index.ts'], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOME: home,
      ARIGAMI_DIR: dir,
      ARIGAMI_PORT: String(port),
      ARIGAMI_AUTH: 'off',
      ARIGAMI_SCREEN_ENABLED: '0',
      ARIGAMI_CLAUDE_BIN: stub,
      ARIGAMI_WA_DATA_DIR: path.join(dir, 'wa'),
      ARIGAMI_TELEMETRY: '0',
      ARIGAMI_DEFAULT_CWD: ws,
      // The supervisor, wound right down so a tick is observable in a test.
      ARIGAMI_SUPERVISOR: '1',
      ARIGAMI_SUPERVISOR_TICK_SEC: '1',
      ARIGAMI_SUPERVISOR_STALL_MIN: '0.05', // 3s
      ARIGAMI_SUPERVISOR_REPORT_GRACE_MIN: '0.03', // ~2s
      ARIGAMI_SUPERVISOR_NOTIFY_MIN: '0.05',
      ARIGAMI_MODEL_CHAIN: 'fable,sonnet,haiku',
      ARIGAMI_MODEL_BACKOFF_MIN: '0.05', // the climb back is armed 3s out
      CLAUDE_CODE_OAUTH_TOKEN: '',
      COMPOSIO_API_KEY: '',
      GH_TOKEN: '',
      GITHUB_TOKEN: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  host.stdout!.on('data', (d) => (log += d));
  host.stderr!.on('data', (d) => (log += d));
  try {
    await until(async () => {
      try {
        return (await fetch(base + '/__api/config', { signal: AbortSignal.timeout(3000) })).ok;
      } catch {
        return false;
      }
    }, 30000);
  } catch {
    throw new Error(`host did not come up: ${log.slice(-1500)}`);
  }
}, 60_000); // the host boot below waits up to 30s; bun caps hooks at 5s by default

afterAll(() => {
  try {
    host?.kill('SIGTERM');
  } catch {}
});

// ---------------------------------------------------------------------------

test('health: every session gets a computed state, and /__api/health answers', async () => {
  const sid = (await api('POST', '/__api/sessions', { title: 'healthy', cwd: ws })).json.id;
  await api('POST', `/__api/sessions/${sid}/message`, { text: 'hello' });
  const row = await until(async () => {
    const h = (await api('GET', '/__api/health')).json;
    return (h.sessions || []).find((r: any) => r.sessionId === sid) || null;
  });
  expect(['RUNNING', 'IDLE_OK']).toContain(row.state);
  expect(row.dot).toBeTruthy();
  const h = (await api('GET', '/__api/health')).json;
  expect(h.modelChain).toEqual(['fable', 'sonnet', 'haiku']);
  expect(Array.isArray(h.accounts)).toBe(true);
  expect(Array.isArray(h.waiting)).toBe(true);
}, 30000);

test('proc death → respawn with --resume and a replay of the last message', async () => {
  const sid = (await api('POST', '/__api/sessions', { title: 'crasher', cwd: ws })).json.id;
  await api('POST', `/__api/sessions/${sid}/message`, { text: 'first' });
  await until(async () => (await session(sid)).claude?.state === 'idle');
  // The stub exits(3) on the first DIE it ever sees.
  await api('POST', `/__api/sessions/${sid}/message`, { text: 'please DIE' });
  await until(async () => (await session(sid)).claude?.state === 'dead');

  // The supervisor restarts it and replays the message the dead turn was on.
  await until(async () => spawns(sid).length >= 2, 20000);
  expect(spawns(sid)[1]).toContain('--resume');
  const txt = await until(async () => {
    const t = await chatText(sid);
    return /restarted it and replayed/.test(t) ? t : null;
  }, 20000);
  // …and the replayed turn actually ran on the fresh proc.
  expect(txt).toMatch(/ok: /);
  expect((await session(sid)).claude?.state).not.toBe('dead');

  const mine = incidents().filter((i) => i.sessionId === sid);
  expect(mine.some((i) => i.action === 'respawn' && i.outcome === 'ok')).toBe(true);
  expect(mine.some((i) => i.detail?.replayed === true)).toBe(true);
}, 60000);

test('limit → account switch → model downgrade → restore to the top rung', async () => {
  const a = (await api('POST', '/__api/accounts', { label: 'A', token: 'sk-ant-oat01-AAAA' })).json;
  const b = (await api('POST', '/__api/accounts', { label: 'B', token: 'sk-ant-oat01-BBBB' })).json;
  expect(a.id).toBeTruthy();
  expect(b.id).toBeTruthy();

  const sid = (await api('POST', '/__api/sessions', { title: 'limiter', cwd: ws, model: 'fable' })).json.id;
  await until(async () => spawns(sid).length >= 1);
  expect(modelOf(spawns(sid)[0])).toBe('fable');

  // 1) the first limit is routed around by switching to the other pooled account
  await api('POST', `/__api/sessions/${sid}/message`, { text: 'LIMIT please' });
  await until(async () => /switched to/.test(await chatText(sid)), 20000);
  const afterSwitch = await session(sid);
  expect(afterSwitch.claude.accountId).toBeTruthy();
  await until(async () => spawns(sid).length >= 2);
  expect(modelOf(spawns(sid)[1])).toBe('fable'); // the switch kept the top rung

  // 2) the replay hits the limit again; with the pool dry the ladder drops a rung
  const downgraded = await until(async () => {
    const s = await session(sid);
    return s.claude?.modelChoice === 'sonnet' ? s : null;
  }, 25000);
  expect(downgraded.claude.modelRung).toBe(1);
  expect(downgraded.claude.modelDowngradedFrom).toBe('fable');
  expect(Date.parse(downgraded.claude.modelRestoreAt)).toBeGreaterThan(Date.now() - 1000);
  expect(await chatText(sid)).toMatch(/out of quota .*switched to sonnet/);
  await until(async () => spawns(sid).some((a) => modelOf(a) === 'sonnet'));
  expect(incidents().some((i) => i.sessionId === sid && i.action === 'model-down' && i.detail?.to === 'sonnet')).toBe(true);

  // 3) the climb back is ARMED at the reset time the CLI itself reported
  // ("resets 3am"), not at some guess of ours — the supervisor waits for it.
  const armed = Date.parse(downgraded.claude.modelRestoreAt);
  expect(armed).toBeGreaterThan(Date.now() + 60_000);
  // …and with the whole pool still quarantined it must NOT climb back early:
  // the top rung would be downgraded again on the next turn and the session
  // would flap between rungs.
  await sleep(4000);
  expect((await session(sid)).claude.modelChoice).toBe('sonnet');

  // The human can always take the top rung back by hand (the model picker's
  // "back on <model>" button) without waiting for the reset.
  const back = await api('POST', `/__api/sessions/${sid}/model/restore`);
  expect(back.status).toBe(200);
  expect(back.json.model).toBe('fable');
  const restored = await session(sid);
  expect(restored.claude.modelRung).toBe(0);
  expect(restored.claude.modelRestoreAt).toBeNull();
  expect(await chatText(sid)).toMatch(/quota reset — back on fable/);
}, 90000);

test('an unavailable model drops a rung too, and the supervisor climbs back when the backoff expires', async () => {
  // A usable account, so the climb back is not blocked by a dry pool (the two
  // from the previous test are quarantined until their reported reset).
  await api('POST', '/__api/accounts', { label: 'C', token: 'sk-ant-oat01-CCCC' });
  const sid = (await api('POST', '/__api/sessions', { title: 'gone-model', cwd: ws, model: 'fable' })).json.id;
  await api('POST', `/__api/sessions/${sid}/message`, { text: 'MODELGONE please' });

  // No account switch can fix a model that does not exist — straight down a rung.
  const down = await until(async () => {
    const s = await session(sid);
    return s.claude?.modelChoice === 'sonnet' ? s : null;
  }, 25000);
  expect(down.claude.modelRung).toBe(1);
  expect(await chatText(sid)).toMatch(/out of quota \(model unavailable\) — switched to sonnet/);
  expect(incidents().some((i) => i.sessionId === sid && i.action === 'model-down' && i.detail?.cause === 'unavailable')).toBe(true);
  // Nothing told us when it comes back, so the backoff knob arms the climb.
  expect(Date.parse(down.claude.modelRestoreAt)).toBeLessThan(Date.now() + 10_000);

  const restored = await until(async () => {
    const s = await session(sid);
    return s.claude?.modelChoice === 'fable' && s.claude?.modelRung === 0 ? s : null;
  }, 30000);
  expect(restored.claude.modelRestoreAt).toBeNull();
  expect(await chatText(sid)).toMatch(/quota reset — back on fable/);
  expect(incidents().some((i) => i.sessionId === sid && i.action === 'model-restore' && i.outcome === 'ok')).toBe(true);
}, 90000);

test('a supervisor-initiated model change mid-turn respawns but replays the interrupted message — never drops it', async () => {
  // Reproduces the RES1 incident this fixes: a model-restore firing while a
  // turn is genuinely in flight must not silently kill it. Two independent
  // guards now exist — server/supervisor.ts defers model-restore until the
  // session is idle, and claude.js's restoreModel captures+replays the last
  // message as a second line of defense. This drives the SAME code path the
  // supervisor's own automatic restore uses (POST /model/restore →
  // claude.restoreModel), deliberately timed to land mid-turn, so it exercises
  // that second line of defense directly rather than racing the supervisor's tick.
  const sid = (await api('POST', '/__api/sessions', { title: 'mid-turn', cwd: ws, model: 'fable' })).json.id;
  await until(async () => spawns(sid).length >= 1);
  await api('POST', `/__api/sessions/${sid}/message`, { text: 'MODELGONE please' });
  await until(async () => {
    const s = await session(sid);
    return s.claude?.modelChoice === 'sonnet' && s.claude?.state === 'idle' ? s : null;
  }, 25000);
  const spawnsBefore = spawns(sid).length;

  // A turn the stub deliberately keeps 'working' on for ~2.5s.
  await api('POST', `/__api/sessions/${sid}/message`, { text: 'please go SLOW' });
  expect((await session(sid)).claude?.state).toBe('working');

  const back = await api('POST', `/__api/sessions/${sid}/model/restore`);
  expect(back.status).toBe(200);
  expect(back.json.model).toBe('fable');

  // It respawned with --resume on the restored top rung...
  await until(async () => spawns(sid).length > spawnsBefore);
  const latest = spawns(sid)[spawns(sid).length - 1];
  expect(latest).toContain('--resume');
  expect(modelOf(latest)).toBe('fable');
  expect((await session(sid)).claude?.modelRung).toBe(0);
  // …and the interrupted "please go SLOW" turn was replayed and actually
  // answered — not left as the worker's silent last words with no report.
  const txt = await until(async () => {
    const t = await chatText(sid);
    return /ok: [\s\S]*SLOW/.test(t) ? t : null;
  }, 20000);
  expect(txt).toMatch(/ok: [\s\S]*SLOW/);
}, 60000);

test('a child that goes terminal without report_to_master gets its report synthesized', async () => {
  const master = (await api('POST', '/__api/sessions', { title: 'master', cwd: ws })).json.id;
  const child = (
    await api('POST', '/__api/sessions', {
      title: 'child',
      cwd: ws,
      metadata: { master, subtask: 'do-the-thing', branch: 'child/do-the-thing' },
    })
  ).json.id;
  await api('POST', `/__api/sessions/${child}/message`, { text: 'work on it' });
  await until(async () => (await session(child)).claude?.state === 'idle');

  // It never calls report_to_master. The host builds the report from what it CAN
  // see and wakes the master with the same thin pointer — but RES2: it never
  // claims the work is 'done' on the child's behalf, only that it doesn't know.
  const result = await until(async () => (await session(child)).metadata?.result || null, 25000);
  expect(result.state).toBe('unknown');
  expect(result.synthesized).toBe(true);
  expect(result.summary).toContain('did NOT call report_to_master');
  expect(result.summary).toContain('child/do-the-thing');
  expect(result.summary).toMatch(/last words.*ok: /); // quotes the child's own last words, not a made-up conclusion
  expect(await chatText(child)).toMatch(/you did not report_to_master/);
  await until(async () => /host-synthesized/.test(await chatText(master)), 20000);
  expect(incidents().some((i) => i.sessionId === child && i.action === 'synthesize-report' && i.outcome === 'ok')).toBe(true);
}, 60000);

test('SUP1: a controller with a live child is IDLE_OK and never nudged, even though it owes its OWN master a report', async () => {
  // Reproduces the shape that actually mis-fired live (incidents.jsonl,
  // action "nudge", reason "610s"/"626s" on a CONTROLLER/PM session): a
  // session that is itself a worker of some higher master (has not reported
  // up yet) but is correctly quiet because the work it owns right now belongs
  // to its own still-working child.
  const grandparent = (await api('POST', '/__api/sessions', { title: 'grandparent', cwd: ws })).json.id;
  const controller = (
    await api('POST', '/__api/sessions', { title: 'nested-controller', cwd: ws, metadata: { master: grandparent } })
  ).json.id;
  await api('POST', `/__api/sessions/${controller}/message`, { text: 'hello' });
  await until(async () => (await session(controller)).claude?.state === 'idle');

  const child = (
    await api('POST', '/__api/sessions', { title: 'busy-child', cwd: ws, metadata: { master: controller } })
  ).json.id;
  // Keeps the child 'working' well past the 3s stall threshold — it never reports.
  await api('POST', `/__api/sessions/${child}/message`, { text: 'please HANG' });
  await until(async () => (await session(child)).claude?.state === 'working');

  const row = await until(async () => {
    const h = (await api('GET', '/__api/health')).json;
    return (h.sessions || []).find((r: any) => r.sessionId === controller) || null;
  });
  expect(row.state).toBe('IDLE_OK');

  const spawnsBefore = spawns(controller).length;
  // Several supervisor ticks past the 3s stall threshold.
  await sleep(6000);

  const mine = incidents().filter((i) => i.sessionId === controller);
  expect(mine.filter((i) => ['nudge', 'respawn', 'escalate', 'synthesize-report'].includes(i.action))).toEqual([]);
  expect(spawns(controller).length).toBe(spawnsBefore);
  expect(await chatText(controller)).not.toMatch(/host supervisor/);

  const h2 = (await api('GET', '/__api/health')).json;
  expect((h2.sessions || []).find((r: any) => r.sessionId === controller)?.state).toBe('IDLE_OK');
}, 30000);

test('a WAITING_HUMAN session is never nudged, respawned or downgraded', async () => {
  const sid = (await api('POST', '/__api/sessions', { title: 'blocked-on-me', cwd: ws })).json.id;
  await api('POST', `/__api/sessions/${sid}/message`, { text: 'hello' });
  await until(async () => (await session(sid)).claude?.state === 'idle');
  // An open question card — the one state where stopping is correct.
  await api('POST', `/__api/sessions/${sid}/action`, {
    prompt: 'Which branch should I merge into?',
    buttons: [{ label: 'main', value: 'main' }],
  });

  const row = await until(async () => {
    const h = (await api('GET', '/__api/health')).json;
    return (h.sessions || []).find((r: any) => r.sessionId === sid && r.state === 'WAITING_HUMAN') || null;
  });
  expect(row.dot).toBe('amber');

  const before = (await chatText(sid)).length;
  const spawnsBefore = spawns(sid).length;
  // Well past the 3s stall threshold — several supervisor ticks.
  await sleep(6000);

  const mine = incidents().filter((i) => i.sessionId === sid);
  expect(mine.filter((i) => ['nudge', 'respawn', 'model-down', 'refresh-auth', 'escalate'].includes(i.action))).toEqual([]);
  expect(spawns(sid).length).toBe(spawnsBefore);
  const after = await chatText(sid);
  expect(after).not.toMatch(/host supervisor/);
  expect(after.length).toBe(before);

  // …but it IS in the queue the human is meant to look at.
  const q = (await api('GET', '/__api/waiting')).json;
  const mineRow = q.waiting.find((w: any) => w.sessionId === sid);
  expect(mineRow).toBeTruthy();
  expect(mineRow.kind).toBe('action');
  expect(mineRow.unblock).toBe('answer');
  expect(mineRow.what).toBe('waiting.what.action');
  expect(Date.parse(mineRow.since)).toBeLessThanOrEqual(Date.now());
  // GET /__api/pending carries the same rows (the spec's single endpoint).
  expect((await api('GET', '/__api/pending')).json.waiting.some((w: any) => w.sessionId === sid)).toBe(true);
}, 60000);

test('a master waiting on a child that never got the ask has it re-delivered', async () => {
  // A project folder is what authorises task_session controller → child.
  const folder = (await api('POST', '/__api/folders', { name: 'proj' })).json;
  const master = (await api('POST', '/__api/sessions', { title: 'controller', cwd: ws })).json.id;
  const child = (await api('POST', '/__api/sessions', { title: 'worker', cwd: ws })).json.id;
  await api('PATCH', `/__api/folders/${folder.id}`, { controllerSessionId: master });
  await api('PATCH', `/__api/sessions/${child}`, { folderId: folder.id });

  const r = await api('POST', `/__api/sessions/${child}/task`, { from: master, text: 'merge the branch when green' });
  expect(r.status).toBe(200);
  // The controller now records what it is waiting on.
  const w = await until(async () => (await session(master)).metadata?.waitingOn || null);
  expect(w.sessionId).toBe(child);
  expect(w.what).toContain('merge the branch');

  // Pretend the ask never landed: rewind the child so nothing looks newer than
  // `since`, which is exactly the state the supervisor is built to notice.
  await until(async () => (await session(child)).claude?.state === 'idle');
  await api('PATCH', `/__api/sessions/${master}`, {
    metadata: { waitingOn: { sessionId: child, since: new Date(Date.now() + 60_000).toISOString(), what: 'merge the branch when green' } },
  });
  await until(async () => /never reached you/.test(await chatText(child)), 25000);
  expect(incidents().some((i) => i.sessionId === master && i.action === 'redeliver-ask')).toBe(true);
}, 60000);

test('incidents are readable over the API, newest first', async () => {
  const r = (await api('GET', '/__api/health/incidents?hours=24')).json;
  expect(r.hours).toBe(24);
  expect(r.count).toBeGreaterThan(0);
  expect(r.incidents[0].ts >= r.incidents[r.incidents.length - 1].ts).toBe(true);
  for (const i of r.incidents) {
    expect(typeof i.action).toBe('string');
    expect(typeof i.sessionId).toBe('string');
  }
}, 30000);
