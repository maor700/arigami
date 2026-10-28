// Launcher — permission mode and the ticket plan panel.
//   perm:      a fresh launcher opens on acceptEdits (or the owner's last pick),
//              never a silent bypass; options are labelled with a one-line
//              description; Bypass carries the danger styling; no raw SDK enum
//              text in the DOM; the pick is remembered; engines only offer theirs
//   provision: the plan panel promises only what the host will do — the rows
//              come from POST /ticket-plan (reserved port), off shows nothing
//              promised; the payload carries the plan's repo + reservation
import { test, expect, beforeAll } from 'bun:test';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isolate } from './_isolate.js';
isolate(); // restore globalThis/process.env after this file (bun test shares them)

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const web = (p) => path.join(ROOT, 'web/src', p);

let React, render, prefs, L, engines, TooltipProvider;

beforeAll(async () => {
  const mem = new Map();
  globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
  globalThis.window = globalThis;
  globalThis.location = { origin: 'http://host.test', port: '', pathname: '/', hash: '' };
  globalThis.document = {
    documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} }, setAttribute() {}, classList: { add() {}, remove() {} }, dir: 'ltr' },
    querySelector: () => null, addEventListener() {}, removeEventListener() {},
  };
  globalThis.navigator = { language: 'en-US', userAgent: 'test' };
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  globalThis.WebSocket = class { close() {} };
  React = (await import(path.join(ROOT, 'web/node_modules/react/index.js'))).default;
  ({ renderToStaticMarkup: render } = await import(path.join(ROOT, 'web/node_modules/react-dom/server.js')));
  prefs = await import(web('lib/prefs.js'));
  engines = await import(web('lib/engines.js'));
  L = await import(web('components/Launcher.jsx'));
  ({ TooltipProvider } = await import(web('components/ui/tooltip.jsx')));
});

const wrap = (el) => render(React.createElement(TooltipProvider, null, el));
const picker = (props) => wrap(React.createElement(L.PermissionPicker, { value: 'acceptEdits', onChange() {}, engine: '', label: 'Permissions', ...props }));
const visibleText = (html) => html.replace(/<[^>]*>/g, ' ');

test('perm: the default is the owner\'s last pick, else bypass', () => {
  expect(L.LAUNCH_PERMISSION_FALLBACK).toBe('bypassPermissions');
  expect(L.initialPermissionMode({})).toBe('bypassPermissions');
  expect(L.initialPermissionMode({ launcherPermissionMode: '' })).toBe('bypassPermissions');
  expect(L.initialPermissionMode({ launcherPermissionMode: 'plan' })).toBe('plan');
  expect(L.initialPermissionMode({ launcherPermissionMode: 'default' })).toBe('default');
  expect(L.initialPermissionMode({ launcherPermissionMode: 'yolo' })).toBe('bypassPermissions');
  // the pick is stored as a pref; an invalid stored value is dropped
  prefs.setPrefs({ launcherPermissionMode: 'plan' });
  expect(L.initialPermissionMode(prefs.getPrefs())).toBe('plan');
  prefs.setPrefs({ launcherPermissionMode: 'nonsense' });
  expect(prefs.getPrefs().launcherPermissionMode).toBe('');
  expect(L.initialPermissionMode(prefs.getPrefs())).toBe('bypassPermissions');
});

test('perm (en): labelled options with one-line descriptions, Bypass marked dangerous, no raw enum text', () => {
  prefs.setPrefs({ language: 'en' });
  const html = picker();
  for (const s of ['Default', 'Ask before edits &amp; commands', 'Accept edits', 'Auto-accept file edits; still ask for commands', 'Plan mode', 'Read &amp; plan only — makes no changes', 'Bypass permissions', 'Run everything without asking'])
    expect(html).toContain(s);
  const text = visibleText(html);
  for (const raw of ['bypassPermissions', 'acceptEdits', 'default —']) expect(text).not.toContain(raw);
  // acceptEdits is the checked radio
  expect(html).toMatch(/checked="" value="acceptEdits"/);
  expect(html).not.toMatch(/checked="" value="bypassPermissions"/);
  // Bypass row: danger flag, destructive text and the red status dot
  const bypassRow = html.slice(html.indexOf('data-perm="bypassPermissions"'));
  expect(bypassRow).toContain('data-danger=""');
  expect(bypassRow).toContain('text-destructive');
  expect(bypassRow).toContain('data-status="err"');
  const acceptRow = html.slice(html.indexOf('data-perm="acceptEdits"'), html.indexOf('data-perm="plan"'));
  expect(acceptRow).not.toContain('data-danger');
});

test('perm (he): the same options in Hebrew', () => {
  prefs.setPrefs({ language: 'he' });
  const html = picker({ label: 'הרשאות' });
  for (const s of ['ברירת מחדל', 'אישור עריכות', 'מצב תכנון', 'עקיפת הרשאות', 'הרצת הכול ללא שאילה']) expect(html).toContain(s);
  expect(visibleText(html)).not.toMatch(/bypassPermissions|acceptEdits/);
  prefs.setPrefs({ language: 'en' });
});

test('perm: an engine only offers its own modes, and an unavailable pick falls back to bypass', () => {
  const codexModes = engines.permissionModesFor('codex');
  expect(L.permissionModeForEngine('acceptEdits', '')).toBe('acceptEdits');
  if (codexModes.length) {
    expect(L.permissionModeForEngine('acceptEdits', 'codex')).toBe('bypassPermissions');
    const html = picker({ engine: 'codex' });
    expect(html).not.toContain('data-perm="acceptEdits"');
    expect(html).toMatch(/checked="" value="bypassPermissions"/);
  } else {
    expect(picker({ engine: 'codex' })).toBe('');
  }
});

test('perm: a fresh launcher (empty form) renders the picker on bypass', () => {
  prefs.setPrefs({ language: 'en', launcherPermissionMode: '' });
  const html = wrap(React.createElement(L.default, { config: { defaultCwd: '/tmp/ws' }, sessions: [], onCreated() {}, initialMode: 'empty' }));
  expect(html).toContain('data-perm="bypassPermissions"');
  expect(html).toMatch(/checked="" value="bypassPermissions"/);
  expect(visibleText(html)).not.toContain('bypassPermissions');
});

const plan = { ticket: 'ENG-7', repos: ['web'], repo: 'web', dir: '/r/web-wt-eng-7', branch: 'feat/eng-7-add-dark-mode', base: 'main', reuse: false, port: 3204, reservation: 'rsv_x' };
const provisionPlan = (props) => wrap(React.createElement(L.ProvisionPlan, { provision: true, plan, skill: '', onRepo() {}, ...props }));

test('provision: the panel shows the host\'s plan — worktree, branch and the reserved port', () => {
  prefs.setPrefs({ language: 'en' });
  const html = provisionPlan();
  expect(html).toContain('web-wt-eng-7');
  expect(html).toContain('feat/eng-7-add-dark-mode');
  expect(html).toContain(':3204');
  expect(html).not.toContain('app-worktrees'); // no hard-coded layout of one particular workspace
  expect(provisionPlan({ plan: { ...plan, reuse: true } })).toContain('existing, reused');
  expect(provisionPlan({ plan: { ...plan, port: null } })).toContain('none free');
  expect(provisionPlan({ plan: { ...plan, repos: ['web', 'api'] } })).toContain('<option value="api">api</option>');
});

test('provision: nothing is promised when the host will not set anything up', () => {
  prefs.setPrefs({ language: 'en' });
  const off = provisionPlan({ provision: false });
  expect(off).toContain('The host sets up nothing');
  expect(off).not.toContain(':3204');
  const bySkill = provisionPlan({ provision: false, skill: 'my-skill' });
  expect(bySkill).toContain('my-skill');
  expect(bySkill).not.toContain('feat/');
  expect(provisionPlan({ plan: null })).toContain('reserving a port');
  expect(provisionPlan({ plan: { ...plan, repo: null, repos: [] } })).toContain('No ready repo');
  prefs.setPrefs({ language: 'he' });
  expect(provisionPlan({ provision: false })).toContain('ה-host לא מכין כלום');
  prefs.setPrefs({ language: 'en' });
});

test('provision: the ticket payload carries the plan\'s repo + reservation only when on', () => {
  const t = { id: 'ENG-7', title: 'Add dark mode' };
  const on = L.buildTicketPayload(t, {}, [], 'acceptEdits', '', {}, { repo: 'web', reservation: 'rsv_x' });
  expect(on.provision).toEqual({ repo: 'web', reservation: 'rsv_x' });
  expect(on.permissionMode).toBe('acceptEdits');
  expect(on.metadata).toEqual({ ticket: 'ENG-7' });
  expect(L.buildTicketPayload(t, {}, [], 'acceptEdits', '', {}, null).provision).toBeUndefined();
  expect(L.buildTicketPayload(t, {}, [], 'acceptEdits', '', {}, { repo: '', reservation: undefined }).provision).toEqual({});
});

test('provision: the workspace report stays visible in Simple chat; other system lines fold', async () => {
  const { hiddenInSimple } = await import(web('lib/chatMode.js'));
  expect(hiddenInSimple({ kind: 'system', text: '⤷ Workspace ready — …', provision: { ok: true } })).toBe(false);
  expect(hiddenInSimple({ kind: 'system', text: '⤷ context compacted' })).toBe(true);
});
