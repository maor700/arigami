// The sandbox as a SIDECAR container of the host's pod (sandbox.mode 'sidecar', Helm `isolation.sandbox`): the wire
// format, the agent ⇄ launcher round trip (stdio, exit code, signals, refusals), and what a restricted session's spawn
// becomes — while a Full session's spawn stays exactly what the engine driver built.
import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { FRAME, encodeFrame, FrameReader } from '../docker/sandbox/sidecar-frames.ts';
import { startError } from '../docker/sandbox/sidecar-agent.ts';
import { runInChild } from './_child.js';
import { tmpDir } from './_tmp.js';

const REPO = path.resolve(import.meta.dir, '..');

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
    s.on('error', reject);
  });

describe('frames', () => {
  test('round trip, split anywhere', () => {
    const wire = Buffer.concat([encodeFrame(FRAME.STDOUT, 'hello'), encodeFrame(FRAME.EXIT, '{"code":0}'), encodeFrame(FRAME.STDIN, Buffer.alloc(0))]);
    const r = new FrameReader();
    const got: { type: number; payload: string }[] = [];
    for (let i = 0; i < wire.length; i += 3) {
      r.push(wire.subarray(i, i + 3));
      for (const f of r.drain()) got.push({ type: f.type, payload: f.payload.toString() });
    }
    expect(got).toEqual([{ type: FRAME.STDOUT, payload: 'hello' }, { type: FRAME.EXIT, payload: '{"code":0}' }, { type: FRAME.STDIN, payload: '' }]);
  });
});

describe('agent checks', () => {
  test('argv, env, an existing absolute cwd inside a work root', () => {
    const root = tmpDir('arigami-sbx-root-');
    fs.mkdirSync(path.join(root, 'w'));
    expect(startError({ argv: ['sh'], env: {}, cwd: path.join(root, 'w') }, [root])).toBeNull();
    expect(startError({ argv: [], env: {}, cwd: root }, [root])).toContain('argv');
    expect(startError({ argv: ['sh'], env: [], cwd: root }, [root])).toContain('env');
    expect(startError({ argv: ['sh'], env: {}, cwd: 'rel' }, [root])).toContain('absolute');
    expect(startError({ argv: ['sh'], env: {}, cwd: '/' }, [root])).toContain('outside');
    expect(startError({ argv: ['sh'], env: {}, cwd: path.join(root, 'nope') }, [root])).toContain('does not exist');
    // a symlink out of the root is judged by where it leads
    fs.symlinkSync('/', path.join(root, 'out'));
    expect(startError({ argv: ['sh'], env: {}, cwd: path.join(root, 'out') }, [root])).toContain('outside');
  });
});

describe('agent ⇄ launcher', () => {
  let agent: ChildProcess;
  let port = 0;
  let root = '';
  let runDir = '';
  beforeAll(async () => {
    root = tmpDir('arigami-sbx-work-');
    runDir = tmpDir('arigami-sbx-run-');
    port = await freePort();
    agent = spawn('bun', [path.join(REPO, 'docker/sandbox/sidecar-agent.ts')], {
      env: { PATH: process.env.PATH!, SANDBOX_AGENT_LISTEN: `127.0.0.1:${port}`, SANDBOX_WORK_ROOTS: root },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    for (let i = 0; i < 100; i++) {
      const up = await new Promise<boolean>((r) => { const s = net.connect(port, '127.0.0.1'); s.on('connect', () => { s.destroy(); r(true); }); s.on('error', () => r(false)); });
      if (up) return;
      await Bun.sleep(50);
    }
    throw new Error('agent did not start');
  });
  afterAll(() => agent?.kill('SIGTERM'));

  const launch = (spec: Record<string, unknown>, input = '') => {
    const f = path.join(runDir, `spec-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(f, JSON.stringify({ v: 1, sessionId: 's1', agent: `127.0.0.1:${port}`, ...spec }), { mode: 0o600 });
    return { f, p: Bun.spawn(['bun', path.join(REPO, 'server/lib/sandbox-sidecar-launch.ts'), f], { stdin: new Blob([input]), stdout: 'pipe', stderr: 'pipe' }) };
  };

  test('stdin in, stdout and stderr out, the exit code, the env it was given and nothing else; the spec is gone', async () => {
    const { f, p } = launch({ argv: ['sh', '-c', 'cat; printf "env=%s home=%s\\n" "$ONLY" "${SECRET_OF_THE_AGENT:-none}"; echo oops >&2; exit 3'], env: { ONLY: 'yes', PATH: process.env.PATH }, cwd: root }, 'from stdin\n');
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    expect(out).toBe('from stdin\nenv=yes home=none\n');
    expect(err).toContain('oops');
    expect(code).toBe(3);
    expect(fs.existsSync(f)).toBe(false);
  });

  test('SIGTERM to the launcher ends the engine and its process group', async () => {
    const mark = path.join(root, `alive-${Date.now()}`);
    const { p } = launch({ argv: ['sh', '-c', `(sleep 30; touch ${mark}) & sleep 30`], env: { PATH: process.env.PATH }, cwd: root });
    await Bun.sleep(400);
    p.kill('SIGTERM');
    const code = await p.exited;
    expect(code).not.toBe(0);
    await Bun.sleep(300);
    const left = Bun.spawnSync(['pgrep', '-f', `touch ${mark}`]).stdout.toString().trim();
    expect(left).toBe('');
  });

  test('a cwd outside the work roots never starts; the reason reaches the session', async () => {
    const { p } = launch({ argv: ['sh', '-c', 'echo ran'], env: { PATH: process.env.PATH }, cwd: '/' });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    expect(out).toBe('');
    expect(err).toContain('outside the shared work roots');
    expect(code).not.toBe(0);
  });

  test('a refused spec (the host said no) and an unreachable agent fail with the reason', async () => {
    const a = launch({ argv: [], env: {}, cwd: root, error: 'not in a shared folder' });
    expect(await new Response(a.p.stderr).text()).toContain('not in a shared folder');
    expect(await a.p.exited).toBe(1);
    const b = launch({ argv: ['true'], env: {}, cwd: root, agent: '127.0.0.1:1' });
    expect(await new Response(b.p.stderr).text()).toContain('not reachable');
    expect(await b.p.exited).toBe(1);
  });
});

describe('the spawn in sidecar mode (server/lib/sandbox.ts)', () => {
  const env = (d: string, roots: string) => ({ ARIGAMI_DIR: d, ARIGAMI_PORT: '', ARIGAMI_STATE_FILE: path.join(d, 'state.json'), ARIGAMI_SANDBOX: 'sidecar', ARIGAMI_SANDBOX_WORK_ROOTS: roots, ARIGAMI_SANDBOX_AGENT: '127.0.0.1:3299', ARIGAMI_SANDBOX_EGRESS: '127.0.0.1:3128' });
  const run = (d: string, roots: string, body: string) => {
    const r = runInChild("const sb=await import('./server/lib/sandbox.ts');" + body, env(d, roots));
    if (!r.ok) throw new Error(r.error);
    return r.out[0] as any;
  };

  test('a Full session is spawned exactly as built; a restricted one goes through the launcher with nothing but its spec path', () => {
    const d = tmpDir('arigami-sbxc-');
    const work = tmpDir('arigami-sbxc-work-');
    const o = run(d, work, `const built={bin:'/bin/true',args:['-p'],env:{A:'1',CLAUDE_CODE_OAUTH_TOKEN:'t'},cwd:${JSON.stringify(work)}};` +
      `const full=sb.wrapSpawn({id:'s_full'},built,'claude');const r=sb.wrapSpawn({id:'s_r',profile:{name:'p'}},built,'claude');` +
      `const spec=JSON.parse(require('fs').readFileSync(r.args[1],'utf8'));require('fs').rmSync(r.args[1]);emit({same:full===built,args0:r.args[0],envKeys:Object.keys(r.env).sort(),spec});`);
    expect(o.same).toBe(true);
    expect(o.args0).toEndWith('server/lib/sandbox-sidecar-launch.ts');
    expect(o.envKeys.every((k: string) => ['PATH', 'HOME', 'LANG', 'TMPDIR'].includes(k))).toBe(true);
    expect(o.spec.error).toBeUndefined();
    expect(o.spec.agent).toBe('127.0.0.1:3299');
    expect(o.spec.argv).toEqual(['/usr/bin/true', '-p'].map((x, i) => (i === 0 ? require('node:fs').realpathSync('/bin/true') : x)));
    const e = o.spec.env;
    expect(e.CLAUDE_CODE_OAUTH_TOKEN).toBe('t');
    expect(e.HOME).toBe(path.join(d, 'sandbox', 'sessions', 's_r', 'home'));
    expect(e.TMPDIR).toBe(path.join(d, 'sandbox', 'sessions', 's_r', 'tmp'));
    expect(e.HTTPS_PROXY).toMatch(/^http:\/\/s_r:[A-Za-z0-9_-]{32}@127\.0\.0\.1:3128$/);
    expect(e.ARIGAMI_SANDBOX).toBe('sidecar');
    // its egress policy is where the egress container reads it
    expect(JSON.parse(fs.readFileSync(path.join(d, 'sandbox', 'egress', 'policies', 's_r.json'), 'utf8')).allow).toContain('api.anthropic.com');
  });

  test("only this engine's credential: a codex session never gets the Claude token, nor a claude session codex's key", () => {
    const d = tmpDir('arigami-sbxc-');
    const work = tmpDir('arigami-sbxc-work-');
    const o = run(d, work, `const built={bin:'/bin/true',args:[],env:{CLAUDE_CODE_OAUTH_TOKEN:'c',ANTHROPIC_API_KEY:'a',OPENAI_API_KEY:'o'},cwd:${JSON.stringify(work)}};` +
      `const sp=(e)=>{const r=sb.wrapSpawn({id:'s_'+e,profile:{name:'p'}},built,e);const s=JSON.parse(require('fs').readFileSync(r.args[1],'utf8'));require('fs').rmSync(r.args[1]);return s.env;};` +
      `const c=sp('claude'),x=sp('codex');emit({c:[c.CLAUDE_CODE_OAUTH_TOKEN,c.ANTHROPIC_API_KEY,c.OPENAI_API_KEY],x:[x.CLAUDE_CODE_OAUTH_TOKEN,x.ANTHROPIC_API_KEY,x.OPENAI_API_KEY]});`);
    expect(o.c).toEqual(['c', 'a', null]);
    expect(o.x).toEqual([null, null, 'o']);
  });

  test("a folder outside the shared work roots — or one that would expose the host's state — is refused, never run on the host", () => {
    const d = tmpDir('arigami-sbxc-');
    const work = tmpDir('arigami-sbxc-work-');
    const o = run(d, work, `const go=(cwd)=>{const r=sb.wrapSpawn({id:'s1',profile:{name:'p'}},{bin:'/bin/true',args:[],env:{},cwd},'claude');const s=JSON.parse(require('fs').readFileSync(r.args[1],'utf8'));require('fs').rmSync(r.args[1]);return {err:s.error||null,argv:s.argv};};` +
      `emit({out:go('/'),state:go(${JSON.stringify(d)}),noRoots:null});`);
    expect(o.out.err).toContain('not in a folder the sandbox shares');
    expect(o.out.argv).toEqual([]);
    expect(o.state.err).toBeTruthy();
    const none = run(d, '', `const r=sb.wrapSpawn({id:'s1',profile:{name:'p'}},{bin:'/bin/true',args:[],env:{},cwd:${JSON.stringify(work)}},'claude');const s=JSON.parse(require('fs').readFileSync(r.args[1],'utf8'));require('fs').rmSync(r.args[1]);emit(s.error);`);
    expect(none).toContain('no shared work roots');
  });

  test('codex: its own CODEX_HOME in the session dir — the config copied, a minimal read-only login without the refresh token', () => {
    const d = tmpDir('arigami-sbxc-');
    const work = tmpDir('arigami-sbxc-work-');
    const login = path.join(tmpDir('arigami-sbxc-owner-'), 'auth.json');
    fs.writeFileSync(login, JSON.stringify({ auth_mode: 'chatgpt', tokens: { id_token: 'i', access_token: 'a', account_id: 'x', refresh_token: 'LONG-LIVED' }, last_refresh: 'now' }));
    const ch = path.join(d, 'codex', 's1');
    fs.mkdirSync(ch, { recursive: true });
    fs.writeFileSync(path.join(ch, 'config.toml'), 'model = "m"\n');
    fs.symlinkSync(login, path.join(ch, 'auth.json'));
    const o = run(d, work, `const r=sb.wrapSpawn({id:'s1',profile:{name:'p'}},{bin:'/bin/true',args:[],env:{CODEX_HOME:${JSON.stringify(ch)}},cwd:${JSON.stringify(work)}},'codex');const s=JSON.parse(require('fs').readFileSync(r.args[1],'utf8'));require('fs').rmSync(r.args[1]);emit(s);`);
    const home = path.join(d, 'sandbox', 'sessions', 's1', 'codex');
    expect(o.env.CODEX_HOME).toBe(home);
    expect(fs.readFileSync(path.join(home, 'config.toml'), 'utf8')).toBe('model = "m"\n');
    const auth = JSON.parse(fs.readFileSync(path.join(home, 'auth.json'), 'utf8'));
    expect(auth.tokens).toEqual({ id_token: 'i', access_token: 'a', account_id: 'x', refresh_token: '' });
    expect(fs.statSync(path.join(home, 'auth.json')).mode & 0o777).toBe(0o400);
    expect(o.ephemeral).toEqual([path.join(home, 'auth.json')]);
    expect(JSON.stringify(o)).not.toContain('LONG-LIVED');
  });
});
