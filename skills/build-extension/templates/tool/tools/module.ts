// A `kind:'module'` tool: plain functions with a JSON schema. The host wraps this
// file with mcp/ext-mcp.js — a real MCP stdio server — so a session sees
// `mcp__ext-{{name}}__{{tool}}` and no MCP protocol code is written here.
//
// The tool list of a session is fixed when its `claude` process spawns, so a NEW
// tool appears in the NEXT session (or after restart_session). Until then, call it
// through the host: POST /__api/ext/{{name}}/tool/{{tool}} {"args":{…}}
// (that route requires `tools:{{tool}}` in the manifest permissions).
import type { ToolDef } from '@arigami/sdk';

export const tools: ToolDef[] = [
  {
    name: '{{tool}}',
    // The description is what Claude reads to decide whether to call this. Say
    // what it returns and when to use it — not how it is implemented.
    description: '{{description}}',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to look up' },
        limit: { type: 'number', description: 'Max rows to return (default 10)' },
      },
      required: ['query'],
    },
    async run(args: { query: string; limit?: number }, ctx) {
      const base = String(ctx.settings.baseUrl || '').replace(/\/$/, '');
      if (!base) return { error: 'baseUrl is not set — Settings → Extensions → {{title}}' };

      // ctx.secrets holds $ARIGAMI_DIR/extensions.json secrets[{{name}}] — never a
      // constant in this file, and never in the human's git repo.
      const res = await ctx.fetch(`${base}/search?q=${encodeURIComponent(args.query)}`, {
        headers: ctx.secrets.API_KEY ? { authorization: `Bearer ${ctx.secrets.API_KEY}` } : {},
      });
      if (!res.ok) return { error: `upstream ${res.status} ${res.statusText}` };

      const rows = ((await res.json()) as { rows?: unknown[] }).rows || [];
      // Return DATA, small and already trimmed — the result goes into the model's
      // context, so paging beats dumping.
      return { count: rows.length, rows: rows.slice(0, Number(args.limit) || 10) };
    },
  },
];
