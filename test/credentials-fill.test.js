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
}, 60000);
