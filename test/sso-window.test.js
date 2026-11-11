// SSO1: the agent's window into "My browser" (server/lib/sso.ts) against a real Chrome: a tab of its own, the
// approved site and the sign-in providers only, nothing shown once the tab wanders off, and the tab closed at the end
// while the owner's own tabs stay. Plus the pure rules. Skipped where no Chrome is installed.
import { test, expect } from 'bun:test';
import { runInChild } from './_child.js';
import { tmpDir } from './_tmp.js';
import { findChromeBin } from '../server/lib/platform.ts';
import * as sso from '../server/lib/sso.ts';

test('the window: the approved site and the sign-in providers, nothing else', () => {
  expect(sso.allowed('acme.com', 'https://app.acme.com/login')).toBe(true);
  expect(sso.allowed('acme.com', 'https://accounts.google.com/o/oauth2/v2/auth?x=1')).toBe(true);
  expect(sso.allowed('acme.com', 'https://login.microsoftonline.com/common/oauth2')).toBe(true);
  expect(sso.allowed('acme.com', 'https://github.com/login/oauth/authorize')).toBe(true);
  expect(sso.allowed('acme.com', 'https://github.com/settings/tokens')).toBe(false);
  expect(sso.allowed('acme.com', 'https://mail.google.com/mail/u/0')).toBe(false);
  expect(sso.allowed('acme.com', 'https://acme.com.evil.io/')).toBe(false);
  expect(sso.allowed('acme.com', 'http://acme.com/')).toBe(false);
  expect(sso.providerOf('https://accounts.google.com/signin')).toBe('Google');
  expect(sso.providerOf('https://drive.google.com/')).toBeNull();
});

test.skipIf(!findChromeBin())('in a real Chrome: own tab, no view outside the window, the owner\'s tabs untouched', () => {
  const r = runInChild("await import('./test/_sso-chrome.ts');", { ARIGAMI_DIR: tmpDir('arigami-sso-'), ARIGAMI_PORT: '' });
  if (!r.ok) throw new Error(r.error);
  const o = r.out[0];
  expect(o.noGrant).toMatch(/^404 no SSO sign-in is open/);
  expect(o.provider).toMatch(/^400 .*identity provider/);
  expect(o.ownTab).toBe(true);
  expect(o.look).toEqual({ text: true, needsHuman: true, image: true });
  expect(o.navOut).toMatch(/^403 localhost is outside/);
  expect(o.otherSession).toMatch(/^404/);
  expect(o.after).toBe(true);
  expect(o.outside).toMatch(/^403 the sign-in tab is now on localhost/);
  expect(o.outside).not.toContain('PRIVATE');
  expect(o.outsideClick).toMatch(/^403/);
  expect(o.finished).toBe('127.0.0.1');
  expect(o.tabClosed).toBe(true);
  expect(o.ownerTabKept).toBe(true);
  expect(o.afterFinish).toMatch(/^404/);
}, 60000);
