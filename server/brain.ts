// M4.2/M4.3 — the "second brain": one persistent session per instance plus an
// optional heartbeat. Deliberately thin: no new subsystem, just (a) find-or-
// create a single `metadata.kind:'brain'` session that already has every tool
// it needs (memory_search/get/write, cronjob, create_session, list_sessions —
// all shipped in M1–M3's mcp/host-mcp.js), and (b) an on/off cron trigger
// (server/triggers.ts, M2) that wakes it periodically to self-check whether
// anything needs the owner's attention (SPEC-ARIGAMI-BRAIN.md §M4.3, off by default).
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
  'You are the "second brain" of the instance owner — one persistent session for this instance ' +
  '(it does not close at the end of a conversation; it keeps existing). ' +
  'Your main tools: memory_search / memory_get / memory_write (Arigami\'s shared memory — ' +
  'USER.md/MEMORY.md/journal/episodes), cronjob (scheduling recurring tasks), create_session and list_sessions ' +
  '(opening/reviewing other sessions). ' +
  'When the owner asks you something about the past, preferences, people, or decisions — search memory with ' +
  'memory_search first, before answering "I don\'t know". When they ask you to schedule something — use cronjob. ' +
  'When they ask for actual work (fixing code, checking something, doing a task that needs other tools) — open a ' +
  'new session with create_session instead of trying to do it all here yourself. When you learn a new fact worth ' +
  'remembering long-term (a preference, a decision, standing information about the owner/home/projects) — save it ' +
  'immediately with memory_write. ' +
  'Answer briefly and to the point, in Hebrew unless the owner writes in English.';

// Appended to every heartbeat fire. Unlike an 'isolated' cron run, fireCron's
// 'existing' branch (server/triggers.ts) doesn't auto-append
// CRON_REPORT_DIRECTIVE, so the report_to_master instruction has to live in
// the prompt itself. The "[SILENT]" prefix reuses deliverCronResult's
// existing success-suppression (spec M4.3: a NO_REPLY heartbeat must not
// push) — no new delivery-side code needed for that half of the contract.
export const HEARTBEAT_PROMPT =
  'Periodic heartbeat check (an automatic message, not from the owner themself). Check whether anything needs the ' +
  "owner's attention right now — facts pending approval in memory, scheduled tasks that failed/got blocked, open " +
  "journal items. If something needs attention — call report_to_master with state:'done' and a short, clear " +
  "summary explaining what. If nothing needs attention — call report_to_master with state:'done' and " +
  "summary:'[SILENT] NO_REPLY' only, with no other text.";

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
