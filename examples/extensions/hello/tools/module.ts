// A `kind:'module'` tool: plain functions with a schema. mcp/ext-mcp.js turns
// this file into a real MCP server, so the session sees `mcp__ext-hello__hello_echo`
// with no MCP code written here at all.
import type { ToolDef } from '@arigami/sdk';

export const tools: ToolDef[] = [
  {
    name: 'hello_echo',
    description: 'Echo a message back, prefixed with this extension\'s configured greeting. Proof that an extension tool reached the session.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'What to echo' } },
      required: ['text'],
    },
    run(args: { text: string }, ctx) {
      const greeting = String((ctx.settings as Record<string, unknown>)?.greeting || 'שלום');
      return { echo: `${greeting}, ${String(args.text)}`, extDir: ctx.extDir };
    },
  },
];
