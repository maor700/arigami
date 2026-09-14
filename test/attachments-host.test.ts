// ZIP: end-to-end against an isolated host — the streamed upload endpoint
// (auth, wrong session, size cap) and the inline base64 path both land the
// same archive summary in the turn the model actually sees.
import { test, expect, beforeAll, afterAll, describe } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let host: ChildProcess;
let dir: string;
let base: string;
let ws: string;
let stdinLogDir: string;

const freePort = (): Promise<number> =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => Promise<T | null | undefined | false>, ms = 8000): Promise<T> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await fn();
    if (v) return v as T;
    await sleep(50);
  }
  throw new Error('condition not met in time');
}

async function api(method: string, p: string, body?: unknown): Promise<{ status: number; json: any }> {
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  try {
    return { status: r.status, json: JSON.parse(text) };
  } catch {
    return { status: r.status, json: { raw: text } };
  }
}

/** The last "user" turn's injected text for a session, from the stub's stdin log. */
const lastUserText = (sid: string): string | null => {
  const f = path.join(stdinLogDir, `${sid}.jsonl`);
  if (!fs.existsSync(f)) return null;
  const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
  if (!lines.length) return null;
  let j: any;
  try {
    j = JSON.parse(lines[lines.length - 1]);
  } catch {
    return null; // the stub is mid-write (torn last line) — the caller polls again
  }
  return (j.message?.content || []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n');
};

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-ZIP-host-'));
  stdinLogDir = path.join(dir, 'stdin-log');
  fs.mkdirSync(stdinLogDir, { recursive: true });
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-ZIP-ws-'));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });

  // A stream-json stub that logs every 'user' turn it receives (so the test
  // can inspect the exact text the model would have seen) and answers with
  // one assistant message + a result, like the other host-test stubs.
  const stub = path.join(dir, 'claude-stub.js');
  fs.writeFileSync(
    stub,
    `#!/usr/bin/env bun
const fs=require('node:fs');
const path=require('node:path');
const sidIdx=process.argv.indexOf('--session-id');const rsIdx=process.argv.indexOf('--resume');
const sid=sidIdx>0?process.argv[sidIdx+1]:rsIdx>0?process.argv[rsIdx+1]:'stub';
const out=(o)=>process.stdout.write(JSON.stringify(o)+'\\n');
out({type:'system',subtype:'init',session_id:sid,model:'claude-stub',tools:['Bash','Read'],mcp_servers:[]});
// Log by the ARIGAMI session id (env), not the claude-internal --session-id
// UUID above — those are two different ids and the test needs the former.
const logFile=path.join(${JSON.stringify(stdinLogDir)},process.env.ARIGAMI_SESSION_ID+'.jsonl');
let buf='';
process.stdin.on('data',(d)=>{buf+=d;let i;while((i=buf.indexOf('\\n'))>=0){const line=buf.slice(0,i);buf=buf.slice(i+1);if(!line.trim())continue;
  let j={};try{j=JSON.parse(line);}catch{}
  if(j.type!=='user')continue;
  fs.appendFileSync(logFile, JSON.stringify(j)+'\\n');
  out({type:'assistant',message:{role:'assistant',content:[{type:'text',text:'ok'}],usage:{input_tokens:10,output_tokens:10,cache_creation_input_tokens:0,cache_read_input_tokens:0}}});
  out({type:'result',subtype:'success',session_id:sid,is_error:false,result:'ok',duration_ms:1,num_turns:1,total_cost_usd:0.001});
}});
setInterval(()=>{},1e6);
`,
    { mode: 0o755 }
  );

  host = spawn('bun', ['server/index.ts'], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOME: home,
      ARIGAMI_DIR: dir,
      ARIGAMI_PORT: String(port),
      ARIGAMI_AUTH: 'off',
      ARIGAMI_SCREEN_ENABLED: '0',
      ARIGAMI_CLAUDE_BIN: stub,
      ARIGAMI_WA_DATA_DIR: path.join(dir, 'wa'),
      ARIGAMI_TELEMETRY: '0',
      ARIGAMI_DEFAULT_CWD: ws,
      ARIGAMI_ATTACHMENT_MAX_BYTES: '2048', // tiny cap so the 413 path is cheap to exercise
      COMPOSIO_API_KEY: '',
      GH_TOKEN: '',
      GITHUB_TOKEN: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  host.stdout!.on('data', (d) => (log += d));
  host.stderr!.on('data', (d) => (log += d));
  try {
    await until(async () => {
      try {
        return (await fetch(base + '/__api/config')).ok;
      } catch {
        return false;
      }
    }, 30000);
  } catch {
    throw new Error(`host did not come up: ${log.slice(-1500)}`);
  }
}, 60_000); // the host boot below waits up to 30s; bun caps hooks at 5s by default

afterAll(() => {
  try {
    host?.kill('SIGTERM');
  } catch {}
});

let sid = '';

test('setup: create a session', async () => {
  const r = await api('POST', '/__api/sessions', { title: 'zip-test', cwd: ws });
  expect(r.status).toBe(201);
  sid = r.json.id;
});

test('POST .../attachments on an unknown session 404s', async () => {
  const r = await fetch(`${base}/__api/sessions/does-not-exist/attachments`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain', 'x-arigami-filename': 'a.txt' },
    body: 'hi',
  });
  expect(r.status).toBe(404);
});

test('a body past the (tiny, test-only) cap is rejected with 413', async () => {
  const big = 'x'.repeat(4096);
  const r = await fetch(`${base}/__api/sessions/${sid}/attachments`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain', 'x-arigami-filename': 'big.txt' },
    body: big,
  });
  expect(r.status).toBe(413);
  expect((await r.json()).error).toMatch(/cap/);
});

test('a plain (non-archive) streamed upload is saved and returns a descriptor without an archive field', async () => {
  const r = await fetch(`${base}/__api/sessions/${sid}/attachments`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain', 'x-arigami-filename': 'notes.txt' },
    body: 'just some notes',
  });
  expect(r.status).toBe(201);
  const j = await r.json();
  expect(j.name).toBe('notes.txt');
  expect(j.archive).toBeUndefined();
  expect(fs.readFileSync(j.path, 'utf8')).toBe('just some notes');
});

test('a streamed zip upload extracts, and referencing its path in .../message injects the tree', async () => {
  const py = Bun.spawnSync(['python3', '-c', `
import zipfile, io
buf = io.BytesIO()
with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as zf:
    zf.writestr('readme.txt', 'hi from the archive')
    zf.writestr('src/index.js', 'console.log(1)')
import sys
sys.stdout.buffer.write(buf.getvalue())
`]);
  expect(py.exitCode).toBe(0);
  const zipBytes = py.stdout;

  const up = await fetch(`${base}/__api/sessions/${sid}/attachments`, {
    method: 'POST',
    headers: { 'content-type': 'application/zip', 'x-arigami-filename': 'bundle.zip' },
    body: zipBytes,
  });
  expect(up.status).toBe(201);
  const descriptor = await up.json();
  expect(descriptor.archive.entryCount).toBe(2);
  expect(descriptor.archive.dir).toContain('bundle.zip.d');

  const sent = await api('POST', `/__api/sessions/${sid}/message`, {
    text: 'here is a bundle',
    attachments: [{ name: descriptor.name, type: descriptor.type, path: descriptor.path }],
  });
  expect(sent.status).toBe(200);

  const injected = await until(() => Promise.resolve(lastUserText(sid)));
  expect(injected).toContain('here is a bundle');
  expect(injected).toContain('📦 bundle.zip');
  expect(injected).toContain('extracted to');
  expect(injected).toContain('readme.txt');
  expect(injected).toContain('src/index.js');
  expect(injected).toContain('2 entries');
});

test('ZIP2: DELETE .../attachments removes the spooled file and its extraction dir', async () => {
  const py = Bun.spawnSync(['python3', '-c', `
import zipfile, io
buf = io.BytesIO()
with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as zf:
    zf.writestr('a.txt', 'aaa')
import sys
sys.stdout.buffer.write(buf.getvalue())
`]);
  expect(py.exitCode).toBe(0);

  const up = await fetch(`${base}/__api/sessions/${sid}/attachments`, {
    method: 'POST',
    headers: { 'content-type': 'application/zip', 'x-arigami-filename': 'removeme.zip' },
    body: py.stdout,
  });
  expect(up.status).toBe(201);
  const descriptor = await up.json();
  expect(fs.existsSync(descriptor.path)).toBe(true);
  expect(fs.existsSync(descriptor.archive.dir)).toBe(true);

  const del = await fetch(`${base}/__api/sessions/${sid}/attachments?path=${encodeURIComponent(descriptor.path)}`, { method: 'DELETE' });
  expect(del.status).toBe(200);
  expect((await del.json()).ok).toBe(true);
  expect(fs.existsSync(descriptor.path)).toBe(false);
  expect(fs.existsSync(descriptor.archive.dir)).toBe(false);
});

test('ZIP2: DELETE .../attachments refuses a path outside this session\'s upload dir', async () => {
  const outside = path.join(os.tmpdir(), `arigami-zip2-outside-${Date.now()}.txt`);
  fs.writeFileSync(outside, 'do not delete me');
  const del = await fetch(`${base}/__api/sessions/${sid}/attachments?path=${encodeURIComponent(outside)}`, { method: 'DELETE' });
  expect(del.status).toBe(200);
  expect((await del.json()).ok).toBe(false);
  expect(fs.existsSync(outside)).toBe(true);
  fs.rmSync(outside, { force: true });
});

test('an inline base64 archive (small enough for the JSON path) is described the same way', async () => {
  const py = Bun.spawnSync(['python3', '-c', `
import zipfile, io, base64
buf = io.BytesIO()
with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as zf:
    zf.writestr('a.txt', 'aaa')
    zi = zipfile.ZipInfo('../escape.txt')
    zf.writestr(zi, 'nope')
import sys
sys.stdout.write(base64.b64encode(buf.getvalue()).decode())
`]);
  expect(py.exitCode).toBe(0);
  const b64 = py.stdout.toString();

  const sent = await api('POST', `/__api/sessions/${sid}/message`, {
    text: 'inline archive',
    attachments: [{ name: 'inline.zip', type: 'application/zip', dataBase64: b64 }],
  });
  expect(sent.status).toBe(200);
  const injected = await until(() => {
    const t = lastUserText(sid);
    return Promise.resolve(t && t.includes('inline archive') ? t : null);
  });
  expect(injected).toContain('📦 inline.zip');
  expect(injected).toContain('1 entr'); // "1 entry rejected" — traversal caught
  expect(injected).toMatch(/rejected/);
});

// ZIP3: the real-world bug this covers — a Windows-produced zip, 1335
// entries, every one backslash-separated — only got 57 of 1335 entries out
// before the fix, and the chat card didn't say so. These exercise the fix
// through the actual HTTP pipeline (upload endpoint → extraction → the text
// the model receives), not just the extractor function directly. A second,
// dedicated host is used here — the shared one above runs with a 2KB
// attachment cap (to cheaply exercise the 413 path) that a several-hundred-
// entry zip can't fit under regardless of entry count.
describe('ZIP3: end-to-end on a dedicated isolated host (real attachment size cap)', () => {
  let host2: ChildProcess;
  let base2: string;
  let sid2: string;

  beforeAll(async () => {
    // A separate ARIGAMI_DIR/HOME — two host processes can't share a
    // hostlock. Same `stub` binary and `stdinLogDir` as the shared host
    // above (both absolute paths baked in at creation time), so the same
    // stdin-log inspection helpers work unchanged.
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-ZIP3-host2-'));
    const home2 = path.join(dir2, 'home');
    fs.mkdirSync(home2, { recursive: true });
    const stub2 = path.join(dir, 'claude-stub.js');
    const port = await freePort();
    base2 = `http://127.0.0.1:${port}`;
    host2 = spawn('bun', ['server/index.ts'], {
      cwd: ROOT,
      env: {
        ...process.env,
        HOME: home2,
        ARIGAMI_DIR: dir2,
        ARIGAMI_PORT: String(port),
        ARIGAMI_AUTH: 'off',
        ARIGAMI_SCREEN_ENABLED: '0',
        ARIGAMI_CLAUDE_BIN: stub2,
        ARIGAMI_WA_DATA_DIR: path.join(dir2, 'wa'),
        ARIGAMI_TELEMETRY: '0',
        ARIGAMI_DEFAULT_CWD: ws,
        COMPOSIO_API_KEY: '',
        GH_TOKEN: '',
        GITHUB_TOKEN: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log2 = '';
    host2.stdout!.on('data', (d) => (log2 += d));
    host2.stderr!.on('data', (d) => (log2 += d));
    try {
      await until(async () => {
        try {
          return (await fetch(base2 + '/__api/config')).ok;
        } catch {
          return false;
        }
      }, 30000);
    } catch {
      throw new Error(`second host did not come up: ${log2.slice(-1500)}`);
    }
    const r = await fetch(base2 + '/__api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'zip3-test', cwd: ws }),
    });
    sid2 = (await r.json()).id;
  }, 40000);

  afterAll(() => {
    try {
      host2?.kill('SIGTERM');
    } catch {}
  });

  test('a streamed 1100-entry backslash-separated (Windows) zip extracts completely', async () => {
    const py = Bun.spawnSync(['python3', '-c', `
import zipfile, io
buf = io.BytesIO()
with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as zf:
    for i in range(1100):
        zf.writestr(f'proj\\\\group{i % 20}\\\\file{i}.txt', f'content {i}')
import sys
sys.stdout.buffer.write(buf.getvalue())
`]);
    expect(py.exitCode).toBe(0);

    const up = await fetch(`${base2}/__api/sessions/${sid2}/attachments`, {
      method: 'POST',
      headers: { 'content-type': 'application/zip', 'x-arigami-filename': 'winbundle.zip' },
      body: py.stdout,
    });
    expect(up.status).toBe(201);
    const descriptor = await up.json();
    expect(descriptor.archive.error).toBeUndefined();
    expect(descriptor.archive.entriesTotal).toBe(1100);
    expect(descriptor.archive.entryCount).toBe(1100);
    expect(descriptor.archive.rejectedCount).toBe(0);
    expect(fs.readFileSync(path.join(descriptor.archive.dir, 'proj/group7/file7.txt'), 'utf8')).toBe('content 7');
    expect(fs.readFileSync(path.join(descriptor.archive.dir, 'proj/group19/file1099.txt'), 'utf8')).toBe('content 1099');
  });

  test('a partial extraction is described honestly in the injected turn text, not as a clean success', async () => {
    const py = Bun.spawnSync(['python3', '-c', `
import zipfile, io
buf = io.BytesIO()
with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as zf:
    zf.writestr('ok1.txt', 'fine1')
    zf.writestr('conflict/', '')
    zf.writestr('conflict', 'this collides with the directory above')
    zf.writestr('ok2.txt', 'fine2')
import sys
sys.stdout.buffer.write(buf.getvalue())
`]);
    expect(py.exitCode).toBe(0);

    const up = await fetch(`${base2}/__api/sessions/${sid2}/attachments`, {
      method: 'POST',
      headers: { 'content-type': 'application/zip', 'x-arigami-filename': 'partial.zip' },
      body: py.stdout,
    });
    expect(up.status).toBe(201);
    const descriptor = await up.json();
    expect(descriptor.archive.entriesTotal).toBe(4);
    expect(descriptor.archive.entryCount).toBe(3); // the colliding "conflict" file entry was rejected
    expect(descriptor.archive.rejectedCount).toBe(1);

    const sent = await fetch(`${base2}/__api/sessions/${sid2}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: 'partial archive',
        attachments: [{ name: descriptor.name, type: descriptor.type, path: descriptor.path }],
      }),
    });
    expect(sent.status).toBe(200);
    const injected = await until(() => {
      const f = path.join(stdinLogDir, `${sid2}.jsonl`);
      if (!fs.existsSync(f)) return Promise.resolve(null);
      const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
      if (!lines.length) return Promise.resolve(null);
      const j = JSON.parse(lines[lines.length - 1]);
      const t = (j.message?.content || []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n');
      return Promise.resolve(t.includes('partial archive') ? t : null);
    });
    // "3 of 4 entries", never a bare "3 entries" that reads as complete
    expect(injected).toContain('3 of 4 entries');
    expect(injected).toMatch(/rejected/);
  });
});
