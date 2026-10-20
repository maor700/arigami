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
//
// POLICY gates: with `--gates` (codex sessions — codex has no mods, so this hook IS its adapter) the same call also
// runs the extensions' tool.before gates, and PostToolUse runs tool.after. Claude sessions get those through the
// generated mod instead, so the flag is off there and nothing is judged twice.
const GATES = process.argv.includes('--gates');
const HOST = process.env.ARIGAMI_URL || 'http://127.0.0.1:3099';
const TOKEN = process.env.ARIGAMI_TOKEN || '';
const SID = process.env.ARIGAMI_SESSION_ID || '';

let raw = '';
for await (const chunk of process.stdin) raw += chunk;
let ev = {};
try { ev = JSON.parse(raw || '{}'); } catch {}
const toolName = String(ev.tool_name || '');
if (!SID || !toolName) process.exit(0); // nothing to judge
const post = (route, body) =>
  fetch(`${HOST}/__api/sessions/${SID}/${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(25_000),
  }).then(async (res) => {
    const v = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(v?.error || `HTTP ${res.status}`);
    return v;
  });

// POLICY tool.after (PostToolUse, codex sessions): the extensions see what the tool returned. An MCP tool's result can
// be replaced outright; a built-in's cannot through a hook, so a refusal/redaction is fed back as a blocking reason.
if (ev.hook_event_name === 'PostToolUse' && !GATES) process.exit(0); // only the gates path judges outputs
if (ev.hook_event_name === 'PostToolUse') {
  let out = ev.tool_response ?? '';
  if (typeof out !== 'string') try { out = JSON.stringify(out); } catch { out = String(out); }
  try {
    const v = await post('policy', { gate: 'tool.after', tool: toolName, input: ev.tool_input ?? {}, output: out });
    if (v.ok && typeof v.output !== 'string') process.exit(0);
    if (v.ok && toolName.startsWith('mcp__')) {
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', updatedMCPToolOutput: v.output } }));
      process.exit(0);
    }
    const reason = v.ok ? `Redacted by policy (${(v.changedBy || []).join(', ')}): treat the previous ${toolName} output as replaced by:\n${v.output}` : `Blocked by policy${v.ext ? ` (${v.ext})` : ''}: ${v.reason}. Do not use the ${toolName} output.`;
    process.stdout.write(JSON.stringify({ decision: 'block', reason }));
    process.exit(0);
  } catch (e) {
    process.stdout.write(JSON.stringify({ decision: 'block', reason: `[arigami policy] could not check the ${toolName} output (${e?.message || e}); do not use it.` }));
    process.exit(0);
  }
}

try {
  // A3 allowlist, then the extensions' tool.before gates — one round-trip (api.ts .../policy/check).
  const v = await post('policy/check', { tool_name: toolName, input: ev.tool_input ?? {}, gates: GATES });
  if (v.allow === false) {
    process.stderr.write(`[arigami policy] blocked: ${v.reason || 'not allowed for this agent'}\n`);
    process.exit(2);
  }
  if (v.input && typeof v.input === 'object') {
    // A gate rewrote the arguments: the engine runs the call with these.
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: v.input } }));
  }
  process.exit(0);
} catch (e) {
  process.stderr.write(`[arigami policy] cannot verify "${toolName}" against the policy (${e?.message || e}) — blocked\n`);
  process.exit(2);
}
