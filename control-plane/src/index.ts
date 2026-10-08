import { loadConfig } from './config.js';
import { openDb, createStore } from './db.js';
import { createApp } from './server.js';
import * as provisioner from './provisioner.js';
import { startReconcile } from './reconcile.js';
import { startRosterSync } from './shared-ops.js';

const cfg = loadConfig();
const db = openDb(cfg.dbPath);
const store = createStore(db);
const app = createApp(cfg, store, provisioner);

Bun.serve({
  port: cfg.port,
  fetch: app.handle,
});

// K8S-3: converge desired_digest → running_digest and take scheduled backups.
startReconcile(cfg, store);
// Shared workspaces: retry member-roster pushes a pod has not acknowledged yet (src/shared-ops.ts).
startRosterSync(app.sharedDeps);

console.log(`[control-plane] up on :${cfg.port} (public: ${cfg.publicUrl}, org domain: ${cfg.orgDomain}, oidc: ${app.auth.oidcEnabled() ? 'on' : 'OFF — /auth/login will fail'})`);
