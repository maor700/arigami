// Nothing goes to a person without the owner seeing the exact text first.
//
// A tool that sends to a PERSON — a WhatsApp message, a Slack message, an
// email, a comment — never performs the send when an agent calls it. It files
// the request; the host shows the owner a card with the recipient and the exact
// text; only on the owner's "Send" does the HOST perform it, with exactly the
// arguments the card showed. The agent is told what happened afterwards.
//
// Before this, WhatsApp's send_message and an extension's slack_send_message
// went straight out from an agent's call, with no one shown anything.
//
// Which tools count: an extension names them in its manifest (`outbound`), and
// anything whose name reads as sending is caught regardless — an extension
// that forgets to declare a sender must not thereby get a free pass.
//
// What this is not: a sandbox. An agent with a shell can still call a provider
// API itself. This closes the TOOL path, which is how agents actually send.

/** send_message, slack_send_message, post_reply, create_comment, email_send, GMAIL_FORWARD_MESSAGE, … */
export const OUTBOUND_RE = /(^|_)(sends?|post|reply|comment|publish|tweet|email|dm|notify|forward|share|invite)(_|$)/i;

export function isOutbound(tool: string, declared: string[] = []): boolean {
  return declared.includes(tool) || OUTBOUND_RE.test(tool);
}

export interface OutboundExec {
  /** How the host performs the send once approved. */
  via: 'whatsapp' | 'ext' | 'composio';
  ext?: string;
  /** composio: the connected account it runs under, and that account's user id. */
  account?: string;
  user?: string;
  tool: string;
  args: Record<string, unknown>;
}

const pick = (a: Record<string, unknown>, keys: string[]): string | null => {
  for (const k of keys) if (a[k] != null && String(a[k]).trim()) return String(a[k]);
  return null;
};

/** Recipient and text as a person reads them, whatever the tool calls its fields. */
export function describe(x: OutboundExec): { channel: string; to: string | null; text: string | null; rest: Record<string, unknown> } {
  const channel = x.via === 'whatsapp' ? 'WhatsApp' : x.via === 'composio' ? `Composio · ${x.tool}` : `${x.ext} · ${x.tool}`;
  const toKeys = ['recipient', 'recipient_email', 'to', 'target', 'channel', 'chat_jid', 'user', 'email', 'phone', 'attendees'];
  const textKeys = ['message', 'text', 'markdown_text', 'body', 'content', 'comment'];
  const to = pick(x.args, toKeys);
  const text = pick(x.args, textKeys);
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(x.args)) if (!toKeys.includes(k) && !textKeys.includes(k)) rest[k] = v;
  return { channel, to, text, rest };
}

/** The card's text: the exact message, nothing paraphrased. */
export function cardPrompt(x: OutboundExec, why?: string): string {
  const d = describe(x);
  const lines = [`Send on ${d.channel}${d.to ? ` to ${d.to}` : ''}?`];
  if (why) lines.push(`Why: ${why}`);
  lines.push('', d.text ?? '(no message text)');
  if (Object.keys(d.rest).length) lines.push('', `Also: ${JSON.stringify(d.rest)}`);
  return lines.join('\n');
}
