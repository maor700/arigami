import { useT } from '../lib/i18n.js';
import { useModels } from '../lib/models.js';
import { engineOptions, coerceSessionOptions, modelOptionsFor, resolveEngine, DEFAULT_ENGINE } from '../lib/engines.js';

// Segmented engine toggle shared by the Launcher and the agent forms (AgentView / AgentCard).
// WHICH ENGINE a new session is born on. A visible segmented toggle, not a
// <select> among the others and not behind the "Advanced" fold: this is a
// first-class choice about what the session IS, made before anything else, so
// it has to be readable at a glance and switchable in one click. The three
// selects below it (skill/model/effort) stay in Advanced — they refine a
// session, they don't define it.
//
// Switching runs coerceSessionOptions(), which drops a model/effort the new
// engine doesn't offer instead of POSTing e.g. a Claude alias to a Codex
// session (lib/engines.js: Codex's model list is static and its effort ladder
// is per-model, with an `ultra` rung Claude has no equivalent for). Picking
// Codex before its driver is registered is meant to fail loudly at spawn
// (pickEngine throws) — there is deliberately no quiet fall-back to Claude.
//
// Switching runs coerceSessionOptions() on `options` and hands back the clamped object; extra props land on the root.
export function EngineToggle({ options, onChange, className = '', label, ...rest }) {
  const t = useT();
  const { models: claudeModels } = useModels();
  const current = resolveEngine(options.engine);
  const pick = (value) =>
    onChange(coerceSessionOptions({ ...options, engine: value === DEFAULT_ENGINE ? '' : value }, claudeModels));
  return (
    <div className={`flex flex-wrap items-center gap-2 ${className}`} {...rest}>
      <span className="text-xs font-medium text-fgdim">
        {label ?? t('launcher.options.engine')}
      </span>
      <span
        role="radiogroup"
        aria-label={t('launcher.options.engine')}
        className="inline-flex shrink-0 gap-0.5 rounded-md bg-muted p-0.5"
      >
        {engineOptions().map((o) => (
          <button
              key={o.value}
              title={o.desc}
              type="button"
              role="radio"
              aria-checked={current === o.value}
              onClick={() => current !== o.value && pick(o.value)}
              className={`inline-flex h-7 cursor-pointer items-center rounded-sm px-3 text-xs font-medium whitespace-nowrap outline-none transition-colors focus-visible:outline-2 focus-visible:outline-ring coarse:h-10 ${
                current === o.value ? 'bg-card text-foreground shadow-[0_0_0_1px_var(--hb-hair)]' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {o.label}
            </button>
        ))}
      </span>
    </div>
  );
}

/** An agent form's model options for `engine`: its catalog minus 'default', plus the stored value if the catalog lacks it. */
export function agentModelOptions(engine, claudeModels, current) {
  const list = modelOptionsFor(resolveEngine(engine), claudeModels).filter((m) => m.value && m.value !== 'default');
  if (current && !list.some((m) => m.value === current)) list.push({ value: current, label: current });
  return list;
}
