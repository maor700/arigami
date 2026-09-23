// BROWSE1: the browser_* host tools — drive a session's own Chrome over the
// EXISTING CDP/xdotool plumbing (chrome.ts launch+profile, chrome-cdp.ts
// DevTools, screenshots.ts capture). No new runtime dependency, no
// playwright — that MCP was removed on purpose (per-session cost); this is
// the replacement for any restricted agent (desktop + web, no Bash) that
// needs to actually navigate the session desktop's browser.
//
// Human-in-the-loop (machine-work skill rule): never type into a field that
// looks like a password/OTP/2FA input, and never type on a page showing a
// CAPTCHA widget — browser_type refuses and returns a hint to call
// request_screen instead. This is enforced here (server-side), not just
// documented, so a restricted agent cannot "forget" the rule.
//
// F8 / Google sign-in rule (see chrome.ts and the session-chrome-cdp-google-
// block / facebook-browser-driving memory notes): openChrome() always starts
// with `--remote-debugging-port=0` — Chrome picks its OWN loopback-only port
// and writes it to <profile>/DevToolsActivePort, so there is never a fixed,
// predictable CDP port to expose, and no relaunch is needed to get one: the
// SAME running Chrome (the one the human may be signing in to Google on) is
// what these tools talk to over chrome-cdp.ts.
import { openChrome, closeChrome as closeChromeProcess, isChromeRunning, touch } from './chrome.js';
import { frontPage, pageNavigate, pageEvaluate, pageClick, pageScroll, pageScreenshot, typeIntoDesktop, type ChromeTab } from './chrome-cdp.js';
import * as screens from '../screenshots.js';

export interface HumanGate {
  needsHuman: boolean;
  reason?: 'credentials' | 'captcha';
  hint?: string;
}

// Read the focused element + page for the tell-tale signs of a step only the
// human may complete. Best-effort: any CDP failure just means "no gate".
const HUMAN_GATE_JS = `(() => {
  const el = document.activeElement;
  let credentialField = false;
  if (el) {
    const type = (el.type || '').toLowerCase();
    const ac = (el.autocomplete || '').toLowerCase();
    const name = ((el.name || '') + ' ' + (el.id || '')).toLowerCase();
    credentialField = type === 'password' || ac.indexOf('password') !== -1 || ac === 'one-time-code' || /otp|one.?time|verification.?code|2fa|mfa/.test(name);
  }
  const captcha = !!document.querySelector('iframe[src*="recaptcha" i],iframe[src*="hcaptcha" i],[class*="captcha" i],[id*="captcha" i]');
  return { credentialField, captcha };
})()`;

export async function humanGate(sessionId: string): Promise<HumanGate> {
  try {
    const r = (await pageEvaluate(sessionId, HUMAN_GATE_JS)) as { credentialField?: boolean; captcha?: boolean } | undefined;
    if (r?.credentialField)
      return { needsHuman: true, reason: 'credentials', hint: 'This looks like a password/OTP field — never type credentials or codes here. Call request_screen and let the human do it.' };
    if (r?.captcha)
      return { needsHuman: true, reason: 'captcha', hint: 'This page shows a CAPTCHA — call request_screen so the human can solve it.' };
    return { needsHuman: false };
  } catch {
    return { needsHuman: false };
  }
}

function findClickableJs(text: string): string {
  return `(() => {
    const needle = ${JSON.stringify(String(text))}.toLowerCase();
    const nodes = document.querySelectorAll('a,button,[role="button"],input,label,summary,[onclick],select,textarea');
    let best = null, bestLen = Infinity;
    for (const el of nodes) {
      const t = (el.innerText || el.value || el.getAttribute('aria-label') || el.placeholder || '').trim().toLowerCase();
      if (t && t.includes(needle) && t.length < bestLen) { best = el; bestLen = t.length; }
    }
    if (!best) return null;
    best.scrollIntoView({block: 'center', inline: 'center'});
    const r = best.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`;
}

async function shot(sessionId: string, caption: string): Promise<{ url: string; ts: number } | null> {
  try {
    const r = await screens.takeScreenshot(sessionId, { caption });
    if (r.status === 'recorded') return { url: r.event.url, ts: r.event.ts };
    if (r.status === 'duplicate') return { url: r.url, ts: r.ts };
    return null; // throttled
  } catch {
    return null;
  }
}

/**
 * Every browser step goes through here: it marks the browser as in use (the
 * idle closer in chrome.ts counts from the last step) and, when the idle closer
 * already stopped it, reopens it with the same profile and its restored tabs —
 * so an agent never sees "no open page" just because it paused.
 */
async function ready(sessionId: string): Promise<void> {
  touch(sessionId);
  if (isChromeRunning(sessionId)) return;
  await openChrome(sessionId);
  for (let i = 0; i < 40 && !(await frontPage(sessionId).catch(() => null)); i++) await new Promise((r) => setTimeout(r, 250));
}

async function currentPage(sessionId: string): Promise<{ url: string; title: string }> {
  const page = await frontPage(sessionId);
  return { url: page.url, title: page.title };
}

export interface OpenResult { ok: true; url: string; title: string; screenshot: { url: string; ts: number } | null }

/** Ensure the session has a desktop + Chrome (its own profile, agent-seeded per A2), optionally navigate, screenshot. */
export async function open(sessionId: string, url?: string): Promise<OpenResult> {
  touch(sessionId);
  const wasRunning = isChromeRunning(sessionId);
  await openChrome(sessionId, wasRunning ? undefined : url);
  if (wasRunning && url) await pageNavigate(sessionId, url);
  else {
    // Freshly launched with a url arg — give Chrome a moment to open the tab
    // before we look for it (openChrome doesn't wait for the page to exist).
    for (let i = 0; i < 20 && !(await frontPage(sessionId).catch(() => null)); i++) await new Promise((r) => setTimeout(r, 250));
  }
  const page = await currentPage(sessionId).catch(() => ({ url: url || '', title: '' }));
  return { ok: true, url: page.url, title: page.title, screenshot: await shot(sessionId, 'Page loaded') };
}

export interface NavigateResult { ok: true; url: string; title: string }

export async function navigate(sessionId: string, url: string): Promise<NavigateResult> {
  await ready(sessionId);
  const r = await pageNavigate(sessionId, url);
  return { ok: true, ...r };
}

export interface SnapshotResult extends HumanGate { ok: true; url: string; title: string; text: string; screenshot: { url: string; ts: number } | null }

export async function snapshot(sessionId: string, caption = 'Snapshot'): Promise<SnapshotResult> {
  await ready(sessionId);
  const page = await currentPage(sessionId);
  const text = ((await pageEvaluate(sessionId, 'document.body ? document.body.innerText.slice(0, 8000) : ""').catch(() => '')) as string) || '';
  const gate = await humanGate(sessionId);
  return { ok: true, url: page.url, title: page.title, text, screenshot: await shot(sessionId, caption), ...gate };
}

export interface ClickResult { ok: true; x: number; y: number }

export async function click(sessionId: string, opts: { x?: number; y?: number; text?: string }): Promise<ClickResult> {
  await ready(sessionId);
  let { x, y } = opts;
  if ((x === undefined || y === undefined) && opts.text) {
    const found = (await pageEvaluate(sessionId, findClickableJs(opts.text))) as { x: number; y: number } | null;
    if (!found) throw new Error(`no clickable element matching "${opts.text}" found on the page`);
    ({ x, y } = found);
  }
  if (x === undefined || y === undefined) throw new Error('pass {x,y} or {text}');
  await pageClick(sessionId, x, y);
  return { ok: true, x, y };
}

export interface TypeResult { ok: true; via: 'cdp' | 'xinput' }
export interface TypeBlocked { ok: false; needsHuman: true; reason?: string; hint?: string }

export async function type(sessionId: string, text: string, submit?: boolean): Promise<TypeResult | TypeBlocked> {
  await ready(sessionId);
  const gate = await humanGate(sessionId);
  if (gate.needsHuman) return { ok: false, needsHuman: true, reason: gate.reason, hint: gate.hint };
  const r = await typeIntoDesktop(sessionId, text, submit ? 'Enter' : undefined);
  return { ok: true, via: r.via };
}

export interface ScrollResult { ok: true }

export async function scroll(sessionId: string, opts: { x?: number; y?: number; dx?: number; dy?: number }): Promise<ScrollResult> {
  await ready(sessionId);
  const x = opts.x ?? 640;
  const y = opts.y ?? 400;
  await pageScroll(sessionId, x, y, opts.dx ?? 0, opts.dy ?? 600);
  return { ok: true };
}

export function close(sessionId: string): { ok: true } {
  closeChromeProcess(sessionId);
  return { ok: true };
}

/** PNG bytes of the front tab (CDP `Page.captureScreenshot`) — the `connect.sh shot` / evidence-screenshot path. */
export async function screenshot(sessionId: string): Promise<Buffer> {
  await ready(sessionId);
  return pageScreenshot(sessionId);
}
