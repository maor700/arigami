// Nothing goes to a person on an agent's call (server/lib/outbound.ts).
//
//   - the rule: which tool names count as senders
//   - the card: the exact text and the recipient, nothing paraphrased
//   - ext-mcp, for real: an agent's call to a sender does NOT run the tool — it
//     files a request with the host; a host call (after the owner's Send) runs
//     it; a non-sender runs as always
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isOutbound, cardPrompt, describe as describeOut } from '../server/lib/outbound.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('senders are recognized by name, and a declared one by declaration', () => {
  for (const t of ['send_message', 'slack_send_message', 'post_reply', 'create_comment', 'email_send', 'publish'])
    expect(isOutbound(t)).toBe(true);
  for (const t of ['list_messages', 'search_contacts', 'get_chat', 'slack_find_user', 'postgres_query', 'sender_stats'])
    expect(isOutbound(t)).toBe(false);
  expect(isOutbound('nudge', ['nudge'])).toBe(true);
});

test('the card shows the recipient and the exact text, whatever the tool calls its fields', () => {
  const wa = { via: 'whatsapp' as const, tool: 'send_message', args: { recipient: '+15550001', message: 'On my way.\nTen minutes.' } };
  const p = cardPrompt(wa, 'confirm the meeting');
  expect(p).toContain('Send on WhatsApp to +15550001?');
  expect(p).toContain('On my way.\nTen minutes.'); // verbatim, newlines kept
  expect(p).toContain('Why: confirm the meeting');
  const sl = describeOut({ via: 'ext', ext: 'slack-web', tool: 'slack_send_message', args: { target: '#general', text: 'hi', thread_ts: '1.2' } });
  expect(sl).toEqual({ channel: 'slack-web · slack_send_message', to: '#general', text: 'hi', rest: { thread_ts: '1.2' } });
});

async function mcpCall(env: Record<string, string>, modulePath: string, tool: string, args: Record<string, unknown>) {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const transport = new StdioClientTransport({ command: 'bun', args: [path.join(ROOT, 'mcp/ext-mcp.js'), modulePath], env: { ...(process.env as Record<string, string>), ...env } });
  const client = new Client({ name: 't', version: '0' }, { capabilities: {} });
  await client.connect(transport);
  try {
    const r: any = await client.callTool({ name: tool, arguments: args });
    return String((r.content || []).map((c: any) => c.text).join(''));
  } finally {
    await client.close();
  }
}

test('ext-mcp: an agent calling a sender files a request instead of sending', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outbound-ext-'));
  const sent = path.join(dir, 'sent.txt');
  const mod = path.join(dir, 'tools', 'module.js');
  fs.mkdirSync(path.dirname(mod), { recursive: true });
  fs.writeFileSync(
    mod,
    `import fs from 'node:fs';
     export const tools = [
       { name: 'send_note', run: async (a) => { fs.appendFileSync(${JSON.stringify(sent)}, a.text + '\\n'); return { ok: true }; } },
       { name: 'nudge', run: async (a) => { fs.appendFileSync(${JSON.stringify(sent)}, 'nudge:' + a.text + '\\n'); return { ok: true }; } },
       { name: 'read_notes', run: async () => ({ notes: fs.existsSync(${JSON.stringify(sent)}) ? fs.readFileSync(${JSON.stringify(sent)}, 'utf8') : '' }) },
     ];`
  );
  // a stub host that records what reached it
  const seen: any[] = [];
  const host = Bun.serve({
    port: 0,
    async fetch(req) {
      seen.push({ path: new URL(req.url).pathname, auth: req.headers.get('authorization'), body: await req.json().catch(() => null) });
      return Response.json({ pending: true, sent: false, note: 'NOT sent' }, { status: 202 });
    },
  });
  const base = { ARIGAMI_URL: `http://127.0.0.1:${host.port}`, ARIGAMI_TOKEN: 'sess-token', EXT_NAME: 'notes', EXT_DIR: dir, EXT_OUTBOUND: JSON.stringify(['nudge']) };
  try {
    // an agent (session env): the sender does not run
    const r1 = await mcpCall({ ...base, ARIGAMI_SESSION_ID: 'sess_abc' }, mod, 'send_note', { text: 'hello Dana' });
    expect(r1).toContain('"pending":true');
    expect(fs.existsSync(sent)).toBe(false);
    expect(seen[0]).toEqual({ path: '/__api/sessions/sess_abc/outbound', auth: 'Bearer sess-token', body: { via: 'ext', ext: 'notes', tool: 'send_note', args: { text: 'hello Dana' } } });
    // a DECLARED sender with an innocent name is held too
    await mcpCall({ ...base, ARIGAMI_SESSION_ID: 'sess_abc' }, mod, 'nudge', { text: 'x' });
    expect(fs.existsSync(sent)).toBe(false);
    expect(seen[1].body.tool).toBe('nudge');
    // a non-sender runs as always
    expect(await mcpCall({ ...base, ARIGAMI_SESSION_ID: 'sess_abc' }, mod, 'read_notes', {})).toContain('"notes":""');
    // the host's own call — after the owner pressed Send — runs the sender
    await mcpCall({ ...base, EXT_HOST_CALL: '1' }, mod, 'send_note', { text: 'hello Dana' });
    expect(fs.readFileSync(sent, 'utf8')).toBe('hello Dana\n');
    expect(seen.length).toBe(2); // the host call asked nobody
  } finally {
    host.stop(true);
  }
}, 30_000);
