// One way out of the host for "tell the human something".
//
// Until now every caller reached for sendPush() directly (listeners.ts,
// api.ts pushIntervention, supervisor-loop.ts, triggers.ts) and Web Push was the
// only channel there was — `deliver.whatsapp` on a cron trigger was schema-only
// because no second transport existed. notify() is that abstraction: it fans a
// payload out to Web Push plus every registered channel, and extensions add
// channels from hooks.ts (`export const channels = { telegram: … }`).
//
// The built-in extra channel is WhatsApp, through the host's ONE paired bridge
// (whatsapp-proxy.ts → whatsapp-bridge.ts). Not connected → the channel is
// skipped in silence: a notification is never allowed to become an error.
import { cfg } from './state.js';

export interface NotifyPayload {
  title: string;
  body: string;
  tag?: string;
  sessionId?: string;
  url?: string;
  /** the chat event this notification points at (push.ts passes it through) */
  eventId?: string;
  /** restrict the fan-out to these channel ids ('push' is always one of them) */
  channels?: string[];
  /** WhatsApp: an explicit JID for this one message (else config.notify.whatsappJid) */
  whatsappJid?: string;
}

export type ChannelSend = (payload: NotifyPayload) => Promise<void> | void;

const channels = new Map<string, ChannelSend>();

/** Register a delivery channel. Returns the unregister function. */
export function registerChannel(id: string, send: ChannelSend): () => void {
  channels.set(id, send);
  return () => channels.delete(id);
}

export const unregisterChannel = (id: string): boolean => channels.delete(id);
/** Channel ids currently available, 'push' first. */
export const channelIds = (): string[] => ['push', 'whatsapp', ...channels.keys()];

const wanted = (p: NotifyPayload, id: string) => !p.channels?.length || p.channels.includes(id);

/** The JID a WhatsApp notification goes to: explicit → config → none. */
export function whatsappTarget(p: NotifyPayload): string | null {
  const explicit = typeof p.whatsappJid === 'string' ? p.whatsappJid.trim() : '';
  if (explicit) return explicit;
  const fromConfig = (cfg as any)?.notify?.whatsappJid;
  return typeof fromConfig === 'string' && fromConfig.trim() ? fromConfig.trim() : null;
}

/** One line, so WhatsApp and Push read the same. */
export const notifyText = (p: NotifyPayload): string => `${p.title}${p.body ? `\n${p.body}` : ''}`.slice(0, 3000);

async function sendWhatsapp(p: NotifyPayload): Promise<void> {
  const jid = whatsappTarget(p);
  if (!jid) return;
  try {
    const { callWhatsapp } = await import('./whatsapp-proxy.js');
    // Not paired → needs_setup shape; that is a skip, not a failure.
    await callWhatsapp('send_message', { recipient: jid, message: notifyText(p) }, 'send you a notification');
  } catch {
    /* the bridge is the human's, not ours to fail over */
  }
}

/**
 * Deliver `payload` to Web Push and every other channel that wants it. Never
 * throws and never rejects — a failing channel is skipped, the rest still go.
 */
export async function notify(payload: NotifyPayload): Promise<void> {
  const jobs: Promise<unknown>[] = [];

  if (wanted(payload, 'push')) {
    jobs.push(
      import('./push.js')
        .then((push) => {
          if (!push.hasSubscriptions()) return;
          return push.sendPush({
            title: String(payload.title || '').slice(0, 80),
            body: String(payload.body || '').slice(0, 200),
            tag: payload.tag,
            sessionId: payload.sessionId,
            eventId: payload.eventId,
            url: payload.url,
          });
        })
        .catch(() => {})
    );
  }

  if (wanted(payload, 'whatsapp') && whatsappTarget(payload)) jobs.push(sendWhatsapp(payload).catch(() => {}));

  for (const [id, send] of channels) {
    if (!wanted(payload, id)) continue;
    jobs.push(Promise.resolve().then(() => send(payload)).catch(() => {}));
  }

  // Extension-contributed channels are registered lazily (they come and go with
  // a reload), so ask the loader rather than keeping a stale copy here.
  try {
    const ext = await import('./extensions.js');
    for (const c of ext.extChannels()) {
      if (channels.has(c.id) || !wanted(payload, c.id)) continue;
      jobs.push(Promise.resolve().then(() => c.send(payload as any)).catch(() => {}));
    }
  } catch {
    /* no loader in this process */
  }

  await Promise.allSettled(jobs);
}
