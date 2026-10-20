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
// MODS: with `--mods` (codex sessions — codex has no mods, so this hook IS their adapter) PreToolUse also runs the
// extensions' mods' tool.call hooks up to next() in the host (server/mods.ts), and PostToolUse hands the tool's
// result back to the suspended chain. Claude sessions run the same mods natively, so the flag is off there.
const MODS = process.argv.includes('--mods');
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

// MODS tool.call, after the tool ran (PostToolUse): the chain that was suspended at next() decides. An MCP tool's
// result can be replaced outright; a built-in's cannot through a hook, so it is blocked with the new text as the reason.
if (ev.hook_event_name === 'PostToolUse') {
  try {
    const v = await post('mods/tool-post', { tool: toolName, tool_use_id: ev.tool_use_id || '', output: ev.tool_response ?? '' });
    if (v.replace !== undefined && toolName.startsWith('mcp__')) {
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', updatedMCPToolOutput: v.replace } }));
    } else if (v.replace !== undefined) {
      process.stdout.write(JSON.stringify({ decision: 'block', reason: `A mod replaced the ${toolName} output; use this instead:\n${v.replace}` }));
    } else if (v.block !== undefined) {
      process.stdout.write(JSON.stringify({ decision: 'block', reason: v.block }));
    }
    process.exit(0);
  } catch (e) {
    process.stdout.write(JSON.stringify({ decision: 'block', reason: `[arigami mods] could not check the ${toolName} output (${e?.message || e}); do not use it.` }));
    process.exit(0);
  }
}

try {
  // A3 allowlist, then the mods' tool.call hooks up to next() — one round-trip (api.ts .../policy/check).
  const v = await post('policy/check', { tool_name: toolName, input: ev.tool_input ?? {}, mods: MODS, tool_use_id: ev.tool_use_id || '' });
  if (v.allow === false) {
    process.stderr.write(`[arigami policy] blocked: ${v.reason || 'not allowed for this agent'}\n`);
    process.exit(2);
  }
  if (v.input && typeof v.input === 'object') {
    // A mod passed changed arguments to next(): the engine runs the call with these.
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: v.input } }));
  }
  process.exit(0);
} catch (e) {
  process.stderr.write(`[arigami policy] cannot verify "${toolName}" against the policy (${e?.message || e}) — blocked\n`);
  process.exit(2);
}
