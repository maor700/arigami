// M4.2/M4.3 — the "second brain": one persistent session per instance plus an
// optional heartbeat. Deliberately thin: no new subsystem, just (a) find-or-
// create a single `metadata.kind:'brain'` session that already has every tool
// it needs (memory_search/get/write, cronjob, create_session, list_sessions —
// all shipped in M1–M3's mcp/host-mcp.js), and (b) an on/off cron trigger
// (server/triggers.ts, M2) that wakes it periodically to self-check whether
// anything needs Dana's attention (SPEC-ARIGAMI-BRAIN.md §M4.3, off by default).
import * as state from './state.js';
import * as triggers from './triggers.js';
import type { CronTrigger } from './triggers.js';
import { cfg, updateBrainConfig } from './lib/config.js';
import type { BrainConfig } from './lib/config.js';

export const BRAIN_TITLE = 'המוח השני';
export const HEARTBEAT_TRIGGER_NAME = 'Brain heartbeat';

// Sent as the brain session's very first message (same mechanism as a skill's
// instructions — see api.ts buildFirstPrompt) — establishes its identity and
// toolset once, at creation. USER.md/MEMORY.md are already prepended to that
// same first turn by claude.js (M1.3's writeUserMessage), so this doesn't
// repeat that content — just what the session IS and how to use its tools.
export const BRAIN_SYSTEM_DIRECTIVE =
  'אתה "המוח השני" של דנה — סשן קבוע אחד לאינסטנס הזה (לא נסגר בסוף שיחה, אלא ממשיך להתקיים). ' +
  'הכלים העיקריים שלך: memory_search / memory_get / memory_write (הזיכרון המשותף של אריגמי — ' +
  'USER.md/MEMORY.md/יומן/episodes), cronjob (תזמון משימות חוזרות), create_session ו-list_sessions ' +
  '(פתיחת/סקירת סשנים אחרים). ' +
  'כשדנה שואל אותך משהו על העבר, העדפות, אנשים או החלטות — קודם חפש בזיכרון עם memory_search לפני ' +
  'שאתה עונה "אני לא יודע". כשהוא מבקש לתזמן משהו — השתמש ב-cronjob. כשהוא מבקש עבודה בפועל (לתקן ' +
  'קוד, לבדוק משהו, לבצע משימה שדורשת כלים אחרים) — פתח סשן חדש עם create_session במקום לנסות לעשות ' +
  'הכל כאן בעצמך. כשאתה לומד עובדה חדשה שכדאי לזכור לטווח ארוך (העדפה, החלטה, מידע קבוע על דנה/הבית/' +
  'הפרויקטים) — שמור אותה מיד עם memory_write. ' +
  'ענה בקצרה ולעניין, בעברית אלא אם דנה כותב באנגלית.';

// Appended to every heartbeat fire. Unlike an 'isolated' cron run, fireCron's
// 'existing' branch (server/triggers.ts) doesn't auto-append
// CRON_REPORT_DIRECTIVE, so the report_to_master instruction has to live in
// the prompt itself. The "[SILENT]" prefix reuses deliverCronResult's
// existing success-suppression (spec M4.3: a NO_REPLY heartbeat must not
// push) — no new delivery-side code needed for that half of the contract.
export const HEARTBEAT_PROMPT =
  'בדיקת heartbeat תקופתית (הודעה אוטומטית, לא מדנה בעצמו). בדוק אם יש משהו שדורש את תשומת לבו של ' +
  'דנה עכשיו — עובדות pending לאישור בזיכרון, משימות מתוזמנות שנכשלו/נחסמו, פריטים פתוחים ביומן. ' +
  "אם יש משהו שדורש תשומת לב — קרא ל-report_to_master עם state:'done' וsummary קצר וברור שמסביר מה. " +
  "אם אין שום דבר שדורש תשומת לב — קרא ל-report_to_master עם state:'done' וsummary:'[SILENT] NO_REPLY' " +
  'בלבד, בלי שום טקסט נוסף.';

// ---- singleton session ------------------------------------------------------

// One brain session per instance. If more than one somehow exists (e.g. a
// crash mid-create), prefer the live one; otherwise the most recently touched.
export function findBrainSession(): ReturnType<typeof state.listSessions>[number] | null {
  const brains = (state.listSessions({ archived: true }) as any[]).filter((s) => s.metadata?.kind === 'brain');
  if (!brains.length) return null;
  const live = brains.filter((s) => !s.archived);
  const pick = (live.length ? live : brains).sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  return pick[0];
}

export async function ensureBrainSession(): Promise<{ id: string; created: boolean }> {
  const existing = findBrainSession();
  if (existing) {
    if (existing.archived) state.patchSession(existing.id, { archived: false });
    return { id: existing.id, created: false };
  }
  // Dynamic import — api.ts imports triggers.ts, so a static top-level import
  // here would cycle (same pattern memory.ts/triggers.ts already use for api.js).
  const api = await import('./api.js');
  const { id } = api.startEmptySession({
    title: BRAIN_TITLE,
    prompt: BRAIN_SYSTEM_DIRECTIVE,
    metadata: { kind: 'brain' },
  });
  return { id, created: true };
}

// ---- heartbeat --------------------------------------------------------------

function findHeartbeatTrigger(): CronTrigger | undefined {
  return triggers.listTriggers().find((t) => t.type === 'cron' && t.name === HEARTBEAT_TRIGGER_NAME) as
    | CronTrigger
    | undefined;
}

export interface HeartbeatStatus {
  enabled: boolean;
  every: string;
  triggerId: string | null;
}

export function getHeartbeatStatus(): HeartbeatStatus {
  const t = findHeartbeatTrigger();
  return { enabled: cfg.brain.heartbeatEnabled, every: cfg.brain.heartbeatEvery, triggerId: t?.id || null };
}

// Toggle the heartbeat on/off — creates/removes the backing CronTrigger
// (spec M4.3: "heartbeat toggle → trigger create/remove") and mirrors the
// desired state into config.brain (the UI's source of truth for the toggle;
// the trigger itself is the mechanism and already survives a restart on its
// own via triggers.json).
export async function setHeartbeat(enabled: boolean, every?: string): Promise<HeartbeatStatus> {
  const interval = (every || cfg.brain.heartbeatEvery || '30m').trim();
  const existing = findHeartbeatTrigger();
  if (enabled) {
    const { id: brainId } = await ensureBrainSession();
    if (existing) {
      triggers.patchTrigger(existing.id, {
        enabled: true,
        schedule: { kind: 'interval', value: interval },
        sessionMode: `existing:${brainId}`,
      });
    } else {
      await triggers.createCronTrigger({
        name: HEARTBEAT_TRIGGER_NAME,
        prompt: HEARTBEAT_PROMPT,
        schedule: { kind: 'interval', value: interval },
        sessionMode: `existing:${brainId}`,
        deliver: { push: true },
      });
    }
  } else if (existing) {
    triggers.deleteTrigger(existing.id);
  }
  updateBrainConfig({ heartbeatEnabled: enabled, heartbeatEvery: interval } as Partial<BrainConfig>);
  return getHeartbeatStatus();
}
