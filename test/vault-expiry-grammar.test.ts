// VAULT3: ONE grammar for a saved expiry, in two places — the vault worker (web/src/lib/vault-schema.js expiryPart,
// the preferred path: the split happens in the owner's cockpit) and the host's fill route (server/lib/credentials.ts
// expiryPartOf, compatibility for a cockpit tab older than the host that sends the whole value). The same vector
// table runs through both, so the two can never drift apart; and the host's shape contract (partShape) accepts
// exactly what either produces and nothing else.
import { test, expect } from 'bun:test';
import * as cr from '../server/lib/credentials.ts';
import { expiryPart } from '../web/src/lib/vault-schema.js';

// [input, month, year] — null = not an expiry in a known format
const VECTORS: [string, string | null, string | null][] = [
  ['03/27', '03', '2027'],
  ['3/27', '03', '2027'],
  ['12/2030', '12', '2030'],
  ['1/2031', '01', '2031'],
  ['2028-05', '05', '2028'],
  ['2028/5', '05', '2028'],
  ['0729', '07', '2029'],
  [' 07 - 29 ', '07', '2029'],
  ['07.29', '07', '2029'],
  ['11 / 2026', '11', '2026'],
  ['13/27', null, null],
  ['00/27', null, null],
  ['03/2', null, null],
  ['03/1999', null, null],
  ['03/2100', null, null],
  ['27', null, null], // a two-digit year alone is not a year — never guessed
  ['2027', null, null], // a four-digit year alone is not a whole expiry either
  ['03', null, null], // a month alone is not a whole expiry (it is a well-shaped PART, accepted as-is by the host)
  ['abc', null, null],
  ['next year', null, null],
  ['', null, null],
  ['03/27/2027', null, null],
  ['032027', null, null],
];

test('the worker and the host split a whole expiry identically, vector by vector', () => {
  for (const [input, month, year] of VECTORS) {
    expect(`${JSON.stringify(input)} month: ${expiryPart(input, 'month')}`).toBe(`${JSON.stringify(input)} month: ${month}`);
    expect(`${JSON.stringify(input)} year: ${expiryPart(input, 'year')}`).toBe(`${JSON.stringify(input)} year: ${year}`);
    expect(`${JSON.stringify(input)} host month: ${cr.expiryPartOf(input, 'month')}`).toBe(`${JSON.stringify(input)} host month: ${month}`);
    expect(`${JSON.stringify(input)} host year: ${cr.expiryPartOf(input, 'year')}`).toBe(`${JSON.stringify(input)} host year: ${year}`);
    // part 'value' is the whole value, untouched, in both
    expect(expiryPart(input, 'value')).toBe(input);
    expect(cr.expiryPartOf(input, 'value')).toBe(input);
  }
});

test("everything the split produces passes the host's shape contract, and nothing a stale client could send does", () => {
  for (const [, month, year] of VECTORS) {
    if (month) expect(cr.partShape('month', month)).toBe(null);
    if (year) expect(cr.partShape('year', year)).toBe(null);
  }
  for (const [input] of VECTORS) {
    // a whole expiry (or garbage) is never a well-shaped part by itself — the route must split or refuse
    if (input !== '03') expect(cr.partShape('month', input)).not.toBe(null);
    if (input !== '2027') expect(cr.partShape('year', input)).not.toBe(null); // a full year alone IS a well-shaped part
  }
  expect(cr.partShape('month', '03')).toBe(null);
  expect(cr.partShape('year', '2027')).toBe(null);
  expect(cr.partShape('year', '27')).toMatch(/not a four-digit year/);
  // neither message ever carries what was sent
  for (const [input] of VECTORS) for (const p of ['month', 'year'] as const) {
    const m = cr.partShape(p, input);
    if (m && input) expect(m).not.toContain(input.trim());
  }
});

test('the fill route: a well-shaped part as-is, a whole expiry split, anything else fail-closed before the DOM', async () => {
  const mk = (part: cr.FieldPart) => {
    const id = `cred_grammar_${part}`;
    const req: cr.CredentialRequest = { requestId: id, at: new Date().toISOString(), origin: 'https://bank.example', host: 'bank.example', fields: ['expiry'], pref: 'ask', kind: 'field', part, page: { tag: 'select', type: 'select-one', label: 'Expiry', name: 'cmbExpiry' } };
    cr._setPending(id, { sessionId: 'sess-grammar', origin: 'https://bank.example', tabId: 'tab-none', fields: ['expiry'], at: Date.now(), request: req } as any);
    return id;
  };
  const outcome = async (part: cr.FieldPart, value: string) => {
    const id = mk(part);
    try {
      await cr.fill('sess-grammar', id, { expiry: value });
      return 'filled';
    } catch (e) {
      return `${(e as any).status} ${(e as Error).message}`;
    }
  };
  // past the shape check = reaches the (absent) tab → 410; refused = 400 before any tab lookup
  expect(await outcome('month', '03')).toMatch(/^410 /);
  expect(await outcome('year', '2027')).toMatch(/^410 /);
  expect(await outcome('month', '03/27')).toMatch(/^410 /);
  expect(await outcome('year', '12/2030')).toMatch(/^410 /);
  expect(await outcome('year', '27')).toMatch(/^400 .*not a four-digit year/);
  expect(await outcome('month', '13/27')).toMatch(/^400 .*not a two-digit month/);
  const bad = await outcome('month', 'next year');
  expect(bad).toMatch(/^400 .*not a two-digit month/);
  expect(bad).not.toContain('next year');
  cr.forgetSession('sess-grammar');
});
