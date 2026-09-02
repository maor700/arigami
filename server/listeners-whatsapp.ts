// WhatsApp listener — polls the local Baileys SQLite DB for new incoming
// messages and wakes the session with a formatted summary when any arrive.
// The DB is written by the whatsapp-mcp process (whatsapp.ts) in real-time
// via Baileys' messages.upsert event, so polling here gives near-real-time
// delivery at a fraction of the cost of a model polling itself.

import { DatabaseSync } from 'node:sqlite';
import { WA_DB_PATH } from './whatsapp-bridge.js';

export interface WhatsAppWatermark extends Record<string, unknown> {
  since: string; // ISO timestamp — only messages with timestamp > since are new
}

export interface WhatsAppRow {
  timestamp: string;
  chat_jid: string;
  sender: string | null;
  chat_name: string;
  sender_name: string;
  content: string;
}

// WAFILT1: one entry of a listener's `contacts` filter, as stored in params.
// `raw` is what the caller passed (JID / +phone / name substring); `jids` is the
// resolved set it expands to (phone JID + its LID, or every contact whose name
// matched), so the poller matches exactly and cheaply; `name` is for the UI.
export interface ResolvedContact {
  raw: string;
  jids: string[];
  name: string | null;
}

const DEFAULT_DB_PATH = WA_DB_PATH;

// Returns new incoming messages since watermark.since, optionally filtered to a
// specific group and/or to a set of contact JIDs (WAFILT1). Filters AND together:
// the group restricts the chat, the contact set restricts chat-or-sender.
export function fetchWhatsappMessages(
  dbPath: string,
  since: string,
  groupJid?: string | null,
  contactJids?: string[] | null
): { messages: WhatsAppRow[]; error?: string } {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbPath, { open: true });

    const params: string[] = [since];
    let groupFilter: string;
    if (groupJid) {
      groupFilter = `AND m.chat_jid = ?`;
      params.push(groupJid);
    } else if (contactJids?.length) {
      // A contact filter may name a group explicitly (its JID is in the set), so
      // only status broadcasts are excluded here — the IN clause does the rest.
      groupFilter = `AND m.chat_jid != 'status@broadcast'`;
    } else {
      groupFilter = `AND m.chat_jid != 'status@broadcast' AND m.chat_jid NOT LIKE '%@g.us'`;
    }
    let contactFilter = '';
    if (contactJids?.length) {
      const marks = contactJids.map(() => '?').join(',');
      contactFilter = `AND (m.chat_jid IN (${marks}) OR m.sender IN (${marks}))`;
      params.push(...contactJids, ...contactJids);
    }

    const rows = db
      .prepare(
        `SELECT m.timestamp, m.chat_jid, m.sender,
          COALESCE(c.name, ct.name, ct.notify, m.chat_jid) as chat_name,
          COALESCE(s.name, s.notify, m.sender, 'Unknown') as sender_name,
          m.content
         FROM messages m
         JOIN chats c ON m.chat_jid = c.jid
         LEFT JOIN contacts ct ON c.jid = ct.jid
         LEFT JOIN contacts s ON m.sender = s.jid
         WHERE m.timestamp > ? AND m.is_from_me = 0
         ${groupFilter}
         ${contactFilter}
         ORDER BY m.timestamp ASC
         LIMIT 50`
      )
      .all(...params) as unknown as WhatsAppRow[];
    return { messages: rows };
  } catch (e: any) {
    return { messages: [], error: String(e?.message || e) };
  } finally {
    try { db?.close(); } catch {}
  }
}

// ---- group subscription management (shared via whatsapp.db) -----------------

function openDb(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath, { open: true });
  db.exec(`CREATE TABLE IF NOT EXISTS group_subscriptions (
    jid TEXT PRIMARY KEY,
    added_at TEXT DEFAULT (datetime('now'))
  )`);
  return db;
}

export function addGroupSubscription(dbPath: string, jid: string): void {
  const db = openDb(dbPath);
  try { db.prepare(`INSERT OR IGNORE INTO group_subscriptions (jid) VALUES (?)`).run(jid); }
  finally { try { db.close(); } catch {} }
}

export function removeGroupSubscription(dbPath: string, jid: string): void {
  const db = openDb(dbPath);
  try { db.prepare(`DELETE FROM group_subscriptions WHERE jid = ?`).run(jid); }
  finally { try { db.close(); } catch {} }
}

// ---- diff -------------------------------------------------------------------

export interface WhatsAppDiff {
  shouldFire: boolean;
  terminal: false;
  summary: string;
  nextWatermark: WhatsAppWatermark;
}

export function diffWhatsapp(
  messages: WhatsAppRow[],
  nextSince: string,
  contacts?: ResolvedContact[] | null
): WhatsAppDiff {
  const nextWatermark: WhatsAppWatermark = { since: nextSince };
  if (!messages.length) {
    return { shouldFire: false, terminal: false, summary: '', nextWatermark };
  }
  const lines = messages.map((m) => {
    const time = new Date(m.timestamp).toLocaleTimeString('he-IL', {
      hour: '2-digit',
      minute: '2-digit',
    });
    return `📱 ${m.chat_name} | ${m.sender_name} [${time}]: ${m.content}`;
  });
  const n = messages.length;
  // WAFILT1: when a contact filter is on, the wake names who matched so the
  // session knows which of its contacts spoke without re-reading the DB.
  const matched = contacts?.length
    ? [...new Set(messages.map((m) => contactLabel(matchWhatsappContact(m, contacts))).filter(Boolean))]
    : [];
  const who = matched.length ? ` from ${matched.join(', ')}` : '';
  const summary = `🔔 Listener: ${n} new WhatsApp message${n > 1 ? 's' : ''}${who}:\n${lines.join('\n')}`;
  return { shouldFire: true, terminal: false, summary, nextWatermark };
}

// ---- contact filter (WAFILT1) -----------------------------------------------

export function contactLabel(c: ResolvedContact | null | undefined): string {
  if (!c) return '';
  return c.name || c.raw;
}

// Pure matcher: a message matches a contact when its chat JID (DMs, groups
// named explicitly) or its sender JID (a filtered person talking in a group)
// is one of the contact's resolved JIDs. Returns the first matching contact.
export function matchWhatsappContact(
  msg: { chat_jid: string; sender?: string | null },
  contacts: ResolvedContact[] | null | undefined
): ResolvedContact | null {
  if (!contacts?.length) return null;
  for (const c of contacts) {
    for (const j of c.jids) {
      if (j === msg.chat_jid || (msg.sender && j === msg.sender)) return c;
    }
  }
  return null;
}

// Empty/absent filter = no contact filtering (legacy behaviour).
export function matchesWhatsappFilter(
  msg: { chat_jid: string; sender?: string | null },
  contacts: ResolvedContact[] | null | undefined
): boolean {
  if (!contacts?.length) return true;
  return matchWhatsappContact(msg, contacts) !== null;
}

// Flat JID set for the SQL IN clause.
export function contactJidSet(contacts: ResolvedContact[] | null | undefined): string[] {
  return [...new Set((contacts || []).flatMap((c) => c.jids))];
}

// Normalise a listener's stored params into a contacts array: new listeners
// carry params.contacts; legacy ones may carry a single `contact`/`from`
// string, which becomes a one-element array on read. (params.groupJid stays a
// separate AND filter — it also drives the group subscription.)
export function normalizeContacts(params: Record<string, unknown> | null | undefined): ResolvedContact[] {
  if (!params) return [];
  const arr = params.contacts;
  if (Array.isArray(arr) && arr.length) {
    return arr
      .map((c: any) => (typeof c === 'string' ? { raw: c, jids: [c], name: null } : c))
      .filter((c: any) => c && typeof c.raw === 'string' && Array.isArray(c.jids)) as ResolvedContact[];
  }
  const legacy = (params.contact ?? params.from) as unknown;
  if (typeof legacy === 'string' && legacy.trim()) {
    const raw = legacy.trim();
    return [{ raw, jids: [isJid(raw) ? raw : phoneJid(raw) || raw], name: null }];
  }
  return [];
}

export function isJid(s: string): boolean {
  return /@(s\.whatsapp\.net|lid|g\.us|broadcast)$/.test(s);
}

// "+972 52-123 4567" → "972521234567@s.whatsapp.net"; null when not a phone.
export function phoneJid(s: string): string | null {
  const t = s.trim();
  if (!/^\+?[\d\s\-().]{6,}$/.test(t)) return null;
  const digits = t.replace(/\D/g, '');
  if (digits.length < 6) return null;
  return `${digits}@s.whatsapp.net`;
}

// Resolve one raw entry (JID / E.164 phone / display-name substring) against
// the WhatsApp DB into the JID set a message may carry for it. Mirrors how
// sends are addressed (resolveActiveJid — phone JIDs are mapped to their LID
// through the contacts table and verified against real chats), but keeps the
// phone JID too, since a message can still arrive keyed either way.
export function resolveContactEntry(dbPath: string, raw: string): ResolvedContact {
  const entry = raw.trim();
  if (!entry) throw new Error('empty contact entry');
  if (isJid(entry)) {
    const active = resolveActiveJid(dbPath, entry);
    const jids = [...new Set([entry, active])];
    return { raw: entry, jids, name: displayNameFor(dbPath, jids) };
  }
  const pj = phoneJid(entry);
  if (pj) {
    const active = resolveActiveJid(dbPath, pj);
    const jids = [...new Set([pj, active])];
    return { raw: entry, jids, name: displayNameFor(dbPath, jids) };
  }
  // display-name substring: every contact/chat whose name matches
  const hits = lookupContactByName(dbPath, entry);
  const groupHits = lookupGroupByName(dbPath, entry);
  const jids = new Set<string>();
  for (const h of hits) { jids.add(h.jid); if (h.phoneJid) jids.add(h.phoneJid); }
  for (const g of groupHits) jids.add(g.jid);
  if (!jids.size) throw new Error(`could not resolve WhatsApp contact "${entry}" — no chat or contact name matches; pass a JID or an E.164 phone instead`);
  const names = [...new Set([...hits.map((h) => h.name), ...groupHits.map((g) => g.name)].filter(Boolean))];
  return { raw: entry, jids: [...jids], name: names.length === 1 ? names[0] : names.length ? names.slice(0, 3).join(' / ') : null };
}

export function resolveContacts(dbPath: string, raws: string[]): ResolvedContact[] {
  return raws.map((r) => resolveContactEntry(dbPath, r));
}

// Best display name for a JID set: chats.name first (a group's name lives
// there), then the contacts row of any JID in the set.
function displayNameFor(dbPath: string, jids: string[]): string | null {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbPath, { open: true });
    for (const j of jids) {
      const c = db.prepare(`SELECT name FROM chats WHERE jid = ? AND name IS NOT NULL AND name != ''`).get(j) as { name: string } | undefined;
      if (c?.name) return c.name;
    }
    for (const j of jids) {
      const c = db.prepare(`SELECT name, notify FROM contacts WHERE jid = ?`).get(j) as { name: string | null; notify: string | null } | undefined;
      if (c?.name || c?.notify) return c.name || c.notify;
    }
    // A LID whose contacts row only carries the phone: find the phone-JID row.
    for (const j of jids) {
      if (!j.endsWith('@s.whatsapp.net')) continue;
      const phone = j.replace('@s.whatsapp.net', '');
      const c = db.prepare(`SELECT name, notify FROM contacts WHERE phone_number = ? OR phone_number = ? LIMIT 1`).get(phone, j) as { name: string | null; notify: string | null } | undefined;
      if (c?.name || c?.notify) return c.name || c.notify;
    }
  } catch {
    // no name
  } finally {
    try { db?.close(); } catch {}
  }
  return null;
}

function lookupGroupByName(dbPath: string, term: string): Array<{ jid: string; name: string }> {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbPath, { open: true });
    return db.prepare(`SELECT jid, name FROM chats WHERE jid LIKE '%@g.us' AND name LIKE ? LIMIT 10`)
      .all(`%${term}%`) as unknown as Array<{ jid: string; name: string }>;
  } catch {
    return [];
  } finally {
    try { db?.close(); } catch {}
  }
}

// ---- contact lookup by name -------------------------------------------------
// Given a search term (name or relationship), returns candidates with their
// active JID (resolved through LID migration) and a recent message snippet
// so the caller can verify the right person before acting.
export interface ContactCandidate {
  jid: string;          // active chat JID (LID if migrated, else @s.whatsapp.net)
  phoneJid?: string;    // the @s.whatsapp.net JID when known (WAFILT1: messages may still carry it)
  name: string;         // phone-book display name
  recentMessage?: string;
  recentTimestamp?: string;
}

export function lookupContactByName(dbPath: string, term: string): ContactCandidate[] {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbPath, { open: true });
    // Find contacts whose phone-book name matches the term
    const contacts = db.prepare(
      `SELECT jid, name, notify, phone_number FROM contacts
       WHERE name LIKE ? AND jid NOT LIKE '%@g.us'`
    ).all(`%${term}%`) as Array<{ jid: string; name: string; notify: string | null; phone_number: string | null }>;

    const results: ContactCandidate[] = [];
    for (const c of contacts) {
      // Resolve to active JID (handles LID migration)
      const activeJid = resolveActiveJid(dbPath, c.jid);
      const phoneJid = c.jid.endsWith('@s.whatsapp.net')
        ? c.jid
        : c.phone_number ? `${c.phone_number.replace(/\D/g, '')}@s.whatsapp.net` : undefined;
      // Fetch most recent message so caller can verify the right person
      const recent = db.prepare(
        `SELECT content, timestamp FROM messages WHERE chat_jid = ? ORDER BY timestamp DESC LIMIT 1`
      ).get(activeJid) as { content: string; timestamp: string } | undefined;
      results.push({
        jid: activeJid,
        phoneJid,
        name: c.name,
        recentMessage: recent?.content,
        recentTimestamp: recent?.timestamp,
      });
    }
    return results;
  } catch {
    return [];
  } finally {
    try { db?.close(); } catch {}
  }
}

// ---- JID resolution ---------------------------------------------------------
// WhatsApp migrates contacts from @s.whatsapp.net to LID format (@lid).
// When given a phone-number JID, resolve it to the active chat JID by:
//   1. Checking if there's a LID contact with phone_number matching this JID
//   2. Falling back to the original JID if no mapping found
export function resolveActiveJid(dbPath: string, jid: string): string {
  if (!jid.endsWith('@s.whatsapp.net')) return jid;

  const phoneNum = jid.replace('@s.whatsapp.net', '');
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbPath, { open: true });

    // Look for a LID contact that maps this phone number
    const lidContact = db
      .prepare(
        `SELECT c.jid FROM contacts c
         WHERE (c.phone_number = ? OR c.phone_number = ?)
           AND c.jid LIKE '%@lid'
         ORDER BY c.jid LIMIT 1`
      )
      .get(phoneNum, jid) as { jid: string } | undefined;

    if (lidContact?.jid) {
      // Verify the LID has actual messages (i.e. it's an active chat)
      const hasMessages = db
        .prepare(`SELECT 1 FROM messages WHERE chat_jid = ? LIMIT 1`)
        .get(lidContact.jid);
      if (hasMessages) return lidContact.jid;
    }
  } catch {
    // fall through to original JID
  } finally {
    try { db?.close(); } catch {}
  }
  return jid;
}

export { DEFAULT_DB_PATH };
