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
  expect(o.cardReq).toEqual({ kind: 'field', fields: ['card_number'], entry: 'Dana', host: '127.0.0.1' });
  expect(o.cardFill).toMatchObject({ filled: ['card_number'], submitted: false });
  expect(o.cardSeen).toEqual({ cn: '4111 1111 1111 1111', cvv: '', exp: '', other: '', marks: 0 });
  expect(o.cardReuse).toMatch(/no longer open/);
  expect(o.notesFill).toMatchObject({ filled: ['remarks'] });
  expect(o.notesSeen).toBe('line one\nline two SECRET-NOTE');
  expect(o.snapshotLeak).toBe(false);
  expect(o.masked).toEqual(['disc', 'disc', 'none']);
  // the pixels a screenshot (browser_snapshot's, capture_screen's) carries: none of the value — two different values
  // of the same length in the masked input and textarea render byte-identical screenshots; a plain field does not
  expect(o.maskedValues).toEqual(['4222 3333 4444 5555', 'line two\nline one SECRET-NOTE']);
  expect(o.maskedPixelsSame).toBe(true);
  expect(o.plainPixelsSame).toBe(false);
  expect(o.focusFill).toMatchObject({ filled: ['cvv'] });
  expect(o.focusSeen).toBe('321');
  expect(o.noFocus).toMatchObject({ status: 'error' });
  expect(o.noFocus.error).toMatch(/no field has the focus/);
  expect(o.noMatch.error).toMatch(/no field matches "iban"/);
  expect(o.fieldWrongSite).toBe('error');
  expect(o.fieldMoved).toMatch(/no longer on 127\.0\.0\.1 — nothing was filled/);
  expect(o.fieldMovedValue).toBe('');
}, 60000);
