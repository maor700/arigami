// `hello-tick` — a deterministic listener provider.
//
// It fires on every poll until it has fired `count` times, then goes terminal.
// No network, no clock skew, no external service: that is on purpose, so the
// host's tests (and a human trying the system out) can watch the whole
// watermark → wake → watermark-advances loop happen for real in a few seconds.
import type { ListenerProvider } from '@arigami/sdk';

type Args = { count: number; note?: string };
type WM = { fired: number };

export const tickProvider: ListenerProvider<Args, WM> = {
  type: 'hello-tick',
  label: (a) => `hello ×${a?.count ?? '?'}`,
  schema: {
    type: 'object',
    required: ['count'],
    properties: { count: { type: 'number' }, note: { type: 'string' } },
  },
  fireOn: ['tick'],
  defaultIntervalSec: 30,

  async register(ctx, args) {
    const count = Math.max(1, Math.min(100, Number(args.count) || 1));
    ctx.log(`armed for ${count} tick(s)`);
    return { params: { ...args, count }, watermark: { fired: 0 } };
  },

  async poll(ctx, l) {
    const fired = Number(l.watermark?.fired || 0);
    const count = Number(l.params.count) || 1;
    if (fired >= count) return { kind: 'ok', shouldFire: false, nextWatermark: { fired }, terminal: 'done' };
    const next = fired + 1;
    return {
      kind: 'ok',
      shouldFire: true,
      nextWatermark: { fired: next },
      terminal: next >= count ? 'done' : null,
      summary: `hello tick ${next}/${count}${l.params.note ? ` — ${l.params.note}` : ''}`,
    };
  },

  // The same listener can be pushed instead of polled: POST to the host's
  // custom webhook `ext-hello-tick` and this turns the delivery into a wake.
  async onWebhook(_ctx, l, event) {
    const fired = Number(l.watermark?.fired || 0) + 1;
    const body = typeof event.body === 'string' ? event.body : JSON.stringify(event.body ?? {});
    return { kind: 'ok', shouldFire: true, nextWatermark: { fired }, summary: `hello webhook: ${body.slice(0, 300)}` };
  },
};
