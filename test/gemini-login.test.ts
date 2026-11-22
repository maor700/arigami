// Signing agy in from the cockpit: the host presses Enter on "Google OAuth", shows agy's link, types the pasted code — agy writes its own token file.
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInChild } from './_child.js';
import { tmpDir } from './_tmp.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(HERE, '_fake-agy.sh');
const CODE = '4/0Ab_good-code.xyz';

function env(extra: Record<string, string> = {}) {
  const dir = tmpDir('arigami-gemini-login-');
  const home = path.join(dir, 'gemini');
  return {
    dir,
    home,
    token: path.join(home, 'antigravity-cli', 'antigravity-oauth-token'),
    vars: {
      ARIGAMI_DIR: dir, HOME: dir, ARIGAMI_CODEX_HOME: path.join(dir, 'no-codex'), ARIGAMI_GEMINI_HOME: home, ARIGAMI_AGY_BIN: FAKE, CLAUDE_CODE_OAUTH_TOKEN: '',
      FAKE_AGY_CODE: CODE, FAKE_AGY_RECORD: path.join(dir, 'typed'), ARIGAMI_GEMINI_LOGIN_EXCHANGE_MS: '2500', ARIGAMI_GEMINI_LOGIN_MENU_MS: '2500', ...extra,
    },
  };
}
const PRELUDE =
  "const a=await import('./server/accounts.js');a.initAccounts();const gl=await import('./server/gemini-login.ts');" +
  'const until=async(id,ok,ms=8000)=>{const t=Date.now();for(;;){const s=gl.geminiLoginStatus(id);if(ok(s)||Date.now()-t>ms)return s;await new Promise(r=>setTimeout(r,100));}};';

test('parseAgyLogin reads the whole authorize link out of real agy output (the printed text is wrapped, the hyperlink is not)', async () => {
  const { parseAgyLogin } = await import('../server/gemini-login.ts');
  const raw = fs.readFileSync(path.join(HERE, 'fixtures/gemini/agy-login.raw'), 'utf8');
  const seen = parseAgyLogin(raw);
  expect(seen.menu).toBe(true);
  expect(seen.url).toStartWith('https://accounts.google.com/o/oauth2/auth?');
  expect(seen.url).toContain('redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback');
  expect(seen.url).toEndWith('state=TESTSTATE');
  // before Enter: the menu is up, no link yet
  expect(parseAgyLogin(raw.slice(0, raw.indexOf('Signing in')))).toEqual({ menu: true, url: null });
  expect(parseAgyLogin('')).toEqual({ menu: false, url: null });
  // no hyperlink escape → the plain text is the fallback
  expect(parseAgyLogin('open https://accounts.google.com/o/oauth2/auth?x=1 now').url).toBe('https://accounts.google.com/o/oauth2/auth?x=1');
});

test('cleanAuthCode: only code characters ever reach the terminal', async () => {
  const { cleanAuthCode } = await import('../server/gemini-login.ts');
  expect(cleanAuthCode(`  ${CODE}\n`)).toBe(CODE);
  expect(cleanAuthCode(`https://antigravity.google/oauth-callback?state=abc&code=4%2F0Ab_good-code.xyz&scope=x`)).toBe(CODE);
  for (const bad of ['', 'short', 'two words here', 'code\rrm -rf /', 'a;b|c&d$(x)', '\x1b[2Jabcdefgh', 'x'.repeat(600), null, undefined]) expect(cleanAuthCode(bad)).toBeNull();
});

test('sign-in: menu → link → pasted code → agy writes its token → the gemini-home account appears, agy is stopped', () => {
  const e = env();
  const r = runInChild(
    PRELUDE +
      "const before=a.listAccounts().accounts.map(x=>x.type);const st=gl.startGeminiLogin();" +
      "const waiting=await until(st.id,s=>s.state!=='starting');" +
      "const junk=gl.submitGeminiCode(st.id,'bad code; rm -rf');" +
      `const sent=gl.submitGeminiCode(st.id,${JSON.stringify(CODE)});` +
      "const done=await until(st.id,s=>s.state==='done'||s.state==='error');" +
      "await new Promise(r=>setTimeout(r,400));" +
      "emit({before,id:st.id,first:st.state,waiting,junk,sent,done,after:a.listAccounts().accounts.map(x=>x.provider+':'+x.type),active:a.getActiveId('gemini')!==null,again:gl.submitGeminiCode(st.id,'whatever-code')});",
    e.vars
  );
  if (!r.ok) throw new Error(r.error);
  const o = r.out[0];
  expect(o.before).toEqual([]);
  expect(o.id).toStartWith('agy_');
  expect(o.first).toBe('starting');
  expect(o.waiting.state).toBe('awaiting');
  expect(o.waiting.needsCode).toBe(true);
  expect(o.waiting.url).toBe('https://accounts.google.com/o/oauth2/auth?client_id=test&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&state=abc');
  expect(o.junk.ok).toBe(false); // refused before anything is typed
  expect(o.sent).toEqual({ ok: true, state: 'verifying' });
  expect(o.done.state).toBe('done');
  expect(o.done.account.provider).toBe('gemini');
  expect(o.after).toEqual(['gemini:gemini-home']);
  expect(o.active).toBe(true);
  expect(o.again).toEqual({ ok: true, state: 'done' });
  // exactly the code was typed, once — and the host wrote nothing into agy's home itself
  expect(fs.readFileSync(e.vars.FAKE_AGY_RECORD, 'utf8')).toBe(CODE);
  expect(fs.existsSync(e.token)).toBe(true);
  expect(fs.readFileSync(path.join(e.dir, 'accounts.json'), 'utf8')).not.toContain('access_token');
});

test('a code agy rejects ends in an error that says what agy said; cancel and unknown ids are clean', () => {
  const e = env();
  const r = runInChild(
    PRELUDE +
      "const st=gl.startGeminiLogin();await until(st.id,s=>s.state!=='starting');" +
      "gl.submitGeminiCode(st.id,'4/0Wrong-code-123');const bad=await until(st.id,s=>s.state==='error',6000);" +
      "const st2=gl.startGeminiLogin();await until(st2.id,s=>s.state!=='starting');const c=gl.cancelGeminiLogin(st2.id);" +
      "emit({bad,cancelled:gl.geminiLoginStatus(st2.id).state,c,late:gl.submitGeminiCode(st2.id,'4/0Wrong-code-123'),unknown:gl.geminiLoginStatus('agy_nope'),sub:gl.submitGeminiCode('agy_nope','4/0Wrong-code-123'),accounts:a.listAccounts().accounts.length});",
    e.vars
  );
  if (!r.ok) throw new Error(r.error);
  const o = r.out[0];
  expect(o.bad.state).toBe('error');
  expect(o.bad.error).toContain('Invalid authorization code');
  expect(o.cancelled).toBe('cancelled');
  expect(o.c).toEqual({ ok: true });
  expect(o.late.ok).toBe(false);
  expect(o.unknown.state).toBe('error');
  expect(o.sub).toEqual({ ok: false, error: 'unknown login flow' });
  expect(o.accounts).toBe(0);
  expect(fs.existsSync(e.token)).toBe(false);
});

test('already signed in: no menu comes up, the flow ends done without typing anything; no agy at all is said plainly', () => {
  const e = env();
  fs.mkdirSync(path.dirname(e.token), { recursive: true });
  fs.writeFileSync(e.token, '{"token":{"access_token":"t","expiry":"2020-01-01T00:00:00Z"}}');
  const r = runInChild(PRELUDE + "const st=gl.startGeminiLogin();const done=await until(st.id,s=>s.state==='done'||s.state==='error',6000);emit({done});", e.vars);
  if (!r.ok) throw new Error(r.error);
  expect(r.out[0].done.state).toBe('done');
  expect(fs.existsSync(e.vars.FAKE_AGY_RECORD)).toBe(false);

  const none = env({ ARIGAMI_AGY_BIN: path.join(e.dir, 'no-such-agy') });
  const r2 = runInChild(PRELUDE + 'emit(gl.startGeminiLogin());', none.vars);
  if (!r2.ok) throw new Error(r2.error);
  expect(r2.out[0].state).toBe('error');
  expect(r2.out[0].error).toContain('Antigravity CLI');
});
