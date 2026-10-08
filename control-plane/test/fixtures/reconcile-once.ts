// One real reconcile tick (src/reconcile.ts realOps) against whatever the env
// configures, printing {sum, logs} as JSON. test/profile-rollout.e2e.test.ts
// runs this as a child so it can put a fake `kubectl` first on PATH (bun
// resolves executables against the PATH it started with).
import { loadConfig } from '../../src/config.js';
import { openDb, createStore } from '../../src/db.js';
import { reconcileTick, realOps } from '../../src/reconcile.js';

const cfg = loadConfig();
const store = createStore(openDb(cfg.dbPath));
const logs: string[] = [];
const sum = await reconcileTick(cfg, store, realOps(cfg), (m) => logs.push(m));
process.stdout.write(JSON.stringify({ sum, logs }));
