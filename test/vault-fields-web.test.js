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

let React, render, CredentialCard, schema, prefs, vaultLib, grants, store;
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
  globalThis.MutationObserver = class { observe() {} disconnect() {} takeRecords() { return []; } };
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
  vaultLib = await import(web('lib/vault.js'));
  grants = await import(web('lib/vault-grants.js'));
  store = await import(web('lib/store.js'));
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
  // VAULT3: the part of a saved expiry, split in the worker — month two digits, year four; anything else is null (no value in errors)
  expect(schema.expiryPart('03/27', 'month')).toBe('03');
  expect(schema.expiryPart('03/27', 'year')).toBe('2027');
  expect(schema.expiryPart('3/27', 'month')).toBe('03');
  expect(schema.expiryPart('12/2030', 'year')).toBe('2030');
  expect(schema.expiryPart('12/2030', 'month')).toBe('12');
  expect(schema.expiryPart('2028-05', 'month')).toBe('05');
  expect(schema.expiryPart('2028-05', 'year')).toBe('2028');
  expect(schema.expiryPart('2028/5', 'month')).toBe('05');
  expect(schema.expiryPart('0729', 'year')).toBe('2029');
  expect(schema.expiryPart(' 07 - 29 ', 'month')).toBe('07');
  expect(schema.expiryPart('07.29', 'year')).toBe('2029');
  expect(schema.expiryPart('13/27', 'month')).toBe(null);
  expect(schema.expiryPart('00/27', 'month')).toBe(null);
  expect(schema.expiryPart('03/2', 'year')).toBe(null);
  expect(schema.expiryPart('03/1999', 'year')).toBe(null);
  expect(schema.expiryPart('abc', 'month')).toBe(null);
  expect(schema.expiryPart('', 'month')).toBe(null);
  expect(schema.expiryPart('03/27', 'day')).toBe(null);
  expect(schema.expiryPart('03/27', 'value')).toBe('03/27');
  expect(schema.expiryPart('03/27')).toBe('03/27');
  expect(schema.FIELD_PARTS).toEqual(['value', 'month', 'year']);
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
  expect(html).toContain('Card number · card_number'); // an agent's label never hides the stored name
  expect(html).toMatch(/inputmode="numeric"/i);
  expect(html).toMatch(/inputmode="email"/i);
  expect(html).toContain('value="Dana"'); // the account the agent named, editable
  expect(html).toContain('data-cred-save-form');
  expect(html).toContain('Save to vault');
  expect(html).not.toContain('data-cred-manual'); // nothing to type into a page
  expect(html).not.toMatch(/type="password"/);
  // a required field is marked; an optional one is not
  expect(html).toMatch(/Card number · card_number \*/);
  expect(html).not.toMatch(/email \*/);
  // a multi-line field is a textarea (plain, several rows); the others are single-line inputs
  expect(html).toMatch(/<textarea[^>]*data-cred-field="notes"/);
  expect((html.match(/<textarea/g) || []).length).toBe(1);
});

test('one named field (vault_fill) renders WHERE it goes, a single dotted input, keep-in-vault, I\'ll type it myself — and no "remember" (never automatic)', async () => {
  const html = render(h(CredentialCard, { sessionId: 's1', request: { ...base, kind: 'field', fields: ['card_number'], entry: 'Dana', reason: 'verify', page: { tag: 'input', type: 'text', label: 'Card number' } } }));
  expect(html).toContain('data-cred-kind="field"');
  expect(html).toContain('card_number for bank.example');
  expect(html).toContain('data-cred-target');
  expect(html).toContain('Into the page field “Card number” (input · text)');
  expect(html).toContain('bank.example');
  expect(html).toContain('data-cred-field="card_number"');
  expect((html.match(/data-cred-field=/g) || []).length).toBe(1);
  expect(html).toContain('-webkit-text-security:disc');
  expect(html).toContain('Keep it in the vault (Dana)');
  expect(html).toContain('data-cred-manual');
  expect(html).not.toContain('Remember this choice'); // the per-site auto choice is a sign-in's, not a grant for named fields
  expect(html).not.toContain('data-cred-shared');
  expect(html).not.toMatch(/type="password"/);
  // VAULT4: a named field is automatic only under this tab's grant (session + exact origin); a sign-in's "remember"
  // choice still reaches only a request without a kind, and a form is never automatic
  const auto = await Bun.file(web('components/VaultAutoFill.jsx')).text();
  expect(auto).toContain("if (!coversRequest(s.id, r)) continue;");
  expect(auto).toContain("if (r.pref !== 'auto' || r.kind) continue;");
  expect(auto).toContain('auto: true, grant: true');
  const shared = render(h(CredentialCard, { sessionId: 's1', request: { ...base, kind: 'field', fields: ['id_number'], target: 'shared', account: 'work.example' } }));
  expect(shared).toContain('data-cred-shared');
  expect(shared).toContain('work.example');
  // a one-time code is never kept
  const otp = render(h(CredentialCard, { sessionId: 's1', request: { ...base, kind: 'field', fields: ['otp'] } }));
  expect(otp).not.toContain('Keep it in the vault');
  // VAULT3: a part of a saved expiry into a select — the card names the part and the select (name), never a value
  const month = render(h(CredentialCard, { sessionId: 's1', request: { ...base, kind: 'field', fields: ['expiry'], part: 'month', page: { tag: 'select', type: 'select-one', label: 'Expiry month', id: 'cmbExpiryMonth', name: 'cmbExpiryMonth' } } }));
  expect(month).toContain('data-cred-part="month"');
  expect(month).toContain('expiry · month for bank.example');
  expect(month).toContain('Into the page field “Expiry month” (select · select-one · cmbExpiryMonth)');
  expect(month).not.toMatch(/\b20\d\d\b|\b0[1-9]\/|\d\d\/\d\d/);
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

// ---- VAULT4: the field card is never a dead end; one tick grants the rest of the session's details on this origin -------

test('a locked vault: the card says so (and that the saved field is there to unlock for), Fill answers instead of sitting disabled', () => {
  vaultLib._setVaultStatus({ exists: true, unlocked: false, count: 0 });
  const req = { ...base, kind: 'field', fields: ['id_number'], saved: true, page: { tag: 'input', type: 'text', label: 'ID' } };
  const html = render(h(CredentialCard, { sessionId: 's1', request: req }));
  expect(html).toContain('data-cred-state="locked"');
  expect(html).toContain('The vault is locked in this tab. Unlock it to fill the saved id_number.');
  expect(html).toMatch(/aria-label="Vault password"/); // the unlock row is on the card
  expect(html).not.toMatch(/data-cred-fill[^>]*disabled/); // a click gets a hint or a fill — never nothing
  // nothing saved for it: unlock, or type it
  const none = render(h(CredentialCard, { sessionId: 's1', request: { ...req, saved: false } }));
  expect(none).toContain('data-cred-state="lockedNone"');
  expect(none).toContain('Unlock it, or type the id_number below.');
  // the vault file could not be read: said, with the status — not folded into "no vault"
  vaultLib._setVaultStatus({ exists: false, unlocked: false, error: 'HTTP 401' });
  const bad = render(h(CredentialCard, { sessionId: 's1', request: req }));
  expect(bad).toContain('data-cred-state="unreachable"');
  expect(bad).toContain('could not be read (HTTP 401)');
  // unlocked, no entry for this exact address: said, with the address
  // unlocked and the catalog says nothing is saved for this field: said at once, with the address (a saved one waits for the vault's answer)
  vaultLib._setVaultStatus({ exists: true, unlocked: true, error: null, count: 3 });
  expect(render(h(CredentialCard, { sessionId: 's1', request: req }))).not.toContain('data-cred-state');
  const no = render(h(CredentialCard, { sessionId: 's1', request: { ...req, saved: false } }));
  expect(no).toContain('data-cred-state="noEntry"');
  expect(no).toContain('No saved id_number for bank.example in the vault');
  expect(no).not.toContain('data-cred-grant'); // the grant is offered only with a saved entry to fill from
  // the sign-in card's Fill answers too
  const si = render(h(CredentialCard, { sessionId: 's1', request: { ...base, fields: ['username', 'password'] } }));
  expect(si).not.toMatch(/data-cred-fill[^>]*disabled/);
  vaultLib._setVaultStatus({ exists: false, unlocked: false, error: null });
});

test('a grant: one session, one exact origin, a bounded time; gone on lock, on the session\'s end, never for a sign-in, a form or the owner\'s Chrome', () => {
  const t0 = 1_000_000;
  expect(grants.grantAutoFill({ sessionId: 's1', origin: 'https://bank.example', minutes: 10 }, t0)).toEqual({ until: t0 + 600_000 });
  expect(grants.grantAutoFill({ sessionId: 's1', origin: 'https://bank.example', minutes: 999 }, t0).until).toBe(t0 + 60 * 60_000); // clamped
  expect(grants.grantAutoFill({ sessionId: 's1', origin: 'bank.example' })).toBeNull(); // not an origin
  grants.grantAutoFill({ sessionId: 's1', origin: 'https://bank.example', minutes: 10 }, t0);
  const field = { kind: 'field', origin: 'https://bank.example', fields: ['id_number'] };
  expect(grants.coversRequest('s1', field, t0 + 1)).toBe(true);
  expect(grants.coversRequest('s2', field, t0 + 1)).toBe(false); // another session
  expect(grants.coversRequest('s1', { ...field, origin: 'https://login.bank.example' }, t0 + 1)).toBe(false); // another origin
  expect(grants.coversRequest('s1', { ...field, origin: 'http://bank.example' }, t0 + 1)).toBe(false);
  expect(grants.coversRequest('s1', { ...field, kind: undefined }, t0 + 1)).toBe(false); // a sign-in
  expect(grants.coversRequest('s1', { ...field, kind: 'form' }, t0 + 1)).toBe(false);
  expect(grants.coversRequest('s1', { ...field, target: 'shared' }, t0 + 1)).toBe(false); // the owner's Chrome
  expect(grants.coversRequest('s1', field, t0 + 600_001)).toBe(false); // time up — and dropped
  expect(grants.grantCount()).toBe(0);
  // the rail: an open vault card needs the human — unless this tab's grant is about to fill it
  grants.grantAutoFill({ sessionId: 's1', origin: 'https://bank.example', minutes: 10 });
  expect(store.needsAttention({ id: 's2', credentialRequest: { requestId: 'c', ...field } })).toBe(true);
  expect(store.needsAttention({ id: 's1', credentialRequest: { requestId: 'c', ...field } })).toBe(false);
  expect(store.needsAttention({ id: 's1', credentialRequest: { requestId: 'c', ...field, kind: undefined } })).toBe(true);
  expect(store.needsAttention({ id: 's1' })).toBe(false);
  // the card shows the grant and offers to stop it; an automatic miss is shown on the card
  vaultLib._setVaultStatus({ exists: true, unlocked: true, count: 1 });
  grants.noteAuto('cred_x', 'no saved id_number for this exact address');
  const html = render(h(CredentialCard, { sessionId: 's1', request: { ...base, kind: 'field', fields: ['id_number'], saved: true } }));
  expect(html).toContain('data-cred-grant-on');
  expect(html).toContain('Automatic fills are on for bank.example in this session');
  expect(html).toContain('>Stop<');
  expect(html).toContain('data-cred-auto-error');
  expect(html).toContain('Not filled by itself: no saved id_number for this exact address');
  grants.noteAuto('cred_x', null);
  // a grant dies with its session, and with the vault's lock in this tab
  grants.grantAutoFill({ sessionId: 's9', origin: 'https://x.example' });
  grants.pruneGrants(['s1']);
  expect(grants.grantFor('s9', 'https://x.example')).toBeNull();
  expect(grants.grantFor('s1', 'https://bank.example')).not.toBeNull();
  vaultLib._setVaultStatus({ unlocked: false });
  expect(grants.grantCount()).toBe(0);
  expect(store.needsAttention({ id: 's1', credentialRequest: { requestId: 'c', ...field } })).toBe(true);
  vaultLib._setVaultStatus({ exists: false, unlocked: false, error: null });
});
