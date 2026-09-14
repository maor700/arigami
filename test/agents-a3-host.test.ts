// A3 end-to-end against an ISOLATED host (tmp ARIGAMI_DIR, own port, auth off,
// a stub `claude` that speaks stream-json): a session born from a restricted
// agent is spawned with --disallowedTools + the PreToolUse hook (--settings);
// the policy endpoints classify tools/domains; the hook script itself blocks
// (exit 2) / allows; open_tab refuses foreign domains; request_action carries
// the agent + kind, "auto-approve from now on" lands in agent.json and the next
// action of that kind is answered by the host; turns land in activity.jsonl
// with tokens + cost, the daily budget refuses new sessions (429) and warns the
// running one; the activity + budgets REST views aggregate it.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let host: ChildProcess;
let dir: string;
let base: string;
let argvDir: string;
let ws: string; // the sessions' cwd — OUTSIDE ARIGAMI_DIR (publish_artifact refuses the state dir)

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
async function until<T>(fn: () => Promise<T | null | undefined | false>, ms = 8000): Promise<T> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await fn();
    if (v) return v as T;
    await sleep(50);
  }
  throw new Error('condition not met in time');
}
const chat = async (sid: string): Promise<any[]> => (await api('GET', `/__api/sessions/${sid}/chat`)).json;
const ledger = (slug: string): any[] =>
  fs.existsSync(path.join(dir, 'agents', slug, 'activity.jsonl'))
    ? fs.readFileSync(path.join(dir, 'agents', slug, 'activity.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : [];
const argvOf = async (sid: string): Promise<string[]> => until(async () => {
  const f = path.join(argvDir, `${sid}.json`);
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
});

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-A3-host-'));
  argvDir = path.join(dir, 'argv');
  fs.mkdirSync(argvDir, { recursive: true });
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-A3-ws-'));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  // A stream-json stub: records argv per session, reports init, and answers
  // every user line with one assistant message (600 in / 400 out tokens) and a
  // result whose total_cost_usd grows by $0.01 per turn (cumulative, like the CLI).
  const stub = path.join(dir, 'claude-stub.js');
  fs.writeFileSync(
    stub,
    `#!/usr/bin/env bun
const fs=require('node:fs');
fs.writeFileSync(${JSON.stringify(argvDir)}+'/'+process.env.ARIGAMI_SESSION_ID+'.json',JSON.stringify(process.argv.slice(2)));
const sidIdx=process.argv.indexOf('--session-id');const rsIdx=process.argv.indexOf('--resume');
const sid=sidIdx>0?process.argv[sidIdx+1]:rsIdx>0?process.argv[rsIdx+1]:'stub';
const out=(o)=>process.stdout.write(JSON.stringify(o)+'\\n');
out({type:'system',subtype:'init',session_id:sid,model:'claude-stub',tools:['Bash','Read'],mcp_servers:[{name:'arigami',status:'connected'}]});
let cost=0;let buf='';
process.stdin.on('data',(d)=>{buf+=d;let i;while((i=buf.indexOf('\\n'))>=0){const line=buf.slice(0,i);buf=buf.slice(i+1);if(!line.trim())continue;
  let j={};try{j=JSON.parse(line);}catch{}
  if(j.type!=='user')continue; // the host's eager initialize control_request is not a turn
  cost+=0.01;
  out({type:'assistant',message:{role:'assistant',content:[{type:'text',text:'ok'}],usage:{input_tokens:600,output_tokens:400,cache_creation_input_tokens:0,cache_read_input_tokens:0}}});
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
  // bot: restricted (gmail + desktop + publish, example.com only, 2500 tokens/day = 2 turns of
  // the stub; A5: `publish` is a family now, so publishing has to be asked for); free: unrestricted
  expect((await api('POST', '/__api/agents', { name: 'Bot', slug: 'bot', emoji: '🤖', tools: ['gmail', 'desktop', 'publish'], domains: ['example.com'], budget: { tokensPerDay: 2500 } })).status).toBe(201);
  expect((await api('POST', '/__api/agents', { name: 'Free', slug: 'free', emoji: '🕊️' })).status).toBe(201);
}, 60_000); // the host boot below waits up to 30s; bun caps hooks at 5s by default

afterAll(() => {
  try {
    host?.kill('SIGTERM');
  } catch {}
});

let botSession = '';
let freeSession = '';

test('spawn flags: a restricted agent session gets --disallowedTools + the PreToolUse hook; an unrestricted one gets neither', async () => {
  botSession = (await api('POST', '/__api/sessions', { agent: 'bot', cwd: ws })).json.id;
  freeSession = (await api('POST', '/__api/sessions', { agent: 'free', cwd: ws })).json.id;
  const argv = await argvOf(botSession);
  const dis = argv[argv.indexOf('--disallowedTools') + 1] || '';
  expect(dis.split(',')).toEqual(expect.arrayContaining(['Bash', 'Edit', 'Write', 'WebFetch']));
  const settings = JSON.parse(argv[argv.indexOf('--settings') + 1]);
  expect(settings.hooks.PreToolUse[0].hooks[0].command).toContain('policy-hook.js');
  const free = await argvOf(freeSession);
  expect(free).not.toContain('--disallowedTools');
  expect(free).not.toContain('--settings');
  // the first spawn is a 'session' line in the ledger
  expect(ledger('bot').some((e) => e.kind === 'session' && e.sessionId === botSession)).toBe(true);
});

test('policy REST: hidden host tools, allow/deny verdicts incl. the domain allowlist; denials are logged', async () => {
  const pol = (await api('GET', `/__api/sessions/${botSession}/policy?names=open_tab,create_session,set_title,cronjob,request_action`)).json;
  expect(pol.restrictive).toBe(true);
  expect(pol.hidden).toEqual(['create_session', 'cronjob']);
  expect(pol.domains).toEqual(['example.com']);
  const free = (await api('GET', `/__api/sessions/${freeSession}/policy?names=create_session`)).json;
  expect(free.restrictive).toBe(false);
  expect(free.hidden).toEqual([]);
  const check = async (tool_name: string, input: unknown = {}) => (await api('POST', `/__api/sessions/${botSession}/policy/check`, { tool_name, input })).json;
  expect((await check('Bash', { command: 'ls' })).allow).toBe(false);
  expect((await check('Read', { file_path: '/x' })).allow).toBe(true);
  expect((await check('mcp__composio-mcp__GMAIL_SEND_EMAIL')).allow).toBe(true);
  expect((await check('mcp__composio-mcp__GOOGLEDRIVE_LIST_FILES')).allow).toBe(false);
  const dom = await check('mcp__arigami__open_tab', { url: 'https://evil.com/x' });
  expect(dom.allow).toBe(false);
  expect(dom.reason).toMatch(/evil\.com/);
  expect((await check('mcp__arigami__open_tab', { url: 'https://www.example.com/x' })).allow).toBe(true);
  expect(ledger('bot').filter((e) => e.kind === 'policy').length).toBeGreaterThanOrEqual(3);
  // a session without an agent is never restricted
  const plain = (await api('POST', '/__api/sessions', { title: 'plain', cwd: ws })).json.id;
  expect((await api('POST', `/__api/sessions/${plain}/policy/check`, { tool_name: 'Bash', input: {} })).json.allow).toBe(true);
});

test('the hook script blocks (exit 2, reason on stderr) and allows (exit 0); unreachable host = blocked', () => {
  const run = (tool_name: string, tool_input: unknown, url = base) =>
    spawnSync('bun', [path.join(ROOT, 'mcp', 'policy-hook.js')], {
      input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name, tool_input }),
      env: { ...process.env, ARIGAMI_URL: url, ARIGAMI_SESSION_ID: botSession, ARIGAMI_TOKEN: '', ARIGAMI_AGENT: 'bot' },
      encoding: 'utf8',
      timeout: 20000,
    });
  const blocked = run('Bash', { command: 'rm -rf /' });
  expect(blocked.status).toBe(2);
  expect(blocked.stderr).toMatch(/allowlist/);
  expect(run('mcp__composio-mcp__GMAIL_FETCH_EMAILS', {}).status).toBe(0);
  expect(run('WebFetch', { url: 'https://evil.com' }).status).toBe(2);
  const down = run('Read', {}, 'http://127.0.0.1:1');
  expect(down.status).toBe(2);
  expect(down.stderr).toMatch(/cannot verify/);
});

test('open_tab: a url outside the agent domains is refused (403); inside + loopback pass', async () => {
  const bad = await api('POST', `/__api/sessions/${botSession}/tabs`, { type: 'url', title: 'x', url: 'https://evil.com/' });
  expect(bad.status).toBe(403);
  expect(bad.json.error).toMatch(/evil\.com/);
  expect((await api('POST', `/__api/sessions/${botSession}/tabs`, { type: 'url', title: 'ok', url: 'https://app.example.com/' })).status).toBe(201);
  expect((await api('POST', `/__api/sessions/${botSession}/tabs`, { type: 'url', title: 'dev', url: 'http://localhost:5173/' })).status).toBe(201);
  expect((await api('POST', `/__api/sessions/${botSession}/tabs`, { type: 'content', title: 'md', body: 'hi' })).status).toBe(201);
  // the unrestricted agent may open anything
  expect((await api('POST', `/__api/sessions/${freeSession}/tabs`, { type: 'url', title: 'x', url: 'https://evil.com/' })).status).toBe(201);
});

test('request_action: the card carries the agent + kind; answering with autoApprove stores the kind; the next one is answered by the host', async () => {
  const a1 = await api('POST', `/__api/sessions/${botSession}/action`, { prompt: 'Send the weekly mail?', kind: 'send-email', buttons: [{ label: 'Send', value: 'send', style: 'primary' }, { label: 'No', value: 'no' }] });
  expect(a1.status).toBe(201);
  expect(a1.json.agent).toMatchObject({ slug: 'bot', name: 'Bot', emoji: '🤖' });
  expect(a1.json.kind).toBe('send-email');
  expect(a1.json.autoApproved).toBeUndefined();
  expect((await api('GET', `/__api/sessions/${botSession}`)).json.action.agent.slug).toBe('bot');
  expect((await api('POST', `/__api/sessions/${botSession}/action/answer`, { value: 'send', autoApprove: true })).status).toBe(200);
  expect((await api('GET', '/__api/agents/bot')).json.autoApprove).toEqual(['send-email']);
  const human = ledger('bot').find((e) => e.kind === 'action' && e.auto === false);
  expect(human).toMatchObject({ actionKind: 'send-email', value: 'send', sessionId: botSession });
  // second action of the same kind → answered by the host with the primary button, no sticky bar
  const a2 = await api('POST', `/__api/sessions/${botSession}/action`, { prompt: 'Send the daily mail?', kind: 'send-email', buttons: [{ label: 'Later', value: 'later' }, { label: 'Send', value: 'send', style: 'primary' }] });
  expect(a2.status).toBe(201);
  expect(a2.json.autoApproved).toBe(true);
  expect(a2.json.value).toBe('send');
  expect((await api('GET', `/__api/sessions/${botSession}`)).json.action).toBeNull();
  const evs = await chat(botSession);
  expect(evs.some((e) => e.kind === 'action-auto' && e.actionKind === 'send-email' && e.value === 'send')).toBe(true);
  expect(evs.filter((e) => e.kind === 'user' && e.text === 'send').length).toBe(2);
  expect(ledger('bot').some((e) => e.kind === 'action' && e.auto === true && e.actionKind === 'send-email')).toBe(true);
  // a different kind still asks; an invalid kind is a 400; a plain session's action has no agent
  const a3 = await api('POST', `/__api/sessions/${botSession}/action`, { prompt: 'Merge?', kind: 'merge', buttons: [{ label: 'Yes', value: 'yes' }] });
  expect(a3.json.autoApproved).toBeUndefined();
  await api('POST', `/__api/sessions/${botSession}/action/dismiss`, {});
  expect((await api('POST', `/__api/sessions/${botSession}/action`, { prompt: 'x', kind: 'Bad Kind', buttons: [{ label: 'a', value: 'a' }] })).status).toBe(400);
  const plain = (await api('POST', '/__api/sessions', { title: 'plain2', cwd: ws })).json.id;
  const pa = await api('POST', `/__api/sessions/${plain}/action`, { prompt: 'x', kind: 'send-email', buttons: [{ label: 'a', value: 'a' }] });
  expect(pa.json.agent).toBeUndefined();
  expect(pa.json.autoApproved).toBeUndefined();
});

test('ledger + budget: turns land with tokens/cost; the cap refuses new sessions (429) and warns the running one once', async () => {
  // the two auto-approved answers above already ran 2 stub turns (1000 tokens each) → 2000 / 2500
  await until(async () => ledger('bot').filter((e) => e.kind === 'turn').length >= 2);
  const turns = ledger('bot').filter((e) => e.kind === 'turn');
  expect(turns[0]).toMatchObject({ sessionId: botSession, tokens: 1000, breakdown: { input: 600, output: 400, cacheCreation: 0, cacheRead: 0 } });
  expect(turns[0].costUsd).toBeCloseTo(0.01, 6);
  expect(turns[1].costUsd).toBeCloseTo(0.01, 6); // per-turn DELTA of the cumulative total_cost_usd
  let b = (await api('GET', '/__api/agents/budgets')).json;
  const row = b.budgets.find((r: any) => r.slug === 'bot');
  expect(row).toMatchObject({ name: 'Bot', cap: 2500, usedTokens: 2000, exceeded: false });
  expect(row.usedCostUsd).toBeCloseTo(0.02, 6);
  expect(b.budgets.find((r: any) => r.slug === 'free')).toMatchObject({ cap: null, usedTokens: 0, exceeded: false });
  // one more turn → 3000 ≥ 2500: the session gets the final warning, exactly once
  expect((await api('POST', `/__api/sessions/${botSession}/message`, { text: 'one more' })).status).toBe(200);
  await until(async () => (await chat(botSession)).some((e) => e.kind === 'error' && e.budget === true));
  const evs = await chat(botSession);
  expect(evs.filter((e) => e.kind === 'error' && e.budget === true).length).toBe(1);
  expect(evs.some((e) => e.kind === 'user' && /FINAL WARNING/.test(e.text))).toBe(true);
  // that warning turn itself ran (the stub answers everything) but must not warn again
  await until(async () => ledger('bot').filter((e) => e.kind === 'turn').length >= 4);
  expect((await chat(botSession)).filter((e) => e.kind === 'error' && e.budget === true).length).toBe(1);
  expect(ledger('bot').filter((e) => e.kind === 'budget').length).toBe(1);
  // new sessions of the agent are refused with a clear line; other agents and plain sessions are fine
  const refused = await api('POST', '/__api/sessions', { agent: 'bot', cwd: ws });
  expect(refused.status).toBe(429);
  expect(refused.json.error).toMatch(/daily token budget/);
  expect(refused.json.error).toMatch(/no new sessions or turns until local midnight/); // A5 (#5): turns too
  const home = await api('GET', '/__api/agents/bot/home');
  expect(home.status).toBe(429);
  expect((await api('POST', '/__api/sessions', { agent: 'free', cwd: ws })).status).toBe(201);
  b = (await api('GET', '/__api/agents/budgets')).json;
  expect(b.budgets.find((r: any) => r.slug === 'bot').exceeded).toBe(true);
  // raising the cap in the budgets table lifts the refusal at once
  expect((await api('PATCH', '/__api/agents/bot', { budget: { tokensPerDay: 100000 } })).status).toBe(200);
  expect((await api('POST', '/__api/sessions', { agent: 'bot', cwd: ws })).status).toBe(201);
});

test('activity REST: entries per range with totals + budget; artifacts are logged', async () => {
  fs.writeFileSync(path.join(ws, 'report.html'), '<h1>hi</h1>');
  const pub = await api('POST', `/__api/sessions/${botSession}/artifacts`, { path: path.join(ws, 'report.html'), title: 'Report' });
  expect(pub.status).toBe(200);
  const act = (await api('GET', '/__api/agents/bot/activity?range=today')).json;
  expect(act.range).toBe('today');
  expect(act.totals.turns).toBeGreaterThanOrEqual(4);
  expect(act.totals.tokens).toBeGreaterThanOrEqual(4000);
  expect(act.totals.actions).toBe(2);
  expect(act.totals.artifacts).toBe(1);
  expect(act.totals.denied).toBeGreaterThanOrEqual(3);
  expect(act.budget).toMatchObject({ cap: 100000, exceeded: false });
  expect(act.entries[0].ts >= act.entries[act.entries.length - 1].ts).toBe(true); // newest first
  expect(act.entries.some((e: any) => e.kind === 'artifact' && e.detail === 'Report')).toBe(true);
  expect(act.sessions.some((s: any) => s.id === botSession)).toBe(true);
  // RES2: cost must round-trip through this exact REST surface — every 'turn'
  // line the ledger wrote carries a real costUsd, the range totals sum it, and
  // the per-session rollup (the "runs" tab) does too. A field-name mismatch
  // between producer (claude.js) and any of these three consumers would render
  // as a silent $0 here, not a crash — assert non-zero, not just present.
  expect(act.totals.costUsd).toBeGreaterThan(0);
  const turnEntries = act.entries.filter((e: any) => e.kind === 'turn');
  expect(turnEntries.length).toBeGreaterThanOrEqual(4);
  for (const e of turnEntries) expect(e.costUsd).toBeGreaterThan(0);
  const botRun = act.sessions.find((s: any) => s.id === botSession);
  expect(botRun.costUsd).toBeGreaterThan(0);
  expect((await api('GET', '/__api/agents/bot/activity?range=30d')).json.totals.tokens).toBe(act.totals.tokens);
  expect((await api('GET', '/__api/agents/free/activity')).json.totals).toMatchObject({ tokens: 0, turns: 0 });
});
