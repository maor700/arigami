// Hooks: react to domain events, and gate a merge.
//
// Two very different failure modes, on purpose:
//   on[event]  — a handler that throws is logged, filed as an incident, and the
//                host keeps going. It can never break a merge or a session.
//   gates[...] — a gate that throws, returns {ok:false} or times out (5 min)
//                FAILS CLOSED: the merge is refused with its reason. That is
//                what a gate is for, so keep it fast and deterministic.
import type { Hooks } from '@arigami/sdk';

export const hooks: Hooks = {
  on: {
    // Every event declared in manifest.hooks.events needs a handler here, or
    // validation warns. Payloads are frozen for apiVersion 1 (see sdk/README.md).
    'merge.done': async (ev, ctx) => {
      ctx.log(`merge.done — ${ev.branch} → ${ev.base} (${String(ev.sha || '').slice(0, 7)})`);
      await ctx.notify({
        title: '{{title}}',
        body: `מוזג: ${ev.branch} → ${ev.base}`,
        tag: 'merge',
        sessionId: ev.sessionId,
      });
    },
  },

  gates: {
    'merge.before': async (ev, ctx) => {
      const cmd = String(ctx.settings.gateCommand || '').trim();
      if (!cmd) return { ok: true }; // nothing configured — never block by accident
      const r = await ctx.exec(cmd.split(/\s+/), { cwd: ev.repoRoot, timeoutMs: 120_000 });
      if (r.code === 0) return { ok: true };
      // The reason is shown to the human on the merge card — make it actionable,
      // and keep it short: the tail of stderr is usually the whole story.
      return { ok: false, reason: `${cmd} נכשל (exit ${r.code}${r.timedOut ? ', timeout' : ''}):\n${(r.stderr || r.stdout).slice(-800)}` };
    },
  },
};

// Optional: a notification channel, next to Web Push and WhatsApp. Every
// ctx.notify() in the host fans out to it. A channel that is not configured
// should return quietly — a notification is never allowed to become an error.
// export const channels: Record<string, NotifyChannel> = {
//   telegram: async (payload, ctx) => {
//     const token = ctx.secrets.TELEGRAM_TOKEN;
//     if (!token) return;
//     await ctx.fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
//       method: 'POST',
//       headers: { 'content-type': 'application/json' },
//       body: JSON.stringify({ chat_id: ctx.settings.chatId, text: `${payload.title}\n${payload.body}` }),
//     });
//   },
// };
