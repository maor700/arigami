import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runInChild } from './_child.js';

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'folder-launch-'));
  return { ARIGAMI_DIR: dir, ARIGAMI_STATE_FILE: path.join(dir, 'state.json'), ARIGAMI_CLAUDE_BIN: '/bin/true' };
}

test('session folder names create once, trim, match case-insensitively and preserve id precedence', () => {
  const r = runInChild(`
    const s = await import('./server/state.js');
    const first = s.createSession({ folderName: '  Work  ' });
    const same = s.createSession({ folderName: 'Work' });
    const different = s.createSession({ folderName: 'work' });
    const byId = s.createSession({ folderId: first.folderId, folderName: 'Unused' });
    const invalid = s.createSession({ folderId: 'missing', folderName: 'Unused' });
    const blank = s.createSession({ folderName: '   ' });
    emit({ same: first.folderId === same.folderId, different: first.folderId === different.folderId,
      byId: byId.folderId === first.folderId, invalid: invalid.folderId, blank: blank.folderId,
      names: s.listFolders().map(f => f.name).sort() });
  `, sandbox());
  expect(r).toEqual({ ok: true, out: [{ same: true, different: true, byId: true, invalid: null, blank: null, names: ['Work'] }] });
});

test('empty, ticket, deferred and cron launches resolve their configured folder names', () => {
  const r = runInChild(`
    const api = await import('./server/api.js');
    const s = await import('./server/state.js');
    const t = await import('./server/triggers.js');
    t.load();
    const name = id => s.getFolder(s.getSession(id).folderId)?.name;
    const empty = api.startEmptySession({ folderName: 'Inbox' });
    const ticket = api.startTicketSession({ ticket: 'ENG-1', folderName: 'Tickets' });
    const queued = t.deferEmpty({ folderName: 'Queue' });
    const started = await t.startPending(queued.id);
    const cron = await t.createCronTrigger({ prompt: 'hi', schedule: { kind: 'interval', value: '1h' }, folderName: 'Daily' });
    const fired = await t.runCronNow(cron.id);
    const again = await t.runCronNow(cron.id);
    emit({ empty: name(empty.id), ticket: name(ticket.id), queued: name(started.sessionId),
      cron: name(fired.sessionId), same: s.getSession(fired.sessionId).folderId === s.getSession(again.sessionId).folderId });
  `, sandbox());
  expect(r.ok).toBe(true);
  expect(r.out[0]).toEqual({ empty: 'Inbox', ticket: 'Tickets', queued: 'Queue', cron: 'Daily', same: true });
});

test('trigger folder settings survive reload and queued tickets inherit the updated configuration', () => {
  const r = runInChild(`
    const { mock } = await import('bun:test');
    const real = await import('./server/onboarding.js');
    mock.module('./server/onboarding.js', () => ({ ...real, workspaceReady: () => true }));
    const s = await import('./server/state.js');
    const t = await import('./server/triggers.js');
    t.load();
    const trigger = await t.createTrigger({ folderName: 'Old' });
    t.patchTrigger(trigger.id, { folderName: 'New' });
    const cron = await t.createCronTrigger({ prompt: 'hi', schedule: { kind: 'interval', value: '1h' }, folderName: 'Daily' });
    t.flush();
    t.load();
    const pending = t.deferTicket('ENG-2');
    pending.triggerId = trigger.id;
    const started = await t.startPending(pending.id);
    emit({ name: s.getFolder(s.getSession(started.sessionId).folderId).name,
      cron: t.listTriggers().find(x => x.id === cron.id).folderName,
      cleared: t.patchTrigger(trigger.id, { folderName: null }).folderName });
  `, sandbox());
  expect(r.ok).toBe(true);
  expect(r.out[0]).toEqual({ name: 'New', cron: 'Daily', cleared: null });
});

test('an explicit queued folder name overrides the trigger folder id', () => {
  const r = runInChild(`
    const { mock } = await import('bun:test');
    const real = await import('./server/onboarding.js');
    mock.module('./server/onboarding.js', () => ({ ...real, workspaceReady: () => true }));
    const s = await import('./server/state.js');
    const t = await import('./server/triggers.js');
    const f = s.createFolder({ name: 'Trigger folder' });
    const trigger = await t.createTrigger({ folderId: f.id });
    const item = t.deferTicket('ENG-3', '', '', { folderName: 'Override' });
    item.triggerId = trigger.id;
    const started = await t.startPending(item.id);
    emit(s.getFolder(s.getSession(started.sessionId).folderId).name);
  `, sandbox());
  expect(r).toEqual({ ok: true, out: ['Override'] });
});
