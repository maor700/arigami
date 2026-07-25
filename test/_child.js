// Run a snippet of server code in a FRESH bun process with a controlled env,
// and return its JSON stdout. Server modules (config.js, state.js, accounts.js)
// capture their paths from env into module-level constants at import time, and
// `bun test` shares one module registry across all test files — so any test
// that needs its own ARIGAMI_DIR / state file must run out-of-process to stay
// isolated from the others. The child prints one JSON line to stdout via
// `emit(obj)`; everything else can go to stderr.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function runInChild(body, env = {}) {
  const script =
    'const __out=[];globalThis.emit=(o)=>__out.push(o);' +
    'try{await (async()=>{' +
    body +
    '})();process.stdout.write(JSON.stringify({ok:true,out:__out}));}' +
    'catch(e){process.stdout.write(JSON.stringify({ok:false,error:String(e&&e.message||e)}));}';
  const r = spawnSync('bun', ['-e', script], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 30000,
  });
  let parsed;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    throw new Error(
      `child produced no JSON (code ${r.status}). stdout=${r.stdout?.slice(0, 500)} stderr=${r.stderr?.slice(0, 500)}`
    );
  }
  return parsed;
}
