// SSO1 — "Continue with Google" (or Microsoft, Apple, Okta…) done by the agent, in the ONE browser where the owner is
// signed in to their identity provider: "My browser" (chrome-base, login-vault.ts). A session's own Chrome starts with
// no logins, and Google refuses to sign in inside an automated fresh profile — so an SSO sign-in only works there.
//
// It is the owner's real profile, holding every login they have, so the agent gets a narrow window into it:
//   - only after the owner approved this site on a card (api.ts, `sso-request`), for SSO_TTL_MS;
//   - only in a tab the host opened for it — never one of the owner's own tabs;
//   - only while that tab is on the approved site or an identity provider (SSO_PROVIDERS): anywhere else the tools
//     answer with the host name and nothing more (no screenshot, no text), and navigate refuses;
//   - clicks and screenshots only: there is no typing tool. A password / 2FA prompt is the owner's (needsHuman).
// When the sign-in lands, the host closes the tab and carries that one site into the session's browser
// (login-vault.ts transfer), the same way request_login does.
import { listTabs, cdpCall, type ChromeTab } from './chrome-cdp.js';
import { hostOf, registrable } from './login-sites.js';

export const SSO_TTL_MS = 15 * 60_000;

/** The site a url belongs to: its registrable domain — or the host itself for an IP address / localhost. */
export function siteOf(host: string): string {
  return /^(\d+\.\d+\.\d+\.\d+|localhost|\[[0-9a-f:]+\])$/i.test(host) ? host.toLowerCase() : registrable(host);
}

/** Identity providers an SSO hop may pass through. Host patterns; GitHub only on its sign-in/OAuth paths. */
export const SSO_PROVIDERS: { label: string; host: RegExp; path?: RegExp }[] = [
  { label: 'Google', host: /^(accounts\.google\.com|accounts\.youtube\.com|accounts\.google\.[a-z.]+)$/ },
  { label: 'Microsoft', host: /^(login\.microsoftonline\.com|login\.live\.com|login\.microsoft\.com|account\.live\.com)$/ },
  { label: 'Apple', host: /^(appleid\.apple\.com|idmsa\.apple\.com)$/ },
  { label: 'Okta', host: /(^|\.)(okta|oktapreview|okta-emea)\.com$/ },
  { label: 'OneLogin', host: /(^|\.)onelogin\.com$/ },
  { label: 'Auth0', host: /(^|\.)auth0\.com$/ },
  { label: 'GitHub', host: /^github\.com$/, path: /^\/(login|session|sessions)(\/|$)|^\/login\/oauth\// },
];

export function providerOf(url: string): string | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  const p = SSO_PROVIDERS.find((x) => x.host.test(u.hostname) && (!x.path || x.path.test(u.pathname)));
  return p ? p.label : null;
}

interface Grant {
  sessionId: string;
  site: string; // registrable domain
  port: number;
  tabId: string;
  until: number;
}
const grants = new Map<string, Grant>(); // by session

/** Is this url inside the window: the approved site (any subdomain, https) or an identity provider? */
export function allowed(site: string, url: string): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && /^(127\.0\.0\.1|localhost)$/.test(u.hostname))) return false;
  return siteOf(u.hostname) === site || !!providerOf(url);
}

export class SsoError extends Error {
  constructor(message: string, public status = 409) { super(message); }
}

export function grantFor(sessionId: string): Grant | null {
  const g = grants.get(sessionId);
  if (!g) return null;
  if (Date.now() > g.until) {
    grants.delete(sessionId);
    return null;
  }
  return g;
}

/** After the owner approved: open the site in a new tab of My browser (already running, see api.ts) and open the window. */
export async function start(sessionId: string, url: string, port: number): Promise<{ site: string; tabId: string }> {
  const site = siteOf(hostOf(url));
  if (!site) throw new SsoError('no site', 400);
  if (!allowed(site, url)) throw new SsoError(`not an https page of ${site}`, 400);
  // never a window onto the identity provider itself (Google = the owner's mail, drive…) or a site the card refuses
  if (providerOf(url) || /^(google\.[a-z.]+|youtube\.com|gmail\.com|github\.com|microsoft\.com|live\.com|apple\.com|okta\.com)$/.test(site))
    throw new SsoError(`${site} is an identity provider — no SSO window onto it`, 400);
  const prev = grants.get(sessionId);
  if (prev) await closeTab(prev).catch(() => {});
  const v = (await (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(3000) })).json()) as any;
  const r = await cdpCall(v.webSocketDebuggerUrl, 'Target.createTarget', { url });
  grants.set(sessionId, { sessionId, site, port, tabId: String(r.targetId), until: Date.now() + SSO_TTL_MS });
  return { site, tabId: String(r.targetId) };
}

async function tabOf(g: Grant): Promise<ChromeTab> {
  const tabs = await listTabs('', g.port);
  const t = tabs.find((x) => x.id === g.tabId && x.webSocketDebuggerUrl);
  if (!t) {
    grants.delete(g.sessionId);
    throw new SsoError('the sign-in tab in My browser was closed', 410);
  }
  return t;
}

async function inWindow(sessionId: string): Promise<{ g: Grant; tab: ChromeTab }> {
  const g = grantFor(sessionId);
  if (!g) throw new SsoError('no SSO sign-in is open for this session — call sso_login first', 404);
  const tab = await tabOf(g);
  if (!allowed(g.site, tab.url)) {
    // the page left the window: say where, nothing else — the owner's other sites are not the agent's to see
    throw new SsoError(`the sign-in tab is now on ${hostOf(tab.url)}, outside ${g.site} and the sign-in providers — nothing shown`, 403);
  }
  g.until = Math.max(g.until, Date.now() + 2 * 60_000);
  return { g, tab };
}

const LOOK_JS = `(() => {
  const vis = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
  const secret = [...document.querySelectorAll('input')].some((el) => vis(el) && (el.type === 'password' || (el.autocomplete || '').includes('one-time-code')));
  return { text: document.body ? document.body.innerText.slice(0, 4000) : '', secret };
})()`;

/** What the agent sees: the tab's url, its text, and a screenshot — only inside the window. */
export async function look(sessionId: string): Promise<{ url: string; provider: string | null; text: string; needsHuman: boolean; image: string }> {
  const { tab } = await inWindow(sessionId);
  const ws = tab.webSocketDebuggerUrl!;
  await cdpCall(ws, 'Page.bringToFront', {}).catch(() => {});
  const r = (await cdpCall(ws, 'Runtime.evaluate', { expression: LOOK_JS, returnByValue: true }, 4000))?.result?.value || {};
  const shot = await cdpCall(ws, 'Page.captureScreenshot', { format: 'jpeg', quality: 60 }, 8000);
  return { url: tab.url, provider: providerOf(tab.url), text: String(r.text || ''), needsHuman: !!r.secret, image: String(shot?.data || '') };
}

function findJs(text: string): string {
  return `(() => {
    const needle = ${JSON.stringify(String(text))}.toLowerCase();
    const nodes = document.querySelectorAll('a,button,[role="button"],[role="link"],input[type=submit],input[type=button],li,[data-email],[data-identifier],div[tabindex]');
    let best = null, bestLen = Infinity;
    for (const el of nodes) {
      const t = (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().toLowerCase();
      if (t && t.includes(needle) && t.length < bestLen) { const r = el.getBoundingClientRect(); if (r.width > 0 && r.height > 0) { best = el; bestLen = t.length; } }
    }
    if (!best) return null;
    best.scrollIntoView({block: 'center', inline: 'center'});
    const r = best.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`;
}

/** Click by visible text or viewport coordinates — inside the window only. */
export async function click(sessionId: string, opts: { text?: string; x?: number; y?: number }): Promise<{ x: number; y: number }> {
  const { tab } = await inWindow(sessionId);
  const ws = tab.webSocketDebuggerUrl!;
  let { x, y } = opts;
  if ((x === undefined || y === undefined) && opts.text) {
    const f = (await cdpCall(ws, 'Runtime.evaluate', { expression: findJs(opts.text), returnByValue: true }, 4000))?.result?.value;
    if (!f) throw new SsoError(`nothing clickable matching "${opts.text}"`, 404);
    ({ x, y } = f);
  }
  if (x === undefined || y === undefined) throw new SsoError('pass {text} or {x,y}', 400);
  await cdpCall(ws, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await cdpCall(ws, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await cdpCall(ws, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  return { x: x!, y: y! };
}

/** Navigate the sign-in tab — only to the approved site or a provider. */
export async function navigate(sessionId: string, url: string): Promise<void> {
  const { g, tab } = await inWindow(sessionId);
  if (!allowed(g.site, url)) throw new SsoError(`${hostOf(url)} is outside ${g.site} and the sign-in providers`, 403);
  await cdpCall(tab.webSocketDebuggerUrl!, 'Page.navigate', { url });
}

async function closeTab(g: Grant): Promise<void> {
  await fetch(`http://127.0.0.1:${g.port}/json/close/${g.tabId}`, { signal: AbortSignal.timeout(2000) }).catch(() => {});
}

/** End the window: close the tab (My browser keeps the login it now has) and return the site. */
export async function finish(sessionId: string): Promise<string | null> {
  const g = grants.get(sessionId);
  if (!g) return null;
  grants.delete(sessionId);
  await closeTab(g);
  return g.site;
}

export function forgetSession(sessionId: string): void {
  grants.delete(sessionId);
}

/** Test hook. */
export function _setGrant(g: Grant): void {
  grants.set(g.sessionId, g);
}
