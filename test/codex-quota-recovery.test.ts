// P2-6 — codex quota recovery: detection + rotation decision (pure), the codex model chain, and the IO path against a fake app-server.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runInChild } from './_child.js';
import {
  confirmCodexLimit,
  planCodexRecovery,
  codexLimitNote,
  codexChain,
  codexLadder,
  nextCodexAccount,
  DEFAULT_CODEX_MODEL_CHAIN,
} from '../server/lib/codex-quota.ts';

const NOW = Date.parse('2026-09-15T10:00:00Z');
const LATER = '2026-09-15T15:00:00.000Z';
const WEEK = '2026-09-20T00:00:00.000Z';
const LIMIT_TEXT = 'unexpected status 429 Too Many Requests: usage limit reached';

const usage = (session: number, week: number | null = null, limitReached: string | null = null) => ({
  available: true,
  session: { pct: session, resetsAt: LATER, windowMins: 300 },
  week: week == null ? null : { pct: week, resetsAt: WEEK, windowMins: 10080 },
  limitReached,
});

const ACCOUNTS = [
  { id: 'acc_claude', label: 'claude', provider: 'claude', pool: true, quarantineUntil: null },
  { id: 'acc_a', label: 'A', provider: 'codex', pool: true, quarantineUntil: null },
  { id: 'acc_b', label: 'B', provider: 'codex', pool: true, quarantineUntil: null },
  { id: 'acc_off', label: 'off', provider: 'codex', pool: false, quarantineUntil: null },
];
const CHAIN = [...DEFAULT_CODEX_MODEL_CHAIN];

// ---- detection ---------------------------------------------------------------

test('confirmCodexLimit: limitReached or a window at 100% confirms; the exhausted window names the reset', () => {
  expect(confirmCodexLimit(usage(100))).toEqual({ verdict: 'confirmed', resetAt: LATER, pct: 100 });
  expect(confirmCodexLimit(usage(40, 100))).toEqual({ verdict: 'confirmed', resetAt: WEEK, pct: 100 });
  expect(confirmCodexLimit(usage(62, 10, 'rate_limit_reached')).verdict).toBe('confirmed');
  expect(confirmCodexLimit(usage(62, 10, 'rate_limit_reached')).resetAt).toBe(LATER);
  expect(confirmCodexLimit(usage(58))).toEqual({ verdict: 'not-limited', resetAt: null, pct: 58 });
  expect(confirmCodexLimit({ available: false, reason: 'api-key' }).verdict).toBe('unknown');
  expect(confirmCodexLimit(null).verdict).toBe('unknown');
});

test('codexLimitNote: says unverified only when the rateLimits read could not confirm', () => {
  expect(codexLimitNote(LIMIT_TEXT, 'confirmed', 100)).not.toContain('unverified');
  expect(codexLimitNote(LIMIT_TEXT, 'confirmed', 100)).toContain('confirmed');
  expect(codexLimitNote(LIMIT_TEXT, 'unknown')).toContain('unverified');
  expect(codexLimitNote(LIMIT_TEXT, 'not-limited', 40)).toContain('not exhausted');
  expect(codexLimitNote('unexpected status 401 Unauthorized', 'confirmed')).toBeNull();
});

// ---- rotation decision -----------------------------------------------------------

test('planCodexRecovery: confirmed → next pooled codex account, never a claude or non-pooled one', () => {
  const p = planCodexRecovery({ text: LIMIT_TEXT, usage: usage(100), accounts: ACCOUNTS, curId: 'acc_a', chain: CHAIN, rung: 0, now: NOW });
  expect(p.action).toBe('account-switch');
  expect(p.next?.id).toBe('acc_b');
  expect(p.resetAt).toBe(LATER);
  expect(nextCodexAccount(ACCOUNTS, 'acc_b', NOW)?.id).toBe('acc_a');
});

test('planCodexRecovery: pool dry → one rung down the codex chain; bottom rung → escalate', () => {
  const dry = ACCOUNTS.map((a) => (a.id === 'acc_b' ? { ...a, quarantineUntil: WEEK } : a));
  const down = planCodexRecovery({ text: LIMIT_TEXT, usage: usage(100), accounts: dry, curId: 'acc_a', chain: CHAIN, rung: 0, now: NOW });
  expect(down).toMatchObject({ action: 'model-down', model: 'gpt-5.6-luna', rung: 1 });
  const bottom = planCodexRecovery({ text: LIMIT_TEXT, usage: usage(100), accounts: dry, curId: 'acc_a', chain: CHAIN, rung: 2, now: NOW });
  expect(bottom.action).toBe('escalate');
});

test('planCodexRecovery: the rateLimits read beats the regex', () => {
  const base = { accounts: ACCOUNTS, curId: 'acc_a', chain: CHAIN, rung: 0, now: NOW };
  expect(planCodexRecovery({ ...base, text: LIMIT_TEXT, usage: usage(30) }).action).toBe('none');
  expect(planCodexRecovery({ ...base, text: 'you ran out of quota somehow', usage: null }).action).toBe('none');
  expect(planCodexRecovery({ ...base, text: 'unexpected status 500', usage: usage(100) }).action).toBe('none');
  const unread = planCodexRecovery({ ...base, text: LIMIT_TEXT, usage: { available: false, reason: 'api-key' }, backoffMin: 30 });
  expect(unread).toMatchObject({ action: 'account-switch', verdict: 'unknown' });
  expect(unread.resetAt).toBe(new Date(NOW + 30 * 60_000).toISOString());
});

// ---- codex model chain -------------------------------------------------------------

test('codexChain: config default filtered to the account catalog, the picked model on top, overrides win', () => {
  expect(codexChain({ catalog: ['gpt-5.6-terra', 'gpt-5.5'] })).toEqual(['gpt-5.6-terra', 'gpt-5.5']);
  expect(codexChain({ catalog: [] })).toEqual(CHAIN);
  expect(codexChain({ catalog: ['gpt-5.6-luna', 'gpt-5.5'], modelChoice: 'gpt-6-astra' })).toEqual(['gpt-6-astra', 'gpt-5.6-luna', 'gpt-5.5']);
  expect(codexChain({ sessionChain: ['gpt-5.5'], configChain: CHAIN, catalog: CHAIN })).toEqual(['gpt-5.5']);
  expect(codexChain({ configChain: ['gpt-5.5', 'gpt-5.6-luna'], catalog: CHAIN })).toEqual(['gpt-5.5', 'gpt-5.6-luna']);
  expect(codexLadder(CHAIN, { modelRung: 1, modelChoice: 'gpt-5.6-luna', modelRestoreAt: LATER })).toEqual({
    chain: CHAIN,
    rung: 1,
    model: 'gpt-5.6-luna',
    rungsLeft: 1,
    restoreAt: LATER,
  });
});

// ---- IO: accounts fixture + fake app-server ---------------------------------------------

let dir: string;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-quota-recovery-'));
});
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function fakeAppServer(rateLimits: unknown): string {
  const bin = path.join(dir, `fake-app-server-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(
    bin,
    `#!/usr/bin/env bun
let buf='';process.stdin.on('data',(d)=>{buf+=d;let i;while((i=buf.indexOf('\\n'))>=0){const l=buf.slice(0,i);buf=buf.slice(i+1);let j;try{j=JSON.parse(l);}catch{continue;}
if(j.id===0)process.stdout.write(JSON.stringify({id:0,result:{}})+'\\n');
else if(j.method==='account/rateLimits/read')process.stdout.write(JSON.stringify({id:j.id,result:{rateLimits:${JSON.stringify(rateLimits)}}})+'\\n');
else if(typeof j.id==='number')process.stdout.write(JSON.stringify({id:j.id,result:{data:[]}})+'\\n');}});
`,
    { mode: 0o755 }
  );
  return bin;
}

function fixture(name: string, ids: string[]): string {
  const adir = path.join(dir, name);
  const accounts = ids.map((id) => {
    fs.mkdirSync(path.join(adir, 'codex-accounts', id), { recursive: true });
    fs.writeFileSync(path.join(adir, 'codex-accounts', id, 'auth.json'), '{"auth_mode":"chatgpt"}');
    return { id, provider: 'codex', type: 'chatgpt', label: id, pool: true, addedAt: '2026-09-01T00:00:00Z' };
  });
  fs.writeFileSync(
    path.join(adir, 'accounts.json'),
    JSON.stringify({ activeId: null, activeIds: { claude: null, codex: ids[0] }, accounts: [{ id: 'acc_claude', provider: 'claude', type: 'oauth-token', label: 'claude', pool: true, token: { v: 0, t: 'sk-ant-oat01-x' } }, ...accounts] })
  );
  return adir;
}

const RESET_SEC = Math.floor(Date.now() / 1000) + 3 * 3600;
const LIMITED = { primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: RESET_SEC }, secondary: null, planType: 'plus', rateLimitReachedType: 'rate_limit_reached' };

const SCRIPT =
  "const ac=await import('./server/accounts.js');ac.initAccounts();" +
  "const st=await import('./server/state.ts');" +
  "const cl=await import('./server/claude.js');" +
  "const cx=await import('./server/codex.ts');" +
  "const rec=await import('./server/codex-recovery.ts');" +
  "const inc=await import('./server/incidents.ts');" +
  "const s=st.createSession({title:'q',engine:'codex',cwd:'/tmp'});" +
  "cl.appendChat(s.id,{kind:'user',text:'do the thing'});" +
  `cx.codexHandleEvent(s.id,{type:'turn.failed',error:{message:${JSON.stringify(LIMIT_TEXT)}}});` +
  'let plan=null;for(let i=0;i<200&&!plan;i++){await new Promise((r)=>setTimeout(r,25));plan=await rec.settled(s.id);}' +
  'const after=st.getSession(s.id);' +
  "emit({plan,accountId:after.claude.accountId,claude:after.claude,ladder:st.toWireSession(after).claude.ladder,errClass:cl.lastTurnError(s.id),accounts:ac.listAccounts(),incidents:inc.readIncidents(),chat:cl.getChat(s.id,0).filter(e=>e.kind==='system').map(e=>e.text)," +
  "restored:(cl.restoreModel(s.id)||null),top:st.getSession(s.id).claude.modelChoice});";

const env = (adir: string, bin: string) => ({
  ARIGAMI_DIR: adir,
  ARIGAMI_PORT: '',
  ARIGAMI_FUNNEL_QUIET: '1',
  ARIGAMI_CODEX_HOME: path.join(adir, 'no-machine-login'),
  ARIGAMI_CODEX_BIN: bin,
  ARIGAMI_CODEX_PROBE_TIMEOUT_MS: '5000',
  ARIGAMI_CODEX_MODEL_CHAIN: '',
});

test('confirmed limit with a second codex account: quarantine until resetsAt, re-pin, account-switch incident', () => {
  const adir = fixture('rotate', ['acc_a', 'acc_b']);
  const r = runInChild(SCRIPT, env(adir, fakeAppServer(LIMITED)));
  if (!r.ok) throw new Error(r.error);
  const o = r.out[0];
  expect(o.plan).toMatchObject({ action: 'account-switch', verdict: 'confirmed' });
  expect(o.accountId).toBe('acc_b');
  const a = o.accounts.accounts.find((x: any) => x.id === 'acc_a');
  expect(a.quarantineUntil).toBe(new Date(RESET_SEC * 1000).toISOString());
  expect(o.accounts.accounts.find((x: any) => x.id === 'acc_claude').quarantineUntil).toBeNull();
  expect(o.accounts.activeIds).toMatchObject({ codex: 'acc_b', claude: 'acc_claude' });
  expect(o.chat.some((t: string) => t.includes('confirmed') && !t.includes('unverified'))).toBe(true);
  expect(o.incidents.map((i: any) => i.action)).toEqual(['account-switch']);
  expect(o.errClass).toBe('limit');
});

test('confirmed limit with the codex pool dry: one rung down the codex chain, badge on the wire, restore climbs back', () => {
  const adir = fixture('ladder', ['acc_a']);
  const r = runInChild(SCRIPT, env(adir, fakeAppServer(LIMITED)));
  if (!r.ok) throw new Error(r.error);
  const o = r.out[0];
  expect(o.plan).toMatchObject({ action: 'model-down', model: 'gpt-5.6-luna' });
  expect(o.claude).toMatchObject({ modelChoice: 'gpt-5.6-luna', modelRung: 1, modelDowngradedFrom: 'gpt-5.6-terra' });
  expect(o.ladder).toMatchObject({ running: 'gpt-5.6-luna', configured: 'gpt-5.6-terra' });
  expect(o.incidents.map((i: any) => i.action)).toEqual(['model-down']);
  expect(o.restored).toBe('gpt-5.6-terra');
  expect(o.top).toBe('gpt-5.6-terra');
});

test('rateLimits say not limited: a note, no quarantine, no switch', () => {
  const adir = fixture('fine', ['acc_a', 'acc_b']);
  const r = runInChild(SCRIPT, env(adir, fakeAppServer({ ...LIMITED, primary: { ...LIMITED.primary, usedPercent: 41 }, rateLimitReachedType: null })));
  if (!r.ok) throw new Error(r.error);
  const o = r.out[0];
  expect(o.plan.action).toBe('none');
  expect(o.accountId).not.toBe('acc_b');
  expect(o.accounts.accounts.every((a: any) => !a.quarantineUntil)).toBe(true);
  expect(o.incidents).toEqual([]);
});
