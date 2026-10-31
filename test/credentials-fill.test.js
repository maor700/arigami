// VAULT1: the sign-in card's fill, against a real Chrome (test/_cred-chrome.ts in a child, with its own ARIGAMI_DIR):
// which fields are found, the origin check at fill time, the username-first two-step form, and that a request is
// used once. Skipped where no Chrome is installed.
import { test, expect } from 'bun:test';
import { runInChild } from './_child.js';
import { tmpDir } from './_tmp.js';
import { findChromeBin } from '../server/lib/platform.ts';

const chrome = findChromeBin();

test.skipIf(!chrome)('the host finds the sign-in fields, fills only them on the page the card was opened on, and once', () => {
  const r = runInChild("await import('./test/_cred-chrome.ts');", { ARIGAMI_DIR: tmpDir('arigami-cred-chrome-'), ARIGAMI_PORT: '' });
  if (!r.ok) throw new Error(r.error);
  const o = r.out[0];
  expect(o.login.fields).toEqual(['username', 'password']);
  expect(o.requestStatus).toBe('pending');
  expect(o.wrongSite).toBe('error');
  expect(o.fill).toMatchObject({ filled: ['username', 'password'], submitted: true });
  expect(o.sent).toEqual({ u: 'me@x.test', p: 's3cret' });
  expect(o.search).toBe(''); // a value is never aimed at another field
  expect(o.reuse).toMatch(/no longer open/);
  expect(o.moved).toMatch(/no longer on 127\.0\.0\.1 — nothing was filled/);
  expect(o.movedValue).toBe('');
  expect(o.twoStepFields).toEqual(['username']);
  expect(o.twoStep.filled.sort()).toEqual(['password', 'username']);
  expect(o.twoStepSeen).toEqual({ u: 'me', p: 'pw2', t: 'done' });
  expect(o.otpFields).toEqual(['otp']);
  expect(o.none).toMatchObject({ status: 'error' });
  expect(o.none.error).toMatch(/no sign-in field/);
  expect(o.inspectKeys.sort()).toEqual(['fields', 'origin', 'tab']);
  // VAULT2: a named field — by the words of its label, or the focused one; one marked element, one origin, once
  // the card learns WHERE the value goes (tag, type, label words) and is never automatic (pref 'ask' whatever the site's sign-in choice)
  expect(o.cardReq).toEqual({ kind: 'field', fields: ['card_number'], entry: 'Dana', host: '127.0.0.1', pref: 'ask', page: { tag: 'input', type: 'text', label: 'Card number', id: 'cn', name: 'cardNumber' } });
  expect(o.cardFill).toMatchObject({ filled: ['card_number'], submitted: false });
  expect(o.cardSeen).toEqual({ cn: '4111 1111 1111 1111', cvv: '', exp: '', other: '', marks: 0 });
  expect(o.cardReuse).toMatch(/no longer open/);
  expect(o.notesFill).toMatchObject({ filled: ['remarks'] });
  expect(o.notesSeen).toBe('line one\nline two SECRET-NOTE');
  expect(o.snapshotLeak).toBe(false);
  expect(o.masked).toEqual(['disc', 'disc', 'none']);
  // the pixels a screenshot (browser_snapshot's, capture_screen's) carries: none of the value — two different values
  // of the same length in the masked input and textarea render byte-identical screenshots; a plain field does not
  expect(o.maskedValues).toEqual(['4222 3333 4444 5555', 'line two\nline one SECRET-NOTE', '5678', '2021-03-04']);
  expect(o.maskedPixelsSame).toBe(true);
  expect(o.plainPixelsSame).toBe(false);
  expect(o.focusFill).toMatchObject({ filled: ['cvv'] });
  expect(o.focusSeen).toBe('321');
  expect(o.noFocus).toMatchObject({ status: 'error' });
  expect(o.noFocus.error).toMatch(/no field has the focus/);
  expect(o.noMatch.error).toMatch(/no field matches "iban"/);
  expect(o.fieldWrongSite).toBe('error');
  expect(o.fieldWwwSite).toBe('pending');
  // a secret never goes into a search box or a free-text area; an unknown-typed name counts as a secret
  expect(o.cvvIntoTextarea).toMatchObject({ status: 'error' });
  expect(o.cvvIntoTextarea.error).toMatch(/not put into a free-text area \(Notes\)/);
  expect(o.cvvIntoSearch.error).toMatch(/not put into a search box \(Search\)/);
  expect(o.unknownIntoTextarea.error).toMatch(/not put into a free-text area/);
  expect(o.searchValue).toBe('');
  // number and date inputs: Chrome draws no dots there, so the value is made invisible — and is still in the field
  expect(o.numFill).toMatchObject({ filled: ['amount'] });
  expect(o.dobFill).toMatchObject({ filled: ['dob'] });
  expect(o.numDobSeen).toEqual(['1234', '2020-01-02']);
  expect(o.numDobInvisible).toEqual(['rgba(0, 0, 0, 0)', 'rgba(0, 0, 0, 0)', 'rgba(0, 0, 0, 0)']);
  // browser_click({text}) matches no field value (no prefix oracle), while labels, buttons and placeholders still work
  expect(o.oracle).toEqual({ value: null, valueDigit: null, note: null, number: null, label: true, button: true, placeholder: true });
  expect(o.fieldMoved).toMatch(/no longer on 127\.0\.0\.1 — nothing was filled/);
  expect(o.fieldMovedValue).toBe('');
  // VAULT3: an expiry's month / year into two selects — the card learns the part and the select's name, never a value
  expect(o.monthReq).toEqual({ part: 'month', fields: ['expiry'], page: { tag: 'select', type: 'select-one', label: 'Expiry month', id: 'cmbExpiryMonth', name: 'cmbExpiryMonth' } });
  expect(o.monthFill).toMatchObject({ filled: ['expiry'] });
  expect(o.yearFill).toMatchObject({ filled: ['expiry'] });
  expect(o.selected).toEqual(['3', '27']); // "03" ↔ option "3"; "2027" ↔ option "27"
  expect(o.bogus).toMatchObject({ status: 409 });
  expect(o.bogus.message).toMatch(/none of the 2 options of cmbBogus matches the saved expiry year — nothing was chosen/);
  expect(o.bogus.message).not.toContain('2027');
  expect(o.bogusValue).toBe('a');
  expect(o.selectHidden).toEqual([['rgba(0, 0, 0, 0)', 'none', '-1', '1'], ['rgba(0, 0, 0, 0)', 'none', '-1', '1']]);
  expect(o.selectOracle).toEqual({ byText03: null, byText2027: null, guardOnSelect: true, guardOnButton: false, gate: 'filled', payButton: true });
  expect(o.selectPixelsSame).toBe(true);
  expect(o.plainSelectPixelsSame).toBe(false);
  expect(o.paid).toEqual({ n: '', m: '11', y: '29' });
}, 60000);
