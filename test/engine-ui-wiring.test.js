// ENGINE-UI (server half): the engine choice has to reach a session from EVERY
// route that creates one, not just POST /__api/sessions.
//
// The seam commit wired `engine` through the generic create route only. If the
// other entry points keep dropping it, the launcher's picker looks like it
// works — you pick Codex, the POST succeeds — but a session started from a
// ticket, from the pending queue, or by a Linear trigger silently runs Claude.
// That is a worse failure than the loud one: pickEngine() throwing "engine not
// implemented" is visible, a session quietly on the wrong CLI is not.
//
// Runs out-of-process (see _child.js): these modules capture their state paths
// at import time. ARIGAMI_CLAUDE_BIN points at /bin/true so no real CLI is
// spawned — the assertions are about the session RECORD, which is written
// before any spawn is attempted.
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runInChild } from './_child.js';

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-ui-'));
  return {
    ARIGAMI_DIR: dir,
    ARIGAMI_STATE_FILE: path.join(dir, 'state.json'),
    ARIGAMI_CLAUDE_BIN: '/bin/true',
  };
}

test('startEmptySession and startTicketSession carry the engine onto the session', () => {
  const r = runInChild(
    `
    const api = await import('./server/api.js');
    const state = await import('./server/state.js');
    const empty = api.startEmptySession({ title: 'e', engine: 'codex' });
    const ticket = api.startTicketSession({ ticket: 'ENG-1', engine: 'codex' });
    const claudeOne = api.startEmptySession({ title: 'c' });
    emit({
      empty: state.getSession(empty.id).engine,
      ticket: state.getSession(ticket.id).engine,
      // no engine asked for → claude, exactly as before this change
      unset: state.getSession(claudeOne.id).engine,
      // the unimplemented engine fails LOUDLY at spawn instead of running claude
      emptyState: state.getSession(empty.id).claude.state,
      claudeState: state.getSession(claudeOne.id).claude.state,
    });
    `,
    sandbox()
  );
  expect(r.ok).toBe(true);
  const o = r.out[0];
  expect(o.empty).toBe('codex');
  expect(o.ticket).toBe('codex');
  expect(o.unset).toBe('claude');
  // pickEngine() throws for codex until its driver is registered — spawnSafe
  // records that as a dead session rather than falling back to claude.
  expect(o.emptyState).toBe('dead');
  expect(o.claudeState).not.toBe('dead');
});

test('the pending queue remembers the engine, and startPending hands it back', () => {
  const r = runInChild(
    `
    const t = await import('./server/triggers.js');
    const state = await import('./server/state.js');
    const empty = t.deferEmpty({ title: 'q', engine: 'codex' });
    const ticket = t.deferTicket('ENG-9', 'Q', '', { engine: 'codex' });
    const started = await t.startPending(empty.id);
    emit({
      storedEmpty: empty.engine,
      storedTicket: ticket.engine,
      startedEngine: state.getSession(started.sessionId).engine,
    });
    `,
    sandbox()
  );
  expect(r.ok).toBe(true);
  expect(r.out[0]).toEqual({ storedEmpty: 'codex', storedTicket: 'codex', startedEngine: 'codex' });
});

test('a Linear trigger stores an engine, defaults it to the host default, and refuses junk', () => {
  const r = runInChild(
    `
    const t = await import('./server/triggers.js');
    // createTrigger primes against Linear; unreachable here, which it tolerates.
    const codex = await t.createTrigger({ name: 'c', engine: 'codex' });
    const plain = await t.createTrigger({ name: 'p' });
    const junk = await t.createTrigger({ name: 'j', engine: 'gpt-9000' });
    if (codex.engine !== 'codex' || plain.engine !== '') throw new Error('createTrigger engine: ' + codex.engine + '/' + plain.engine);
    // patchTrigger returns the live record, so read each result immediately —
    // the next patch mutates the same object.
    const patched = t.patchTrigger(plain.id, { engine: 'codex' }).engine;
    // a typo must NOT quietly move a live codex trigger back to claude
    const unpatched = t.patchTrigger(codex.id, { engine: 'nonsense' }).engine;
    const backToClaude = t.patchTrigger(codex.id, { engine: 'claude' }).engine;
    emit({ codex: 'codex', plain: '', junk: junk.engine, patched, unpatched, backToClaude });
    `,
    sandbox()
  );
  expect(r.ok).toBe(true);
  // '' = cfg.defaultEngine; an explicit claude is kept so a codex default can't override it.
  expect(r.out[0]).toEqual({ codex: 'codex', plain: '', junk: '', patched: 'codex', unpatched: 'codex', backToClaude: 'claude' });
});

test('a queued item overrides its trigger\'s engine, and inherits it when unset', () => {
  const r = runInChild(
    `
    // Ticket items are gated on a provisioned workspace, whose steps are LIVE
    // probes of this machine — stub the gate rather than fake a whole one.
    const { mock } = await import('bun:test');
    const real = await import('./server/onboarding.js');
    mock.module('./server/onboarding.js', () => ({ ...real, workspaceReady: () => true }));
    const t = await import('./server/triggers.js');
    const state = await import('./server/state.js');
    const trig = await t.createTrigger({ name: 'codex trigger', engine: 'codex' });
    // A ticket item queued BY that trigger carries no engine of its own.
    const inherit = t.deferTicket('ENG-11', 'i', '');
    inherit.triggerId = trig.id;
    const r1 = await t.startPending(inherit.id);
    // ...and one that does keeps its own, overriding the trigger's.
    const own = t.deferTicket('ENG-12', 'o', '', { engine: 'claude' });
    own.triggerId = trig.id;
    const r2 = await t.startPending(own.id);
    emit({
      inherited: r1.sessionId ? state.getSession(r1.sessionId).engine : r1,
      overridden: r2.sessionId ? state.getSession(r2.sessionId).engine : r2,
    });
    `,
    sandbox()
  );
  expect(r.ok).toBe(true);
  expect(r.out[0].inherited).toBe('codex');
  expect(r.out[0].overridden).toBe('claude');
});

test('the create_session MCP tool forwards the engine (dispatch children included)', () => {
  const src = fs.readFileSync(path.join(import.meta.dir, '../mcp/host-mcp.js'), 'utf8');
  // Schema exposes it as a closed choice, so a typo is a tool error, not a
  // session silently on the default engine.
  expect(src).toMatch(/engine:\s*\{\s*type:\s*'string',\s*enum:\s*\['claude',\s*'codex'\]/);
  // ...and it actually reaches the POST body.
  expect(src).toContain("...(a.engine ? { engine: a.engine } : {})");
});
