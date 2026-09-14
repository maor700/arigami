// `bun test` runs every file in ONE process: globalThis and process.env are
// shared, and a stub installed by one file (globalThis.fetch = …, the browser
// shims of the *-web tests, process.env.ARIGAMI_STATE_FILE = … at the top of a
// unit test) is inherited by every file that runs after it — in readdir order,
// which differs between this box and CI. A host test then polls its spawned
// server through an inert fetch stub and times out, or spawns it with another
// file's state path. Symptom: passes alone, fails in the full run.
//
// Call `isolate()` at the top of any file that assigns to globalThis or
// process.env: it snapshots both at load time and puts them back in afterAll —
// added keys are deleted, changed ones restored, whatever the file did in
// between. Hooks registered here bind to the calling test file (bun scopes
// hooks to the file being collected). The restore is registered from a
// microtask so it runs AFTER the file's own afterAll hooks (bun runs them in
// registration order): a file that resets shared module state on the way out
// (prefs.setPrefs in engine-naming-web) still finds its DOM shim in place.
import { afterAll } from 'bun:test';

export function isolate() {
  const globals = new Map();
  for (const k of Object.getOwnPropertyNames(globalThis)) globals.set(k, Object.getOwnPropertyDescriptor(globalThis, k));
  const env = { ...process.env };

  queueMicrotask(() => afterAll(() => {
    for (const k of Object.getOwnPropertyNames(globalThis)) {
      const was = globals.get(k);
      if (!was) {
        delete globalThis[k];
        continue;
      }
      const now = Object.getOwnPropertyDescriptor(globalThis, k);
      const same = 'value' in was ? now && 'value' in now && now.value === was.value : now && now.get === was.get && now.set === was.set;
      if (same) continue;
      try {
        Object.defineProperty(globalThis, k, was);
      } catch {
        if ('value' in was) globalThis[k] = was.value;
      }
    }
    for (const k of Object.keys(process.env)) if (!(k in env)) delete process.env[k];
    for (const [k, v] of Object.entries(env)) if (process.env[k] !== v) process.env[k] = v;
  }));
}
