// The cockpit side of the gemini engine: a third visible toggle, families with their own effort ladders, ask-vs-bypass, and no claude-only UI.
import { test, expect, beforeAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolate } from './_isolate.js';
isolate();

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const web = (p) => path.join(ROOT, 'web/src', p);
const src = (p) => fs.readFileSync(web(p), 'utf8');

let React, render, engines, providers, prefs, models, Launcher, Usage, AgentCard, Rail;
const h = (...a) => React.createElement(...a);
const values = (opts) => opts.map((o) => o.value);
const CLAUDE_MODELS = [{ value: 'default', label: 'Default' }, { value: 'opus', label: 'Opus' }];
const FAMILIES = ['gemini-4-neon', 'gemini-4-argon', 'gemini-4-hydrogen', 'gemini-3.8-flash'];

beforeAll(async () => {
  const mem = new Map();
  globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
  globalThis.window = globalThis;
  globalThis.location = { origin: 'http://host.test', port: '', pathname: '/', hash: '' };
  globalThis.document = {
    documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} }, setAttribute() {}, classList: { add() {}, remove() {} }, dir: 'ltr' },
    body: {}, querySelector: () => null, addEventListener() {}, removeEventListener() {},
  };
  globalThis.navigator = { language: 'en-US', userAgent: 'test' };
  globalThis.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
  globalThis.WebSocket = class { close() {} };
  globalThis.fetch = async (url) => ({ ok: true, status: 200, url: String(url), json: async () => (String(url).includes('/skills') ? { skills: [] } : { models: [] }), text: async () => '' });
  React = (await import(path.join(ROOT, 'web/node_modules/react/index.js'))).default;
  ({ renderToStaticMarkup: render } = await import(path.join(ROOT, 'web/node_modules/react-dom/server.js')));
  prefs = await import(web('lib/prefs.js'));
  engines = await import(web('lib/engines.js'));
  providers = await import(web('lib/providers.js'));
  models = await import(web('lib/models.js'));
  Launcher = await import(web('components/Launcher.jsx'));
  Usage = await import(web('components/Usage.jsx'));
  ({ default: AgentCard } = await import(web('components/AgentCard.jsx')));
  ({ default: Rail } = await import(web('components/Rail.jsx')));
  prefs.setPrefs({ language: 'en' });
});

test('gemini is a third engine with its own name, and unknown still means claude', () => {
  expect(engines.ENGINE_IDS).toEqual(['claude', 'codex', 'gemini']);
  expect(engines.normalizeEngine('gemini')).toBe('gemini');
  expect(engines.normalizeEngine('nope')).toBe('claude');
  expect(engines.engineLabel('gemini')).toBe('Gemini');
  expect(engines.engineTermName('gemini')).toBe('gemini');
  expect(values(engines.engineOptions())).toEqual(['claude', 'codex', 'gemini']);
});

test('the toggle shows Gemini next to Claude and Codex and marks it when picked', () => {
  const html = render(h(Launcher.EngineToggle, { options: { engine: 'gemini' }, onChange() {} }));
  expect((html.match(/role="radio"/g) || []).length).toBe(3);
  expect(html).toMatch(/aria-checked="true"[^>]*>Gemini</);
  expect(html).toMatch(/aria-checked="false"[^>]*>Claude</);
});

test('the model list is the four Gemini families — no claude alias, no codex model, no Claude/GPT-through-Google', () => {
  engines.setGeminiCatalog(null);
  const opts = engines.modelOptionsFor('gemini', CLAUDE_MODELS);
  expect(values(opts)).toEqual(['default', ...FAMILIES]);
  expect(opts[0].desc).toBe('Gemini 4 Neon'); // what "default" resolves to
  expect(opts[1].label).toBe('Gemini 4 Neon');
  expect(values(opts)).not.toContain('opus');
  expect(values(engines.modelOptionsFor('claude', CLAUDE_MODELS))).toEqual(['default', 'opus']);
});

test('the effort ladder belongs to the family: Neon and Hydrogen reach xhigh, Argon and Flash stop at high', () => {
  expect(values(engines.effortOptionsFor('gemini', 'gemini-4-neon'))).toEqual(['default', 'low', 'medium', 'high', 'xhigh']);
  expect(values(engines.effortOptionsFor('gemini', 'gemini-4-hydrogen'))).toEqual(['default', 'low', 'medium', 'high', 'xhigh']);
  expect(values(engines.effortOptionsFor('gemini', 'gemini-4-argon'))).toEqual(['default', 'low', 'medium', 'high']);
  expect(values(engines.effortOptionsFor('gemini', 'gemini-3.8-flash'))).toEqual(['default', 'low', 'medium', 'high']);
  // no model pinned = the default family (Neon), whose ladder is known
  expect(values(engines.effortOptionsFor('gemini', ''))).toEqual(['default', 'low', 'medium', 'high', 'xhigh']);
  expect(engines.GEMINI_DEFAULT_MODEL).toBe('gemini-4-neon');
  expect(engines.GEMINI_DEFAULT_EFFORT).toBe('high');
  // claude's `max` is not a Gemini rung
  expect(values(engines.effortOptionsFor('gemini', 'gemini-4-neon'))).not.toContain('max');
  expect(engines.effortLabelFor('gemini', 'gemini-4-neon', 'xhigh')).not.toBe('xhigh');
});

test('switching engines drops what the new engine does not offer', () => {
  const fromClaude = engines.coerceSessionOptions({ engine: 'gemini', skill: 'dispatch', model: 'opus', effort: 'max' }, CLAUDE_MODELS);
  expect(fromClaude).toEqual({ engine: 'gemini', skill: 'dispatch', model: '', effort: '' });
  expect(engines.coerceSessionOptions({ engine: 'gemini', model: 'gemini-4-argon', effort: 'xhigh' }, CLAUDE_MODELS)).toEqual({ engine: 'gemini', model: 'gemini-4-argon', effort: '' });
  expect(engines.coerceSessionOptions({ engine: 'gemini', model: 'gemini-4-neon', effort: 'xhigh' }, CLAUDE_MODELS).effort).toBe('xhigh');
  expect(engines.coerceSessionOptions({ engine: 'codex', model: 'gemini-4-neon', effort: 'high' }, CLAUDE_MODELS).model).toBe('');
  expect(engines.coerceSessionOptions({ engine: 'claude', model: 'gemini-4-neon' }, CLAUDE_MODELS).model).toBe('');
});

test('the live families from GET /models replace the fallback, ladders included', () => {
  const live = engines.setGeminiCatalog([
    { id: 'gemini-5-xenon', name: 'Gemini 5 Xenon', efforts: ['low', 'high', 'max'], defaultEffort: 'high' },
    { id: 'broken' },
  ]);
  try {
    expect(live.length).toBe(1);
    expect(values(engines.modelOptionsFor('gemini', CLAUDE_MODELS))).toEqual(['default', 'gemini-5-xenon']);
    expect(values(engines.effortOptionsFor('gemini', 'gemini-5-xenon'))).toEqual(['default', 'low', 'high', 'max']);
    expect(engines.coerceSessionOptions({ engine: 'gemini', model: 'gemini-4-neon' }, CLAUDE_MODELS).model).toBe('');
  } finally {
    engines.setGeminiCatalog(null);
  }
  expect(engines.setGeminiCatalog([])).toBeNull();
  expect(values(engines.modelOptionsFor('gemini', CLAUDE_MODELS))).toEqual(['default', ...FAMILIES]);
  // lib/models.js is what hands the server rows over
  expect(src('lib/models.js')).toMatch(/setGeminiCatalog\(gemini\)/);
  expect(models.modelsSnapshot()).toHaveProperty('gemini');
  expect(models.modelsSnapshot()).toHaveProperty('geminiVersion');
  // the driver's rows carry extra fields (desc, contextWindow) — same adoption
  expect(engines.setGeminiCatalog([{ id: 'gemini-4-neon', name: 'Gemini 4 Neon', desc: '', efforts: ['low', 'high'], defaultEffort: 'high', contextWindow: 1048576 }])[0]).toMatchObject({ value: 'gemini-4-neon', efforts: ['low', 'high'] });
  engines.setGeminiCatalog(null);
});

test('a running model id with the effort baked in resolves to its family', () => {
  expect(engines.catalogModel('gemini-4-neon-high').label).toBe('Gemini 4 Neon');
  expect(engines.catalogModel('gemini-3.8-flash-low', 'gemini').value).toBe('gemini-3.8-flash');
  expect(engines.catalogModel('gpt-5.5').value).toBe('gpt-5.5');
  expect(engines.catalogModel('gpt-5.5-high')).toBeNull(); // only agy bakes the effort in
  expect(engines.catalogModel('claude-opus-5-5-high')).toBeNull();
});

test('permission modes: all four, with ask and bypass worded for what agy does; compaction on; none of the claude-only chrome', () => {
  expect(engines.permissionModesFor('gemini')).toEqual(['default', 'acceptEdits', 'plan', 'bypassPermissions']);
  expect(engines.hasPermissionModes('gemini')).toBe(true);
  expect(engines.permDescKey('gemini', 'default')).toBe('rail.permEngineAskDesc');
  expect(engines.permDescKey('gemini', 'bypassPermissions')).toBe('rail.permEngineBypassDesc');
  expect(engines.permDescKey('gemini', 'plan')).toBeNull();
  expect(engines.permDescKey('codex', 'default')).toBe('rail.permCodexAskDesc');
  expect(engines.permDescKey('claude', 'default')).toBeNull();
  expect(engines.permAppliesNextTurn('gemini')).toBe(true);
  expect(engines.permAppliesNextTurn('claude')).toBe(false);
  expect(engines.supportsCompaction('gemini')).toBe(true); // "compact now" and the auto-compact threshold, both through agy's /compact
  expect(engines.isClaudeEngine('gemini')).toBe(false);
  expect(engines.isClaudeEngine(undefined)).toBe(true);
  const html = render(h(Launcher.PermissionPicker, { value: 'plan', onChange() {}, engine: 'gemini', label: 'Permissions' }));
  expect((html.match(/data-perm=/g) || []).length).toBe(4);
  expect(html).toContain('Gemini asks before commands and tools');
  expect(html).toContain('file edits in the workspace are not asked about');
  expect(html).toContain('Gemini never asks');
  expect(html).not.toContain('Codex');
  expect(Launcher.permissionModeForEngine('plan', 'gemini')).toBe('plan');
  expect(Launcher.permissionModeForEngine('default', 'gemini')).toBe('default');
  // the CLI-update badge + "refresh model list" are gated on the claude engine
  expect(src('components/ComposerPill.jsx')).toMatch(/extra=\{isClaudeEngine\(session\.engine\) && \(/);
});

test('the launcher picker lists Gemini families when the engine is gemini', () => {
  const html = render(h(Launcher.SessionOptionsPicker, { options: { engine: 'gemini', skill: '', model: '', effort: '' }, onChange() {} }));
  expect(html).toContain('Gemini 4 Neon');
  expect(html).toContain('Gemini 3.8 Flash');
  expect(html).not.toContain('GPT-5.6-Terra');
});

test('a saved launcher preset keeps engine gemini', () => {
  const id = prefs.saveSessionPreset('g', { engine: 'gemini', model: 'gemini-4-argon', effort: 'low' });
  expect(prefs.getPrefs().sessionPresets.find((x) => x.id === id)).toMatchObject({ engine: 'gemini', model: 'gemini-4-argon', effort: 'low' });
  const junk = prefs.saveSessionPreset('j', { engine: 'junk' });
  expect(prefs.getPrefs().sessionPresets.find((x) => x.id === junk).engine).toBe('');
});

test('providers: gemini accounts feed the gemini engine; the local type is the only one, signed in through the browser', () => {
  expect(providers.PROVIDER_IDS).toEqual(['claude', 'codex', 'gemini']);
  expect(providers.providerForEngine('gemini')).toBe('gemini');
  expect(providers.providerOf({ provider: 'gemini' })).toBe('gemini');
  expect(providers.providerLabel('gemini')).toBe('Gemini');
  expect(providers.PROVIDERS.gemini.localType).toBe('gemini-home');
  expect(providers.PROVIDERS.gemini.methods).toEqual([{ id: 'browser', type: 'gemini-home' }]);
  expect(providers.TYPE_LABEL_KEYS['gemini-home']).toBe('launcher.account.typeGeminiHome');
  // the snapshot from the accounts list: one 5-hour window, no week
  const u = providers.snapshotUsage({ provider: 'gemini', lastUsage: { session: 3, week: null, sessionMins: 300, at: 1 } });
  expect(u).toEqual({ available: true, session: { pct: 3, windowMins: 300 }, week: null });
});

test('the rail meter shows the Gemini 5-hour bucket: used %, reset time, and whose quota it is', () => {
  const usage = { available: true, session: { pct: 3, resetsAt: new Date(Date.now() + 2 * 3600_000).toISOString(), windowMins: 300 }, week: null };
  const html = render(h(Usage.UsageMini, { usage, provider: 'gemini' }));
  expect(html).toContain('data-usage-provider="gemini"');
  expect(html).toContain('Gemini');
  expect(html).toContain('5-hour window');
  expect(html).toContain('3%');
  expect(html).toMatch(/resets|in /i);
  // the account card's bar reads the same window as "left"
  const bar = render(h(Usage.UsageBar, { label: 'x', win: usage.session, sub: true }));
  expect(bar).toContain('97%');
  // a claude meter is not relabelled
  expect(render(h(Usage.UsageMini, { usage: { available: true, session: { pct: 10 }, week: { pct: 20 } }, provider: 'claude' }))).not.toContain('· Claude');
});

test('badges and settings rows name Gemini', () => {
  const created = render(h(AgentCard, { sessionId: 'sess_x', event: { kind: 'agent-card', cardId: 'agc_1', action: 'create', state: 'created', agent: { slug: 'gem', name: 'Gem', emoji: '💎', engine: 'gemini', model: 'gemini-4-neon', skills: [] } } }));
  expect(created).toContain('data-agent-engine="gemini"');
  expect(created).toContain('Gemini');
  const plain = render(h(AgentCard, { sessionId: 'sess_x', event: { kind: 'agent-card', cardId: 'agc_2', action: 'create', state: 'created', agent: { slug: 'p', name: 'P', emoji: '🙂', skills: [] } } }));
  expect(plain).not.toContain('data-agent-engine');
  const host = src('components/settings/Host.jsx');
  expect(host).toMatch(/api\.get\('\/host\/gemini'\)/);
  expect(host).toMatch(/data-gemini-cli/);
  expect(host).toMatch(/ENGINE_IDS\.map\(\(id\) => \(\{ value: id, label: engineLabel\(id\) \}\)\)/); // the default-engine row offers every engine
  const accounts = src('components/settings/Accounts.jsx');
  expect(accounts).toMatch(/launcher\.account\.localOnlyBody/);
  for (const lang of ['en', 'he']) {
    for (const [file, keys] of [['launcher.js', ['launcher.options.engineGeminiDesc', 'launcher.account.typeGeminiHome', 'launcher.account.localOnlyBody']], ['rail.js', ['rail.permEngineAskDesc', 'rail.permEngineBypassDesc']], ['host.js', ['host.geminiCli', 'host.geminiCli.hint', 'host.geminiCli.missing', 'host.geminiCli.signedIn', 'host.geminiCli.signedOut']]]) {
      const text = src(`locales/${lang}/${file}`);
      for (const k of keys) expect(text).toContain(`'${k}'`);
    }
  }
});

test('a rail row names its engine only when it is not the host default', () => {
  const noop = () => {};
  const sessions = [
    { id: 'sess_g', title: 'gemini job', status: 'In Progress', color: '#2C6BD6', engine: 'gemini', metadata: {}, claude: { state: 'idle' }, createdAt: '2026-11-22T10:00:00Z' },
    { id: 'sess_c', title: 'claude job', status: 'In Progress', color: '#2C6BD6', metadata: {}, claude: { state: 'idle' }, createdAt: '2026-11-22T10:00:00Z' },
  ];
  const mount = () => render(h(Rail, { sessions, selectedId: null, onSelect: noop, onNew: noop, onOpenSettings: noop, onOpenSkills: noop, onOpenBrain: noop, onOpenSetup: noop, onArchive: noop, onRestore: noop, onRestart: noop, onDelete: noop, onEdit: noop, config: { defaultCwd: '/tmp/ws' }, conn: 'open', onOpenAgent: noop }));
  const html = mount();
  expect(html).toMatch(/data-row-engine="gemini"[^>]*>Gemini</);
  expect(html).not.toContain('data-row-engine="claude"');
  expect(engines.engineBadge('codex')).toBe('Codex');
  expect(engines.engineBadge(undefined)).toBeNull();
  // on a gemini-default host it is the claude row that says so
  engines.setDefaultEngine('gemini');
  try {
    const flipped = mount();
    expect(flipped).toMatch(/data-row-engine="claude"[^>]*>Claude</);
    expect(flipped).not.toContain('data-row-engine="gemini"');
  } finally {
    engines.setDefaultEngine('claude');
  }
});
