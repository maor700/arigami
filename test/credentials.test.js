// VAULT1: the pieces of the sign-in card that need no browser (server/lib/credentials.ts, chrome.ts): sites a
// password is never filled on, the per-site choices, what the host accepts as a vault file, keeping it out of the user
// repo, and session Chrome profiles that never save a password. Imports ARIGAMI_DIR → in a child.
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { runInChild } from './_child.js';
import { tmpDir } from './_tmp.js';

function inChild(body, dir = tmpDir('arigami-cred-')) {
  const r = runInChild("const cr=await import('./server/lib/credentials.ts');" + body, { ARIGAMI_DIR: dir, ARIGAMI_PORT: '' });
  if (!r.ok) throw new Error(r.error);
  return { out: r.out[0], dir };
}

test('Google and GitHub are never signed in to with a password; look-alikes are not them', () => {
  const { out } = inChild(
    "emit(['accounts.google.com','www.google.co.il','mail.google.com','youtube.com','github.com','gist.github.com','google.com.evil.io','notgithub.com','app.linear.app'].map(h=>[h,cr.refusedSite(h)?.id||null]));"
  );
  expect(Object.fromEntries(out)).toEqual({
    'accounts.google.com': 'google.com', 'www.google.co.il': 'google.com', 'mail.google.com': 'google.com', 'youtube.com': 'google.com',
    'github.com': 'github.com', 'gist.github.com': 'github.com',
    'google.com.evil.io': null, 'notgithub.com': null, 'app.linear.app': null,
  });
});

test('per-site choices hold no secret and "ask" is the default', () => {
  const { out, dir } = inChild(
    "const a=cr.prefFor('https://x.example');cr.setPref('https://x.example','auto');cr.setPref('https://y.example','manual');" +
      "const b=cr.prefs();cr.setPref('https://x.example','ask');emit({a,b,c:cr.prefs()});"
  );
  expect(out.a).toBe('ask');
  expect(out.b).toEqual({ 'https://x.example': 'auto', 'https://y.example': 'manual' });
  expect(out.c).toEqual({ 'https://y.example': 'manual' });
  expect(JSON.parse(fs.readFileSync(path.join(dir, 'login-prefs.json'), 'utf8'))).toEqual({ 'https://y.example': 'manual' });
});

test('the vault file: KDBX 4 only, If-Match guarded, private, and ignored by the user repo (once)', () => {
  const { out, dir } = inChild(
    "const sig=Buffer.from([0x03,0xd9,0xa2,0x9a,0x67,0xfb,0x4b,0xb5,0,0,4,0,1,2,3]);const v3=Buffer.from(sig);v3.writeUInt16LE(3,10);" +
      "const tryW=(b,m)=>{try{return cr.writeVaultFile(b,m).etag}catch(e){return e.status+' '+e.message}};" +
      "require('node:fs').mkdirSync(process.env.ARIGAMI_DIR+'/user',{recursive:true});require('node:fs').writeFileSync(process.env.ARIGAMI_DIR+'/user/.gitignore','node_modules/');" +
      "const plain=tryW(Buffer.from('password=1')),old=tryW(v3),first=tryW(sig,'*'),again=tryW(sig,'*'),stale=tryW(sig,'\"x\"'),next=tryW(sig,first);cr.ensureIgnored();" +
      "emit({plain,old,first,again,stale,next,read:cr.vaultFile().etag});"
  );
  expect(out.plain).toMatch(/^400 not a KDBX 4/);
  expect(out.old).toMatch(/^400/);
  expect(out.first).toMatch(/^"[0-9a-f]{32}"$/);
  expect(out.again).toMatch(/^412/);
  expect(out.stale).toMatch(/^412/);
  expect(out.next).toBe(out.first);
  expect(out.read).toBe(out.first);
  const gi = fs.readFileSync(path.join(dir, 'user', '.gitignore'), 'utf8');
  expect(gi.startsWith('node_modules/\n')).toBe(true);
  expect(gi.split('\n').filter((l) => l === 'vault/')).toHaveLength(1);
  expect(fs.statSync(path.join(dir, 'user', 'vault')).mode & 0o077).toBe(0);
});

test("a session's Chrome never offers to save a password, and the rest of its Preferences stay", () => {
  const dir = tmpDir('arigami-cred-prefs-');
  fs.mkdirSync(path.join(dir, 'p', 'Default'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'p', 'Default', 'Preferences'), JSON.stringify({ profile: { name: 'x' }, intl: { accept_languages: 'he' } }));
  const r = runInChild(`const c=await import('./server/lib/chrome.ts');c.disablePasswordSaving(${JSON.stringify(path.join(dir, 'p'))});c.disablePasswordSaving(${JSON.stringify(path.join(dir, 'fresh'))});emit(1);`, { ARIGAMI_DIR: dir, ARIGAMI_PORT: '' });
  if (!r.ok) throw new Error(r.error);
  const p = JSON.parse(fs.readFileSync(path.join(dir, 'p', 'Default', 'Preferences'), 'utf8'));
  expect(p).toMatchObject({ credentials_enable_service: false, profile: { name: 'x', password_manager_enabled: false }, intl: { accept_languages: 'he' } });
  expect(JSON.parse(fs.readFileSync(path.join(dir, 'fresh', 'Default', 'Preferences'), 'utf8')).credentials_enable_service).toBe(false);
  const src = fs.readFileSync(path.resolve(import.meta.dir, '../server/lib/chrome.ts'), 'utf8');
  expect(src).toMatch(/disablePasswordSaving\(profileDir\);\n\s*const args = sessionChromeArgs\(profileDir, url\)/);
});

test('the agent gets the tool with the browser, the login block and the password-field refusal point to it', () => {
  const root = path.resolve(import.meta.dir, '..');
  const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
  expect(read('server/agent-policy.ts')).toMatch(/BROWSER_TOOLS = \[[^\]]*'request_credentials'/);
  expect(read('mcp/host-mcp.js')).toContain("name: 'request_credentials'");
  expect(read('server/prompt-blocks.ts')).toContain('request_credentials({site, reason})');
  expect(read('server/lib/browser-actions.ts')).toMatch(/Call request_credentials/);
  // the fill route: the owner's cookie only, the host's own record of the card, values never in the chat line
  const api = read('server/api.ts');
  const fill = api.slice(api.indexOf("sub === 'credentials/fill'"), api.indexOf("sub === 'credentials/fill'") + 4000);
  expect(fill).toContain("me?.kind === 'user' && me.via === 'cookie'");
  expect(fill).toContain('cr.getPending(id, body.requestId)?.request');
  expect(fill).not.toMatch(/body\.values[^)]*\)\s*\+|\$\{[^}]*values/);
  expect(api).toContain('delete body.credentialRequest;');
});

test("the cockpit's secret inputs are never type=password, so the owner's own browser never offers to keep them", () => {
  const root = path.resolve(import.meta.dir, '..');
  for (const f of ['web/src/components/CredentialCard.jsx', 'web/src/components/settings/Passwords.jsx']) {
    const src = fs.readFileSync(path.join(root, f), 'utf8').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    expect(src).not.toMatch(/type=["']password["']|type: 'password'|\? 'password' :/);
    expect(src).toContain('SECRET');
  }
  // the worker posts values to the fill route and nowhere else
  const w = fs.readFileSync(path.join(root, 'web/src/lib/vault.worker.js'), 'utf8');
  expect(w.match(/fetch\(/g).length).toBe(4); // status, read file, write file, fill
  expect(w).not.toMatch(/console\.|postMessage\([^)]*password/);
});

// Every text a session reads about signing in agrees: a sign-in form is request_credentials; request_screen is for
// what only the human's hands can do. One leftover "password → request_screen" line was enough for sessions to send
// the owner to a take-over instead of the card.
test('no agent-facing text still sends a password form to a take-over', () => {
  const root = path.resolve(import.meta.dir, '..');
  const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
  const skills = fs.readdirSync(path.join(root, 'skills')).filter((d) => fs.existsSync(path.join(root, 'skills', d, 'SKILL.md'))).map((d) => `skills/${d}/SKILL.md`);
  const files = ['mcp/host-mcp.js', 'server/prompt-blocks.ts', 'server/api.ts', 'server/lib/browser-actions.ts', 'docs/LOGIN.md', ...skills];
  const stale = [
    /request_screen so the human types the credentials/,
    /a fresh sign-in is\s+`?request_screen/,
    /that is request_screen, the human types/,
    /\(request_screen\) for logins/,
    /manual login, 2FA \/ OTP code/,
    /A vendor login form is the take-over/,
    /hand over to the human at login \/ 2FA/,
    /sign in fresh with request_screen/,
    /credential\/OTP field or a CAPTCHA — if needsHuman is true, stop and call request_screen/,
  ];
  for (const f of files) for (const re of stale) expect(`${f}: ${re.test(read(f)) ? re : 'ok'}`).toBe(`${f}: ok`);
  // the places a session meets at the moment it signs in all name the card
  for (const f of ['mcp/host-mcp.js', 'skills/machine-work/SKILL.md', 'docs/LOGIN.md', 'server/lib/browser-actions.ts']) expect(read(f)).toContain('request_credentials');
  expect(read('skills/machine-work/SKILL.md').split('\n')[1]).toContain('request_credentials'); // the description every session lists
  expect(read('server/api.ts')).toMatch(/const SIGN_IN_FRESH = "[^"]*request_credentials/);
});

test('the first turn of a new session tells it about the card, in the login and the identity blocks', () => {
  const r = runInChild("const c=await import('./server/claude.js');emit(c.firstTurnPreview({engine:'claude'}).firstTurn);", { ARIGAMI_DIR: tmpDir('arigami-cred-ft-'), ARIGAMI_PORT: '' });
  if (!r.ok) throw new Error(r.error);
  const first = r.out[0];
  const login = first.slice(first.indexOf('Signing in to a service'));
  expect(login).toContain('request_credentials({site, reason})');
  expect(first.slice(first.indexOf('You are the agent inside Arigami'))).toContain('request_credentials');
});
