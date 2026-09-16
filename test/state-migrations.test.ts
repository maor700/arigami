// Versioned state files (server/lib/schema-version.ts + lib/state-schemas.ts):
// an existing file with no version field is version 1 and loses nothing; the
// step chain is idempotent; a file from a newer build is refused with a legible
// message and left untouched; and a failure mid-migration leaves a backup you
// can go back to.
//
// Pure engine tests run in-process. Anything that boots a real owner module
// (state.ts, triggers.ts) runs in a child with its own throwaway ARIGAMI_DIR —
// server modules capture their paths at import time. Nothing here touches
// ~/.arigami.
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runInChild } from './_child.js';
import {
  SCHEMA_VERSION_KEY, FIRST_VERSION, SchemaVersionError,
  docVersion, stamp, migrateDoc, migrateFile,
  type StateSchema, type Doc,
} from '../server/lib/schema-version.ts';
import { STATE_SCHEMA, CONFIG_SCHEMA, TRIGGERS_SCHEMA, EXTENSIONS_SCHEMA, ALL_SCHEMAS } from '../server/lib/state-schemas.ts';

const tmp = (p = 'arigami-sv-') => fs.mkdtempSync(path.join(os.tmpdir(), p));
const quiet = { log: () => {} };
const readJson = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8'));

/** A throwaway three-version schema, so the chain is exercised with real steps. */
const FIXTURE: StateSchema = {
  name: 'fixture.json',
  version: 3,
  steps: [
    { to: 2, note: 'add greeting', up: (d) => ({ ...d, greeting: d.greeting ?? 'hello' }) },
    { to: 3, note: 'items becomes an array', up: (d) => ({ ...d, items: Array.isArray(d.items) ? d.items : d.items == null ? [] : [d.items] }) },
  ],
};

// ---- rule 2: no version field means version 1 -------------------------------

test('a file with no version field is the first version', () => {
  expect(docVersion({})).toBe(FIRST_VERSION);
  expect(docVersion({ sessions: [] })).toBe(1);
  expect(docVersion({ [SCHEMA_VERSION_KEY]: null })).toBe(1);
  expect(docVersion({ [SCHEMA_VERSION_KEY]: 4 })).toBe(4);
});

test('a hand-mangled version field is malformed, not guessed', () => {
  for (const bad of ['2', 0, -1, 1.5, {}]) {
    expect(() => docVersion({ [SCHEMA_VERSION_KEY]: bad })).toThrow(SchemaVersionError);
  }
});

test('an unstamped document migrates without losing a single key', () => {
  const before: Doc = { colorIndex: 7, sessions: [{ id: 's1', title: 'keep me' }], items: 'one', extraKeyNobodyKnows: { deep: [1, 2, 3] } };
  const r = migrateDoc(structuredClone(before), FIXTURE);
  expect(r.from).toBe(1);
  expect(r.to).toBe(3);
  expect(r.changed).toBe(true);
  expect(r.applied).toHaveLength(2);
  expect(r.doc[SCHEMA_VERSION_KEY]).toBe(3);
  expect(r.doc.colorIndex).toBe(7);
  expect(r.doc.sessions).toEqual(before.sessions);
  expect(r.doc.extraKeyNobodyKnows).toEqual(before.extraKeyNobodyKnows);
  expect(r.doc.greeting).toBe('hello');
  expect(r.doc.items).toEqual(['one']);
});

// ---- idempotence ------------------------------------------------------------

test('migrating twice changes nothing the second time', () => {
  const once = migrateDoc({ items: 'one' }, FIXTURE);
  const twice = migrateDoc(structuredClone(once.doc), FIXTURE);
  expect(twice.changed).toBe(false);
  expect(twice.applied).toEqual([]);
  expect(twice.doc).toEqual(once.doc);
});

test('each step is idempotent on its own output (a crash re-runs it)', () => {
  for (const s of FIXTURE.steps) {
    const once = s.up({ items: 'one' });
    expect(s.up(structuredClone(once))).toEqual(once);
  }
  for (const s of STATE_SCHEMA.steps) {
    const once = s.up({ sessions: [{ id: 's1', summarizing: true, keep: 1 }] });
    expect(s.up(structuredClone(once))).toEqual(once);
  }
});

// ---- rule 4: refuse a file from a newer build -------------------------------

test('a newer version is refused with a message naming both versions', () => {
  let err: SchemaVersionError | null = null;
  try { migrateDoc({ [SCHEMA_VERSION_KEY]: 9, sessions: [] }, FIXTURE); } catch (e) { err = e as SchemaVersionError; }
  expect(err).toBeInstanceOf(SchemaVersionError);
  expect(err!.code).toBe('too-new');
  expect(err!.found).toBe(9);
  expect(err!.supported).toBe(3);
  expect(err!.message).toContain('fixture.json');
  expect(err!.message).toContain('9');
  expect(err!.message).toContain('3');
  expect(err!.message).toMatch(/newer|Refusing/i);
});

test('a gap in the step chain is an error, not a silent skip', () => {
  const broken: StateSchema = { name: 'broken.json', version: 3, steps: [{ to: 3, note: 'jump', up: (d) => d }] };
  expect(() => migrateDoc({}, broken)).toThrow(/no migration from version 1 to 3/);
});

// ---- file level -------------------------------------------------------------

test('an absent or unparseable file is left completely alone', () => {
  const dir = tmp();
  expect(migrateFile(path.join(dir, 'nope.json'), FIXTURE, quiet).status).toBe('absent');

  const bad = path.join(dir, 'bad.json');
  fs.writeFileSync(bad, '{ truncated');
  expect(migrateFile(bad, FIXTURE, quiet).status).toBe('unreadable');
  expect(fs.readFileSync(bad, 'utf8')).toBe('{ truncated');

  const arr = path.join(dir, 'arr.json');
  fs.writeFileSync(arr, '[1,2]');
  expect(migrateFile(arr, FIXTURE, quiet).status).toBe('unreadable');
  expect(fs.readdirSync(dir).filter((f) => f.includes('.bak-'))).toEqual([]);
});

test('a file already at the current version is not rewritten at all', () => {
  const dir = tmp();
  const f = path.join(dir, 'fixture.json');
  const body = JSON.stringify({ [SCHEMA_VERSION_KEY]: 3, items: [] }, null, 2);
  fs.writeFileSync(f, body);
  const mtime = fs.statSync(f).mtimeMs;
  const r = migrateFile(f, FIXTURE, quiet);
  expect(r.status).toBe('current');
  expect(fs.readFileSync(f, 'utf8')).toBe(body);
  expect(fs.statSync(f).mtimeMs).toBe(mtime);
  expect(fs.readdirSync(dir)).toEqual(['fixture.json']);
});

test('a migration backs the old file up first, keeps the mode, and is idempotent on disk', () => {
  const dir = tmp();
  const f = path.join(dir, 'fixture.json');
  const original = JSON.stringify({ items: 'one', secretish: 'keep' });
  fs.writeFileSync(f, original, { mode: 0o600 });

  const r = migrateFile(f, FIXTURE, quiet);
  expect(r.status).toBe('migrated');
  expect(r.from).toBe(1);
  expect(r.to).toBe(3);
  expect(r.backup).toMatch(/fixture\.json\.bak-v1-\d{8}-\d{6}$/);
  expect(fs.readFileSync(r.backup!, 'utf8')).toBe(original); // byte-for-byte the old file
  expect(readJson(f)).toEqual({ [SCHEMA_VERSION_KEY]: 3, items: ['one'], secretish: 'keep', greeting: 'hello' });
  expect(fs.statSync(f).mode & 0o777).toBe(0o600);
  expect(fs.existsSync(`${f}.tmp`)).toBe(false);

  // second boot: nothing to do, and no second backup piles up
  const again = migrateFile(f, FIXTURE, quiet);
  expect(again.status).toBe('current');
  expect(fs.readdirSync(dir).filter((x) => x.includes('.bak-'))).toHaveLength(1);
});

test('a file from a newer build is refused on disk and never rewritten', () => {
  const dir = tmp();
  const f = path.join(dir, 'fixture.json');
  const body = JSON.stringify({ [SCHEMA_VERSION_KEY]: 99, sessions: [{ id: 'precious' }] }, null, 2);
  fs.writeFileSync(f, body);
  expect(() => migrateFile(f, FIXTURE, quiet)).toThrow(SchemaVersionError);
  expect(fs.readFileSync(f, 'utf8')).toBe(body);
  expect(fs.readdirSync(dir)).toEqual(['fixture.json']); // no backup, no .tmp
});

// ---- the real schemas -------------------------------------------------------

test('every registered schema has a complete step chain from version 1', () => {
  for (const s of ALL_SCHEMAS) {
    expect(s.version).toBeGreaterThanOrEqual(1);
    expect(() => migrateDoc({}, s)).not.toThrow();
    expect(migrateDoc({}, s).doc[SCHEMA_VERSION_KEY]).toBe(s.version);
    // steps are consecutive and stop exactly at the current version
    expect(s.steps.map((x) => x.to)).toEqual(
      Array.from({ length: s.version - 1 }, (_, i) => i + 2)
    );
  }
});

test('config/triggers/extensions are v1, so an existing file is never rewritten', () => {
  for (const s of [CONFIG_SCHEMA, TRIGGERS_SCHEMA, EXTENSIONS_SCHEMA]) {
    expect(s.version).toBe(1);
    expect(migrateDoc({ anything: true }, s).changed).toBe(false);
  }
});

test('state.json v1 → v2 keeps every session and only drops the transient flags', () => {
  const old: Doc = {
    colorIndex: 3,
    folders: [{ id: 'f1', name: 'work' }],
    listeners: [{ id: 'l1', sessionId: 's1', status: 'running' }],
    sessions: [
      { id: 's1', title: 'real work', cwd: '/repo', claude: { sessionId: 'c1', state: 'working' }, summarizing: true, autoReviewing: true, changesExplaining: true, metadata: { agent: 'a' } },
      { id: 's2', title: 'untouched', bg: [{ pid: 1 }] },
      null,
    ],
  };
  const r = migrateDoc(structuredClone(old), STATE_SCHEMA);
  expect(r.from).toBe(1);
  expect(r.to).toBe(2);
  const s = r.doc.sessions as any[];
  expect(s).toHaveLength(3);
  expect(s[0]).toEqual({ id: 's1', title: 'real work', cwd: '/repo', claude: { sessionId: 'c1', state: 'working' }, metadata: { agent: 'a' } });
  expect(s[1]).toEqual(old.sessions![1]);
  expect(s[2]).toBe(null);
  expect(r.doc.listeners).toEqual(old.listeners);
  expect(r.doc.folders).toEqual(old.folders);
  expect(r.doc.colorIndex).toBe(3);
});

test('a pre-migration backup never travels inside an exported archive', () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'memory', 'USER.md'), '- fixture\n');
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ [SCHEMA_VERSION_KEY]: 2, sessions: [] }));
  fs.writeFileSync(path.join(dir, 'state.json.bak-v1-20260101-000000'), JSON.stringify({ sessions: [{ id: 'stale' }] }));
  const out = path.join(tmp(), 'a.tar.gz');

  const r = runInChild(
    `const bk = await import('./server/backup.ts');
     await bk.exportFullToFile(${JSON.stringify(out)});
     emit({ done: true });`,
    { ARIGAMI_DIR: dir },
  );
  expect(r.ok).toBe(true);
  const entries = spawnSync('tar', ['-tzf', out], { encoding: 'utf8' }).stdout.split('\n').map((e) => e.replace(/^\.\//, ''));
  expect(entries).toContain('state.json');
  // a restored dir carrying a stale pre-migration copy would be a trap
  expect(entries.some((e) => e.includes('.bak-v1-'))).toBe(false);
}, 60_000);

test('stamp puts the version first and replaces an existing one', () => {
  const out = stamp({ b: 2 }, FIXTURE);
  expect(Object.keys(out)[0]).toBe(SCHEMA_VERSION_KEY);
  expect(stamp({ [SCHEMA_VERSION_KEY]: 1, b: 2 } as Doc, FIXTURE)[SCHEMA_VERSION_KEY]).toBe(3);
});

// ---- end to end, in a real host boot ---------------------------------------

/** Env for a child that must never reach the live host, ports, or WhatsApp. */
const env = (dir: string) => ({
  ARIGAMI_DIR: dir,
  ARIGAMI_PORT: '4771',
  ARIGAMI_WA_AUTOSTART: '0',
  ARIGAMI_WA_DATA_DIR: path.join(dir, 'whatsapp'),
});

test('a real, unstamped state.json boots, loses nothing, and comes out stamped', () => {
  const dir = tmp();
  const f = path.join(dir, 'state.json');
  const before = {
    colorIndex: 4,
    folders: [{ id: 'f1', name: 'work' }],
    sessions: [
      { id: 's1', title: 'a real session', cwd: '/repo', claude: { sessionId: 'c1', state: 'working' }, summarizing: true },
      { id: 's2', title: 'second', archived: true },
    ],
    listeners: [],
  };
  fs.writeFileSync(f, JSON.stringify(before, null, 2));

  const r = runInChild(
    `const st = await import('./server/state.ts');
     emit({ ids: st.listSessions({ archived: true }).map(s => s.id),
            titles: st.listSessions({ archived: true }).map(s => s.title) });`,
    env(dir),
  );
  expect(r.ok).toBe(true);
  expect(r.out[0].ids.sort()).toEqual(['s1', 's2']);
  expect(r.out[0].titles).toContain('a real session');

  const after = readJson(f);
  expect(after[SCHEMA_VERSION_KEY]).toBe(STATE_SCHEMA.version);
  expect(after.sessions).toHaveLength(2);
  expect(after.sessions[0].title).toBe('a real session');
  expect(after.sessions[0].summarizing).toBeUndefined();
  expect(after.colorIndex).toBe(4);
  expect(after.folders).toEqual(before.folders);
  const baks = fs.readdirSync(dir).filter((x) => x.startsWith('state.json.bak-v1-'));
  expect(baks).toHaveLength(1);
  expect(JSON.parse(fs.readFileSync(path.join(dir, baks[0]), 'utf8'))).toEqual(before);
}, 30_000);

test('a state.json from a newer build stops the boot and survives it untouched', () => {
  const dir = tmp();
  const f = path.join(dir, 'state.json');
  const body = JSON.stringify({ [SCHEMA_VERSION_KEY]: 99, sessions: [{ id: 'precious', title: 'do not lose me' }] }, null, 2);
  fs.writeFileSync(f, body);

  const r = runInChild(`await import('./server/state.ts'); emit({ loaded: true });`, env(dir));
  expect(r.ok).toBe(false);
  expect(r.error).toContain('state.json');
  expect(r.error).toMatch(/99/);
  expect(fs.readFileSync(f, 'utf8')).toBe(body); // not rewritten, not emptied
  expect(fs.readdirSync(dir).some((x) => x.includes('.bak-'))).toBe(false);
}, 30_000);

test('a config.json from a newer build stops the boot instead of falling back to defaults', () => {
  const dir = tmp();
  const f = path.join(dir, 'config.json');
  const body = JSON.stringify({ [SCHEMA_VERSION_KEY]: 42, port: 4771, voiceLang: 'he' }, null, 2);
  fs.writeFileSync(f, body);

  const r = runInChild(`await import('./server/lib/config.ts'); emit({ loaded: true });`, env(dir));
  expect(r.ok).toBe(false);
  expect(r.error).toContain('config.json');
  expect(fs.readFileSync(f, 'utf8')).toBe(body);
}, 30_000);

test('an unstamped config.json loads exactly as before and only gains the field when settings are saved', () => {
  const dir = tmp();
  const f = path.join(dir, 'config.json');
  const before = JSON.stringify({ port: 4771, voiceLang: 'he', brain: { heartbeatEnabled: false, heartbeatEvery: '30m' } }, null, 2) + '\n';
  fs.writeFileSync(f, before);

  const r = runInChild(
    `const c = await import('./server/lib/config.ts');
     emit({ port: c.cfg.port, lang: c.cfg.voiceLang, hasVersionKey: 'schemaVersion' in c.cfg,
            onDiskBeforeWrite: (await import('node:fs')).readFileSync(${JSON.stringify(f)}, 'utf8') });
     c.updateBrainConfig({ heartbeatEnabled: true });`,
    env(dir),
  );
  expect(r.ok).toBe(true);
  expect(r.out[0].port).toBe(4771);
  expect(r.out[0].lang).toBe('he');
  expect(r.out[0].hasVersionKey).toBe(false); // never leaks into the live config object
  expect(r.out[0].onDiskBeforeWrite).toBe(before); // a v1 file is not touched at boot

  const after = readJson(f);
  expect(after[SCHEMA_VERSION_KEY]).toBe(CONFIG_SCHEMA.version);
  expect(after.port).toBe(4771);
  expect(after.voiceLang).toBe('he');
  expect(after.brain.heartbeatEnabled).toBe(true);
}, 30_000);

test('a triggers.json from a newer build is refused and never overwritten', () => {
  const dir = tmp();
  const f = path.join(dir, 'triggers.json');
  const body = JSON.stringify({ [SCHEMA_VERSION_KEY]: 7, triggers: [{ id: 't1', type: 'cron', name: 'nightly' }], pending: [], settings: {} }, null, 2);
  fs.writeFileSync(f, body);

  const r = runInChild(
    `const tr = await import('./server/triggers.ts');
     tr.load();
     tr.flush();
     emit({ triggers: tr.listTriggers().length });`,
    env(dir),
  );
  expect(r.ok).toBe(true);
  expect(r.out[0].triggers).toBe(0);          // refused: nothing loaded
  expect(fs.readFileSync(f, 'utf8')).toBe(body); // and the flush did not clobber it
}, 30_000);

test('an unstamped triggers.json round-trips and gains the field on the next save', () => {
  const dir = tmp();
  const f = path.join(dir, 'triggers.json');
  const before = { triggers: [], pending: [{ id: 'p1', kind: 'empty', prompt: 'hi' }], settings: { autoplay: true, maxConcurrent: 2 } };
  fs.writeFileSync(f, JSON.stringify(before, null, 2));

  const r = runInChild(
    `const tr = await import('./server/triggers.ts');
     tr.load(); tr.flush();
     emit({ pending: tr.snapshot().pending.length });`,
    env(dir),
  );
  expect(r.ok).toBe(true);
  expect(r.out[0].pending).toBe(1);
  const after = readJson(f);
  expect(after[SCHEMA_VERSION_KEY]).toBe(TRIGGERS_SCHEMA.version);
  expect(after.pending).toHaveLength(1);
  expect(after.settings.autoplay).toBe(true);
}, 30_000);

test('an extensions.json from a newer build disables extensions but keeps the file', () => {
  const dir = tmp();
  const f = path.join(dir, 'extensions.json');
  const body = JSON.stringify({ [SCHEMA_VERSION_KEY]: 5, enabled: { compare: true }, secrets: { compare: { k: 'v' } } }, null, 2);
  fs.writeFileSync(f, body, { mode: 0o600 });

  const r = runInChild(
    `const ex = await import('./server/extensions.ts');
     const st = ex.readState();
     ex.writeState({ enabled: { wiped: true }, settings: {}, secrets: {}, sha: {}, trusted: {}, migrated: {} });
     emit({ enabled: Object.keys(st.enabled) });`,
    env(dir),
  );
  expect(r.ok).toBe(true);
  expect(r.out[0].enabled).toEqual([]);          // reported as "no extensions"
  expect(fs.readFileSync(f, 'utf8')).toBe(body); // the write was blocked
}, 30_000);

// A full import (server/backup.ts) swaps $ARIGAMI_DIR on disk under a
// still-running host. That host keeps the PRE-import state in memory and
// flushes it on the way out — shutdown() calls flushState() first — so the
// restart that finishes the import came up with the imported chat/ and
// agents/ (plain files, untouched) and the OLD session list. Reported live as
// "the import brought only the agents, not the sessions". freezeState() is
// the guard; these two tests are the before/after of that report.
test('freezeState stops a later flush from clobbering an imported state.json', () => {
  const dir = tmp('arigami-freeze-');
  fs.writeFileSync(
    path.join(dir, 'state.json'),
    JSON.stringify({ [SCHEMA_VERSION_KEY]: 2, colorIndex: 0, sessions: [{ id: 'sess_OLD', title: 'old' }], listeners: [], folders: [] }, null, 2),
  );

  const r = runInChild(
    `const st = await import('./server/state.ts');
     const fs = await import('node:fs');
     const file = ${JSON.stringify(path.join(dir, 'state.json'))};
     // the import lands: the dir on disk is now somebody else's
     st.freezeState('test');
     fs.writeFileSync(file, JSON.stringify({ ${JSON.stringify(SCHEMA_VERSION_KEY)}: 2, colorIndex: 0,
       sessions: [{ id: 'sess_IMPORTED', title: 'imported' }], listeners: [], folders: [] }, null, 2));
     // ...and the host shuts down, which flushes
     st.flushState();
     emit({ ids: JSON.parse(fs.readFileSync(file, 'utf8')).sessions.map((s) => s.id) });`,
    { ARIGAMI_DIR: dir },
  );
  expect(r.ok).toBe(true);
  expect(r.out[0].ids).toEqual(['sess_IMPORTED']);
});

test('without the freeze, that same flush writes the pre-import sessions back', () => {
  const dir = tmp('arigami-freeze-');
  fs.writeFileSync(
    path.join(dir, 'state.json'),
    JSON.stringify({ [SCHEMA_VERSION_KEY]: 2, colorIndex: 0, sessions: [{ id: 'sess_OLD', title: 'old' }], listeners: [], folders: [] }, null, 2),
  );

  const r = runInChild(
    `const st = await import('./server/state.ts');
     const fs = await import('node:fs');
     const file = ${JSON.stringify(path.join(dir, 'state.json'))};
     fs.writeFileSync(file, JSON.stringify({ ${JSON.stringify(SCHEMA_VERSION_KEY)}: 2, colorIndex: 0,
       sessions: [{ id: 'sess_IMPORTED', title: 'imported' }], listeners: [], folders: [] }, null, 2));
     st.flushState();
     emit({ ids: JSON.parse(fs.readFileSync(file, 'utf8')).sessions.map((s) => s.id) });`,
    { ARIGAMI_DIR: dir },
  );
  expect(r.ok).toBe(true);
  expect(r.out[0].ids).toEqual(['sess_OLD']);
});
