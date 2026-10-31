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

test('the agent gets sign_in with the browser, the login block and the password-field refusal point to it', () => {
  const root = path.resolve(import.meta.dir, '..');
  const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
  expect(read('server/agent-policy.ts')).toMatch(/BROWSER_TOOLS = \[[^\]]*'sign_in'/);
  expect(read('mcp/host-mcp.js')).toContain("name: 'sign_in'");
  // request_credentials is sign_in's internal now: defined, but not listed to the model
  expect(read('mcp/host-mcp.js')).toMatch(/LOGIN_INTERNAL = new Set\(\[[^\]]*'request_credentials'/);
  expect(read('server/prompt-blocks.ts')).toContain('sign_in({site, reason})');
  expect(read('server/lib/browser-actions.ts')).toMatch(/Call sign_in/);
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
  expect(w.match(/fetch\(/g).length).toBe(6); // status, read file, write file, fill, the names-only catalog (VAULT2), one named field's fill
  expect(w).not.toMatch(/console\.|postMessage\([^)]*password/);
  // the two fills are the only calls that carry a value, and both go to the session's fill route
  expect(w.match(/credentials\/fill`/g).length).toBe(2);
  // the catalog upload is built from describe() — names and types — never from a field's text
  const cat = w.slice(w.indexOf('async function pushCatalog'), w.indexOf('async function pushCatalog') + 400);
  expect(cat).toContain('catalogOf(entries().map(describe))');
  expect(cat).not.toMatch(/text\(|getText|fieldValue/);
});

// ---- VAULT2: named fields -------------------------------------------------------------------------------------------

test('VAULT2: a field name is any language, cleaned and capped — never one of the entry\'s own keys', () => {
  const { out } = inChild(
    "emit({a:cr.fieldName(' מספר  כרטיס '),b:cr.fieldName('Title'),c:cr.fieldName('Arigami origin'),d:cr.fieldName('x'.repeat(65)),e:cr.fieldName('a\\u0000b'),u:cr.fieldName('username')," +
      "f:cr.normalizeFieldSpecs([{name:'card_number',type:'number',label:' Card  number '},'cvv',{name:'CVV'},{name:'expiry',type:'bogus',required:false},{name:'remarks',type:'multiline'}])," +
      "g:cr.normalizeFieldSpecs([]),h:cr.normalizeFieldSpecs(Array.from({length:25},(_,i)=>'f'+i)),i:cr.normalizeFieldSpecs([{name:'URL'}]),j:cr.normalizeFieldSpecs('cvv')," +
      "o:[cr.siteOrigin('https://www.Bank.example/login'),cr.siteOrigin('bank.example'),cr.siteOrigin('not a site'),cr.siteOrigin('')]});"
  );
  expect(out.a).toBe('מספר כרטיס');
  expect(out.b).toBe(null);
  expect(out.c).toBe(null);
  expect(out.d).toBe(null);
  expect(out.e).toBe('a b');
  expect(out.u).toBe('username');
  expect(out.f).toEqual({ fields: [{ name: 'card_number', type: 'number', label: 'Card number' }, { name: 'cvv', type: 'secret' }, { name: 'expiry', type: 'secret', required: false }, { name: 'remarks', type: 'multiline' }] }); // "notes" itself is the entry's own key (refused, like URL below)
  expect(out.g.error).toMatch(/fields required/);
  expect(out.h.error).toMatch(/at most 24/);
  expect(out.i.error).toMatch(/reserved/);
  expect(out.j.error).toMatch(/fields required/);
  expect(out.o).toEqual(['https://www.bank.example', 'https://bank.example', null, null]);
});

test('VAULT2: the catalog keeps ids, titles, origins and field names — whatever else was uploaded is dropped on the way in', () => {
  const { out, dir } = inChild(
    "const n=cr.writeCatalog({entries:[" +
      "{id:'e1',title:'Dana',origin:'https://bank.example',username:'dana@example.com',notes:'x',fields:[{name:'card_number',type:'number',value:'4111'},{name:'password',type:'secret'},{name:'Notes'},{name:'otp',type:'otp'},{name:'card_number'}]}," +
      "{id:'e2',title:'',origin:'https://login.bank.example',fields:[]}," +
      "{id:'e3',title:'Other',origin:'https://other.example',fields:['pin']}," +
      "{origin:'https://noid.example',fields:['pin']},{id:'e5',title:'bad',origin:'javascript:alert(1)',fields:[]},{id:'e6',title:'path',origin:'https://x.example/path',fields:[]}]});" +
      "emit({n,all:cr.readCatalog(),bank:cr.catalogFor('https://www.bank.example/x'),other:cr.catalogFor('other.example'),none:cr.catalogFor(''),file:require('node:fs').readFileSync(cr.CATALOG_FILE(),'utf8')});"
  );
  expect(out.n).toEqual({ entries: 3 });
  expect(out.all[0]).toEqual({ id: 'e1', title: 'Dana', origin: 'https://bank.example', fields: [{ name: 'card_number', type: 'number' }, { name: 'password', type: 'secret' }, { name: 'otp', type: 'otp' }] });
  expect(out.all[1].title).toBe('login.bank.example');
  expect(out.bank.map((e) => e.id)).toEqual(['e1', 'e2']);
  expect(out.other).toEqual([{ id: 'e3', title: 'Other', origin: 'https://other.example', fields: [{ name: 'pin', type: 'secret' }] }]);
  expect(out.none).toEqual([]);
  for (const leak of ['4111', 'dana@example.com', 'notes', 'value', 'username']) expect(out.file).not.toContain(leak);
  expect(fs.statSync(path.join(dir, 'user', 'vault', 'catalog.json')).mode & 0o077).toBe(0);
  expect(fs.readFileSync(path.join(dir, 'user', '.gitignore'), 'utf8').split('\n')).toContain('vault/');
});

// The original gap was a tool missing from a session's list: the three must come out of tools/list on BOTH engines
// (a plain session, no agent allowlist), while request_credentials stays internal.
test('VAULT2: tools/list on the claude and the codex engine names vault_fields / vault_collect / vault_fill', async () => {
  const { createArigamiServer } = await import('../mcp/host-mcp.js');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  for (const engine of ['claude', 'codex']) {
    const server = await createArigamiServer({ ARIGAMI_URL: 'http://127.0.0.1:1', ARIGAMI_SESSION_ID: 'sess_list', ARIGAMI_ENGINE: engine });
    const client = new Client({ name: 'vault-list-test', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    await client.connect(b);
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      for (const n of ['vault_fields', 'vault_collect', 'vault_fill', 'sign_in']) expect(`${engine}: ${n} ${names.includes(n)}`).toBe(`${engine}: ${n} true`);
      for (const n of ['request_credentials', 'request_login', 'browser_logins']) expect(`${engine}: ${n} ${names.includes(n)}`).toBe(`${engine}: ${n} false`);
      const fill = (await client.listTools()).tools.find((t) => t.name === 'vault_fill');
      expect(fill.inputSchema.required).toEqual(['site', 'field']); // a value is aimed at one site, by name — never by selector
      const collect = (await client.listTools()).tools.find((t) => t.name === 'vault_collect');
      expect(Object.keys(collect.inputSchema.properties.fields.items.properties).sort()).toEqual(['label', 'name', 'required', 'type']); // the ask describes fields, never carries values
    } finally {
      await client.close();
      await server.close();
    }
  }
});

test('VAULT2: the agent gets vault_fields / vault_collect / vault_fill with the browser, and no text of theirs promises a value', () => {
  const root = path.resolve(import.meta.dir, '..');
  const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
  expect(read('server/agent-policy.ts')).toMatch(/BROWSER_TOOLS = \[[^\]]*'vault_fields', 'vault_collect', 'vault_fill'/);
  const mcp = read('mcp/host-mcp.js');
  for (const name of ['vault_fields', 'vault_collect', 'vault_fill']) {
    const i = mcp.indexOf(`name: '${name}'`);
    expect(i).toBeGreaterThan(0);
    const def = mcp.slice(i, mcp.indexOf('run:', i));
    expect(def).toMatch(/never (a|see the) value|never a value/);
  }
  // the login block names the three, in its three lines
  expect(read('server/prompt-blocks.ts')).toMatch(/vault_fill\(\{site, field\}\)[^\n]*vault_collect/);
  // the in-page scripts: the one that marks a field returns where it is, never what it holds; the fill returns ok / error
  const cr = read('server/lib/credentials.ts');
  const target = cr.slice(cr.indexOf('export function targetJs'), cr.indexOf('export function fillFieldJs'));
  expect(target).not.toMatch(/\.value\b/);
  const fill = cr.slice(cr.indexOf('export function fillFieldJs'), cr.indexOf('export type FieldOutcome'));
  expect(fill).toMatch(/return \{ ok: true \}/);
  expect(fill).not.toMatch(/return \{[^}]*value/);
  // the vault routes an agent reaches answer names and outcomes: no values key is ever read out of a request body there
  const api = read('server/api.ts');
  const sec = api.slice(api.indexOf('// ---- VAULT2: the owner\'s named details — a secure form'), api.indexOf('/** sign_in({fill})'));
  expect(sec.length).toBeGreaterThan(2000);
  expect(sec).not.toMatch(/body\.values|body\.value\b/);
});

// Every text a session reads about signing in agrees: a sign-in is sign_in; request_screen is for
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
  // the places a session meets at the moment it signs in all name sign_in
  for (const f of ['mcp/host-mcp.js', 'skills/machine-work/SKILL.md', 'docs/LOGIN.md', 'server/lib/browser-actions.ts']) expect(read(f)).toContain('sign_in');
  expect(read('skills/machine-work/SKILL.md').split('\n')[1]).toContain('sign_in'); // the description every session lists
  expect(read('server/api.ts')).toMatch(/const SIGN_IN_FRESH = "[^"]*sign_in/);
  // and none of them sends the model to a tool it cannot see any more
  const visible = [...skills, 'server/prompt-blocks.ts', 'server/lib/browser-actions.ts'];
  for (const f of visible) for (const re of [/request_credentials/, /request_login/, /sso_login/, /(^|[^_])browser_logins/, /save_login\(/]) expect(`${f}: ${re.test(read(f)) ? re : 'ok'}`).toBe(`${f}: ok`);
});

test('the first turn of a new session tells it about sign_in, in the login and the identity blocks', () => {
  const r = runInChild("const c=await import('./server/claude.js');emit(c.firstTurnPreview({engine:'claude'}).firstTurn);", { ARIGAMI_DIR: tmpDir('arigami-cred-ft-'), ARIGAMI_PORT: '' });
  if (!r.ok) throw new Error(r.error);
  const first = r.out[0];
  const login = first.slice(first.indexOf('Signing in anywhere'));
  expect(login).toContain('sign_in({site, reason})');
  expect(first.slice(first.indexOf('You are the agent inside Arigami'))).toContain('sign_in');
});
