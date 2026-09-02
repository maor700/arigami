// LADDER1 — compact-before-replay end-to-end against an ISOLATED host (tmp
// ARIGAMI_DIR, own port, auth off, a stub `claude`): a conversation the stub
// reports as ~600k tokens is downgraded fable → haiku (chain 'fable,haiku', so
// the drop crosses the 1M → 200k window cliff). The host must NOT `--resume` it
// raw; it compacts (digest via the one-shot runner ON THE TARGET RUNG + the tail
// verbatim) onto a fresh conversation, badges the session, and on the climb
// back resumes the ORIGINAL full history.
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
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
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
    await sleep(80);
  }
  throw new Error(`condition not met in ${ms}ms (last: ${JSON.stringify(last)?.slice(0, 300)})`);
}
const session = async (sid: string) => (await api('GET', `/__api/sessions/${sid}`)).json;
const chatText = async (sid: string): Promise<string> =>
  ((await api('GET', `/__api/sessions/${sid}/chat`)).json as any[]).map((e) => `${e.kind}:${e.text || ''}`).join('\n');
const spawns = (sid: string): string[][] => {
  const f = path.join(argvDir, `${sid}.jsonl`);
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
};
/** Every user message text the stub received for a session (stdin), oldest first. */
const received = (sid: string): string[] => {
  const f = path.join(argvDir, `${sid}.msgs`);
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split('\n\x1e\n').filter(Boolean);
};
const flag = (argv: string[], name: string): string | null => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
};
const incidents = (): any[] => {
  const f = path.join(dir, 'incidents.jsonl');
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
};

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-LADDER1-host-'));
  argvDir = path.join(dir, 'argv');
  fs.mkdirSync(argvDir, { recursive: true });
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-LADDER1-ws-'));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });

  // The stub: records argv + every user message; `claude -p <prompt>` (the
  // one-shot summarizer) answers a canned digest and exits; BIG makes the
  // assistant usage claim a ~600k-token context; LIMIT fails ONCE per session
  // with a quota error (so the replayed turn then succeeds).
  const stub = path.join(dir, 'claude-stub.js');
  fs.writeFileSync(
    stub,
    `#!/usr/bin/env bun
const fs=require('node:fs');
const AD=${JSON.stringify(argvDir)};
const argv=process.argv.slice(2);
if(argv[0]==='-p'&&argv[1]&&!argv[1].startsWith('--')){
  fs.appendFileSync(AD+'/oneshot.jsonl',JSON.stringify({argv,prompt:argv[1]})+'\\n');
  process.stdout.write(JSON.stringify({type:'result',is_error:false,result:'DIGEST-FROM-STUB: the older turns, summarized on the target rung.'})+'\\n');
  process.exit(0);
}
const sid0=process.env.ARIGAMI_SESSION_ID;
fs.appendFileSync(AD+'/'+sid0+'.jsonl',JSON.stringify(argv)+'\\n');
const sidIdx=argv.indexOf('--session-id');const rsIdx=argv.indexOf('--resume');
const sid=sidIdx>=0?argv[sidIdx+1]:rsIdx>=0?argv[rsIdx+1]:'stub';
const out=(o)=>process.stdout.write(JSON.stringify(o)+'\\n');
out({type:'system',subtype:'init',session_id:sid,model:'claude-stub',tools:['Bash'],mcp_servers:[{name:'arigami',status:'connected'}]});
const once=(k)=>{const f=AD+'/'+sid0+'.'+k;if(fs.existsSync(f))return false;fs.writeFileSync(f,'1');return true;};
let cost=0;let buf='';
process.stdin.on('data',(d)=>{buf+=d;let i;while((i=buf.indexOf('\\n'))>=0){const line=buf.slice(0,i);buf=buf.slice(i+1);if(!line.trim())continue;
  let j={};try{j=JSON.parse(line);}catch{}
  if(j.type!=='user')continue;
  const txt=(j.message&&j.message.content||[]).map((c)=>c.text||'').join(' ');
  fs.appendFileSync(AD+'/'+sid0+'.msgs',txt+'\\n\\x1e\\n');
  if(txt.includes('LIMIT')&&once('limited')){
    out({type:'result',subtype:'error',session_id:sid,is_error:true,result:'You have hit your usage limit. Your limit resets 6:50pm.',duration_ms:5,num_turns:1,total_cost_usd:cost});
    continue;
  }
  const big=txt.includes('BIG');
  cost+=0.01;
  out({type:'assistant',message:{role:'assistant',content:[{type:'text',text:'ok: '+txt.slice(-40)}],usage:{input_tokens:10,output_tokens:5,cache_creation_input_tokens:0,cache_read_input_tokens:big?600000:0}}});
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
      ARIGAMI_SUPERVISOR: '0', // this test drives the ladder through claude.js directly
      ARIGAMI_MODEL_CHAIN: 'fable,haiku', // one drop crosses the 1M → 200k cliff
      ARIGAMI_LADDER_TAIL_TURNS: '2',
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
        return (await fetch(base + '/__api/config')).ok;
      } catch {
        return false;
      }
    }, 30000);
  } catch {
    throw new Error(`host did not come up: ${log.slice(-1500)}`);
  }
});

afterAll(() => {
  try {
    host?.kill('SIGTERM');
  } catch {}
});

test('a ~600k conversation is COMPACTED (not resumed raw) when the ladder drops to haiku; the climb back restores the full history', async () => {
  const sid = (await api('POST', '/__api/sessions', { title: 'big-ctx', cwd: ws, model: 'fable' })).json.id;
  await until(async () => spawns(sid).length >= 1);
  const original = (await session(sid)).claude.sessionId;
  expect(original).toBeTruthy();

  // Three turns; the assistant usage claims ~600k tokens of context.
  for (const t of ['BIG turn one about /repo/a.ts', 'BIG turn two about /repo/b.ts', 'BIG turn three about /repo/c.ts']) {
    await api('POST', `/__api/sessions/${sid}/message`, { text: t });
    await until(async () => ((await session(sid)).claude?.state === 'idle' ? true : null));
  }
  expect((await session(sid)).claude.usage.ctxTokens).toBe(600_010);

  // The quota wall. No pooled account to switch to → one rung down → haiku,
  // whose 200k window cannot hold 600k → compact.
  await api('POST', `/__api/sessions/${sid}/message`, { text: 'LIMIT please finish /repo/d.ts' });
  const down = await until(async () => {
    const s = await session(sid);
    return s.claude?.ladderReplay?.mode === 'compact' ? s : null;
  }, 30000);
  expect(down.claude.modelChoice).toBe('haiku');
  expect(down.claude.modelRung).toBe(1);
  expect(down.claude.ladderReplay.originalSessionId).toBe(original);
  expect(down.claude.ladderReplay.estTokens).toBe(600_010);
  expect(down.claude.ladderReplay.targetWindow).toBe(200_000);
  expect(down.claude.ladderReplay.digest).toBe('llm');
  // A FRESH conversation, not a --resume of the too-big one.
  expect(down.claude.sessionId).not.toBe(original);
  const haikuSpawn = spawns(sid).find((a) => flag(a, '--model') === 'haiku');
  expect(haikuSpawn).toBeTruthy();
  expect(haikuSpawn).not.toContain('--resume');
  expect(flag(haikuSpawn!, '--session-id')).toBe(down.claude.sessionId);
  // The summarizer ran on the TARGET rung.
  const oneshots = fs.readFileSync(path.join(argvDir, 'oneshot.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  expect(oneshots.length).toBe(1);
  expect(flag(oneshots[0].argv, '--model')).toBe('haiku');
  expect(oneshots[0].prompt).toContain('BIG turn one about /repo/a.ts');
  // Receipts + incident.
  const txt = await chatText(sid);
  expect(txt).toMatch(/out of quota .*switched to haiku/);
  expect(txt).toMatch(/does not fit haiku's 200k window — compacting/);
  expect(txt).toMatch(/context compacted for haiku: a digest .* last 2 turns verbatim/);
  expect(incidents().some((i) => i.sessionId === sid && i.action === 'context-compact' && i.detail?.originalSessionId === original)).toBe(true);
  // The badge the API's session summary carries (rail row + chat header).
  const wire = (await api('GET', '/__api/sessions')).json.find((s: any) => s.id === sid);
  expect(wire.claude.ladder).toEqual({ running: 'haiku', configured: 'fable', resetAt: down.claude.modelRestoreAt, compacted: true });
  expect(Date.parse(down.claude.modelRestoreAt)).toBeGreaterThan(Date.now());

  // The replayed turn actually reached the fresh proc, preceded by the
  // preamble: digest first, then the last 2 turns verbatim, then the message.
  const replayed = await until(async () => received(sid).find((m) => m.includes('[host — context compacted]')) || null, 20000);
  const iDigest = replayed.indexOf('=== DIGEST OF THE OLDER CONVERSATION ===');
  const iTail = replayed.indexOf('=== LAST 2 TURNS (verbatim) ===');
  const iMsg = replayed.lastIndexOf('LIMIT please finish /repo/d.ts');
  expect(iDigest).toBeGreaterThan(0);
  expect(iTail).toBeGreaterThan(iDigest);
  expect(iMsg).toBeGreaterThan(iTail);
  expect(replayed).toContain('DIGEST-FROM-STUB');
  expect(replayed).toContain('USER: BIG turn three about /repo/c.ts'); // verbatim tail
  expect(replayed.slice(iDigest, iTail)).not.toContain('USER: BIG turn one'); // …the older turn is only in the digest
  // …and it was answered on haiku (the stub's LIMIT fires once).
  await until(async () => (/ok: [\s\S]*d\.ts/.test(await chatText(sid)) ? true : null), 20000);

  // The climb back: the top rung is back → resume the ORIGINAL full history.
  const back = await api('POST', `/__api/sessions/${sid}/model/restore`);
  expect(back.status).toBe(200);
  expect(back.json.model).toBe('fable');
  const restored = await until(async () => {
    const s = await session(sid);
    return s.claude?.ladderReplay?.mode === 'full-restore' ? s : null;
  }, 20000);
  expect(restored.claude.modelChoice).toBe('fable');
  expect(restored.claude.modelRung).toBe(0);
  expect(restored.claude.sessionId).toBe(original);
  await until(async () => spawns(sid).some((a) => flag(a, '--model') === 'fable' && flag(a, '--resume') === original) || null);
  expect(await chatText(sid)).toMatch(/back on fable, with the full conversation history/);
  expect(incidents().some((i) => i.sessionId === sid && i.action === 'context-restore')).toBe(true);
  // Badge gone.
  const wire2 = (await api('GET', '/__api/sessions')).json.find((s: any) => s.id === sid);
  expect(wire2.claude.ladder ?? null).toBeNull();
  // The next message on the restored history carries the interim note once.
  await api('POST', `/__api/sessions/${sid}/message`, { text: 'after restore' });
  const withInterim = await until(async () => received(sid).find((m) => m.includes('[host — full history restored]') && m.includes('after restore')) || null, 20000);
  expect(withInterim).toContain('=== INTERIM TURNS ===');
  expect(withInterim).toContain('LIMIT please finish /repo/d.ts');
  await until(async () => ((await session(sid)).claude?.state === 'idle' ? true : null));
  await api('POST', `/__api/sessions/${sid}/message`, { text: 'plain follow-up' });
  const plain = await until(async () => received(sid).find((m) => m.endsWith('plain follow-up') || m.includes('\nplain follow-up')) || null, 20000);
  expect(plain).not.toContain('[host — full history restored]');
}, 120000);

test('a conversation that FITS the weaker rung is still replayed in full (plain --resume, as before)', async () => {
  const sid = (await api('POST', '/__api/sessions', { title: 'small-ctx', cwd: ws, model: 'fable' })).json.id;
  await until(async () => spawns(sid).length >= 1);
  const original = (await session(sid)).claude.sessionId;
  await api('POST', `/__api/sessions/${sid}/message`, { text: 'small turn' });
  await until(async () => ((await session(sid)).claude?.state === 'idle' ? true : null));
  await api('POST', `/__api/sessions/${sid}/message`, { text: 'LIMIT again' });
  const down = await until(async () => {
    const s = await session(sid);
    return s.claude?.modelChoice === 'haiku' ? s : null;
  }, 30000);
  expect(down.claude.ladderReplay.mode).toBe('full');
  expect(down.claude.sessionId).toBe(original);
  const haikuSpawn = await until(async () => spawns(sid).find((a) => flag(a, '--model') === 'haiku') || null);
  expect(flag(haikuSpawn, '--resume')).toBe(original);
  expect(await chatText(sid)).not.toMatch(/compacting/);
}, 60000);
