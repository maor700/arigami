// The one way a test makes a temp dir.
//
// Every directory lands inside this run's own temp root, which the preload
// (test/_preload.ts) points TMPDIR at and deletes when the `bun test` process
// exits — so nothing a test, a spawned host or a child process puts under
// $TMPDIR outlives the run. Before this, each file did its own
// fs.mkdtempSync(path.join(os.tmpdir(), …)) and almost none removed it: one
// session's TMPDIR held 9,482 leftovers (5.3 GB) from repeated runs.
//
// test/tmp-guard.test.ts fails on any test file that creates a temp dir
// without going through here.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** A fresh, empty directory, removed with the run. `prefix` only names it. */
export function tmpDir(prefix = 'arigami-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** A path inside the run's temp root that does not exist yet (for "missing file" cases). */
export function tmpPath(...parts) {
  return path.join(os.tmpdir(), ...parts);
}
