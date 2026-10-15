import { forwardRef } from 'react';
import { ChevronDown } from 'lucide-react';
import { useT } from '../lib/i18n.js';
import { useModels } from '../lib/models.js';
import { cn } from '../lib/utils.js';
import { engineOptions, coerceSessionOptions, modelOptionsFor, resolveEngine, DEFAULT_ENGINE } from '../lib/engines.js';
import { Label } from './ui/label.jsx';
import { Tip, TooltipProvider } from './ui/tooltip.jsx';
import { fieldBase } from './ui/input.jsx';

// A Tip that brings its own TooltipProvider, so it also works where the app-root
// UiProvider is not mounted (SSR tests, an embedded pane). Nested providers are fine.
export function Hint({ label, children, ...props }) {
  if (!label) return children;
  return (
    <TooltipProvider>
      <Tip label={label} {...props}>{children}</Tip>
    </TooltipProvider>
  );
}

// A native <select> in the kit's field look (hairline border, 4px radius, a
// chevron, 44px under a finger). Native on purpose: the launcher's pickers are
// short lists, a native menu is the best picker on a phone, it needs no portal
// inside the launcher's scroll panes, and `''` is a real option value (Radix
// Select forbids it). Width follows content (`w-auto`); pass className="w-full"
// plus wrapperClassName="w-full" for a full-width field.
export const NativeSelect = forwardRef(function NativeSelect({ className, wrapperClassName, children, ...props }, ref) {
  return (
    <span className={cn('relative inline-flex max-w-full min-w-0', wrapperClassName)}>
      <select
        ref={ref}
        data-slot="select"
        className={cn(fieldBase, 'h-8 w-auto max-w-full cursor-pointer appearance-none pe-7 text-sm coarse:h-11', className)}
        {...props}
      >
        {children}
      </select>
      <ChevronDown aria-hidden="true" className="pointer-events-none absolute end-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
    </span>
  );
});

// The kit's neutral segmented control as a VALUE picker (a radiogroup of
// <button role="radio">): a muted track, the selected segment a raised card
// with a hairline. For navigation between panes use ui/Tabs instead.
// `options` = [[value, label, tip?], …].
export const Segmented = forwardRef(function Segmented({ value, options, onChange, disabled, label, className = '', ...rest }, ref) {
  return (
    <span ref={ref} role="radiogroup" aria-label={label} {...rest} className={cn('inline-flex shrink-0 items-center gap-0.5 rounded-md bg-muted p-0.5', className)}>
      {options.map(([v, text, tip]) => (
        <Hint key={v} label={tip}>
          <button
            type="button"
            role="radio"
            aria-checked={value === v}
            disabled={disabled}
            onClick={() => value !== v && onChange(v)}
            className="inline-flex h-6 cursor-pointer items-center rounded-sm px-3 text-xs font-medium text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50 aria-checked:bg-card aria-checked:text-foreground aria-checked:shadow-[0_0_0_1px_var(--hb-hair)] coarse:h-9"
          >
            {text}
          </button>
        </Hint>
      ))}
    </span>
  );
});

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
//
// Look: the kit's neutral segmented control (a muted track, the selected
// segment a raised card with a hairline). It stays a radiogroup of <button
// role="radio"> — not Radix Tabs — because it is a value picker, not navigation.
export function EngineToggle({ options, onChange, className = '', label, ...rest }) {
  const t = useT();
  const { models: claudeModels } = useModels();
  const current = resolveEngine(options.engine);
  const pick = (value) =>
    onChange(coerceSessionOptions({ ...options, engine: value === DEFAULT_ENGINE ? '' : value }, claudeModels));
  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)} {...rest}>
      <Label>{label ?? t('launcher.options.engine')}</Label>
      <Segmented value={current} options={engineOptions().map((o) => [o.value, o.label, o.desc])} onChange={pick} label={t('launcher.options.engine')} />
    </div>
  );
}

/** An agent form's model options for `engine`: its catalog minus 'default', plus the stored value if the catalog lacks it. */
export function agentModelOptions(engine, claudeModels, current) {
  const list = modelOptionsFor(resolveEngine(engine), claudeModels).filter((m) => m.value && m.value !== 'default');
  if (current && !list.some((m) => m.value === current)) list.push({ value: current, label: current });
  return list;
}
