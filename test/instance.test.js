// T5 instance isolation: paths, identity, the sweep planner and the host lock.
// Everything path-related is captured at import → each case runs in a child
// with its own ARIGAMI_DIR (see _child.js).
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runInChild } from './_child.js';
import { planSweep } from '../server/lib/children.ts';
import { judgeHostInfo, portFree } from '../server/lib/hostlock.ts';
import { makeHostId } from '../server/lib/instance.ts';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-t5-'));

// ---- paths -------------------------------------------------------------------

test('every instance path lives under ARIGAMI_DIR (children, host.pid, state, chat, uploads, chrome, vapid, sms, secrets)', () => {
  const dir = tmp();
  const r = runInChild(
    "const inst=await import('./server/lib/instance.ts');" +
      "const {cfg}=await import('./server/lib/config.ts');" +
      "const sec=await import('./server/lib/secrets.ts');" +
      "const chrome=await import('./server/lib/chrome.ts');" +
      "const shots=await import('./server/screenshots.ts');" +
      'emit({dir:inst.ARIGAMI_DIR,isDefault:inst.IS_DEFAULT_INSTANCE,pid:inst.HOST_PID_FILE,configDir:cfg.configDir,state:cfg.stateFile,chat:cfg.chatDir,' +
      'secrets:sec.SECRETS_ENV,chromeBase:chrome.CHROME_BASE_DIR,chromeSessions:chrome.CHROME_SESSIONS_DIR,screens:shots.SCREENS_DIR,port:cfg.port});',
    { ARIGAMI_DIR: dir, ARIGAMI_PORT: '' }
  );
  if (!r.ok) throw new Error(r.error);
  const o = r.out[0];
  expect(o.isDefault).toBe(false);
  expect(o.port).toBe(4099); // shifted default
  for (const k of ['pid', 'configDir', 'state', 'chat', 'secrets', 'chromeBase', 'chromeSessions', 'screens'])
    expect(o[k].startsWith(dir + path.sep) || o[k] === dir).toBe(true);
  // and nothing points at the real default dir
  const home = path.join(os.homedir(), '.arigami');
  for (const v of Object.values(o)) if (typeof v === 'string') expect(v.startsWith(home + path.sep) || v === home).toBe(false);
});

test('children.json/vapid/sms modules resolve under ARIGAMI_DIR via a source grep (no hard-coded ~/.arigami left)', () => {
  const root = path.resolve(import.meta.dir, '..');
  const offenders = [];
  const walk = (d) => {
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f);
      if (fs.statSync(p).isDirectory()) { if (f !== 'node_modules') walk(p); continue; }
      if (!/\.(ts|js)$/.test(f)) continue;
      if (p.endsWith(path.join('lib', 'instance.ts'))) continue; // the ONE place allowed to spell out the default
      const src = fs.readFileSync(p, 'utf8');
      // code (not comments) that builds a path from HOME + '.arigami'
      for (const line of src.split('\n')) {
        const code = line.replace(/\/\/.*$/, '');
        if (/HOME[^\n]*['"]\.arigami['"]|['"]\.arigami['"][^\n]*HOME/.test(code)) offenders.push(p.replace(root + '/', '') + ': ' + line.trim());
      }
    }
  };
  walk(path.join(root, 'server'));
  walk(path.join(root, 'mcp'));
  expect(offenders).toEqual([]);
});

test('a config.json copied from the default instance cannot point a non-default instance at ~/.arigami state', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ stateFile: '~/.arigami/state.json', chatDir: '~/.arigami/chat' }));
  const r = runInChild("const {cfg}=await import('./server/lib/config.ts');emit({state:cfg.stateFile,chat:cfg.chatDir});", { ARIGAMI_DIR: dir, ARIGAMI_PORT: '' });
  if (!r.ok) throw new Error(r.error);
  expect(r.out[0].state).toBe(path.join(dir, 'state.json'));
  expect(r.out[0].chat).toBe(path.join(dir, 'chat'));
});

test('the default instance keeps its historical defaults (backward compatible)', () => {
  const r = runInChild(
    "const inst=await import('./server/lib/instance.ts');const {DEFAULTS}=await import('./server/lib/config.ts');" +
      'emit({isDefault:inst.IS_DEFAULT_INSTANCE,port:DEFAULTS.port,vnc:DEFAULTS.screen.portRange,disp:DEFAULTS.screen.displayBase,dev:DEFAULTS.devServerPorts[0],state:DEFAULTS.stateFile});',
    { ARIGAMI_DIR: '', ARIGAMI_PORT: '' }
  );
  if (!r.ok) throw new Error(r.error);
  expect(r.out[0]).toEqual({ isDefault: true, port: 3099, vnc: [5901, 5950], disp: 100, dev: 3020, state: '~/.arigami/state.json' });
});

// ---- sweep planner -------------------------------------------------------------

const ME = { hostId: makeHostId('/x/a', 3099), hostPid: 100 };
const OTHER = makeHostId('/x/b', 4099);
const rec = (pid, extra = {}) => ({ pid, tag: 't', at: 1, ...extra });

test('planSweep kills only OUR orphans: same hostId, host dead, child alive', () => {
  const alive = new Set([11, 12, 21, 31]);
  const plan = planSweep(
    [
      rec(11, { hostId: ME.hostId, hostPid: 99 }), // ours, previous host (99) dead → kill
      rec(12, { hostId: ME.hostId, hostPid: 100 }), // ours, hostPid is us → kill (leftover of this pid? still ours+alive)
      rec(13, { hostId: ME.hostId, hostPid: 99 }), // ours but already dead → dropped
      rec(21, { hostId: OTHER, hostPid: 99 }), // other host (dead) → keep, never touch
      rec(31, { hostId: OTHER, hostPid: 31 }), // other host (alive) → keep
    ],
    ME,
    (p) => alive.has(p),
    false
  );
  expect(plan.kill.map((r) => r.pid)).toEqual([11, 12]);
  expect(plan.keep.map((r) => r.pid)).toEqual([21, 31]);
});

test('planSweep leaves records alone when a host with our identity is still running', () => {
  const alive = new Set([11, 500]);
  const plan = planSweep([rec(11, { hostId: ME.hostId, hostPid: 500 })], ME, (p) => alive.has(p), false);
  expect(plan.kill).toEqual([]);
  expect(plan.keep.map((r) => r.pid)).toEqual([11]);
});

test('planSweep migration: pre-T5 records (no hostId) are ours only if the legacy host is dead', () => {
  const alive = new Set([11]);
  expect(planSweep([rec(11)], ME, (p) => alive.has(p), true).kill).toEqual([]);
  expect(planSweep([rec(11)], ME, (p) => alive.has(p), true).keep.map((r) => r.pid)).toEqual([11]);
  expect(planSweep([rec(11)], ME, (p) => alive.has(p), false).kill.map((r) => r.pid)).toEqual([11]);
});

test('sweepOrphans in an isolated instance never reads the default children.json and writes only its own', () => {
  const dir = tmp();
  const foreign = [{ pid: process.pid, tag: 'foreign', at: Date.now(), hostId: OTHER, hostPid: 1 }];
  fs.writeFileSync(path.join(dir, 'children.json'), JSON.stringify(foreign));
  const r = runInChild(
    "const c=await import('./server/lib/children.ts');const n=c.sweepOrphans();" +
      "emit({n,file:JSON.parse(require('node:fs').readFileSync(process.env.ARIGAMI_DIR+'/children.json','utf8')),hostId:c.HOST_ID});",
    { ARIGAMI_DIR: dir, ARIGAMI_PORT: '' }
  );
  if (!r.ok) throw new Error(r.error);
  expect(r.out[0].n).toBe(0); // we (this test process) are alive and NOT killed
  expect(r.out[0].file).toEqual(foreign); // other host's record preserved verbatim
  expect(r.out[0].hostId).toBe(makeHostId(dir, 4099));
});

// ---- host lock -----------------------------------------------------------------

test('judgeHostInfo refuses the same identity twice, allows a dead/own pid, warns on same dir other port', () => {
  const info = (pid, port) => ({ pid, port, hostId: 'h', dir: '/d', startedAt: 0 });
  const alive = (p) => p === 7;
  expect(judgeHostInfo(null, { pid: 1, port: 3099 }, alive).ok).toBe(true);
  expect(judgeHostInfo(info(7, 3099), { pid: 7, port: 3099 }, alive).ok).toBe(true);
  expect(judgeHostInfo(info(8, 3099), { pid: 1, port: 3099 }, alive).ok).toBe(true); // dead
  const same = judgeHostInfo(info(7, 3099), { pid: 1, port: 3099 }, alive);
  expect(same.ok).toBe(false);
  expect(same.reason).toMatch(/same instance/);
  const other = judgeHostInfo(info(7, 3099), { pid: 1, port: 4099 }, alive);
  expect(other.ok).toBe(true);
  expect(other.warn).toMatch(/SAME ARIGAMI_DIR/);
});

test('portFree reports a bound port as busy and a free one as free', async () => {
  const net = await import('node:net');
  const srv = net.createServer();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  expect(await portFree(port, '127.0.0.1')).toBe(false);
  srv.close();
  await new Promise((r) => setTimeout(r, 50));
  expect(await portFree(port, '127.0.0.1')).toBe(true);
});

test('claimHost refuses to boot when the port is already served — before any sweep could run', async () => {
  const net = await import('node:net');
  const srv = net.createServer();
  await new Promise((r) => srv.listen(0, '0.0.0.0', r));
  const port = srv.address().port;
  const dir = tmp();
  const r = runInChild(
    "const h=await import('./server/lib/hostlock.ts');try{await h.claimHost(" + port + ");emit({claimed:true})}catch(e){emit({claimed:false,msg:String(e.message)})}",
    { ARIGAMI_DIR: dir, ARIGAMI_PORT: '' }
  );
  srv.close();
  expect(r.ok).toBe(true);
  expect(r.out[0].claimed).toBe(false);
  expect(r.out[0].msg).toMatch(/already in use/);
  expect(fs.existsSync(path.join(dir, 'run', 'host.json'))).toBe(false);
});

test('claimHost writes run/host.json + host.pid and a second claim of the same identity is refused', async () => {
  const dir = tmp();
  const r = runInChild(
    "const h=await import('./server/lib/hostlock.ts');const inst=await import('./server/lib/instance.ts');" +
      'await h.claimHost(0);' + // port 0 = let the probe pick any free port; identity check is what we test
      "const info=JSON.parse(require('node:fs').readFileSync(inst.HOST_INFO_FILE,'utf8'));" +
      'const v=h.judgeHostInfo(info,{pid:info.pid+1,port:info.port},(p)=>p===info.pid);' +
      "emit({pid:info.pid,me:process.pid,pidfile:require('node:fs').readFileSync(inst.HOST_PID_FILE,'utf8').trim(),second:v});",
    { ARIGAMI_DIR: dir, ARIGAMI_PORT: '' }
  );
  if (!r.ok) throw new Error(r.error);
  expect(r.out[0].pid).toBe(r.out[0].me);
  expect(Number(r.out[0].pidfile)).toBe(r.out[0].me);
  expect(r.out[0].second.ok).toBe(false);
});
