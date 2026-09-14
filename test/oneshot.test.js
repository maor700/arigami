// M1c: server/lib/oneshot.ts — the shared runner behind skills.ts's analyze()
// and memory.ts's episode hook. Bug: a one-shot spawned with plain
// `env: {...process.env}` gets no auth at all — the host process itself
// normally carries no CLAUDE_CODE_OAUTH_TOKEN (that's injected per-SESSION by
// claude.js, not globally), so real credentials must be resolved explicitly
// the same way a session does (accounts.js), not inherited.
//
// Runs against a fake `claude` binary (test/_fake-claude.js, no network/real
// credentials) via ARIGAMI_CLAUDE_BIN so the env-construction logic is tested
// deterministically. accounts.js/instance.ts capture ARIGAMI_DIR at import
// time, so each case runs in a fresh child process — see _child.js.
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInChild } from './_child.js';
import { isolate } from './_isolate.js';
isolate(); // restore globalThis/process.env after this file (bun test shares them)

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-oneshot-'));
const FAKE_CLAUDE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '_fake-claude.js');

// Seeds a plaintext (no ARIGAMI_SECRET) oauth-token account directly, mirroring
// what addTokenAccount() would produce, so tokenForSession() has something to
// resolve without needing a real `sk-ant-…` token or ARIGAMI_SECRET set up.
function seedAccount(dir, token) {
  fs.writeFileSync(
    path.join(dir, 'accounts.json'),
    JSON.stringify({
      activeId: 'acc_test',
      accounts: [{ id: 'acc_test', label: 'test', type: 'oauth-token', pool: true, addedAt: new Date().toISOString(), token: { v: 0, t: token } }],
    })
  );
}

test('with a configured account: the inherited (stale) env token is stripped and the resolved active-account token is injected instead', () => {
  const dir = tmp();
  seedAccount(dir, 'sk-ant-REAL-ACTIVE-TOKEN');
  const r = runInChild(
    "const acc=await import('./server/accounts.js');acc.initAccounts();" +
      "const {runClaudeOneShot}=await import('./server/lib/oneshot.ts');" +
      "const out=await runClaudeOneShot('reply ok');" +
      'emit(JSON.parse(out));',
    {
      ARIGAMI_DIR: dir,
      ARIGAMI_PORT: '',
      ARIGAMI_CLAUDE_BIN: FAKE_CLAUDE,
      CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-STALE-INHERITED-TOKEN', // must NOT reach the child
      ANTHROPIC_API_KEY: 'stale-api-key', // must NOT reach the child either
    }
  );
  if (!r.ok) throw new Error(r.error);
  const o = r.out[0];
  expect(o.token).toBe('sk-ant-REAL-ACTIVE-TOKEN'); // resolved from accounts.json, not inherited
  expect(o.apiKey).toBeNull();
}, 15000);

test('with no account configured and nothing in env: no token is injected (keychain fallback), not a crash or a garbage value', () => {
  const dir = tmp();
  // Deliberately no CLAUDE_CODE_OAUTH_TOKEN here: accounts.js's own seed()
  // legitimately migrates a token found in env into a real stored account on
  // first initAccounts() (a separate, pre-existing "imported from .env"
  // feature) — setting one would test THAT, not the strip-then-inject
  // property this case is about.
  const r = runInChild(
    "const acc=await import('./server/accounts.js');acc.initAccounts();" +
      "const {runClaudeOneShot}=await import('./server/lib/oneshot.ts');" +
      "const out=await runClaudeOneShot('reply ok');" +
      'emit(JSON.parse(out));',
    {
      ARIGAMI_DIR: dir,
      ARIGAMI_PORT: '',
      ARIGAMI_CLAUDE_BIN: FAKE_CLAUDE,
    }
  );
  if (!r.ok) throw new Error(r.error);
  expect(r.out[0].token).toBeNull(); // stripped, and nothing to resolve → keychain fallback, not the stale value
}, 15000);

test('passes --model (default sonnet, overridable) and the prompt through to the CLI', () => {
  const dir = tmp();
  const r = runInChild(
    "const {runClaudeOneShot}=await import('./server/lib/oneshot.ts');" +
      "const a=JSON.parse(await runClaudeOneShot('hello there'));" +
      "const b=JSON.parse(await runClaudeOneShot('hi', {model:'opus'}));" +
      'emit({a,b});',
    { ARIGAMI_DIR: dir, ARIGAMI_PORT: '', ARIGAMI_CLAUDE_BIN: FAKE_CLAUDE }
  );
  if (!r.ok) throw new Error(r.error);
  const { a, b } = r.out[0];
  expect(a.argv).toEqual(['-p', 'hello there', '--permission-mode', 'bypassPermissions', '--output-format', 'json', '--model', 'sonnet']);
  expect(b.argv).toEqual(['-p', 'hi', '--permission-mode', 'bypassPermissions', '--output-format', 'json', '--model', 'opus']);
}, 15000);

test('on a non-zero exit with stderr output, rejects with the exit code and a stderr snippet instead of hanging/silently failing', () => {
  const dir = tmp();
  const r = runInChild(
    "const {runClaudeOneShot}=await import('./server/lib/oneshot.ts');" +
      "let msg=null;" +
      "try{await runClaudeOneShot('reply ok');}catch(e){msg=e.message;}" +
      'emit({msg});',
    { ARIGAMI_DIR: dir, ARIGAMI_PORT: '', ARIGAMI_CLAUDE_BIN: FAKE_CLAUDE, FAKE_CLAUDE_MODE: 'fail', FAKE_CLAUDE_STDERR: 'invalid_grant: token expired' }
  );
  if (!r.ok) throw new Error(r.error);
  expect(r.out[0].msg).toMatch(/claude exited 1/);
  expect(r.out[0].msg).toMatch(/invalid_grant/);
}, 15000);

// The real `claude -p --output-format json` on an auth failure (verified
// directly against the binary): exit 1, EMPTY stderr, real message inside the
// stdout JSON envelope. This is the actual shape of the M1c bug report — a
// stderr-only failure path would have kept showing the useless bare
// "claude exited 1" for exactly this case.
test('on a non-zero exit with the real is_error envelope shape (empty stderr), surfaces the envelope .result as the error message', () => {
  const dir = tmp();
  const r = runInChild(
    "const {runClaudeOneShot}=await import('./server/lib/oneshot.ts');" +
      "let msg=null;" +
      "try{await runClaudeOneShot('reply ok');}catch(e){msg=e.message;}" +
      'emit({msg});',
    { ARIGAMI_DIR: dir, ARIGAMI_PORT: '', ARIGAMI_CLAUDE_BIN: FAKE_CLAUDE, FAKE_CLAUDE_MODE: 'fail-envelope', FAKE_CLAUDE_RESULT: 'Not logged in · Please run /login' }
  );
  if (!r.ok) throw new Error(r.error);
  expect(r.out[0].msg).toMatch(/claude exited 1/);
  expect(r.out[0].msg).toMatch(/Not logged in/);
}, 15000);

// ---- F3 #7: stale token after a restart → refresh once, retry once ----------
function seedRefreshableAccount(dir, token, refresh) {
  fs.writeFileSync(
    path.join(dir, 'accounts.json'),
    JSON.stringify({
      activeId: 'acc_r',
      accounts: [{ id: 'acc_r', label: 'login', type: 'oauth-token', pool: true, addedAt: new Date().toISOString(),
        token: { v: 0, t: token }, refreshToken: { v: 0, t: refresh }, expiresAt: new Date(Date.now() + 3600_000).toISOString() }],
    })
  );
}

test('F3 #7: a 401/revoked envelope refreshes the active account once and retries with the NEW token (resolved at call time)', () => {
  const dir = tmp();
  seedRefreshableAccount(dir, 'sk-ant-OLD-REVOKED', 'rt-1');
  const marker = path.join(dir, 'first-call');
  const r = runInChild(
    // Stub the OAuth token endpoint: no network in tests.
    "globalThis.fetch=async(url,init)=>{globalThis.__calls=(globalThis.__calls||0)+1;" +
      "return new Response(JSON.stringify({access_token:'sk-ant-FRESH',refresh_token:'rt-2',expires_in:28800}),{status:200,headers:{'content-type':'application/json'}});};" +
      "const acc=await import('./server/accounts.js');acc.initAccounts();" +
      "const {runClaudeOneShot}=await import('./server/lib/oneshot.ts');" +
      "const out=JSON.parse(await runClaudeOneShot('reply ok'));" +
      "emit({out,refreshCalls:globalThis.__calls||0,stored:acc.resolveToken('acc_r'),first:require('node:fs').readFileSync(process.env.FAKE_CLAUDE_FAIL_ONCE_FILE,'utf8')});",
    { ARIGAMI_DIR: dir, ARIGAMI_PORT: '', ARIGAMI_CLAUDE_BIN: FAKE_CLAUDE, FAKE_CLAUDE_FAIL_ONCE_FILE: marker }
  );
  if (!r.ok) throw new Error(r.error);
  const o = r.out[0];
  expect(o.first).toBe('sk-ant-OLD-REVOKED'); // first attempt ran with the stale token
  expect(o.refreshCalls).toBe(1); // exactly one refresh
  expect(o.out.token).toBe('sk-ant-FRESH'); // retry re-resolved the token from the store
  expect(o.stored).toBe('sk-ant-FRESH'); // and the store now holds it for the next run
}, 15000);

test('F3 #7: an auth failure with NO refresh token (paste account) is not retried — surfaces the error once', () => {
  const dir = tmp();
  seedAccount(dir, 'sk-ant-DEAD-PASTE');
  const marker = path.join(dir, 'first-call');
  const r = runInChild(
    "globalThis.fetch=async()=>{throw new Error('must not be called');};" +
      "const acc=await import('./server/accounts.js');acc.initAccounts();" +
      "const {runClaudeOneShot,isAuthFailure}=await import('./server/lib/oneshot.ts');" +
      "let msg=null;try{await runClaudeOneShot('reply ok');}catch(e){msg=e.message;}" +
      "emit({msg,auth:isAuthFailure(msg),benign:isAuthFailure('claude exited 1: rate limit reached')});",
    { ARIGAMI_DIR: dir, ARIGAMI_PORT: '', ARIGAMI_CLAUDE_BIN: FAKE_CLAUDE, FAKE_CLAUDE_FAIL_ONCE_FILE: marker }
  );
  if (!r.ok) throw new Error(r.error);
  expect(r.out[0].msg).toMatch(/revoked/);
  expect(r.out[0].auth).toBe(true);
  expect(r.out[0].benign).toBe(false);
}, 15000);

test('F3 #2: an explicit opts.token overrides the active account and is used verbatim', () => {
  const dir = tmp();
  seedAccount(dir, 'sk-ant-ACTIVE');
  const r = runInChild(
    "const acc=await import('./server/accounts.js');acc.initAccounts();" +
      "const {runClaudeOneShot}=await import('./server/lib/oneshot.ts');" +
      "const a=JSON.parse(await runClaudeOneShot('ping',{token:'sk-ant-oat01-CANDIDATE'}));" +
      "const b=JSON.parse(await runClaudeOneShot('ping',{apiKey:'sk-ant-api03-CANDIDATE'}));emit({a,b});",
    { ARIGAMI_DIR: dir, ARIGAMI_PORT: '', ARIGAMI_CLAUDE_BIN: FAKE_CLAUDE }
  );
  if (!r.ok) throw new Error(r.error);
  expect(r.out[0].a.token).toBe('sk-ant-oat01-CANDIDATE');
  expect(r.out[0].b.token).toBeNull();
  expect(r.out[0].b.apiKey).toBe('sk-ant-api03-CANDIDATE');
}, 15000);

// ---- codex engine: fake `codex` on ARIGAMI_CODEX_BIN writes the -o file ----
const FAKE_CODEX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '_fake-codex.sh');

function seedCodexAccount(dir) {
  const acc = path.join(dir, 'codex-accounts', 'cx_1');
  fs.mkdirSync(acc, { recursive: true });
  fs.writeFileSync(path.join(acc, 'auth.json'), '{}');
  fs.writeFileSync(
    path.join(dir, 'accounts.json'),
    JSON.stringify({ activeIds: { codex: 'cx_1' }, accounts: [{ id: 'cx_1', label: 'gpt', provider: 'codex', type: 'chatgpt', pool: true, addedAt: new Date().toISOString() }] })
  );
  return path.join(acc, 'auth.json');
}

test('codex: exec --ephemeral with the prompt on stdin, -o result, active account auth linked, claude creds stripped, scratch home removed', () => {
  const dir = tmp();
  const authFile = seedCodexAccount(dir);
  const rec = path.join(dir, 'rec');
  const r = runInChild(
    "const acc=await import('./server/accounts.js');acc.initAccounts();" +
      "const {runOneShot}=await import('./server/lib/oneshot.ts');" +
      "const out=await runOneShot('say pong',{engine:'codex',model:'sonnet',json:{type:'object'},cwd:process.env.ARIGAMI_DIR,tag:'t',env:{ARIGAMI_SESSION_ID:'s1'},mcpServers:{arigami:{command:'bun',args:['x.js'],env:{A:'1'}}}});" +
      "emit({out,left:require('node:fs').readdirSync(process.env.ARIGAMI_DIR+'/oneshot-codex')});",
    { ARIGAMI_DIR: dir, ARIGAMI_PORT: '', ARIGAMI_CODEX_BIN: FAKE_CODEX, FAKE_CODEX_RECORD: rec, CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-LEAK', ANTHROPIC_API_KEY: 'leak' }
  );
  if (!r.ok) throw new Error(r.error);
  const o = r.out[0];
  expect(o.out).toBe('pong from codex');
  expect(o.left).toEqual([]);
  const argv = fs.readFileSync(rec + '.argv', 'utf8').trim().split('\n');
  expect(argv.slice(0, 4)).toEqual(['exec', '--ephemeral', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox']);
  expect(argv).toContain('-o');
  expect(argv).toContain('--output-schema');
  expect(argv).not.toContain('-m'); // a claude alias never reaches codex
  expect(argv[argv.length - 1]).toBe('-');
  expect(fs.readFileSync(rec + '.stdin', 'utf8')).toBe('say pong');
  expect(fs.readFileSync(rec + '.auth', 'utf8').trim()).toBe(authFile);
  expect(JSON.parse(fs.readFileSync(rec + '.schema', 'utf8'))).toEqual({ type: 'object' });
  const env = fs.readFileSync(rec + '.env', 'utf8');
  expect(env).not.toMatch(/CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY/);
  expect(env).toMatch(/ARIGAMI_SESSION_ID=s1/);
  expect(env).toMatch(new RegExp(`CODEX_HOME=${dir}/oneshot-codex/`));
  const toml = fs.readFileSync(rec + '.toml', 'utf8');
  expect(toml).toMatch(/\[mcp_servers\.arigami\]/);
  expect(toml).toMatch(/A = "1"/);
}, 15000);

test('codex: a non-zero exit rejects with the error line', () => {
  const dir = tmp();
  seedCodexAccount(dir);
  const r = runInChild(
    "const acc=await import('./server/accounts.js');acc.initAccounts();" +
      "const {runOneShot}=await import('./server/lib/oneshot.ts');" +
      "let msg=null;try{await runOneShot('x',{engine:'codex'});}catch(e){msg=e.message;}emit({msg});",
    { ARIGAMI_DIR: dir, ARIGAMI_PORT: '', ARIGAMI_CODEX_BIN: FAKE_CODEX, FAKE_CODEX_MODE: 'fail' }
  );
  if (!r.ok) throw new Error(r.error);
  expect(r.out[0].msg).toMatch(/codex exited 1: .*401/);
}, 15000);

test('hostEngine: nothing connected → claude, codex-only → codex, cfg.defaultEngine wins', () => {
  const run = (seed) => {
    const dir = tmp();
    if (seed) seedCodexAccount(dir);
    const r = runInChild(
      "const acc=await import('./server/accounts.js');acc.initAccounts();" +
        "const {hostEngine,sessionEngine}=await import('./server/lib/oneshot.ts');const {cfg}=await import('./server/lib/config.ts');" +
        "const a=hostEngine();cfg.defaultEngine='claude';const b=hostEngine();" +
        "emit({a,b,s:sessionEngine({engine:'codex'}),t:sessionEngine({})});",
      { ARIGAMI_DIR: dir, ARIGAMI_PORT: '', HOME: dir, ARIGAMI_CODEX_HOME: path.join(dir, 'nocodex'), CLAUDE_CODE_OAUTH_TOKEN: '', ANTHROPIC_API_KEY: '' }
    );
    if (!r.ok) throw new Error(r.error);
    return r.out[0];
  };
  expect(run(false)).toEqual({ a: 'claude', b: 'claude', s: 'codex', t: 'claude' });
  expect(run(true)).toEqual({ a: 'codex', b: 'claude', s: 'codex', t: 'claude' });
}, 15000);

test('P4-5 voice router: anthropic provider with no Claude creds → Groq when keyed, else a codex one-shot', () => {
  const run = (groq) => {
    const dir = tmp();
    seedCodexAccount(dir);
    const r = runInChild(
      "globalThis.fetch=async(url)=>{globalThis.__url=String(url);return new Response(JSON.stringify({choices:[{message:{content:'{\"actions\":[],\"say\":\"groq\"}'}}]}),{status:200});};" +
        "const acc=await import('./server/accounts.js');acc.initAccounts();" +
        "const {cfg}=await import('./server/lib/config.ts');cfg.voiceRouterProvider='anthropic';" +
        "const voice=await import('./server/voice.js');" +
        "const plan=await voice.route({transcript:'hi',context:{}});emit({say:plan.say,url:globalThis.__url||null});",
      { ARIGAMI_DIR: dir, ARIGAMI_PORT: '', HOME: dir, GROQ_API_KEY: groq, CLAUDE_CODE_OAUTH_TOKEN: '', ARIGAMI_CODEX_BIN: FAKE_CODEX, FAKE_CODEX_OUT: 'plan: {"actions":[],"say":"codex"}' }
    );
    if (!r.ok) throw new Error(r.error);
    return r.out[0];
  };
  expect(run('gsk_x')).toMatchObject({ say: 'groq' });
  expect(run('')).toEqual({ say: 'codex', url: null });
}, 20000);
