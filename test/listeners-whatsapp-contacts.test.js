// WAFILT1: unit tests for the WhatsApp listener contact filter — the pure
// matcher (JID / LID / phone / group-sender / empty array / legacy field) and
// the resolver against a stubbed whatsapp.db (chats + contacts + messages).
// Imports the pure module only (no state singleton, no bridge).
import { test, expect } from 'bun:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const wa = await import('../server/listeners-whatsapp.ts');
const {
  matchWhatsappContact, matchesWhatsappFilter, normalizeContacts, contactJidSet,
  phoneJid, isJid, resolveContactEntry, resolveContacts, fetchWhatsappMessages, diffWhatsapp,
} = wa;

const PHONE = '972501234567@s.whatsapp.net';
const LID = '73100494372867@lid';
const GROUP = '120363412808577334@g.us';
const OTHER = '972509999999@s.whatsapp.net';

const c = (over = {}) => ({ raw: '+972501234567', jids: [PHONE, LID], name: 'אבא', ...over });

test('matcher: DM keyed by phone JID matches', () => {
  expect(matchWhatsappContact({ chat_jid: PHONE, sender: PHONE }, [c()])?.name).toBe('אבא');
});

test('matcher: DM keyed by LID (post-migration) matches the same contact', () => {
  expect(matchWhatsappContact({ chat_jid: LID, sender: LID }, [c()])?.name).toBe('אבא');
});

test('matcher: a filtered person talking in a group matches via sender JID', () => {
  expect(matchWhatsappContact({ chat_jid: GROUP, sender: LID }, [c()])?.name).toBe('אבא');
  expect(matchWhatsappContact({ chat_jid: GROUP, sender: OTHER }, [c()])).toBeNull();
});

test('matcher: a group named explicitly matches by chat JID whoever speaks', () => {
  const g = { raw: GROUP, jids: [GROUP], name: 'משפחה' };
  expect(matchWhatsappContact({ chat_jid: GROUP, sender: OTHER }, [g])?.name).toBe('משפחה');
});

test('matcher: unrelated chat does not match; empty/absent array = no filter', () => {
  expect(matchWhatsappContact({ chat_jid: OTHER, sender: OTHER }, [c()])).toBeNull();
  expect(matchesWhatsappFilter({ chat_jid: OTHER, sender: OTHER }, [c()])).toBe(false);
  expect(matchesWhatsappFilter({ chat_jid: OTHER, sender: OTHER }, [])).toBe(true);
  expect(matchesWhatsappFilter({ chat_jid: OTHER, sender: OTHER }, null)).toBe(true);
  expect(matchesWhatsappFilter({ chat_jid: OTHER, sender: OTHER }, undefined)).toBe(true);
});

test('normalizeContacts: legacy single contact/from string → one-element array', () => {
  expect(normalizeContacts({ contact: LID })).toEqual([{ raw: LID, jids: [LID], name: null }]);
  expect(normalizeContacts({ from: '+972 50-123 4567' })).toEqual([{ raw: '+972 50-123 4567', jids: [PHONE], name: null }]);
  expect(normalizeContacts({ contacts: [c()] })).toEqual([c()]);
  expect(normalizeContacts({ contacts: [LID] })).toEqual([{ raw: LID, jids: [LID], name: null }]);
  expect(normalizeContacts({ groupJid: GROUP })).toEqual([]);
  expect(normalizeContacts({ contacts: [] })).toEqual([]);
  expect(normalizeContacts(null)).toEqual([]);
});

test('contactJidSet flattens + dedups; phoneJid/isJid classify entries', () => {
  expect(contactJidSet([c(), { raw: LID, jids: [LID], name: null }])).toEqual([PHONE, LID]);
  expect(phoneJid('+972 50-123 4567')).toBe(PHONE);
  expect(phoneJid('אבא')).toBeNull();
  expect(phoneJid(LID)).toBeNull();
  expect(isJid(LID)).toBe(true); expect(isJid(GROUP)).toBe(true); expect(isJid(PHONE)).toBe(true);
  expect(isJid('+972501234567')).toBe(false);
});

// ---- resolution against a stubbed whatsapp.db --------------------------------

function stubDb() {
  const dir = mkdtempSync(join(tmpdir(), 'wafilt1-'));
  const path = join(dir, 'whatsapp.db');
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE chats (jid TEXT PRIMARY KEY, name TEXT, last_message_time TEXT);
    CREATE TABLE messages (id TEXT, chat_jid TEXT, sender TEXT, content TEXT, timestamp TEXT, is_from_me INTEGER, PRIMARY KEY (id, chat_jid));
    CREATE TABLE contacts (jid TEXT PRIMARY KEY, name TEXT, notify TEXT, phone_number TEXT);
    INSERT INTO chats VALUES ('${LID}', NULL, '2026-09-01T10:00:00.000Z');
    INSERT INTO chats VALUES ('${OTHER}', NULL, '2026-09-01T10:00:00.000Z');
    INSERT INTO chats VALUES ('${GROUP}', 'משפחת אלימלך', '2026-09-01T10:00:00.000Z');
    INSERT INTO contacts VALUES ('${LID}', 'אבא', 'Abba', '972501234567');
    INSERT INTO contacts VALUES ('${OTHER}', 'שכן', NULL, NULL);
    INSERT INTO messages VALUES ('m0', '${LID}', '${LID}', 'old', '2026-09-01T10:00:00.000Z', 0);
  `);
  db.close();
  return { path, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

test('resolve: E.164 phone → phone JID + its LID (via contacts.phone_number, verified against a real chat), with the name', () => {
  const { path, dispose } = stubDb();
  try {
    const r = resolveContactEntry(path, '+972 50-123 4567');
    expect(r.raw).toBe('+972 50-123 4567');
    expect(r.jids.sort()).toEqual([PHONE, LID].sort());
    expect(r.name).toBe('אבא');
  } finally { dispose(); }
});

test('resolve: a LID / group JID is kept as-is; group name comes from the chats table', () => {
  const { path, dispose } = stubDb();
  try {
    expect(resolveContactEntry(path, LID)).toEqual({ raw: LID, jids: [LID], name: 'אבא' });
    expect(resolveContactEntry(path, GROUP)).toEqual({ raw: GROUP, jids: [GROUP], name: 'משפחת אלימלך' });
  } finally { dispose(); }
});

test('resolve: display-name substring → every matching contact/group; unknown name throws', () => {
  const { path, dispose } = stubDb();
  try {
    const r = resolveContactEntry(path, 'אב');
    expect(r.jids).toContain(LID);
    expect(r.jids).toContain(PHONE);
    expect(r.name).toBe('אבא');
    const g = resolveContactEntry(path, 'אלימלך');
    expect(g.jids).toEqual([GROUP]);
    expect(() => resolveContactEntry(path, 'nobody-here')).toThrow(/could not resolve/);
    expect(resolveContacts(path, [LID, GROUP]).map((x) => x.raw)).toEqual([LID, GROUP]);
  } finally { dispose(); }
});

test('fetch + diff: the contact IN-filter selects the contact\'s DM and group-sender rows only, and the wake names them', () => {
  const { path, dispose } = stubDb();
  try {
    const db = new DatabaseSync(path);
    db.exec(`
      INSERT INTO messages VALUES ('m1', '${LID}', '${LID}', 'hi from dad', '2026-09-02T10:00:01.000Z', 0);
      INSERT INTO messages VALUES ('m2', '${OTHER}', '${OTHER}', 'hi from neighbour', '2026-09-02T10:00:02.000Z', 0);
      INSERT INTO messages VALUES ('m3', '${GROUP}', '${LID}', 'dad in group', '2026-09-02T10:00:03.000Z', 0);
      INSERT INTO messages VALUES ('m4', '${GROUP}', '${OTHER}', 'neighbour in group', '2026-09-02T10:00:04.000Z', 0);
      INSERT INTO messages VALUES ('m5', '${LID}', '${LID}', 'mine', '2026-09-02T10:00:05.000Z', 1);
    `);
    db.close();
    const contacts = [resolveContactEntry(path, '+972501234567')];
    const since = '2026-09-02T00:00:00.000Z';
    const { messages, error } = fetchWhatsappMessages(path, since, null, contactJidSet(contacts));
    expect(error).toBeUndefined();
    expect(messages.map((m) => m.content)).toEqual(['hi from dad', 'dad in group']);
    const d = diffWhatsapp(messages, '2026-09-02T11:00:00.000Z', contacts);
    expect(d.shouldFire).toBe(true);
    expect(d.summary).toContain('2 new WhatsApp messages from אבא:');
    // no filter → legacy: DMs only, groups excluded
    const all = fetchWhatsappMessages(path, since, null, []);
    expect(all.messages.map((m) => m.content)).toEqual(['hi from dad', 'hi from neighbour']);
    // group_jid AND contacts → only the contact inside that group
    const inGroup = fetchWhatsappMessages(path, since, GROUP, contactJidSet(contacts));
    expect(inGroup.messages.map((m) => m.content)).toEqual(['dad in group']);
    // group named as a contact → everything in it
    const g = fetchWhatsappMessages(path, since, null, [GROUP]);
    expect(g.messages.map((m) => m.content)).toEqual(['dad in group', 'neighbour in group']);
  } finally { dispose(); }
});
