#!/usr/bin/env bun
// A3 — PreToolUse hook installed (via `--settings`) into every session born from
// an agent whose agent.json carries a `tools` / `domains` allowlist. Claude Code
// runs it before EVERY tool call with {tool_name, tool_input, …} on stdin; the
// host answers allow/deny from the agent's policy (server/agent-policy.ts).
// Exit 2 = block the call, stderr is shown to the model as the reason.
//
// Fail-CLOSED: if the host cannot be reached the call is blocked (a policy that
// silently evaporates when the host hiccups is no policy). Sessions without
// ARIGAMI_AGENT never get this hook, so nothing else is affected.
const HOST = process.env.ARIGAMI_URL || 'http://127.0.0.1:3099';
const TOKEN = process.env.ARIGAMI_TOKEN || '';
const SID = process.env.ARIGAMI_SESSION_ID || '';

let raw = '';
for await (const chunk of process.stdin) raw += chunk;
let ev = {};
try { ev = JSON.parse(raw || '{}'); } catch {}
const toolName = String(ev.tool_name || '');
if (!SID || !toolName) process.exit(0); // nothing to judge

try {
  const res = await fetch(`${HOST}/__api/sessions/${SID}/policy/check`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}) },
    body: JSON.stringify({ tool_name: toolName, input: ev.tool_input ?? {} }),
    signal: AbortSignal.timeout(15_000),
  });
  const v = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(v?.error || `HTTP ${res.status}`);
  if (v.allow === false) {
    process.stderr.write(`[arigami policy] blocked: ${v.reason || 'not allowed for this agent'}\n`);
    process.exit(2);
  }
  process.exit(0);
} catch (e) {
  process.stderr.write(`[arigami policy] cannot verify "${toolName}" against the agent policy (${e?.message || e}) — blocked\n`);
  process.exit(2);
}
