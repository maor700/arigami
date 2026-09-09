// Which agent-engine CLI a new session is born on, and what the two pickers
// standing next to that choice are allowed to offer.
//
// `session.engine` ('claude' | 'codex') is read at every spawn by pickEngine()
// (server/lib/engine-driver.ts). It is the FIRST of the launcher's four
// selects because it decides the contents of two of the others: the model list
// and the effort scale are engine-specific, not a shared vocabulary that
// happens to be spelled the same.
//
// Where each engine's model list comes from:
//   claude — fetched. server/models.js runs a `claude` CLI handshake and the
//            cockpit reads it through lib/models.js (revalidating cache).
//   codex  — static, right here. There is NO equivalent handshake to run: the
//            Codex CLI keeps its model metadata in $CODEX_HOME/models_cache.json
//            (a server-pushed catalog it refreshes on its own schedule), which
//            the Arigami server does not read. The list below is transcribed
//            from that file on the host — codex-cli 0.153.4, read 2026-09-09 —
//            filtered to `visibility: "list"` and ordered by its `priority`.
//            Adding a model when Codex ships one is a one-line edit here.
//
// Why the effort scales are NOT shared (the thing not to "simplify"):
// `claude --effort` is a flag with one fixed ladder for every model. Codex has
// no such flag at all — reasoning depth is the `model_reasoning_effort` config
// key (`-c model_reasoning_effort=…`), and the ladder is a property of the
// MODEL: gpt-5.6-terra adds an `ultra` rung above `max`, gpt-5.5 stops at
// `xhigh` and has neither. Showing Claude's ladder for a Codex session would
// offer levels the model rejects and hide the one it has.
import { t } from './i18n.js';
import { EFFORT_OPTIONS } from './effort.js';

export const ENGINE_IDS = ['claude', 'codex'];
export const DEFAULT_ENGINE = 'claude';

/** '' / unknown / legacy-undefined all mean claude — same rule as pickEngine(). */
export function normalizeEngine(engine) {
  return ENGINE_IDS.includes(engine) ? engine : DEFAULT_ENGINE;
}

// Product names, not translated strings — the same word in both languages.
// `label` is what UI copy calls the engine when it names the thing the human is
// talking to ("Codex is working…", "Reply to Codex…"); `term` is the CLI-ish
// lowercase form the terminal header wears next to the session name.
const ENGINE_NAMES = {
  claude: { label: 'Claude Code', term: 'claude-code' },
  codex: { label: 'Codex', term: 'codex' },
};

/**
 * How to NAME this session's engine in UI copy.
 *
 * The rule these two exist to enforce: a string that describes the ENGINE (who
 * is working, who wants the screen, whose capabilities these are) must follow
 * the session's engine; a string that describes ARIGAMI, or genuinely describes
 * the Claude Code CLI itself (its install, its keychain item, its subscription
 * usage), keeps saying Claude. Hence `{engine}` placeholders in the locales
 * rather than a search-and-replace.
 */
export function engineLabel(engine) {
  return ENGINE_NAMES[normalizeEngine(engine)].label;
}

/** Lowercase CLI-ish name for the terminal header. */
export function engineTermName(engine) {
  return ENGINE_NAMES[normalizeEngine(engine)].term;
}

// Labels are product names, not translated strings; the option list is a
// function (not a frozen const) so a language switch re-renders it.
export function engineOptions() {
  return [
    { value: 'claude', label: 'Claude', desc: t('launcher.options.engineClaudeDesc') },
    { value: 'codex', label: 'Codex', desc: t('launcher.options.engineCodexDesc') },
  ];
}

// `efforts` is that model's own `supported_reasoning_levels`, in the catalog's
// order (weakest → strongest); `defaultEffort` its `default_reasoning_level`,
// which is what Codex uses when the config key is absent.
export const CODEX_MODELS = [
  {
    value: 'gpt-5.6-terra',
    label: 'GPT-5.6-Terra',
    desc: 'Balanced agentic coding model for everyday work.',
    efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    defaultEffort: 'medium',
  },
  {
    value: 'gpt-5.6-luna',
    label: 'GPT-5.6-Luna',
    desc: 'Fast and affordable agentic coding model.',
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultEffort: 'medium',
  },
  {
    value: 'gpt-5.5',
    label: 'GPT-5.5',
    desc: 'Proven previous-generation model for coding and general work.',
    efforts: ['low', 'medium', 'high', 'xhigh'],
    defaultEffort: 'medium',
  },
];

// With no model pinned, Codex picks its own (config `model`, else the
// server-recommended one) — we can't know which, so offer only the rungs every
// listed model has. Anything above that would be a level the chosen model may
// reject.
export const CODEX_COMMON_EFFORTS = CODEX_MODELS.reduce(
  (acc, m) => acc.filter((e) => m.efforts.includes(e)),
  CODEX_MODELS[0].efforts
);

const EFFORT_KEY = {
  low: 'rail.effortLow',
  medium: 'rail.effortMedium',
  high: 'rail.effortHigh',
  xhigh: 'rail.effortXhigh',
  max: 'rail.effortMax',
  ultra: 'rail.effortUltra',
};

/**
 * The model `<select>`'s options for this engine. `claudeModels` is the live
 * list from useModels() — passed in rather than imported so this module stays
 * pure and testable (and so a Codex-only render never triggers the claude
 * handshake fetch).
 */
export function modelOptionsFor(engine, claudeModels) {
  if (normalizeEngine(engine) !== 'codex') return claudeModels || [];
  return [
    { value: 'default', label: t('rail.effortDefault'), desc: t('launcher.options.codexModelDefaultDesc') },
    ...CODEX_MODELS.map(({ value, label, desc }) => ({ value, label, desc })),
  ];
}

/** The catalog entry for a Codex model value, or null (incl. 'default'/''). */
export function codexModel(model) {
  return CODEX_MODELS.find((m) => m.value === model) || null;
}

/**
 * The effort `<select>`'s options for this engine + currently-picked model.
 * Claude ignores `model` (one ladder for all); Codex reads the model's own.
 * The leading 'default' entry means "send no override" in both engines — for
 * claude, omit `--effort`; for codex, omit `model_reasoning_effort` and let the
 * model's `default_reasoning_level` stand.
 */
export function effortOptionsFor(engine, model) {
  if (normalizeEngine(engine) !== 'codex') return EFFORT_OPTIONS;
  const m = codexModel(model);
  const levels = m ? m.efforts : CODEX_COMMON_EFFORTS;
  return [
    { value: 'default', label: t('rail.effortDefault') },
    ...levels.map((e) => ({ value: e, label: t(EFFORT_KEY[e]) || e })),
  ];
}

/** Human label for a stored effort value under this engine/model. */
export function effortLabelFor(engine, model, value) {
  const v = value || 'default';
  return effortOptionsFor(engine, model).find((o) => o.value === v)?.label || v;
}

/**
 * Clamp a `{engine, skill, model, effort}` object to what the engine actually
 * offers. Switching Claude→Codex with `model: 'sonnet'` must not POST a Claude
 * alias to a Codex session — and an effort rung the new model lacks (`ultra`
 * on gpt-5.5) must not survive the model switch either. Skill is engine-
 * agnostic and never touched.
 *
 * `claudeModels` is optional: without it a Claude model value is left alone
 * (the list may not have loaded yet, and dropping a valid pick because of a
 * pending fetch would be worse than keeping it).
 */
export function coerceSessionOptions(options, claudeModels) {
  const engine = normalizeEngine(options?.engine);
  const out = { ...options, engine: engine === DEFAULT_ENGINE ? '' : engine };
  const known = modelOptionsFor(engine, claudeModels);
  if (out.model) {
    const listed = known.some((o) => o.value === out.model);
    // Claude with an unloaded list → keep. Codex's list is static, so an
    // unlisted value there is genuinely wrong.
    if (!listed && (engine === 'codex' || (claudeModels && claudeModels.length))) out.model = '';
  }
  if (out.effort && !effortOptionsFor(engine, out.model).some((o) => o.value === out.effort)) out.effort = '';
  return out;
}
