// A listener provider: it answers two questions and inherits the whole existing
// machine (5s scheduler, exponential backoff, auth-fail counting, TTL,
// queue-until-idle delivery, coalescing, watermark-after-delivery).
//
//   register(ctx, args) → the BASELINE. Never fire on the past: read the source
//                         once and store what "already seen" means.
//   poll(ctx, l)        → what changed since l.watermark. 20 SECOND deadline
//                         (ctx.signal); a throw or a timeout is `transient` and
//                         goes through the normal backoff, so do not catch it
//                         into a fake `ok`.
//
// The watermark advances only AFTER the wake is delivered, on purpose: wakes are
// at-least-once. `summary` is the text the session is woken with — a thin
// pointer, not the content.
import type { ListenerProvider } from '@arigami/sdk';

type Args = { url: string; match?: string };
type WM = { lastId: string };

/** One item from the watched source, newest first. Replace with the real shape. */
type Item = { id: string; title: string };

async function fetchItems(ctx: { fetch: typeof fetch; signal: AbortSignal }, args: Args): Promise<Item[]> {
  // ctx.fetch + ctx.signal: the host's deadline cancels the request for you.
  const res = await ctx.fetch(args.url, { signal: ctx.signal, headers: { accept: 'application/json' } });
  if (!res.ok) throw Object.assign(new Error(`${res.status} ${res.statusText}`), { status: res.status });
  const body = (await res.json()) as { items?: Item[] };
  const items = (body.items || []).map((i) => ({ id: String(i.id), title: String(i.title ?? '') }));
  return args.match ? items.filter((i) => i.title.includes(args.match!)) : items;
}

export const provider: ListenerProvider<Args, WM> = {
  type: '{{type}}',
  label: (a) => `{{title}} — ${a?.url ? new URL(a.url).hostname : '?'}`,
  schema: {
    type: 'object',
    required: ['url'],
    properties: { url: { type: 'string' }, match: { type: 'string' } },
  },
  defaultIntervalSec: 300,

  async register(ctx, args) {
    const items = await fetchItems(ctx, args);
    ctx.log(`baseline: ${items.length} item(s), newest ${items[0]?.id ?? '—'}`);
    return { params: args, watermark: { lastId: items[0]?.id ?? '' } };
  },

  async poll(ctx, l) {
    let items: Item[];
    try {
      items = await fetchItems(ctx, l.params);
    } catch (e: any) {
      // Classify: 401/403 → 'auth' (the host counts failures and asks the human),
      // 404/410 → 'gone' (stop), everything else → 'transient' (backoff + retry).
      const status = Number(e?.status) || 0;
      const kind: 'auth' | 'gone' | 'transient' = status === 401 || status === 403 ? 'auth' : status === 404 || status === 410 ? 'gone' : 'transient';
      return { kind, error: String(e?.message || e) };
    }

    const seen = l.watermark?.lastId || '';
    const at = seen ? items.findIndex((i) => i.id === seen) : -1;
    const fresh = at >= 0 ? items.slice(0, at) : items.slice(0, 1);
    if (!fresh.length) return { kind: 'ok', shouldFire: false, nextWatermark: { lastId: seen } };

    const max = Number(ctx.settings.maxItems) || 5;
    return {
      kind: 'ok',
      shouldFire: true,
      nextWatermark: { lastId: fresh[0].id },
      summary: `{{title}}: ${fresh.length} חדשים — ${fresh.slice(0, max).map((i) => i.title).join(' · ')}`,
    };
  },

  // Optional: the same listener, pushed instead of polled. POST to the host's
  // custom webhook `ext-{{name}}-inbound` (declared in manifest webhooks[]) and
  // the delivery becomes a wake with no waiting for the next poll.
  async onWebhook(_ctx, l, event) {
    const body = typeof event.body === 'string' ? event.body : JSON.stringify(event.body ?? {});
    return {
      kind: 'ok',
      shouldFire: true,
      nextWatermark: l.watermark,
      summary: `{{title}} (webhook): ${body.slice(0, 300)}`,
    };
  },
};
