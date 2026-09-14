// P2-3: the host MCP server's tools/list hides permission_prompt from a codex session only.
import { test, expect } from 'bun:test';
import path from 'node:path';
import { spawn } from 'node:child_process';

const MCP = path.resolve(import.meta.dir, '../mcp/host-mcp.js');

async function toolNames(engine: string | null): Promise<string[]> {
  const env: Record<string, string | undefined> = { ...process.env, ARIGAMI_URL: 'http://127.0.0.1:1', ARIGAMI_SESSION_ID: 'sess_test', ARIGAMI_AGENT: '', ARIGAMI_ENGINE: engine ?? '' };
  const child = spawn('bun', [MCP], { env, stdio: ['pipe', 'pipe', 'ignore'] });
  let buf = '';
  const listed = new Promise<string[]>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no tools/list reply')), 20000);
    child.stdout!.on('data', (d) => {
      buf += d;
      for (const line of buf.split('\n')) {
        try {
          const j = JSON.parse(line);
          if (j.id === 2) {
            clearTimeout(timer);
            resolve(j.result.tools.map((t: any) => t.name));
          }
        } catch {}
      }
    });
  });
  const send = (o: unknown) => child.stdin!.write(JSON.stringify(o) + '\n');
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  try {
    return await listed;
  } finally {
    child.kill();
  }
}

test('permission_prompt is absent for a codex session and present for claude', async () => {
  const codex = await toolNames('codex');
  expect(codex).toContain('set_status');
  expect(codex).not.toContain('permission_prompt');
  expect(await toolNames(null)).toContain('permission_prompt');
}, 60000);
