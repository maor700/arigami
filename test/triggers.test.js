// Regression: flush() must be a no-op until load() has run. The scheduler
// (which calls load()) only starts in the server.listen callback; if a
// SIGTERM/SIGINT arrives before that — or the port bind fails — shutdown() still
// calls flush(), which would otherwise clobber the real triggers.json with an
// empty default store. Runs in a child so triggers.js' captured STORE path is
// isolated from the shared registry.
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runInChild } from './_child.js';

test('flush() before the scheduler has loaded does not overwrite triggers.json', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-trig-'));
  const storeFile = path.join(dir, 'triggers.json');
  const realData = JSON.stringify({
    triggers: [{ id: 'trig_1', type: 'linear-filter', name: 'keep me', seen: ['ENG-1'] }],
    pending: [{ id: 'pend_1', ticket: 'ENG-2', kind: 'ticket' }],
    settings: { autoplay: true, maxConcurrent: 5 },
  });
  fs.writeFileSync(storeFile, realData);

  const r = runInChild(
    "const t=await import('./server/triggers.js');t.flush();emit({done:true});",
    { ARIGAMI_DIR: dir, ARIGAMI_STATE_FILE: path.join(dir, 'state.json') }
  );
  expect(r.ok).toBe(true);
  // File on disk is untouched by the premature flush.
  expect(JSON.parse(fs.readFileSync(storeFile, 'utf8'))).toEqual(JSON.parse(realData));
});
