// ENGINE-UI (web half): the launcher's fourth select — WHICH ENGINE a new
// session is born on — and the two selects it governs.
//
// The thing these tests exist to stop: quietly showing one shared model list
// and one shared effort ladder for both engines because that is simpler. It
// isn't equivalent. `claude --effort` is a flag with one ladder for every
// model; Codex has no such flag — reasoning depth is the
// `model_reasoning_effort` config key and the ladder belongs to the MODEL
// (gpt-5.6-terra has an `ultra` rung above max, gpt-5.5 stops at xhigh). A
// shared list would offer Codex levels its model rejects and hide the one it
// has, and would let a Claude model alias be POSTed to a Codex session.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolate } from './_isolate.js';
isolate(); // restore globalThis/process.env after this file (bun test shares them)

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const web = (p) => path.join(ROOT, 'web/src', p);

let React, render, engines, prefs, Launcher;
const h = (...a) => React.createElement(...a);

const CLAUDE_MODELS = [
  { value: 'default', label: 'Default' },
  { value: 'claude-opus-5[1m]', label: 'Opus 5' },
];

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
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  globalThis.WebSocket = class { close() {} };
  globalThis.fetch = async (url) => ({
    ok: true, status: 200, url: String(url),
    json: async () => (String(url).includes('/skills') ? { skills: [] } : { models: [] }),
    text: async () => '',
  });
  React = (await import(path.join(ROOT, 'web/node_modules/react/index.js'))).default;
  ({ renderToStaticMarkup: render } = await import(path.join(ROOT, 'web/node_modules/react-dom/server.js')));
  prefs = await import(web('lib/prefs.js'));
  engines = await import(web('lib/engines.js'));
  Launcher = await import(web('components/Launcher.jsx'));
});

const values = (opts) => opts.map((o) => o.value);

/* ---------- the model list is engine-specific ----------------------------- */

test('Codex gets its own static model list — no claude handshake models leak in', () => {
  const codex = engines.modelOptionsFor('codex', CLAUDE_MODELS);
  expect(values(codex)).toEqual(['default', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5']);
  // the fetched claude list must not appear under codex, and vice versa
  expect(values(codex)).not.toContain('claude-opus-5[1m]');
  expect(values(engines.modelOptionsFor('claude', CLAUDE_MODELS))).toEqual(['default', 'claude-opus-5[1m]']);
});

test('an unset / unknown engine means claude — same rule as the server pickEngine()', () => {
  for (const v of [undefined, '', 'nope']) {
    expect(engines.normalizeEngine(v)).toBe('claude');
    expect(values(engines.modelOptionsFor(v, CLAUDE_MODELS))).toEqual(['default', 'claude-opus-5[1m]']);
  }
});

/* ---------- the effort ladder is engine- AND model-specific --------------- */

test("Codex's effort ladder comes from the model, and is not Claude's", () => {
  const claude = values(engines.effortOptionsFor('claude', null));
  expect(claude).toEqual(['default', 'low', 'medium', 'high', 'xhigh', 'max']);

  // terra has a rung above max that Claude has no equivalent for
  expect(values(engines.effortOptionsFor('codex', 'gpt-5.6-terra'))).toEqual([
    'default', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra',
  ]);
  // gpt-5.5 stops two rungs earlier — offering it 'max' would be a level it rejects
  expect(values(engines.effortOptionsFor('codex', 'gpt-5.5'))).toEqual([
    'default', 'low', 'medium', 'high', 'xhigh',
  ]);
  // luna's rungs happen to spell Claude's exactly — which is precisely why the
  // ladder must be looked up per model instead of sampled once and shared: two
  // of the three Codex models disagree with Claude, the third coincides.
  expect(values(engines.effortOptionsFor('codex', 'gpt-5.6-luna'))).toEqual(claude);
  expect(values(engines.effortOptionsFor('codex', 'gpt-5.6-terra'))).not.toEqual(claude);
  expect(values(engines.effortOptionsFor('codex', 'gpt-5.5'))).not.toEqual(claude);
});

test('with no Codex model pinned, only rungs every listed model supports are offered', () => {
  // we can't know which model Codex will pick, so nothing model-specific
  expect(values(engines.effortOptionsFor('codex', ''))).toEqual(['default', 'low', 'medium', 'high', 'xhigh']);
  for (const m of engines.CODEX_MODELS) {
    for (const e of engines.CODEX_COMMON_EFFORTS) expect(m.efforts).toContain(e);
  }
});

test("the ultra rung is labelled in both locales, not left as the raw key", () => {
  prefs.setPrefs({ language: 'en' });
  expect(engines.effortLabelFor('codex', 'gpt-5.6-terra', 'ultra')).toBe('Ultra');
  prefs.setPrefs({ language: 'he' });
  const he = engines.effortOptionsFor('codex', 'gpt-5.6-terra');
  expect(he.find((o) => o.value === 'ultra').label).toBe('אולטרה');
  expect(he.find((o) => o.value === 'default').label).toBe('ברירת מחדל');
  expect(engines.engineOptions().find((o) => o.value === 'codex').desc).toContain('OpenAI');
  prefs.setPrefs({ language: 'en' });
});

/* ---------- switching engine/model must not carry the old pick over ------- */

test('switching Claude→Codex drops a Claude model alias instead of POSTing it to Codex', () => {
  const out = engines.coerceSessionOptions(
    { engine: 'codex', skill: 'dispatch', model: 'claude-opus-5[1m]', effort: 'max' },
    CLAUDE_MODELS,
  );
  expect(out.model).toBe('');
  expect(out.effort).toBe(''); // 'max' isn't offered until a model that has it is picked
  expect(out.skill).toBe('dispatch'); // skill is engine-agnostic — never touched
  expect(out.engine).toBe('codex');
});

test('switching Codex→Claude drops the Codex model, and normalizes claude back to ""', () => {
  const out = engines.coerceSessionOptions(
    { engine: 'claude', skill: '', model: 'gpt-5.6-terra', effort: 'ultra' },
    CLAUDE_MODELS,
  );
  expect(out.model).toBe('');
  expect(out.effort).toBe(''); // claude has no 'ultra'
  expect(out.engine).toBe(''); // '' = claude, so old presets and new ones compare equal
});

test('changing the Codex model drops an effort rung the new model lacks, keeps one it has', () => {
  const dropped = engines.coerceSessionOptions({ engine: 'codex', model: 'gpt-5.5', effort: 'ultra' });
  expect(dropped.effort).toBe('');
  const kept = engines.coerceSessionOptions({ engine: 'codex', model: 'gpt-5.5', effort: 'high' });
  expect(kept.effort).toBe('high');
  expect(kept.model).toBe('gpt-5.5');
});

test('a Claude model is NOT dropped while its list is still loading', () => {
  // the handshake list arrives async; discarding a valid pick because the
  // fetch is pending would silently reset the user's choice
  const pending = engines.coerceSessionOptions({ engine: '', model: 'claude-opus-5[1m]', effort: 'high' }, []);
  expect(pending.model).toBe('claude-opus-5[1m]');
  // once the list is there and the value isn't in it, it goes
  const loaded = engines.coerceSessionOptions({ engine: '', model: 'gone-model' }, CLAUDE_MODELS);
  expect(loaded.model).toBe('');
});

/* ---------- the engine choice is a VISIBLE toggle, not a hidden select ---- */

test('the engine choice is a two-button radio group, not a <select> among the others', () => {
  const html = render(h(Launcher.EngineToggle, { options: { engine: '', skill: '', model: '', effort: '' }, onChange() {} }));
  // a select would bury the alternative one click deep; both engines must be
  // readable without opening anything
  expect(html).not.toContain('<select');
  expect(html).toContain('role="radiogroup"');
  expect((html.match(/role="radio"/g) || []).length).toBe(2);
  expect(html).toContain('Claude');
  expect(html).toContain('Codex');
  // and the current one is marked, not just styled
  expect(html).toMatch(/aria-checked="true"[^>]*>Claude</);
  const codex = render(h(Launcher.EngineToggle, { options: { engine: 'codex' }, onChange() {} }));
  expect(codex).toMatch(/aria-checked="true"[^>]*>Codex</);
});

test('the options picker keeps only skill/model/effort — the engine has left it', () => {
  const html = render(h(Launcher.SessionOptionsPicker, { options: { engine: '', skill: '', model: '', effort: '' }, onChange() {} }));
  expect(html.split('<select').length - 1).toBe(3);
  expect(html).not.toContain('Codex');
});

test('picking Codex swaps the model list and the effort ladder in the rendered picker', () => {
  const claudeHtml = render(h(Launcher.SessionOptionsPicker, { options: { engine: '', skill: '', model: '', effort: '' }, onChange() {} }));
  expect(claudeHtml).not.toContain('gpt-5.6-terra');

  const codexHtml = render(h(Launcher.SessionOptionsPicker, { options: { engine: 'codex', skill: '', model: 'gpt-5.6-terra', effort: '' }, onChange() {} }));
  expect(codexHtml).toContain('GPT-5.6-Terra');
  expect(codexHtml).toContain('Ultra'); // terra's extra rung is really offered
});

test('the toggle sits OUTSIDE the collapsed "Advanced" block in the empty-session form', () => {
  const src = fs.readFileSync(path.join(ROOT, 'web/src/components/Launcher.jsx'), 'utf8');
  const toggle = src.indexOf('<EngineToggle options={options} onChange={setOptions} className="mb-3" />');
  const fold = src.indexOf("<div className={advanced ? '' : 'hidden'}>");
  expect(toggle).toBeGreaterThan(-1);
  expect(fold).toBeGreaterThan(-1);
  // rendered before the fold opens → visible with Advanced collapsed
  expect(toggle).toBeLessThan(fold);
  // ...while skill/model/effort stay inside it
  expect(src.indexOf('<SessionOptionsPicker options={options} onChange={setOptions} />')).toBeGreaterThan(fold);
});

/* ---------- the choice actually reaches the server ------------------------ */

test('the ticket payload carries the engine (and omits it for claude)', () => {
  const ticket = { id: 'ENG-1', title: 'T' };
  const codex = Launcher.buildTicketPayload(ticket, {}, [], 'bypassPermissions', '', { engine: 'codex', skill: 's', model: 'gpt-5.5', effort: 'high' });
  expect(codex.engine).toBe('codex');
  expect(codex.model).toBe('gpt-5.5');
  // claude is the default — '' means "don't send it", so old callers are unchanged
  const claude = Launcher.buildTicketPayload(ticket, {}, [], 'bypassPermissions', '', { engine: '', skill: 's' });
  expect(claude.engine).toBeUndefined();
});

test('a saved launcher preset persists the engine, and a pre-engine preset still means claude', () => {
  prefs.setPrefs({ sessionPresets: [] });
  prefs.saveSessionPreset('codex work', { engine: 'codex', skill: '', model: 'gpt-5.6-luna', effort: 'high' });
  const saved = prefs.getPrefs().sessionPresets.at(-1);
  expect(saved.engine).toBe('codex');
  expect(saved.model).toBe('gpt-5.6-luna');

  // a preset written before this field existed
  prefs.setPrefs({ sessionPresets: [{ id: 'old', name: 'old', skill: '', model: '', effort: 'high' }] });
  expect(prefs.getPrefs().sessionPresets[0].engine).toBe('');
  // and a junk value is not trusted through to the server
  prefs.setPrefs({ sessionPresets: [{ id: 'x', name: 'x', engine: 'evil' }] });
  expect(prefs.getPrefs().sessionPresets[0].engine).toBe('');
});
