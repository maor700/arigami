// A5 end-to-end against an ISOLATED host (tmp ARIGAMI_DIR, own port, auth off, a
// stub `claude` that speaks stream-json) — the three fixes the live E2E run said
// had to be provable (TEST-REPORT-AGENTS-E2E.md):
//   #1 a routine asked for by an agent WITHOUT `triggers`: the CLI's own
//      CronCreate is stripped at spawn and refused by the policy with the
//      "the human adds it in the Routine tab" hint;
//   #2 a restricted agent can neither publish nor mint a public link; an agent
//      that may publish still needs the human to approve share:true;
//   #5 after the cap + its one final warning, the next TURN is refused (429).
// Plus #7: a closed allowlist is spawned with --strict-mcp-config.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { hostDiag } from './_host-diag.js';

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
const argvOf = async (sid: string): Promise<string[]> => until(async () => {
  const f = path.join(argvDir, `${sid}.json`);
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
});

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-A5-host-'));
  argvDir = path.join(dir, 'argv');
  fs.mkdirSync(argvDir, { recursive: true });
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-A5-ws-'));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  // The same stream-json stub A3 uses: records argv per session and answers every
  // user line with one assistant message (600 in / 400 out) + a result.
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
  if(j.type!=='user')continue;
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
        return (await fetch(base + '/__api/config', { signal: AbortSignal.timeout(3000) })).ok;
      } catch {
        return false;
      }
    }, 30000);
  } catch {
    throw new Error(`host did not come up: ${log.slice(-1500)}${hostDiag(host)}`);
  }
  // scout: the report's "read-only researcher" — web + desktop, no triggers, no publish.
  // nili: may publish (and hits a 2500-token cap after 2 stub turns). mailer: touches composio.
  expect((await api('POST', '/__api/agents', { name: 'Scout', slug: 'scout', emoji: '🔎', tools: ['web', 'desktop'] })).status).toBe(201);
  expect((await api('POST', '/__api/agents', { name: 'Nili', slug: 'nili', emoji: '✍️', tools: ['git', 'publish'], budget: { tokensPerDay: 2500 } })).status).toBe(201);
  expect((await api('POST', '/__api/agents', { name: 'Mailer', slug: 'mailer', emoji: '📧', tools: ['gmail'] })).status).toBe(201);
  fs.writeFileSync(path.join(ws, 'draft.md'), '# draft\n');
}, 60_000); // the host boot below waits up to 30s; bun caps hooks at 5s by default

afterAll(() => {
  try {
    host?.kill('SIGTERM');
  } catch {}
});

let scoutSession = '';
let niliSession = '';

test('#1 a routine from an agent without `triggers`: CronCreate is stripped at spawn and refused with the Routine-tab hint', async () => {
  scoutSession = (await api('POST', '/__api/sessions', { agent: 'scout', cwd: ws })).json.id;
  const argv = await argvOf(scoutSession);
  const dis = (argv[argv.indexOf('--disallowedTools') + 1] || '').split(',');
  expect(dis).toEqual(expect.arrayContaining(['CronCreate', 'CronDelete', 'CronList']));
  // …and if one ever reaches the hook (a session spawned before the flags), the
  // verdict tells the model exactly what to say instead of faking a routine.
  const v = (await api('POST', `/__api/sessions/${scoutSession}/policy/check`, { tool_name: 'CronCreate', input: { schedule: '0 7 * * *' } })).json;
  expect(v.allow).toBe(false);
  expect(v.reason).toMatch(/session-only schedule \(CronCreate\) is NOT a routine/);
  expect(v.reason).toMatch(/Routine tab/);
  expect((await api('POST', `/__api/sessions/${scoutSession}/policy/check`, { tool_name: 'mcp__arigami__cronjob', input: {} })).json.allow).toBe(false);
  // the host tool is hidden from the toolset as well
  expect((await api('GET', `/__api/sessions/${scoutSession}/policy?names=cronjob,register_listener,set_title`)).json.hidden).toEqual(['cronjob', 'register_listener']);
  // the human's own path still works: the Routine tab form creates a real job
  const trig = await api('POST', '/__api/triggers', { type: 'cron', agent: 'scout', name: 'daily scan', prompt: 'scan', schedule: { kind: 'cron', value: '0 7 * * *' } });
  expect(trig.status).toBe(201);
  expect(trig.json.agent).toBe('scout');
  const routine = (await api('GET', '/__api/agents/scout/routine')).json;
  expect(routine.cron.some((c: any) => c.id === trig.json.id)).toBe(true);
  await api('DELETE', `/__api/triggers/${trig.json.id}`);
});

test('#2 publish: a restricted agent is refused (403); an agent that may publish still asks the human before a public link', async () => {
  // scout has no `publish` — hidden from its toolset and refused by the REST guard
  expect((await api('GET', `/__api/sessions/${scoutSession}/policy?names=publish_artifact,share_artifact,set_title`)).json.hidden).toEqual(['publish_artifact', 'share_artifact']);
  expect((await api('POST', `/__api/sessions/${scoutSession}/policy/check`, { tool_name: 'mcp__arigami__publish_artifact', input: {} })).json.allow).toBe(false);
  const refused = await api('POST', `/__api/sessions/${scoutSession}/artifacts`, { path: path.join(ws, 'draft.md'), title: 'Draft' });
  expect(refused.status).toBe(403);
  expect(refused.json.error).toMatch(/may not publish artifacts/);
  expect((await api('GET', `/__api/sessions/${scoutSession}/artifacts`)).json.length).toBe(0);

  // nili may publish — but share:true only opens an approval card
  niliSession = (await api('POST', '/__api/sessions', { agent: 'nili', cwd: ws })).json.id;
  const pub = await api('POST', `/__api/sessions/${niliSession}/artifacts`, { path: path.join(ws, 'draft.md'), title: 'Zooby draft', share: true, open: false });
  expect(pub.status).toBe(200);
  expect(pub.json.share_url).toBeNull();
  expect(pub.json.share_pending).toBe(true);
  expect(pub.json.warnings.join(' ')).toMatch(/approval card/);
  const artId = pub.json.artifact_id;
  expect((await api('GET', `/__api/sessions/${niliSession}/artifacts/${artId}/share`)).json.tokens.length).toBe(0);
  const act = (await api('GET', `/__api/sessions/${niliSession}`)).json.action;
  expect(act.kind).toBe('share');
  expect(act.agent.slug).toBe('nili');
  expect(act.prompt).toMatch(/PUBLIC link/);
  // approving mints the link and hands it back to the session
  expect((await api('POST', `/__api/sessions/${niliSession}/action/answer`, { value: 'approve' })).status).toBe(200);
  const tokens = (await api('GET', `/__api/sessions/${niliSession}/artifacts/${artId}/share`)).json.tokens;
  expect(tokens.length).toBe(1);
  const evs = await chat(niliSession);
  expect(evs.some((e) => e.kind === 'user' && /APPROVED the public link/.test(e.text || ''))).toBe(true);

  // a refusal mints nothing and says so
  const again = await api('POST', `/__api/sessions/${niliSession}/artifacts/${artId}/share`, { days: 3 });
  expect(again.status).toBe(202);
  expect(again.json.pending).toBe(true);
  expect((await api('POST', `/__api/sessions/${niliSession}/action/answer`, { value: 'no' })).status).toBe(200);
  expect((await api('GET', `/__api/sessions/${niliSession}/artifacts/${artId}/share`)).json.tokens.length).toBe(1); // no second token
  expect((await chat(niliSession)).some((e) => e.kind === 'user' && /REFUSED a public link/.test(e.text || ''))).toBe(true);

  // scout may not even ask
  expect((await api('POST', `/__api/sessions/${scoutSession}/artifacts/${artId}/share`, {})).status).toBe(403);

  // autoApprove:['share'] mints at once — the human pre-approved the kind
  await api('PATCH', '/__api/agents/nili', { autoApprove: ['share'] });
  const auto = await api('POST', `/__api/sessions/${niliSession}/artifacts/${artId}/share`, { days: 3 });
  expect(auto.status).toBe(200);
  expect(auto.json.share_url).toBeTruthy();
  expect((await api('GET', `/__api/sessions/${niliSession}`)).json.action).toBeNull();
  await api('PATCH', '/__api/agents/nili', { autoApprove: [] });
});

test('#7 a closed allowlist is spawned with --strict-mcp-config; one that needs composio is not', async () => {
  expect(await argvOf(scoutSession)).toContain('--strict-mcp-config');
  expect(await argvOf(niliSession)).toContain('--strict-mcp-config');
  const mailer = (await api('POST', '/__api/sessions', { agent: 'mailer', cwd: ws })).json.id;
  const argv = await argvOf(mailer);
  expect(argv).not.toContain('--strict-mcp-config');
  expect(argv).toContain('--settings'); // the hook still filters composio call by call
});

test('#5 budget: after the cap and its one final warning, the next TURN is refused (429), not just new sessions', async () => {
  // nili's cap is 2500 and the stub bills 1000/turn; her session has run a few
  // turns already (the share answers), so push it over and wait for the warning.
  const ledger = (): any[] =>
    fs.existsSync(path.join(dir, 'agents', 'nili', 'activity.jsonl'))
      ? fs.readFileSync(path.join(dir, 'agents', 'nili', 'activity.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
      : [];
  while (!ledger().some((e) => e.kind === 'budget')) {
    const r = await api('POST', `/__api/sessions/${niliSession}/message`, { text: 'more' });
    if (r.status === 429) break;
    await until(async () => ledger().filter((e) => e.kind === 'turn').length > 0);
    await sleep(300);
  }
  await until(async () => (await chat(niliSession)).some((e) => e.kind === 'error' && e.budget === true));
  await until(async () => (await chat(niliSession)).some((e) => e.kind === 'user' && /FINAL WARNING/.test(e.text || '')));
  // the warning itself was delivered (bypassing the block) — every turn after it is refused
  const refused = await until(async () => {
    const r = await api('POST', `/__api/sessions/${niliSession}/message`, { text: 'and one more' });
    return r.status === 429 ? r : null;
  });
  expect(refused.json.error).toMatch(/daily token budget/);
  expect(refused.json.error).toMatch(/no new sessions or turns until local midnight/);
  expect(refused.json.error).not.toMatch(/[֐-׿]/); // #11: no Hebrew inside the English line
  expect(refused.json.budget).toMatchObject({ slug: 'nili', name: 'Nili', cap: 2500, exceeded: true });
  expect(Number(refused.json.budget.usedTokens)).toBeGreaterThanOrEqual(2500);
  // exactly ONE warning, and the refused turns never reached the model
  expect((await chat(niliSession)).filter((e) => e.kind === 'error' && e.budget === true).length).toBe(1);
  expect((await chat(niliSession)).some((e) => e.kind === 'user' && e.text === 'and one more')).toBe(false);
  // new sessions are refused with the same line, other agents are untouched
  const newSession = await api('POST', '/__api/sessions', { agent: 'nili', cwd: ws });
  expect(newSession.status).toBe(429);
  expect(newSession.json.budget.name).toBe('Nili');
  expect((await api('POST', '/__api/sessions', { agent: 'scout', cwd: ws })).status).toBe(201);
  // raising the cap lets the same session run again at once
  expect((await api('PATCH', '/__api/agents/nili', { budget: { tokensPerDay: 10000000 } })).status).toBe(200);
  expect((await api('POST', `/__api/sessions/${niliSession}/message`, { text: 'back to work' })).status).toBe(200);
});
