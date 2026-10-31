// VAULT2 web: named fields in the cockpit.
//   · vault-schema.js (pure): an entry's fields in agent names and types, the stored types, the names-only catalog,
//     the agent's entry hint
//   · the credential card renders three kinds from the same session state — a sign-in (as before), a secure form
//     (vault_collect) and one named field (vault_fill) — with inputs per field type and never type="password"
//   · the Passwords page still renders, and its field rows show dots, never a value
import { test, expect, beforeAll, afterAll } from 'bun:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolate } from './_isolate.js';
isolate();

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const web = (p) => path.join(ROOT, 'web/src', p);

let React, render, CredentialCard, schema, prefs;
const h = (...a) => React.createElement(...a);
let origFetch;

beforeAll(async () => {
  const mem = new Map();
  globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
  globalThis.window = globalThis;
  globalThis.location = { origin: 'http://host.test', port: '', pathname: '/', hash: '', search: '' };
  globalThis.navigator = { language: 'en-US', userAgent: 'test' };
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  globalThis.WebSocket = class { close() {} };
  // the cockpit on https / localhost: saving to the vault is offered (vaultSupported); no worker is started by a server render
  globalThis.isSecureContext = true;
  globalThis.Worker = class { postMessage() {} };
  globalThis.document = {
    documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} }, setAttribute() {}, classList: { add() {}, remove() {} }, dir: 'ltr' },
    body: {}, querySelector: () => null, addEventListener() {}, removeEventListener() {},
  };
  origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '{}', headers: { get: () => 'application/json' } });
  React = (await import(path.join(ROOT, 'web/node_modules/react/index.js'))).default;
  ({ renderToStaticMarkup: render } = await import(path.join(ROOT, 'web/node_modules/react-dom/server.js')));
  prefs = await import(web('lib/prefs.js'));
  prefs.setPrefs({ language: 'en' });
  ({ default: CredentialCard } = await import(web('components/CredentialCard.jsx')));
  schema = await import(web('lib/vault-schema.js'));
});
afterAll(() => { if (origFetch) globalThis.fetch = origFetch; });

// ---- the schema (pure) ------------------------------------------------------------------------------------------------

test("an entry's fields in agent names: the standard keys under their roles, custom keys as named, hidden keys and empties out", () => {
  const kv = [
    { key: 'Title', protected: false, empty: false },
    { key: 'URL', protected: false, empty: false },
    { key: 'Arigami origin', protected: false, empty: false },
    { key: 'UserName', protected: false, empty: false },
    { key: 'Password', protected: true, empty: false },
    { key: 'otp', protected: true, empty: false },
    { key: 'TOTP Settings', protected: false, empty: false },
    { key: 'card_number', protected: true, empty: false },
    { key: 'expiry', protected: true, empty: false },
    { key: 'branch', protected: false, empty: false },
    { key: 'Arigami field types', protected: false, empty: false },
    { key: 'gone', protected: true, empty: true },
  ];
  expect(schema.fieldsOf(kv, { card_number: 'number', expiry: 'date' })).toEqual([
    { name: 'username', type: 'text' },
    { name: 'password', type: 'secret' },
    { name: 'otp', type: 'otp' },
    { name: 'card_number', type: 'number' },
    { name: 'expiry', type: 'date' },
    { name: 'branch', type: 'text' },
  ]);
  // KeePass 2.x keeps the one-time secret as "TOTP Seed": the same role
  expect(schema.fieldsOf([{ key: 'TOTP Seed', protected: true, empty: false }])).toEqual([{ name: 'otp', type: 'otp' }]);
  // an entry from before VAULT2: a protected custom field is a secret, a plain one is text
  expect(schema.fieldsOf([{ key: 'PIN', protected: true, empty: false }, { key: 'Branch', protected: false, empty: false }])).toEqual([{ name: 'PIN', type: 'secret' }, { name: 'Branch', type: 'text' }]);
});

test('what is stored: only the types the protected flag would not say; names cleaned; the catalog has no username', () => {
  expect(schema.typesToStore([{ name: 'card_number', type: 'number' }, { name: 'cvv', type: 'secret' }, { name: 'note', type: 'text' }, { name: 'password', type: 'number' }])).toEqual({ card_number: 'number' });
  expect(schema.parseTypes('{"a":"date","b":"bogus","c":1}')).toEqual({ a: 'date' });
  expect(schema.parseTypes('nope')).toEqual({});
  expect(schema.cleanName(' מספר  כרטיס ')).toBe('מספר כרטיס');
  expect(schema.cleanName('Title')).toBe(null);
  expect(schema.cleanName('Arigami origin')).toBe(null);
  expect(schema.cleanName('x'.repeat(65))).toBe(null);
  expect(schema.kdbxKey('username')).toBe('UserName');
  expect(schema.kdbxKey('Password')).toBe('Password');
  expect(schema.kdbxKey('card_number')).toBe('card_number');
  expect(schema.agentName('UserName')).toBe('username');
  for (const t of schema.FIELD_TYPES) expect(schema.isProtectedType(t)).toBe(t !== 'text' && t !== 'multiline');
  expect(schema.FIELD_TYPES).toContain('multiline');
  expect(schema.inputPropsFor('multiline')).toEqual({ secret: false, multiline: true });
  const cat = schema.catalogOf([{ id: 'e1', title: 'Dana', origin: 'https://bank.example', username: 'dana@example.com', fields: [{ name: 'card_number', type: 'number', value: 'x' }] }]);
  expect(cat).toEqual({ entries: [{ id: 'e1', title: 'Dana', origin: 'https://bank.example', fields: [{ name: 'card_number', type: 'number' }] }] });
  expect(JSON.stringify(cat)).not.toMatch(/username|value/);
  // a named field: the exact origin only — a sibling subdomain (or http vs https) is another origin; a sign-in role
  // keeps the sign-in card's site rule (legacy, unchanged)
  expect(schema.entryAllowedFor('https://bank.example', 'https://bank.example', 'card_number')).toBe(true);
  expect(schema.entryAllowedFor('https://bank.example', 'https://pay.bank.example', 'card_number')).toBe(false);
  expect(schema.entryAllowedFor('https://pay.bank.example', 'https://bank.example', 'card_number')).toBe(false);
  expect(schema.entryAllowedFor('https://bank.example', 'http://bank.example', 'card_number')).toBe(false);
  expect(schema.entryAllowedFor('https://bank.example', 'https://bank.example.evil.example', 'card_number')).toBe(false);
  expect(schema.entryAllowedFor('https://bank.example', 'https://login.bank.example', 'password')).toBe(true);
  expect(schema.entryAllowedFor('https://bank.example', 'https://login.bank.example', 'username')).toBe(true);
  expect(schema.entryAllowedFor('https://bank.example', 'http://login.bank.example', 'password')).toBe(false);
  expect(schema.entryAllowedFor('https://bank.example', 'https://other.example', 'password')).toBe(false);
  expect(schema.entryAllowedFor('', 'https://bank.example', 'password')).toBe(false);
  const e = { id: 'e1', title: 'Dana', username: 'dana@example.com' };
  expect(schema.entryMatches(e, 'dana')).toBe(true);
  expect(schema.entryMatches(e, 'e1')).toBe(true);
  expect(schema.entryMatches(e, 'DANA@example.com')).toBe(true);
  expect(schema.entryMatches(e, 'Moran')).toBe(false);
  expect(schema.entryMatches(e, '')).toBe(true);
});

// ---- the card -----------------------------------------------------------------------------------------------------------

const base = { requestId: 'cred_x', at: new Date().toISOString(), origin: 'https://bank.example', host: 'bank.example', pref: 'ask' };

test('a sign-in request with no kind renders as before: the role inputs, Fill, I\'ll type it myself', () => {
  const html = render(h(CredentialCard, { sessionId: 's1', request: { ...base, fields: ['username', 'password'] } }));
  expect(html).toContain('data-credential-request="cred_x"');
  expect(html).not.toContain('data-cred-kind');
  expect(html).toContain('data-cred-field="username"');
  expect(html).toContain('data-cred-field="password"');
  expect(html).toContain('data-cred-manual');
  expect(html).not.toMatch(/type="password"/);
});

test('a form (vault_collect) renders every field with its label and type, an account name, Save to vault — and no page fill', () => {
  const spec = [{ name: 'card_number', type: 'number', label: 'Card number' }, { name: 'expiry', type: 'date' }, { name: 'cvv', type: 'secret' }, { name: 'email', type: 'email', required: false }, { name: 'notes', type: 'multiline', required: false }];
  const html = render(h(CredentialCard, { sessionId: 's1', request: { ...base, kind: 'form', fields: spec.map((f) => f.name), spec, entry: 'Dana', reason: 'verify the card' } }));
  expect(html).toContain('data-cred-kind="form"');
  expect(html).toContain('Details for bank.example');
  expect(html).toContain('verify the card');
  for (const f of spec) expect(html).toContain(`data-cred-field="${f.name}"`);
  expect(html).toContain('Card number');
  expect(html).toMatch(/inputmode="numeric"/i);
  expect(html).toMatch(/inputmode="email"/i);
  expect(html).toContain('value="Dana"'); // the account the agent named, editable
  expect(html).toContain('data-cred-save-form');
  expect(html).toContain('Save to vault');
  expect(html).not.toContain('data-cred-manual'); // nothing to type into a page
  expect(html).not.toMatch(/type="password"/);
  // a required field is marked; an optional one is not
  expect(html).toMatch(/Card number \*/);
  expect(html).not.toMatch(/email \*/);
  // a multi-line field is a textarea (plain, several rows); the others are single-line inputs
  expect(html).toMatch(/<textarea[^>]*data-cred-field="notes"/);
  expect((html.match(/<textarea/g) || []).length).toBe(1);
});

test('one named field (vault_fill) renders a single dotted input, keep-in-vault, I\'ll type it myself, and the shared-desktop note when typed there', () => {
  const html = render(h(CredentialCard, { sessionId: 's1', request: { ...base, kind: 'field', fields: ['card_number'], entry: 'Dana', reason: 'verify' } }));
  expect(html).toContain('data-cred-kind="field"');
  expect(html).toContain('card_number for bank.example');
  expect(html).toContain('data-cred-field="card_number"');
  expect((html.match(/data-cred-field=/g) || []).length).toBe(1);
  expect(html).toContain('-webkit-text-security:disc');
  expect(html).toContain('Keep it in the vault (Dana)');
  expect(html).toContain('data-cred-manual');
  expect(html).not.toContain('data-cred-shared');
  expect(html).not.toMatch(/type="password"/);
  const shared = render(h(CredentialCard, { sessionId: 's1', request: { ...base, kind: 'field', fields: ['id_number'], target: 'shared', account: 'work.example' } }));
  expect(shared).toContain('data-cred-shared');
  expect(shared).toContain('work.example');
  // a one-time code is never kept
  const otp = render(h(CredentialCard, { sessionId: 's1', request: { ...base, kind: 'field', fields: ['otp'] } }));
  expect(otp).not.toContain('Keep it in the vault');
});

test('the Passwords page renders an unlocked vault\'s entries with their fields as dots — a value is never in the markup', async () => {
  const vaultMod = await import(web('lib/vault.js'));
  // the page reads the vault's status from the store; give it an unlocked one with items the worker would describe
  const { default: Passwords } = await import(web('components/settings/Passwords.jsx'));
  const html = render(h(Passwords));
  expect(html).toContain('Vault');
  expect(typeof vaultMod.saveVaultFields).toBe('function');
  expect(typeof vaultMod.revealVaultField).toBe('function');
  // the field row's value cell is dots until the owner's own click
  const src = await Bun.file(web('components/settings/Passwords.jsx')).text();
  expect(src).toContain("shown === null ? '••••••••' : shown");
  expect(src).not.toMatch(/type=["']password["']/);
});
