// WhatsApp listener — polls the local Baileys SQLite DB for new incoming
// messages and wakes the session with a formatted summary when any arrive.
// The DB is written by the whatsapp-mcp process (whatsapp.ts) in real-time
// via Baileys' messages.upsert event, so polling here gives near-real-time
// delivery at a fraction of the cost of a model polling itself.

import { DatabaseSync } from 'node:sqlite';

export interface WhatsAppWatermark extends Record<string, unknown> {
  since: string; // ISO timestamp — only messages with timestamp > since are new
}

interface WhatsAppRow {
  timestamp: string;
  chat_name: string;
  sender_name: string;
  content: string;
}

const DEFAULT_DB_PATH = '/home/arigami/.local/lib/whatsapp-mcp/data/whatsapp.db';

// Returns new incoming messages since watermark.since, optionally filtered to a specific group.
export function fetchWhatsappMessages(
  dbPath: string,
  since: string,
  groupJid?: string | null
): { messages: WhatsAppRow[]; error?: string } {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbPath, { open: true });

    const groupFilter = groupJid
      ? `AND m.chat_jid = '${groupJid.replace(/'/g, "''")}'`
      : `AND m.chat_jid != 'status@broadcast' AND m.chat_jid NOT LIKE '%@g.us'`;

    const rows = db
      .prepare(
        `SELECT m.timestamp,
          COALESCE(c.name, ct.name, ct.notify, m.chat_jid) as chat_name,
          COALESCE(s.name, s.notify, m.sender, 'Unknown') as sender_name,
          m.content
         FROM messages m
         JOIN chats c ON m.chat_jid = c.jid
         LEFT JOIN contacts ct ON c.jid = ct.jid
         LEFT JOIN contacts s ON m.sender = s.jid
         WHERE m.timestamp > ? AND m.is_from_me = 0
         ${groupFilter}
         ORDER BY m.timestamp ASC
         LIMIT 50`
      )
      .all(since) as unknown as WhatsAppRow[];
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
  nextSince: string
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
  const summary = `🔔 Listener: ${n} new WhatsApp message${n > 1 ? 's' : ''}:\n${lines.join('\n')}`;
  return { shouldFire: true, terminal: false, summary, nextWatermark };
}

// ---- contact lookup by name -------------------------------------------------
// Given a search term (name or relationship), returns candidates with their
// active JID (resolved through LID migration) and a recent message snippet
// so the caller can verify the right person before acting.
export interface ContactCandidate {
  jid: string;          // active chat JID (LID if migrated, else @s.whatsapp.net)
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
      `SELECT jid, name, notify FROM contacts
       WHERE name LIKE ? AND jid NOT LIKE '%@g.us'`
    ).all(`%${term}%`) as Array<{ jid: string; name: string; notify: string | null }>;

    const results: ContactCandidate[] = [];
    for (const c of contacts) {
      // Resolve to active JID (handles LID migration)
      const activeJid = resolveActiveJid(dbPath, c.jid);
      // Fetch most recent message so caller can verify the right person
      const recent = db.prepare(
        `SELECT content, timestamp FROM messages WHERE chat_jid = ? ORDER BY timestamp DESC LIMIT 1`
      ).get(activeJid) as { content: string; timestamp: string } | undefined;
      results.push({
        jid: activeJid,
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
