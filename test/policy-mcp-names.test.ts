// One allowlist, both engines: claude names an MCP tool after the server as configured (mcp__ext-gatekeeper__x);
// codex sanitises the server name (mcp__ext_gatekeeper__x). agent-policy matches both spellings the same way, for an
// agent allowlist and for a restricted session profile alike (the PreToolUse hook and the host MCP filter both ask it).
import { test, expect, describe, afterAll } from 'bun:test';
import * as pol from '../server/agent-policy.ts';
import * as sp from '../server/session-profile.ts';

const restricted = (tools: string[]) => sp.policyForSession({ profile: sp.fromSpec({ tools }) });
const CLAUDE = 'mcp__ext-gatekeeper__gatekeeper_status';
const CODEX = 'mcp__ext_gatekeeper__gatekeeper_status';

describe('MCP tool names are engine-agnostic', () => {
  // FAMILIES is module state shared by every test file in this process: leave it as found.
  afterAll(() => pol.setExtFamilies({}));
  test('mcpCanonical folds the server segment only', () => {
    expect(pol.mcpCanonical(CLAUDE)).toBe(CODEX);
    expect(pol.mcpCanonical(CODEX)).toBe(CODEX);
    expect(pol.mcpCanonical('mcp__composio-mcp__GMAIL_SEND-X')).toBe('mcp__composio_mcp__GMAIL_SEND-X');
    expect(pol.mcpCanonical('Bash')).toBe('Bash');
    expect(pol.mcpCanonical('mcp__ext-gatekeeper-*')).toBe('mcp__ext_gatekeeper_*');
  });
  for (const [label, entry] of [['family ext:gatekeeper', 'ext:gatekeeper'], ['claude pattern', 'mcp__ext-gatekeeper__*'], ['codex pattern', 'mcp__ext_gatekeeper__*']] as const) {
    test(`a profile allowing ${label} allows the tool on claude AND codex`, () => {
      pol.setExtFamilies({ 'ext:gatekeeper': ['mcp__ext-gatekeeper__*', 'mcp__ext-gatekeeper-*'] });
      const p = restricted(['git', entry]);
      expect(pol.toolAllowed(p, CLAUDE)).toBe(true);
      expect(pol.toolAllowed(p, CODEX)).toBe(true);
      expect(pol.checkToolCall(p, CODEX, {}).allow).toBe(true);
      expect(pol.serverReachable(p, 'ext-gatekeeper')).toBe(true);
      expect(pol.serverReachable(p, 'ext_gatekeeper')).toBe(true);
    });
  }
  test('without the entry both spellings stay denied, and other servers are untouched', () => {
    const p = restricted(['git']);
    expect(pol.toolAllowed(p, CLAUDE)).toBe(false);
    expect(pol.toolAllowed(p, CODEX)).toBe(false);
    const g = restricted(['git', 'mcp__ext-gatekeeper__*']);
    expect(pol.toolAllowed(g, 'mcp__ext_other__x')).toBe(false);
    expect(pol.toolAllowed(g, 'mcp__composio_mcp__GMAIL_SEND')).toBe(false);
  });
  test('an agent allowlist (A3) gets the same: codex spelling of an allowed external tool passes', () => {
    const p: pol.Policy = { slug: 'a', tools: pol.expandTools(['mcp__composio-mcp__GMAIL_*']), domains: null, autoApprove: [] };
    expect(pol.toolAllowed(p, 'mcp__composio_mcp__GMAIL_SEND')).toBe(true);
    expect(pol.toolAllowed(p, 'mcp__composio_mcp__GOOGLEDRIVE_LIST')).toBe(false);
  });
});
