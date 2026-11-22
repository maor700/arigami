// The shared MCP output-schema validator: re-listing tools must not compile (and keep) the schemas again,
// and a tool's structuredContent is still validated against its outputSchema.
import { test, expect } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { mcpClientOptions, compiledSchemas, sharedValidator, CAP } from '../server/lib/mcp-validator.ts';

const TOOLS = 20;
// Fresh objects on every list, exactly like a remote server's JSON response.
const tools = () =>
  Array.from({ length: TOOLS }, (_, i) => ({
    name: `t${i}`,
    inputSchema: { type: 'object' as const },
    outputSchema: { type: 'object' as const, properties: { [`f${i}`]: { type: 'string' } }, required: [`f${i}`] },
  }));

async function connected(): Promise<Client> {
  const server = new Server({ name: 'fake', version: '1' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools() }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => ({
    content: [],
    structuredContent: req.params.name === 't0' ? { f0: 'ok' } : { wrong: 1 },
  }));
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  const client = new Client({ name: 'c', version: '1' }, mcpClientOptions());
  await client.connect(a);
  return client;
}

test('re-listing the same tools compiles each output schema once', async () => {
  const client = await connected();
  const before = compiledSchemas();
  await client.listTools();
  const once = compiledSchemas();
  expect(once - before).toBe(TOOLS);
  for (let i = 0; i < 50; i++) await client.listTools();
  expect(compiledSchemas()).toBe(once);
});

test('structuredContent is still checked against the outputSchema', async () => {
  const client = await connected();
  await client.listTools();
  expect(((await client.callTool({ name: 't0', arguments: {} })) as any).structuredContent).toEqual({ f0: 'ok' });
  await expect(client.callTool({ name: 't1', arguments: {} })).rejects.toThrow(/structured content does not match/i);
});

test('the cache is bounded: past CAP distinct schemas it starts a new generation', () => {
  for (let i = 0; i <= CAP; i++) sharedValidator.getValidator({ type: 'object', properties: { [`cap${i}`]: { type: 'number' } } });
  expect(compiledSchemas()).toBeLessThanOrEqual(CAP);
  const v = sharedValidator.getValidator({ type: 'number' });
  expect(v(1).valid).toBe(true);
  expect(v('x').valid).toBe(false);
});
