// Hooks: react to domain events, and gate a merge.
//
// A hook that throws is logged and turned into an incident — the host keeps
// going. A GATE that throws or times out fails CLOSED and blocks the merge,
// which is what a gate is for; this one always passes, so installing the
// example never gets in anybody's way.
import type { Hooks } from '@arigami/sdk';

export const hooks: Hooks = {
  on: {
    'merge.done': async (ev, ctx) => {
      ctx.log(`merge.done — ${ev.branch} → ${ev.base} (${String(ev.sha || '').slice(0, 7)})`);
    },
    'listener.fired': async (ev, ctx) => {
      if (ev.type === 'hello-tick') ctx.log(`listener.fired — ${ev.listenerId}: ${String(ev.summary || '').slice(0, 120)}`);
    },
  },
  gates: {
    'merge.before': async (ev, ctx) => {
      ctx.log(`merge.before — ${ev.branch} → ${ev.base}: allowed`);
      return { ok: true };
    },
  },
};
