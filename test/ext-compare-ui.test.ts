// examples/extensions/compare — the one decision the page makes: which two URLs
// end up in the two panes, and that both go through the HOST PROXY.
//
// The page is dependency-free DOM code, so this runs it against a shim that
// implements exactly the handful of DOM surfaces it touches. That is enough to
// pin the behaviour that matters (?a/?b, settings.baselineUrl, autoPath, the
// empty-state form) without pretending to be a browser.
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

const UI = path.resolve(import.meta.dir, '..', 'examples', 'extensions', 'compare', 'ui');
const APP = fs.readFileSync(path.join(UI, 'app.js'), 'utf8');
const HTML = fs.readFileSync(path.join(UI, 'index.html'), 'utf8');

/** The ids the page declares, so the script and the markup cannot drift apart. */
const idsInHtml = new Set([...HTML.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
const idsUsed = new Set([...APP.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]));

function makeEl(id: string) {
  const listeners: Record<string, ((e: any) => void)[]> = {};
  return {
    id,
    value: '',
    src: '',
    hidden: false,
    textContent: '',
    style: {} as Record<string, string>,
    contentWindow: null as any,
    contentDocument: null as any,
    addEventListener: (t: string, fn: (e: any) => void) => ((listeners[t] ||= []).push(fn)),
    removeEventListener: () => {},
    dispatch: (t: string, e: any = {}) => (listeners[t] || []).forEach((f) => f(e)),
    setPointerCapture: () => {},
    releasePointerCapture: () => {},
    focus: () => {},
    querySelectorAll: () => [],
  };
}

/** Run app.js against the shim and return the elements it drove. */
function run({ query = '', settings = {} as Record<string, unknown>, ready = true } = {}) {
  const els: Record<string, ReturnType<typeof makeEl>> = {};
  for (const id of idsInHtml) els[id] = makeEl(id);
  const document = {
    getElementById: (id: string) => els[id] || null,
    body: { clientWidth: 1000 },
    addEventListener: () => {},
  };
  const arigami = {
    ready: () => (ready ? Promise.resolve({ settings }) : Promise.reject(new Error('standalone'))),
    sendPrompt: () => Promise.resolve({ delivered: 'queued' }),
    setStatus: () => Promise.resolve(),
  };
  const win: any = {
    document,
    arigami,
    location: { search: query },
    URLSearchParams,
    URL,
    open: () => {},
    setTimeout,
    CSS: null,
  };
  // The page is an IIFE over globals; hand it the shim as those globals.
  const fn = new Function('window', 'document', 'arigami', 'location', 'URLSearchParams', 'URL', 'setTimeout', APP);
  fn(win, document, arigami, win.location, URLSearchParams, URL, setTimeout);
  return els;
}

const proxied = (u: string) => '/?__target=' + encodeURIComponent(u);
const settle = () => new Promise((r) => setTimeout(r, 0));

test('the compare page and its script agree on every element id', () => {
  expect([...idsUsed].filter((id) => !idsInHtml.has(id))).toEqual([]);
  // and the two panes really are the ones the markup declares
  expect(idsInHtml.has('fA')).toBe(true);
  expect(idsInHtml.has('fB')).toBe(true);
});

test('?a & ?b: both panes are embedded through the host proxy, a on the right', async () => {
  const els = run({ query: '?a=' + encodeURIComponent('http://127.0.0.1:3020/policies') + '&b=' + encodeURIComponent('https://baseline.example/policies') });
  await settle();
  expect(els.fA.src).toBe(proxied('http://127.0.0.1:3020/policies'));
  expect(els.fB.src).toBe(proxied('https://baseline.example/policies'));
  expect(els.view.hidden).toBe(false);
  expect(els.setup.hidden).toBe(true);
  expect(els.lblA.textContent).toContain('127.0.0.1:3020/policies');
  expect(els.lblB.textContent).toContain('baseline.example/policies');
});

test('?a alone + settings.baselineUrl: autoPath carries the path over to the baseline origin', async () => {
  const els = run({
    query: '?a=' + encodeURIComponent('http://127.0.0.1:3020/policies?tab=2'),
    settings: { baselineUrl: 'https://baseline.example', autoPath: true },
  });
  await settle();
  expect(els.fB.src).toBe(proxied('https://baseline.example/policies?tab=2'));
});

test('autoPath off: the baseline is opened exactly as configured', async () => {
  const els = run({
    query: '?a=' + encodeURIComponent('http://127.0.0.1:3020/policies?tab=2'),
    settings: { baselineUrl: 'https://baseline.example/fixed', autoPath: false },
  });
  await settle();
  expect(els.fB.src).toBe(proxied('https://baseline.example/fixed'));
});

test('no params and no baseline: the setup form, not a broken pane', async () => {
  const els = run({ query: '', settings: {} });
  await settle();
  expect(els.setup.hidden).toBe(false);
  expect(els.view.hidden).toBe(true);
  expect(els.fA.src).toBe('');
  expect(els.fB.src).toBe('');
});

test('?a alone with no baseline configured: the form, pre-filled, and it says why', async () => {
  const a = 'http://127.0.0.1:3020/policies';
  const els = run({ query: '?a=' + encodeURIComponent(a), settings: {} });
  await settle();
  expect(els.setup.hidden).toBe(false);
  expect(els.ua.value).toBe(a);
  expect(els.hint.textContent).toContain('baseline');
});

test('the form starts the comparison, and resolves the baseline the same way', async () => {
  const els = run({ query: '', settings: { baselineUrl: 'https://baseline.example', autoPath: true } });
  await settle();
  els.ua.value = 'http://127.0.0.1:3020/deep/page';
  els.setup.dispatch('submit', { preventDefault() {} });
  expect(els.fA.src).toBe(proxied('http://127.0.0.1:3020/deep/page'));
  expect(els.fB.src).toBe(proxied('https://baseline.example/deep/page'));
});

test('outside the cockpit (ready() rejects) the page still works from the query alone', async () => {
  const els = run({
    query: '?a=' + encodeURIComponent('http://127.0.0.1:3020/x') + '&b=' + encodeURIComponent('https://baseline.example/x'),
    ready: false,
  });
  await settle();
  expect(els.fA.src).toBe(proxied('http://127.0.0.1:3020/x'));
});

test('nothing personal is baked into the example', () => {
  const files = ['app.js', 'index.html', 'style.css', '../manifest.json', '../README.md'];
  for (const f of files) {
    const body = fs.readFileSync(path.join(UI, f), 'utf8');
    // only example.com/example.invalid placeholders, never a real host
    for (const m of body.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)) {
      const host = m[1].toLowerCase();
      expect(
        host === 'baseline.example' ||
          host.endsWith('.example') ||
          host.endsWith('example.com') ||
          host.endsWith('example.invalid') ||
          host === 'localhost' ||
          host === '127.0.0.1'
      ).toBe(true);
    }
  }
});
