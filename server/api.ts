import path from 'node:path';
import { resourceRoot } from './lib/resource-root.js';
import { publicUrl, sessionPath } from './lib/public-url.js';
import { requestOrigin } from './lib/proxy-headers.js';
import { IncomingMessage, ServerResponse } from 'node:http';
import { isWin, which, shellArgs, toPosixPath, HOME } from './lib/platform.js';
import * as state from './state.js';
import * as orchestration from './orchestration.js';
import * as claude from './claude.js';
import { broadcast, emitLocal } from './bus.js';
import { cfg, nano, untildify } from './state.js';
import { skillDir, NAME_RE as SKILL_NAME_RE } from './skills.js';
import { updateScreenConfig, updateAuthConfig, updateDefaultEngine } from './lib/config.js';
import { syncComposioKey } from './lib/mcp-servers.js';
import { auth, canReadFullList } from './auth.js';
import * as screens from './screenshots.js';
import * as artifacts from './artifacts.js';
import { shareTokens } from './share-token.js';
import * as handoff from './handoff.js';
import { webhooks, isInboundWebhookPath, CUSTOM_ID_RE } from './webhooks.js';
// desktops.js stays a direct import for ONE call only: ensureGlobalDesktop()
// (the shared, non-per-session desktop the `desktop` JIT-setup capability
// toggles) is x11-specific plumbing that was never meant to join the
// ScreenDriver interface — see server/lib/screen-driver.ts. Every per-session
// desktop operation below goes through pickDriver() instead.
import * as desktops from './lib/desktops.js';
import { pickDriver } from './lib/screen-driver.js';
import * as chrome from './lib/chrome.js';
import * as reap from './reap.js';
import * as browserActions from './lib/browser-actions.js';
import * as caps from './capabilities.js';
import * as agents from './agents.js';
import * as policy from './agent-policy.js';
import * as ledger from './agent-ledger.js';
import * as mcpCat from './mcp-catalog.js';
import * as mcpConn from './mcp-connections.js';
import * as mcpAuth from './mcp-auth.js';
import {
  changesFor,
  changeDiff,
  changeIdentity,
  prStatus,
  listBaseRefs,
  worktreeInfo,
  provisionChildWorktree,
} from './git.js';
import { mergeBranch, baseStatus, mergeMessage } from './merge.js';
import fs from 'node:fs';

const PERMISSION_TIMEOUT_MS = Number(process.env.ARIGAMI_PERMISSION_TIMEOUT_MS) > 0 ? Number(process.env.ARIGAMI_PERMISSION_TIMEOUT_MS) : 10 * 60 * 1000; // env: tests only
// CHAT1: a "Question for you" card is a conversation, not a tool gate — the
// human gets the same 30 minutes a request_screen card gets before the model
// is told there was no answer.
const QUESTION_TIMEOUT_MS = Number(process.env.ARIGAMI_QUESTION_TIMEOUT_MS) > 0 ? Number(process.env.ARIGAMI_QUESTION_TIMEOUT_MS) : 30 * 60 * 1000;
// Longer than a permission decision — a request_screen ask is typically a
// manual login/2FA/CAPTCHA flow the human has to actually walk through.
const SCREEN_REQUEST_TIMEOUT_MS = 30 * 60 * 1000;
// Push-title suffix per request_screen `reason` (agreed names, see T1/T4 spec).
const SCREEN_REASON_LABEL: Record<string, string> = {
  login: 'login needed',
  '2fa': '2FA code needed',
  captcha: 'CAPTCHA needed',
  payment: 'payment step needs you',
  other: 'needs you on the machine',
};

interface PendingPermission {
  resolve: (value: PermissionResult | PromiseLike<PermissionResult>) => void;
  timer: NodeJS.Timeout;
  sessionId: string;
  toolName: string;
  input: unknown;
  /** CHAT1: the tool_use this prompt gates — how a question card finds its request. */
  toolUseId?: string;
}

interface ScreenRequestResult {
  ok: boolean;
  // true iff the human clicked "Take over" and drove the desktop before Done;
  // false when they just acknowledged (or the request timed out / expired).
  takenOver: boolean;
  note?: string;
}

const SCREEN_REQUEST_REASONS = ['login', '2fa', 'captcha', 'payment', 'other'] as const;
type ScreenRequestReason = (typeof SCREEN_REQUEST_REASONS)[number];

interface PendingScreenRequest {
  resolve: (value: ScreenRequestResult | PromiseLike<ScreenRequestResult>) => void;
  timer: NodeJS.Timeout;
  sessionId: string;
}

// S1 — request_setup: the agent asks for a capability; the human (or the agent
// itself, in auto mode) connects it. Mirrors request_screen: blocking promise,
// pending map, chat card + push, force-expire on session death.
const SETUP_REQUEST_TIMEOUT_MS = Number(process.env.ARIGAMI_SETUP_TIMEOUT_MS) > 0 ? Number(process.env.ARIGAMI_SETUP_TIMEOUT_MS) : 15 * 60 * 1000; // env: tests only
type SetupMode = 'auto' | 'manual' | 'ask';
type SetupState = 'pending' | 'auto' | 'done' | 'skipped' | 'timeout' | 'failed'; // failed = auto attempt failed, card open in manual
interface SetupResult {
  state: 'done' | 'skipped' | 'timeout' | 'auto';
  id: string;
  capability: string;
  detail: string;
  mode: SetupMode;
  playbook?: string;
  evidence?: string | null;
  already?: boolean;
  owner?: caps.Owner; // A2: where an `already` answer resolved from
}
interface PendingSetup {
  id: string;
  sessionId: string;
  capability: string;
  owner: caps.Owner; // A2: 'agent:<slug>' when the requesting session was born from an agent (ownable capabilities only)
  why: string;
  mode: SetupMode;
  state: SetupState;
  evidence: string | null;
  detail: string;
  createdAt: string;
  lines: string[]; // agent narration (report_setup progress lines)
  timer: NodeJS.Timeout;
  // Agents blocked on this card (manual/ask). Empty in auto mode.
  waiters: Array<(r: SetupResult) => void>;
}
const pendingSetups = new Map<string, PendingSetup>();
// F6: cards closed by something other than a human skip (timeout / agent
// report / session delete) stay reachable so a late report_setup can reopen
// and update them; a human "Not now" is final. Bounded per session.
const closedSetups = new Map<string, PendingSetup>();
const CLOSED_SETUPS_MAX = 200;

type PersistedSetup = Pick<PendingSetup, 'id' | 'sessionId' | 'capability' | 'owner' | 'why' | 'mode' | 'state' | 'evidence' | 'detail' | 'createdAt' | 'lines'>;
function persistPendingSetups(): void {
  const list: PersistedSetup[] = [...pendingSetups.values()].map(({ id, sessionId, capability, owner, why, mode, state: st, evidence, detail, createdAt, lines }) => ({ id, sessionId, capability, owner, why, mode, state: st, evidence, detail, createdAt, lines }));
  try {
    fs.mkdirSync(path.dirname(caps.SETUP_PENDING_FILE), { recursive: true });
    fs.writeFileSync(caps.SETUP_PENDING_FILE, JSON.stringify(list, null, 2) + '\n');
  } catch {
    /* never fail the caller */
  }
}
function setupTimer(id: string, createdAt: string): NodeJS.Timeout {
  const left = Math.max(1000, new Date(createdAt).getTime() + SETUP_REQUEST_TIMEOUT_MS - Date.now());
  return setTimeout(() => {
    const cur = pendingSetups.get(id);
    if (cur) finishSetup(cur, 'timeout', { detail: 'timed out — nobody connected it in 15 minutes', human: false });
  }, left);
}
/** Host start: reload the open cards of sessions that still exist (their chat already shows the card). */
function loadPendingSetups(): void {
  let list: PersistedSetup[] = [];
  try {
    list = JSON.parse(fs.readFileSync(caps.SETUP_PENDING_FILE, 'utf8'));
  } catch {
    return;
  }
  if (!Array.isArray(list)) return;
  for (const p of list) {
    if (!p || typeof p.id !== 'string' || !state.getSession(p.sessionId)) continue;
    if (!['pending', 'auto', 'failed'].includes(p.state)) continue;
    pendingSetups.set(p.id, { ...p, owner: caps.parseOwner(p.owner) || ownerOfSession(p.sessionId, p.capability), lines: Array.isArray(p.lines) ? p.lines : [], evidence: p.evidence ?? null, timer: setupTimer(p.id, p.createdAt), waiters: [] });
  }
  if (pendingSetups.size) persistPendingSetups();
}
function rememberClosed(e: PendingSetup): void {
  closedSetups.set(e.id, e);
  while (closedSetups.size > CLOSED_SETUPS_MAX) closedSetups.delete(closedSetups.keys().next().value as string);
}
/** The most recent closed (non-skipped) card for a session+capability, or by id. */
function closedSetupFor(sessionId: string, capability: string, id?: string): PendingSetup | undefined {
  if (id && closedSetups.has(id)) return closedSetups.get(id);
  let best: PendingSetup | undefined;
  for (const e of closedSetups.values()) if (e.sessionId === sessionId && e.capability === capability) best = e;
  return best;
}

interface CleanupPlanResult {
  removable: boolean;
  recorded: boolean;
  cmds: string[];
  worktree: string | null;
  branch: string | null;
}

const pendingPermissions = new Map<string, PendingPermission>();
const pendingScreenRequests = new Map<string, PendingScreenRequest>();

/** Is a human (possibly) looking at this session's desktop right now? The idle browser closer asks. */
export function hasOpenScreenRequest(sessionId: string): boolean {
  for (const e of pendingScreenRequests.values()) if (e.sessionId === sessionId) return true;
  return false;
}

// ---- CHAT1: long-poll legs for the endpoints that block on a human ----------
// One HTTP request held open until the human clicks died after ~5 minutes
// (the MCP process's fetch idle timeout): the tool returned "arigami
// unreachable", the model went on without the answer, and the card the host
// kept open for its own 10/15/30-minute timer resolved into nothing when the
// human finally clicked — "I answered and the chat is stuck". Now a client
// that sends `wait_key` (mcp/blocking-call.js) gets each HTTP leg capped at
// WAIT_LEG_MS and re-attaches with POST /__mcp/wait until the real result
// lands. A client without a key (an MCP process from before this shipped)
// still gets the single blocking response.
const WAIT_LEG_MS = Number(process.env.ARIGAMI_WAIT_LEG_MS) > 0 ? Number(process.env.ARIGAMI_WAIT_LEG_MS) : 4 * 60 * 1000;
const WAIT_KEY_RE = /^wait_[A-Za-z0-9-]{8,80}$/;
const WAIT_RESULT_TTL_MS = 5 * 60 * 1000; // a result nobody came back for is dropped
interface WaitEntry {
  sessionId: string;
  promise: Promise<unknown>;
  legs: number;
  expire?: NodeJS.Timeout;
}
const blockingWaits = new Map<string, WaitEntry>();
function waitKeyOf(body: Record<string, unknown>): string | null {
  const k = body?.wait_key;
  return typeof k === 'string' && WAIT_KEY_RE.test(k) ? k : null;
}
async function waitLeg(res: ServerResponse, key: string, entry: WaitEntry): Promise<void> {
  entry.legs++;
  let timer: NodeJS.Timeout | undefined;
  const leg = new Promise<null>((r) => {
    timer = setTimeout(() => r(null), WAIT_LEG_MS);
  });
  const hit = await Promise.race([entry.promise.then((v) => ({ v })), leg]);
  if (timer) clearTimeout(timer);
  if (!hit) return json(res, { pending: true, wait_key: key, legs: entry.legs }, 202);
  blockingWaits.delete(key);
  if (entry.expire) clearTimeout(entry.expire);
  json(res, hit.v);
}
async function respondBlocking(res: ServerResponse, body: Record<string, unknown>, sessionId: string, promise: Promise<unknown>): Promise<void> {
  const key = waitKeyOf(body);
  if (!key) return json(res, await promise);
  const entry: WaitEntry = { sessionId, promise, legs: 0 };
  promise.then(() => {
    // The result outlives the leg that just missed it; if no client ever
    // comes back for it (its process died) it is dropped after the TTL.
    entry.expire = setTimeout(() => blockingWaits.delete(key), WAIT_RESULT_TTL_MS);
    if (entry.expire.unref) entry.expire.unref();
  });
  blockingWaits.set(key, entry);
  await waitLeg(res, key, entry);
}
/** Test/diagnostics view: how many blocking calls are attached right now. */
export function blockingWaitCount(sessionId?: string): number {
  let n = 0;
  for (const e of blockingWaits.values()) if (!sessionId || e.sessionId === sessionId) n++;
  return n;
}

// ---- B4-full: host export / import ---------------------------------------------
// Export streams a tar.gz straight from `tar` (server/backup.ts) — nothing is
// buffered. Import spools the upload (raw tar.gz body, or multipart with one
// file field) to $ARIGAMI_DIR/tmp, then either restores a full backup and asks
// host-control for a restart, or unpacks + applies a profile bundle.
const IMPORT_MAX_BYTES = 8 * 1024 * 1024 * 1024;

async function handleHostExport(
  req: IncomingMessage,
  res: ServerResponse,
  opts: { mode: string; include: string[]; memory?: boolean; name?: string; whatsapp?: boolean }
): Promise<void> {
  const bk = await import('./backup.js');
  let r: import('./backup.js').ExportResult;
  try {
    if (opts.mode === 'bundle') {
      const tr = await import('./triggers.js');
      const b = bk.exportBundle({ cron: tr.listTriggers(), memory: opts.memory !== false, name: opts.name });
      r = bk.tarDir(b.dir, `arigami-bundle-${b.name}-${bk.stamp()}.tgz`);
    } else if (opts.mode === 'full') {
      r = bk.exportFull({ include: opts.include, whatsapp: opts.whatsapp });
    } else return json(res, { error: 'mode must be "full" or "bundle"' }, 400);
  } catch (e) {
    return json(res, { error: (e as Error).message }, 500);
  }
  res.writeHead(200, {
    'Content-Type': 'application/gzip',
    'Content-Disposition': `attachment; filename="${r.filename}"`,
    'Cache-Control': 'no-store',
    'X-Arigami-Export': opts.mode,
    // #1: a plain header (not JSON — this response body is the tar stream
    // itself) so a caller that opted into `whatsapp` sees the "old machine
    // will log out" notice even on a raw `curl -OJ`.
    ...(r.warnings.length ? { 'X-Arigami-Warning': r.warnings.join(' | ') } : {}),
  });
  // F4 #1: pipe() ends `res` when tar's stdout ends; `done` (tar's close) can
  // settle after or before that — end explicitly either way, and stop tar
  // when the client goes away mid-stream so it never runs to completion for nobody.
  let aborted = false;
  res.on('close', () => { if (!res.writableFinished) { aborted = true; r.kill(); try { r.stream.destroy(); } catch {} } });
  r.stream.pipe(res);
  const code = await r.done;
  if (!res.writableEnded) res.end();
  if (aborted) console.log(`[backup] export ${opts.mode} aborted by the client`);
  else if (code !== 0 && code !== 1) console.error(`[backup] export ${opts.mode}: tar exited ${code}`);
  r.cleanup();
}

/** Spool the request body to a temp file. Multipart: keep only the first file part's bytes. */
function spoolUpload(req: IncomingMessage, dir: string): Promise<string> {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `import-${Date.now().toString(36)}.tgz`);
    const ct = String(req.headers['content-type'] || '');
    const bm = /boundary=("?)([^";]+)\1/i.exec(ct);
    const out = fs.createWriteStream(file);
    let total = 0;
    const fail = (e: Error) => { try { out.destroy(); fs.rmSync(file, { force: true }); } catch {} reject(e); };
    req.on('error', fail);
    out.on('error', fail);
    if (!bm) {
      req.on('data', (c: Buffer) => { total += c.length; if (total > IMPORT_MAX_BYTES) { req.destroy(); fail(new Error('upload too large')); } });
      req.pipe(out);
      out.on('finish', () => resolve(file));
      return;
    }
    // multipart/form-data — a small streaming parser for the first file part.
    // Each chunk is consumed in a loop: a whole small body may arrive at once,
    // with the non-file fields AND the file in the same chunk.
    const boundary = Buffer.from(`\r\n--${bm[2]}`);
    let buf = Buffer.alloc(0);
    let inFile = false;
    let done = false;
    const feed = () => {
      for (;;) {
        if (done) return;
        if (!inFile) {
          const hdrEnd = buf.indexOf('\r\n\r\n');
          if (hdrEnd < 0) return;
          const hdr = buf.slice(0, hdrEnd).toString('latin1');
          if (!/filename=/i.test(hdr)) { // skip a non-file field
            const next = buf.indexOf(boundary, hdrEnd);
            if (next < 0) return;
            buf = buf.slice(next + boundary.length);
            continue;
          }
          inFile = true;
          buf = buf.slice(hdrEnd + 4);
        }
        const end = buf.indexOf(boundary);
        if (end >= 0) {
          out.write(buf.slice(0, end));
          done = true;
          out.end();
          return;
        }
        const keep = boundary.length;
        if (buf.length > keep) { out.write(buf.slice(0, buf.length - keep)); buf = buf.slice(buf.length - keep); }
        return;
      }
    };
    req.on('data', (c: Buffer) => {
      if (done) return;
      total += c.length;
      if (total > IMPORT_MAX_BYTES) { req.destroy(); return fail(new Error('upload too large')); }
      buf = Buffer.concat([buf, c]);
      feed();
    });
    req.on('end', () => {
      if (!done) { if (inFile) out.write(buf); out.end(); }
    });
    out.on('finish', () => (inFile ? resolve(file) : fail(new Error('multipart body has no file part'))));
  });
}

// ---- ZIP: streamed attachment upload ---------------------------------------
// The composer's base64-in-JSON path (POST .../message) is capped at ~8MB by
// the client and 32MB by readBody — fine for a screenshot, useless for a repo
// export. Anything at or past that threshold streams here instead: either a
// raw body (Content-Type + X-Arigami-Filename header, what the composer's XHR
// sends — it needs upload.onprogress, which fetch can't give) or a normal
// multipart/form-data single-file post, so curl -F works too.
// OPENUI: cap on one render_ui block (the web card refuses the same size).
const OPENUI_MAX_CHARS = 64 * 1024;
const ATTACHMENT_MAX_BYTES = Number(process.env.ARIGAMI_ATTACHMENT_MAX_BYTES) > 0 ? Number(process.env.ARIGAMI_ATTACHMENT_MAX_BYTES) : 200 * 1024 * 1024; // env: tests only

function spoolAttachment(
  req: IncomingMessage,
  dir: string,
  maxBytes: number
): Promise<{ file: string; filename: string; contentType: string }> {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `up-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
    const ct = String(req.headers['content-type'] || '');
    const bm = /boundary=("?)([^";]+)\1/i.exec(ct);
    const out = fs.createWriteStream(file);
    let total = 0;
    let settled = false;
    // Never req.destroy() on an over-cap upload — an abrupt socket teardown
    // reads on the client as ECONNRESET instead of the 413 we want it to see.
    // Just stop writing bytes and drain the rest of the body so the server
    // can still respond normally on the same connection.
    const fail = (e: Error) => {
      if (settled) return;
      settled = true;
      try { out.destroy(); fs.rmSync(file, { force: true }); } catch {}
      req.resume();
      reject(e);
    };
    const succeed = (v: { file: string; filename: string; contentType: string }) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    const tooBig = () => Object.assign(new Error(`upload exceeds the ${maxBytes}-byte cap`), { status: 413 });
    req.on('error', fail);
    out.on('error', fail);
    if (!bm) {
      const rawName = req.headers['x-arigami-filename'];
      let filename = 'upload';
      try { filename = rawName ? decodeURIComponent(String(rawName)) : 'upload'; } catch { filename = String(rawName); }
      const contentType = ct || 'application/octet-stream';
      req.on('data', (c: Buffer) => {
        if (settled) return;
        total += c.length;
        if (total > maxBytes) { req.unpipe(out); fail(tooBig()); return; }
      });
      req.pipe(out);
      out.on('finish', () => succeed({ file, filename, contentType }));
      return;
    }
    // multipart/form-data — the same small streaming parser as spoolUpload
    // above, but this one also captures the file part's own filename/type.
    const boundary = Buffer.from(`\r\n--${bm[2]}`);
    let buf = Buffer.alloc(0);
    let inFile = false;
    let done = false;
    let filename = 'upload';
    let contentType = 'application/octet-stream';
    const feed = () => {
      for (;;) {
        if (done) return;
        if (!inFile) {
          const hdrEnd = buf.indexOf('\r\n\r\n');
          if (hdrEnd < 0) return;
          const hdr = buf.slice(0, hdrEnd).toString('latin1');
          const fn = /filename="([^"]*)"/i.exec(hdr);
          if (!fn) {
            const next = buf.indexOf(boundary, hdrEnd);
            if (next < 0) return;
            buf = buf.slice(next + boundary.length);
            continue;
          }
          filename = fn[1];
          const ctm = /content-type:\s*([^\r\n]+)/i.exec(hdr);
          if (ctm) contentType = ctm[1].trim();
          inFile = true;
          buf = buf.slice(hdrEnd + 4);
        }
        const end = buf.indexOf(boundary);
        if (end >= 0) {
          out.write(buf.slice(0, end));
          done = true;
          out.end();
          return;
        }
        const keep = boundary.length;
        if (buf.length > keep) { out.write(buf.slice(0, buf.length - keep)); buf = buf.slice(buf.length - keep); }
        return;
      }
    };
    req.on('data', (c: Buffer) => {
      if (done || settled) return;
      total += c.length;
      if (total > maxBytes) { fail(tooBig()); return; }
      buf = Buffer.concat([buf, c]);
      feed();
    });
    req.on('end', () => {
      if (!done && !settled) { if (inFile) out.write(buf); out.end(); }
    });
    out.on('finish', () => (inFile ? succeed({ file, filename, contentType }) : fail(new Error('multipart body has no file part'))));
  });
}

async function handleHostImport(
  req: IncomingMessage,
  res: ServerResponse,
  u: URL,
  hc: typeof import('./host-control.js')
): Promise<void> {
  const bk = await import('./backup.js');
  const force = u.searchParams.get('force') === '1' || u.searchParams.get('force') === 'true';
  const whatsapp = ['1', 'true', 'yes'].includes(String(u.searchParams.get('whatsapp') || ''));
  let file = '';
  try {
    file = await spoolUpload(req, bk.TMP_DIR);
    const { kind } = await bk.detectArchive(file);
    if (kind === 'bundle') {
      const unpacked = await bk.unpackBundle(file);
      const pf = await import('./profiles.js');
      const report = await pf.applySource(unpacked.dir);
      broadcast({ type: 'host', event: { kind: 'import-done', mode: 'bundle', name: unpacked.name } });
      return json(res, { ok: true, kind, ...report });
    }
    const r = await bk.importFull(file, { force, whatsapp, busyCount: hc.busySessions });
    // The dir on disk is the imported one now, but this process still holds
    // the PRE-import world in memory — and shutdown() flushes before it exits,
    // so the restart below used to come up with the imported chat/ and agents/
    // (files on disk, untouched) and the old session list (state.json,
    // rewritten on the way out). Reported live as "the import brought only the
    // agents, not the sessions".
    //
    // Per file, not wholesale: a PARTIAL archive leaves state.json alone, and
    // freezing it there would strand the sessions this host still owns —
    // they'd stop being written for the rest of the process's life.
    if (r.restored.includes('state.json')) state.freezeState('import restored state.json');
    if (r.restored.includes('triggers.json')) (await import('./triggers.js')).freezeTriggers('import restored triggers.json');
    broadcast({ type: 'host', event: { kind: 'import-done', mode: 'full', backupDir: r.backupDir, version: r.manifest.version } });
    // F4 #3: no supervisor → say so and stay up (the data dir is already
    // swapped; `bin/host restart` finishes the job). Never exit unsupervised.
    let restart: { scheduled: string | false; reason?: string; busySessions?: number };
    let restartError: string | null = null;
    const manager = hc.detectManager();
    if (manager === 'none') restart = { scheduled: false, reason: 'no supervisor — restart manually' };
    else {
      try { restart = hc.restarts.request('now', 'import'); } catch (e) { restartError = (e as Error).message; restart = { scheduled: false, reason: restartError }; }
    }
    return json(res, { ok: true, kind, ...r, restart, restartError, manager });
  } catch (e) {
    const err = e as Error & { status?: number };
    return json(res, { error: err.message }, err.status || 500);
  } finally {
    try { if (file) fs.rmSync(file, { force: true }); } catch {}
  }
}

function json(
  res: ServerResponse,
  body: unknown,
  status: number = 200
): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

const notFound = (
  res: ServerResponse,
  what: string = 'not found'
): void => json(res, { error: what }, 404);

const badRequest = (res: ServerResponse, msg: string): void =>
  json(res, { error: msg }, 400);

function readBody(
  req: IncomingMessage,
  maxBytes: number = 5e6
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c: Buffer) => {
      data += c;
      if (data.length > maxBytes) {
        reject(new Error('body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data) as Record<string, unknown>);
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

export interface PermissionResult {
  behavior: string;
  message?: string;
  updatedInput?: unknown;
  timedOut?: boolean;
}

async function handlePermissionRequest(
  res: ServerResponse,
  body: Record<string, unknown>
): Promise<void> {
  const sessionId = body.session_id as string | undefined;
  const s = sessionId && state.getSession(sessionId);
  if (!s) return badRequest(res, `unknown session_id: ${sessionId}`);
  const toolName = (body.tool_name || body.toolName || 'unknown') as string;
  const input = body.input ?? {};
  // NOTE on AskUserQuestion: we deliberately keep it on the normal (blocking)
  // permission path. Auto-approving it made the CLI run the tool immediately and
  // return "the user did not answer" (there's no interactive TTY in headless
  // stream-json mode), so the model proceeded WITHOUT waiting. Keeping the
  // permission pending is what makes the model wait; the user answers through the
  // rendered "Question for you" card (posted as a message, which interrupts the
  // blocked turn). We only hide the redundant permission *bubble* in the UI — see
  // ChatPane's permission-request case.
  const toolUseId = typeof body.tool_use_id === 'string' && body.tool_use_id ? body.tool_use_id : undefined;
  const promise = openPermission(sessionId, { toolName, input, toolUseId }).then(({ timedOut: _t, ...r }) => r);
  // CHAT1: long-poll legs (see respondBlocking) — the MCP process re-attaches
  // instead of dying at its fetch timeout while the human is still deciding.
  await respondBlocking(res, body, sessionId, promise);
}

/** A permission (or AskUserQuestion) card; resolves with the human's answer, or deny on timeout. Also used by codex app-server approvals. */
export function openPermission(
  sessionId: string,
  { toolName, input, toolUseId, timeoutMs }: { toolName: string; input: unknown; toolUseId?: string; timeoutMs?: number }
): Promise<PermissionResult> {
  const requestId = 'perm_' + nano();
  const isQuestion = toolName === 'AskUserQuestion';
  const ms = timeoutMs || (isQuestion ? QUESTION_TIMEOUT_MS : PERMISSION_TIMEOUT_MS);
  return new Promise<PermissionResult>((resolve) => {
    const timer = setTimeout(() => {
      pendingPermissions.delete(requestId);
      state.setClaude(sessionId, { state: 'working' });
      claude.appendChat(sessionId, {
        kind: 'permission-answer',
        requestId,
        ...(toolUseId ? { toolUseId } : {}),
        behavior: 'deny',
        message: 'timed out',
      });
      resolve({
        behavior: 'deny',
        timedOut: true,
        message: isQuestion
          ? `The human did not answer the question card within ${Math.max(1, Math.round(ms / 60000))} minutes. Do not re-ask the same question right away — continue with a sensible default and say which one you picked.`
          : `Permission request timed out after ${Math.max(1, Math.round(ms / 60000))} minutes`,
      });
    }, ms);
    pendingPermissions.set(requestId, { resolve, timer, sessionId, toolName, input, ...(toolUseId ? { toolUseId } : {}) });
    state.setClaude(sessionId, { state: 'awaiting-input' });
    claude.appendChat(sessionId, { kind: 'permission-request', requestId, toolName, input, ...(toolUseId ? { toolUseId } : {}) });
    broadcast({ type: `permission-request:${sessionId}`, requestId, toolName, input, ...(toolUseId ? { toolUseId } : {}) });
  });
}

/** Close a codex card the engine resolved itself (serverRequest/resolved) — no answer is sent. */
export function dismissPermission(sessionId: string, toolUseId: string, message = 'resolved by the engine'): void {
  for (const [requestId, entry] of pendingPermissions) {
    if (entry.sessionId !== sessionId || entry.toolUseId !== toolUseId) continue;
    clearTimeout(entry.timer);
    pendingPermissions.delete(requestId);
    claude.appendChat(sessionId, { kind: 'permission-answer', requestId, toolUseId, behavior: 'deny', message });
    entry.resolve({ behavior: 'deny', message });
  }
}

// Force-deny any permission request left pending for a session — e.g. its
// `claude` process just died — instead of leaving the chat card showing live
// Allow/Deny buttons for up to PERMISSION_TIMEOUT_MS with nothing behind them.
export function expirePendingPermissions(
  sessionId: string,
  message: string = 'session ended'
): void {
  for (const [requestId, entry] of pendingPermissions) {
    if (entry.sessionId !== sessionId) continue;
    clearTimeout(entry.timer);
    pendingPermissions.delete(requestId);
    claude.appendChat(sessionId, {
      kind: 'permission-answer',
      requestId,
      ...(entry.toolUseId ? { toolUseId: entry.toolUseId } : {}), // CHAT1: closes the question card too
      behavior: 'deny',
      message,
    });
    entry.resolve({ behavior: 'deny', message });
  }
}

function answerPermission(
  sessionId: string,
  data: {
    requestId: string;
    behavior: string;
    message?: string;
    updatedInput?: unknown;
    /** CHAT1: a question card's picks (question text → label), echoed on the chat event. */
    answers?: Record<string, string>;
  }
): { ok: boolean } | null {
  const entry = pendingPermissions.get(data.requestId);
  if (!entry || entry.sessionId !== sessionId) return null;
  clearTimeout(entry.timer);
  pendingPermissions.delete(data.requestId);
  state.setClaude(sessionId, { state: 'working' });
  claude.appendChat(sessionId, {
    kind: 'permission-answer',
    requestId: data.requestId,
    ...(entry.toolUseId ? { toolUseId: entry.toolUseId } : {}),
    behavior: data.behavior,
    ...(data.message ? { message: data.message } : {}),
    ...(data.answers ? { answers: data.answers } : {}),
  });
  entry.resolve(
    data.behavior === 'allow'
      ? {
          behavior: 'allow',
          updatedInput: data.updatedInput ?? entry.input,
        }
      : {
          behavior: 'deny',
          message: data.message || 'Denied by user',
        }
  );
  return { ok: true };
}

// ---- CHAT1: the "Question for you" card --------------------------------------
// AskUserQuestion is a CLI-side tool that blocks on the permission prompt
// (handlePermissionRequest keeps it pending so the model waits for the card).
// The CLI's own answer channel IS that permission result:
//   {behavior:'allow', updatedInput:{...input, answers:{[question]: label}}}
// — the tool then returns "Your questions have been answered: …" on the SAME
// turn, at once. The old path wrote a tool_result onto stdin while the tool
// was still waiting on the permission: the CLI read it as a new user message,
// cancelled the pending tool ("The user doesn't want to proceed with this tool
// use"), ended the turn with error_during_execution and dropped the answer —
// the card looked answered and the chat sat there. When nothing is pending any
// more (the tool already timed out, the process or the host was restarted) the
// answer goes in as a normal user message instead, and the caller is told so.
export interface QuestionAnswer {
  question: string;
  answer: string | null; // null = skipped
}
export function answerQuestion(
  sessionId: string,
  data: { toolUseId?: string; content?: string; answers?: QuestionAnswer[] | null }
): { ok: true; delivered: 'tool' | 'message'; requestId?: string } {
  let found: [string, PendingPermission] | undefined;
  for (const [rid, e] of pendingPermissions) {
    if (e.sessionId !== sessionId || e.toolName !== 'AskUserQuestion') continue;
    if (data.toolUseId && e.toolUseId && e.toolUseId !== data.toolUseId) continue;
    found = [rid, e]; // insertion order → the newest matching card wins
  }
  const list = Array.isArray(data.answers) ? data.answers.filter((a) => a && typeof a.question === 'string') : [];
  const text =
    (data.content || '').trim() ||
    list.map((a) => `${a.question}: ${typeof a.answer === 'string' && a.answer ? a.answer : '(no answer)'}`).join('\n');
  if (!found) {
    claude.sendMessage(sessionId, text || '(no answer)');
    return { ok: true, delivered: 'message' };
  }
  const [requestId, entry] = found;
  const input = (entry.input && typeof entry.input === 'object' ? entry.input : {}) as { questions?: Array<{ question?: string; header?: string }> };
  const answers: Record<string, string> = {};
  if (list.length) {
    for (const a of list) if (typeof a.answer === 'string' && a.answer) answers[a.question] = a.answer;
  } else {
    // An older cockpit build sends only the "label: answer" lines — map them
    // back onto the questions the model asked.
    const lines = text.split('\n');
    for (const q of input.questions || []) {
      for (const label of [q?.question, q?.header]) {
        if (!label) continue;
        const line = lines.find((l) => l.startsWith(`${label}: `));
        const a = line ? line.slice(label.length + 2).trim() : '';
        if (a && a !== '(no answer)' && q?.question) { answers[q.question] = a; break; }
      }
    }
  }
  answerPermission(sessionId, {
    requestId,
    behavior: 'allow',
    updatedInput: { ...input, answers },
    message: text,
    answers,
  });
  return { ok: true, delivered: 'tool', requestId };
}

// ---- push for human intervention -------------------------------------------
// request_screen / request_action / report_to_master(blocked) all mean "the
// agent is stuck until a human acts". Mirror listeners.ts: one push per event,
// tagged by session so the OS collapses repeats into a single notification.
// Best-effort and fire-and-forget — push is never allowed to fail the request.
const INTERVENTION_PUSH_COOLDOWN_MS = 15 * 1000;
const lastInterventionPush = new Map<string, number>(); // `${sessionId}:${kind}` → ts
function pushIntervention(
  sessionId: string,
  kind: 'screen' | 'action' | 'blocked',
  body: string,
  titleSuffix?: string
): void {
  const key = `${sessionId}:${kind}`;
  const now = Date.now();
  // Same session, same kind, within the cooldown → the previous push is still
  // on the lock screen; don't buzz the phone again.
  if (now - (lastInterventionPush.get(key) || 0) < INTERVENTION_PUSH_COOLDOWN_MS) return;
  lastInterventionPush.set(key, now);
  const s = state.getSession(sessionId);
  const title = `${s?.title || 'Arigami'}${titleSuffix ? ` — ${titleSuffix}` : ''}`;
  import('./notify.js')
    .then((n) =>
      n.notify({
        title: title.slice(0, 80),
        body: body.slice(0, 200),
        tag: `${kind}:${sessionId}`,
        sessionId,
        url: publicUrl(sessionPath(sessionId)), // relative unless ARIGAMI_PUBLIC_URL (SW resolves it)
      })
    )
    .catch(() => {});
}

// request_screen: the agent asks the human to look at / drive the shared
// desktop (manual login, CAPTCHA, interactive installer…), shown as a live
// embedded view in the chat. Blocking, same shape as handlePermissionRequest.
async function handleScreenRequest(
  res: ServerResponse,
  body: Record<string, unknown>
): Promise<void> {
  const sessionId = body.session_id as string | undefined;
  const s = sessionId && state.getSession(sessionId);
  if (!s) return badRequest(res, `unknown session_id: ${sessionId}`);
  const requestId = 'scrn_' + nano();
  (await import('./funnel.js')).firstTime('screen.first_request');
  const prompt = String(body.prompt || '');
  // Optional context shown on the card: why the agent is blocked and what
  // exactly the human should complete. Unknown reasons collapse to 'other'.
  const reason: ScreenRequestReason | undefined = body.reason
    ? (SCREEN_REQUEST_REASONS as readonly string[]).includes(String(body.reason))
      ? (String(body.reason) as ScreenRequestReason)
      : 'other'
    : undefined;
  const hint = body.hint ? String(body.hint) : undefined;
  // Lazy per-session desktop (T8): by the time the card/panel mount and
  // connect, metadata.screen should already point at this session's own
  // machine, not the global one. A failed allocation (binary missing, ports
  // exhausted) isn't fatal — screenTarget() falls back to the global desktop.
  try { await pickDriver().ensure(sessionId!); } catch (e) { console.error('[screen] desktop alloc failed for', sessionId, (e as Error).message); }
  const promise = new Promise<ScreenRequestResult>((resolve) => {
    const timer = setTimeout(() => {
      pendingScreenRequests.delete(requestId);
      screens.stopAutoSnapshots(requestId);
      state.setClaude(sessionId, { state: 'working', screenRequest: null });
      const note = '(timed out — the human did not respond)';
      claude.appendChat(sessionId, { kind: 'screen-request-answer', requestId, note });
      resolve({ ok: true, takenOver: false, note });
    }, SCREEN_REQUEST_TIMEOUT_MS);
    pendingScreenRequests.set(requestId, { resolve, timer, sessionId });
    state.setClaude(sessionId, {
      state: 'awaiting-input',
      screenRequest: { requestId, ...(reason ? { reason } : {}) },
    });
    claude.appendChat(sessionId, {
      kind: 'screen-request',
      requestId,
      prompt,
      ...(reason ? { reason } : {}),
      ...(hint ? { hint } : {}),
    });
    // Watch-mode timeline: periodic snapshots grouped under this card until
    // the human takes over (mode → control) or answers.
    screens.startAutoSnapshots(sessionId, requestId);
    pushIntervention(
      sessionId,
      'screen',
      hint ? `${prompt}\n${hint}` : prompt,
      SCREEN_REASON_LABEL[reason ?? ''] || 'needs you on the machine'
    );
  });
  await respondBlocking(res, body, sessionId!, promise); // CHAT1: long-poll legs
}

// Force-resolve any screen request left pending for a session — e.g. its
// `claude` process just died — instead of leaving the chat card showing a
// live embedded view for up to SCREEN_REQUEST_TIMEOUT_MS with nothing behind it.
export function expirePendingScreenRequests(
  sessionId: string,
  message: string = 'session ended'
): void {
  screens.forgetSession(sessionId); // drop the dedup comparison frame
  for (const [requestId, entry] of pendingScreenRequests) {
    if (entry.sessionId !== sessionId) continue;
    clearTimeout(entry.timer);
    pendingScreenRequests.delete(requestId);
    screens.stopAutoSnapshots(requestId);
    state.setClaude(sessionId, { screenRequest: null });
    claude.appendChat(sessionId, { kind: 'screen-request-answer', requestId, note: message });
    entry.resolve({ ok: true, takenOver: false, note: message });
  }
}

function answerScreenRequest(
  sessionId: string,
  data: { requestId: string; note?: string; takenOver?: boolean }
): { ok: boolean } | null {
  const entry = pendingScreenRequests.get(data.requestId);
  if (!entry || entry.sessionId !== sessionId) return null;
  clearTimeout(entry.timer);
  pendingScreenRequests.delete(data.requestId);
  screens.stopAutoSnapshots(data.requestId);
  state.setClaude(sessionId, { state: 'working', screenRequest: null });
  const takenOver = data.takenOver === true;
  // The human may have just logged in / entered a 2FA code / paid — fold
  // whatever landed in this session's Chrome profile back into chrome-base
  // (T8 §4) so the NEXT session starts already logged in. Fire-and-forget:
  // never block the answer on it.
  if (takenOver) {
    // An AGENT session folds the take-over back into the agent's own profile
    // (its identity). A plain session no longer copies its whole profile into
    // the owner's: a login reaches "my browser" one site at a time, and only
    // when the owner approves it (save_login, login-vault.ts).
    if (chrome.profileSeedFor(sessionId).owner !== 'global') chrome.syncProfileToBase(sessionId).catch(() => {});
    chrome.touch(sessionId); // a human just used it — restart the idle clock
    // F6: an identity card waiting on this take-over resolves as done, never skipped.
    try { resolveIdentityAfterTakeover(sessionId); } catch {}
  }
  claude.appendChat(sessionId, {
    kind: 'screen-request-answer',
    requestId: data.requestId,
    takenOver,
    ...(data.note ? { note: data.note } : {}),
  });
  entry.resolve({ ok: true, takenOver, ...(data.note ? { note: data.note } : {}) });
  return { ok: true };
}

// ---- S1 JIT setup state machine ---------------------------------------------

function setupCardPayload(e: PendingSetup): Record<string, unknown> {
  return {
    id: e.id,
    requestId: e.id, // S2 keys the card by requestId (same value as id)
    capability: e.capability,
    why: e.why,
    mode: e.mode,
    state: e.state,
    evidence: e.evidence,
    detail: e.detail,
    lines: e.lines,
    owner: e.owner,
  };
}
const identityView = (owner: caps.Owner = caps.GLOBAL_OWNER): { email: string; owner: caps.Owner } | null => {
  // A2: an agent's card shows the AGENT's identity (what its auto playbook would use).
  const i = caps.readIdentity(owner);
  return i ? { email: i.email, owner } : null;
};

/**
 * A2: the owner a session's connections belong to — 'agent:<slug>' for a
 * session born from an agent, but only for OWNABLE capabilities (identity,
 * composio:*); host-level capabilities are always global.
 */
export function ownerOfSession(sessionId: string | null | undefined, capability?: string): caps.Owner {
  if (capability !== undefined && !caps.isOwnable(capability)) return caps.GLOBAL_OWNER;
  const s = sessionId ? state.getSession(sessionId) : null;
  return caps.ownerForAgent((s?.metadata as any)?.agent);
}

/** A2: the owner an HTTP request acts for — explicit `owner` wins (400 on garbage), else the session principal's agent, else global. */
function ownerOfRequest(explicit: unknown, me: import('./auth.js').Principal | null, capability?: string): caps.Owner | null {
  if (explicit !== undefined && explicit !== null && explicit !== '') {
    const o = caps.parseOwner(explicit);
    if (!o) return null;
    return capability !== undefined && !caps.isOwnable(capability) ? caps.GLOBAL_OWNER : o;
  }
  return me?.kind === 'session' ? ownerOfSession(me.sessionId, capability) : caps.GLOBAL_OWNER;
}

/** P2-4: capability probes that answer for a session's engine (mcp:* grants are per engine). */
function sessionProbes(sessionId: string | null | undefined): Partial<caps.CapabilityProbes> {
  const s = sessionId ? state.getSession(sessionId) : null;
  return s ? { engine: () => (s.engine === 'codex' ? 'codex' : 'claude') } : {};
}

// Every transition: one `setup-update` chat event (same id as the `setup`
// card — the web merges by id) + a bus `setup` broadcast for non-chat views
// (Settings → Connections re-fetches capabilities on it).
function broadcastSetup(e: PendingSetup, extra: Record<string, unknown> = {}): void {
  const payload = { ...setupCardPayload(e), ...extra };
  claude.appendChat(e.sessionId, { kind: 'setup-update', ...payload });
  broadcast({ type: 'setup-update', sessionId: e.sessionId, ...payload });
  persistPendingSetups();
}

function openSetupFor(sessionId: string, capability: string): PendingSetup | undefined {
  for (const e of pendingSetups.values())
    if (e.sessionId === sessionId && e.capability === capability && (e.state === 'pending' || e.state === 'auto' || e.state === 'failed')) return e;
  return undefined;
}

function finishSetup(e: PendingSetup, outcome: 'done' | 'skipped' | 'timeout', opts: { detail?: string; evidence?: string | null; human: boolean }): void {
  clearTimeout(e.timer);
  pendingSetups.delete(e.id);
  rememberClosed(e);
  e.state = outcome;
  if (opts.detail) e.detail = opts.detail;
  if (opts.evidence !== undefined) e.evidence = opts.evidence;
  const s = state.getSession(e.sessionId);
  if (s && (s.claude as any)?.setupRequest?.id === e.id) state.setClaude(e.sessionId, { state: 'working', setupRequest: null } as any);
  broadcastSetup(e);
  caps.appendAudit({ sessionId: e.sessionId, capability: e.capability, mode: e.mode, result: outcome, evidence: e.evidence, human: opts.human, detail: e.detail, owner: e.owner });
  import('./funnel.js').then((f) => f.emit(outcome === 'done' ? 'setup.completed' : 'setup.skipped', { capability: e.capability, mode: e.mode, ...(outcome === 'timeout' ? { timeout: true } : {}) })).catch(() => {});
  if (outcome === 'done') {
    caps.invalidateComposioCache();
    if (e.mode === 'auto' && !opts.human) caps.markIdentityProvider(e.capability, e.owner);
    // F6: a fresh ACTIVE account makes the earlier INITIALIZING/FAILED attempts orphans.
    if (e.capability.startsWith('composio:')) caps.pruneComposioOrphans(e.capability.slice(9), { owner: e.owner }).catch(() => {});
  }
  const result: SetupResult = { state: outcome, id: e.id, capability: e.capability, detail: e.detail, mode: e.mode, evidence: e.evidence };
  for (const w of e.waiters.splice(0)) w(result);
  try { emitLocal('setup.done', { capability: e.capability, ok: outcome === 'done', owner: e.owner, sessionId: e.sessionId }); } catch {}
}

/** F6: put a closed (not human-skipped) card back on the table so a late report can update it. */
function reopenSetup(e: PendingSetup, st: SetupState): PendingSetup {
  closedSetups.delete(e.id);
  e.state = st;
  e.timer = setupTimer(e.id, new Date().toISOString());
  e.waiters = [];
  pendingSetups.set(e.id, e);
  return e;
}

/**
 * F6: the human clicked Done on a take-over while an identity card was open —
 * probe the session's Chrome for the signed-in Google account and, if there
 * is one, register the identity and resolve the card as done (never skipped).
 * Without a detectable account the card stays open for the agent's own verify.
 */
export function resolveIdentityAfterTakeover(sessionId: string): { resolved: boolean; email: string | null } {
  const entry = openSetupFor(sessionId, 'identity');
  if (!entry) return { resolved: false, email: null };
  const email = chrome.googleAccountEmail(sessionId);
  if (!email) {
    entry.lines = [...entry.lines, 'take-over finished — verifying the Google sign-in'].slice(-20);
    broadcastSetup(entry);
    return { resolved: false, email: null };
  }
  try {
    // A2: an agent session's Google login lands in the AGENT's identity (its own Chrome profile).
    caps.writeIdentity({ email, chromeProfile: entry.owner === caps.GLOBAL_OWNER ? 'base' : entry.owner }, entry.owner);
  } catch {
    return { resolved: false, email: null };
  }
  finishSetup(entry, 'done', { detail: `signed in as ${email}`, human: true });
  broadcast({ type: 'setup.changed', capability: 'identity', owner: entry.owner });
  return { resolved: true, email };
}

/** A manual connection landed (REST payload / wizard) — close every open card for that capability. */
function resolveSetupsFor(capability: string, detail: string, human = true, owner: caps.Owner = caps.GLOBAL_OWNER): number {
  let n = 0;
  for (const e of [...pendingSetups.values()]) {
    if (e.capability !== capability || e.owner !== owner) continue;
    finishSetup(e, 'done', { detail, human });
    n++;
  }
  return n;
}

// ---- A1 agents (the Team section) ----------------------------------------------------------

/**
 * The {kind:'agent-card'} chat card (like SetupCard/MergeCard): create_agent /
 * update_agent from a session render one. `confirm:true` (the default for
 * create) posts a PENDING card with the draft — the human edits + confirms in
 * the chat (POST /__api/agents with cardId) or cancels; nothing is written
 * until then. Otherwise the change is applied at once and the card shows it.
 */
function handleAgentCard(res: ServerResponse, body: Record<string, unknown>): void {
  const sessionId = String(body.session_id || '');
  if (!sessionId || !state.getSession(sessionId)) return badRequest(res, `unknown session_id: ${sessionId}`);
  const action = body.action === 'update' ? 'update' : 'create';
  const draft = (body.draft && typeof body.draft === 'object' ? body.draft : {}) as agents.AgentInput;
  const cardId = 'agc_' + nano();
  if (action === 'update') {
    const slug = String(body.slug || '');
    const r = agents.updateAgent(slug, draft);
    if (!r.ok) return json(res, { ok: false, error: r.error }, r.status || 400);
    claude.appendChat(sessionId, { kind: 'agent-card', cardId, action, state: 'updated', agent: r.agent, patch: Object.keys(draft) });
    return json(res, { ok: true, cardId, state: 'updated', agent: r.agent });
  }
  const confirm = body.confirm !== false;
  if (confirm) {
    const r = openPendingAgentCard(sessionId, draft, cardId);
    if ('error' in r) return json(res, { ok: false, error: r.error }, r.status);
    return json(res, {
      card: true, cardId, state: 'pending', slug: r.slug,
      hint: 'The human sees an Agent card in the chat and can edit + confirm or cancel it; you get a message when they decide. Do not create it again meanwhile.',
    });
  }
  const r = agents.createAgent(draft);
  if (!r.ok) return json(res, { ok: false, error: r.error }, r.status || 400);
  claude.appendChat(sessionId, { kind: 'agent-card', cardId, action, state: 'created', agent: r.agent });
  return json(res, { ok: true, cardId, state: 'created', agent: r.agent });
}

/**
 * Post a PENDING {kind:'agent-card'} into a session's chat. Validates what it
 * can up front so the card never opens on a hopeless draft. Shared by the MCP
 * create_agent({confirm:true}) path and the composer's `/agent new [name]` (A4).
 */
function openPendingAgentCard(sessionId: string, draft: agents.AgentInput, cardId = 'agc_' + nano()): { cardId: string; slug: string } | { error: string; status: number } {
  const name = String(draft.name || '').trim();
  if (!name) return { error: 'name required', status: 400 };
  const slug = String(draft.slug || agents.slugify(name));
  if (!agents.SLUG_RE.test(slug)) return { error: `invalid slug "${slug}" — pass an explicit lowercase slug for non-Latin names`, status: 400 };
  if (agents.getAgent(slug)) return { error: `agent "${slug}" already exists — use update_agent`, status: 409 };
  claude.appendChat(sessionId, { kind: 'agent-card', cardId, action: 'create', state: 'pending', draft: { ...draft, slug, name } });
  return { cardId, slug };
}

/** Close a pending agent card in the chat (+ tell the session what the human decided). */
function settleAgentCard(sessionId: string, cardId: string, patch: Record<string, unknown>, note: string): void {
  if (!sessionId || !cardId || !state.getSession(sessionId)) return;
  claude.appendChat(sessionId, { kind: 'agent-card-update', cardId, ...patch });
  try {
    claude.sendMessage(sessionId, note);
  } catch (e) {
    console.error('[agents] card note failed:', (e as Error).message);
  }
}

const AGENT_WIRE_KEYS = ['id', 'title', 'status', 'archived', 'createdAt', 'updatedAt', 'color'] as const;
/** The agent a session was born from (metadata.agent), or null. */
const sessionAgent = (s: { metadata?: Record<string, unknown> } | null | undefined): string | null =>
  s && typeof s.metadata?.agent === 'string' && s.metadata.agent ? (s.metadata.agent as string) : null;

/**
 * A5 (#2) — a PUBLIC share link (share:true / share_artifact) from a session born
 * from an agent is never minted on the agent's word alone:
 *   allow — not an agent session (unchanged for the human's own sessions), or the
 *           agent has the 'share' kind in autoApprove;
 *   deny  — the agent has an allowlist without the `publish` family;
 *   ask   — the default: the host opens a request_action card of kind 'share' and
 *           mints the link only when the human approves it (see action/answer).
 */
const SHARE_KIND = 'share';
// Login cards (login-vault.ts): answered only by a person, and acted on by the
// host — the agent never touches the owner's browser itself.
const LOGIN_KIND = 'login';
const LOGIN_SAVE_KIND = 'login-save';
// Outbound cards (lib/outbound.ts): a message to a PERSON, shown verbatim; the
// host sends it only on a person's Send.
const OUTBOUND_KIND = 'outbound';

/** Put an outbound request up as a card on `sessionId`. The agent is told to wait. */
async function fileOutbound(sessionId: string, exec: import('./lib/outbound.js').OutboundExec, why?: string) {
  const ob = await import('./lib/outbound.js');
  const action = {
    id: 'act_' + nano(),
    at: new Date().toISOString(),
    kind: OUTBOUND_KIND,
    outbound: exec,
    prompt: ob.cardPrompt(exec, why),
    buttons: [
      { label: 'Send', value: 'send', style: 'primary' },
      { label: "Don't send", value: 'deny', style: 'danger' },
    ],
  };
  state.patchSession(sessionId, { action });
  pushIntervention(sessionId, 'action', `Send a message? ${ob.describe(exec).to || ''}`.trim(), 'waiting for your answer');
  return {
    pending: true,
    sent: false,
    note: 'NOT sent. The owner sees the exact message on a card; the host sends it, unchanged, only if they press Send, and messages you "[host] …" with the outcome. Stop and wait — do not try another way to send it.',
  };
}
function shareGate(s: unknown, me?: unknown): { mode: 'allow' | 'ask' | 'deny'; agent: agents.AgentView | null } {
  // A logged-in human clicking "mint a link" in the artifact card IS the approval.
  if ((me as any)?.kind === 'user') return { mode: 'allow', agent: null };
  const slug = sessionAgent(s as any);
  const a = slug ? agents.getAgent(slug) : null;
  if (!a) return { mode: 'allow', agent: null };
  if (!policy.toolAllowed(policy.policyOf(a), 'share_artifact')) return { mode: 'deny', agent: a };
  if ((a.autoApprove || []).includes(SHARE_KIND)) return { mode: 'allow', agent: a };
  return { mode: 'ask', agent: a };
}

/** Open the "mint a public link?" card for `artifactId` in the agent's session. */
function askShareApproval(id: string, a: agents.AgentView, artifactId: string, title: string, days?: number): Record<string, unknown> {
  const prompt = `${a.emoji} ${a.name} wants a PUBLIC link for "${title}" — anyone with the link can open it without logging in.`;
  const action: Record<string, unknown> = {
    id: 'act_' + nano(),
    prompt,
    buttons: [
      { label: 'Approve link', value: 'approve', style: 'primary' },
      { label: 'No link', value: 'no' },
    ],
    kind: SHARE_KIND,
    agent: { slug: a.slug, name: a.name, emoji: a.emoji, color: a.color },
    share: { artifactId, title, ...(days != null ? { days } : {}) },
  };
  state.patchSession(id, { action });
  pushIntervention(id, 'action', prompt, 'waiting for your answer');
  return action;
}

/** Every session stamped as this agent's home, oldest first (archived included). */
function homeSessionsOf(slug: string) {
  return state
    .listSessions({ archived: true })
    .filter((s) => s.metadata?.agentHome && s.metadata?.agent === slug)
    .sort((x, y) => String(x.createdAt).localeCompare(String(y.createdAt)));
}

/**
 * Get-or-create an agent's home chat: one long-lived, worktree-less session for
 * DMs (an archived home is restored). A NEW home is a new session of the agent
 * — refused (429) while its daily budget is spent (A3).
 *
 * UX1 — **one home per agent, enforced**: a home the agent record lost track of
 * (an older build, a restored backup) is adopted rather than re-created, and any
 * extra home is demoted to an ordinary work session — its transcript, ledger and
 * id all stay, it just stops being "the" home.
 */
function ensureHomeSession(a: agents.AgentView): { session: NonNullable<ReturnType<typeof state.getSession>>; created: boolean } {
  const homes = homeSessionsOf(a.slug);
  let s = a.homeSessionId ? state.getSession(a.homeSessionId) : null;
  if (!s) s = homes[0] || null;
  for (const extra of homes) {
    if (extra.id !== s?.id) state.patchSession(extra.id, { metadata: { ...extra.metadata, agentHome: false } });
  }
  if (s && a.homeSessionId !== s.id) agents.updateAgent(a.slug, { homeSessionId: s.id });
  let created = false;
  if (s && s.archived) state.patchSession(s.id, { archived: false });
  if (!s) {
    const b = ledger.budgetState(a.slug);
    if (b?.exceeded) {
      const err = new Error(ledger.budgetRefusal(b, a.name)) as Error & { status?: number; budget?: unknown };
      err.status = 429;
      err.budget = { ...b, name: a.name };
      throw err;
    }
    s = state.createSession({
      title: a.name,
      cwd: (cfg as any).reposDir || cfg.defaultCwd,
      metadata: { agent: a.slug, agentHome: true },
      model: a.model || null,
      engine: agents.engineForSpawn(null, a) || null,
      color: a.color,
    });
    created = true;
    agents.updateAgent(a.slug, { homeSessionId: s.id });
    spawnSafe(s.id);
  }
  return { session: state.getSession(s.id)!, created };
}

/**
 * A4 — route a composer @mention / `/as <agent> <text>` from session `fromId`:
 *  - `as`: a one-off session born from the agent that runs `text` (a FULL child
 *    in the caller's project folder when the caller is its controller, else a
 *    free session in the caller's cwd);
 *  - `mention` from a folder controller (PM): the same — a child born from the
 *    agent, tasked with the text;
 *  - `mention` from a normal session: the agent's home chat gets the text
 *    (now if idle, queued with auto-play if busy).
 * The caller's chat gets a {kind:'delegated'} receipt line either way. Throws
 * with .status on an unknown agent (404) / spent budget (429) / at-capacity (503).
 */
async function delegateToAgent(fromId: string, agentSlug: string, text: string, mode: 'mention' | 'as'): Promise<{ target: string; how: 'child' | 'session' | 'home'; delivered: 'now' | 'queued' }> {
  const from = state.getSession(fromId);
  if (!from) throw Object.assign(new Error(`unknown session: ${fromId}`), { status: 404 });
  const a = agents.getAgent(agentSlug);
  if (!a) throw Object.assign(new Error(`unknown agent: ${agentSlug}`), { status: 404 });
  const folder = from.folderId ? state.getFolder(from.folderId as string) : null;
  const isController = !!folder && folder.controllerSessionId === fromId;
  const brief = text.replace(/\s+/g, ' ').trim();
  const title = `${a.name}: ${brief.length > 48 ? brief.slice(0, 47) + '…' : brief}`;
  let target: string;
  let how: 'child' | 'session' | 'home';
  let delivered: 'now' | 'queued' = 'now';
  if (mode === 'as' || isController) {
    let cwd = from.cwd;
    let permissionMode: string | undefined;
    let metadata: Record<string, unknown> = {};
    if (isController) {
      const wired = await wireFullChild(fromId, { title });
      if ('deferred' in wired) throw Object.assign(new Error(`at capacity — no session created (${wired.reason})`), { status: 503 });
      cwd = wired.cwd;
      permissionMode = wired.permissionMode;
      metadata = wired.metadata;
    }
    // A PM child inherits the controller's engine when the agent has none.
    const engine = agents.engineForSpawn(null, a, isController ? from : null);
    const o = applyAgentToSession(a.slug, { title, model: undefined as string | undefined, engine: engine as string | undefined, metadata: { ...metadata, delegatedFrom: fromId } });
    const s = state.createSession({ title: o.title, cwd, permissionMode, metadata: o.metadata, model: o.model, engine: o.engine, color: o.color });
    spawnSafe(s.id);
    try {
      claude.sendMessage(s.id, isController ? `[Task from your project controller (${from.title || fromId})]\n\n${text}` : text);
    } catch {}
    if (isController) {
      const pf = ensureProjectFolder(fromId);
      if (pf) state.patchSession(s.id, { folderId: pf.id });
      how = 'child';
    } else how = 'session';
    target = s.id;
  } else {
    const home = ensureHomeSession(a).session;
    const fromLabel = from.title || fromId;
    delivered = deliverToSession(home.id, `[Forwarded from the chat "${fromLabel}" (session ${fromId}) — the human addressed you with @${a.slug}]\n\n${text}`).delivered;
    target = home.id;
    how = 'home';
  }
  const targetTitle = state.getSession(target)?.title || a.name;
  claude.appendChat(fromId, { kind: 'delegated', agent: { slug: a.slug, name: a.name, emoji: a.emoji, color: a.color }, target, targetTitle, how, delivered, mode, text });
  return { target, how, delivered };
}

/**
 * UX2 — "Adopt agent": a session already underway takes on an existing agent's
 * persona/skills/model/connections/policy for its NEXT turn onward, without
 * spawning a new session. `metadata.agent` is the single source both A3's
 * per-turn policy/budget checks (claude.js policyArgs / budgetRefusalFor) and
 * mcpConfigFor read fresh on every spawn, so setting it here is enough — the
 * only extra step is telling the model (a queued `[host]` line with the
 * adopted persona) and leaving a chat receipt so the human can revert.
 * `adoptedFrom` remembers what to restore ("Revert to normal") — null if the session
 * had no agent at all before adopting.
 */
function adoptAgentIntoSession(sessionId: string, agentSlug: string): { session: NonNullable<ReturnType<typeof state.getSession>>; agent: agents.AgentView } {
  const s = state.getSession(sessionId);
  if (!s) throw Object.assign(new Error(`unknown session: ${sessionId}`), { status: 404 });
  const a = agents.getAgent(agentSlug);
  if (!a) throw Object.assign(new Error(`unknown agent: ${agentSlug}`), { status: 404 });
  const b = ledger.budgetState(a.slug);
  if (b?.exceeded) {
    const err = new Error(ledger.budgetRefusal(b, a.name)) as Error & { status?: number; budget?: unknown };
    err.status = 429;
    err.budget = { ...b, name: a.name };
    throw err;
  }
  const prevAgent = typeof s.metadata?.agent === 'string' ? (s.metadata.agent as string) : null;
  state.patchSession(sessionId, { metadata: { agent: a.slug, adoptedFrom: prevAgent }, color: a.color });
  claude.appendChat(sessionId, { kind: 'agent-adopt', agent: { slug: a.slug, name: a.name, emoji: a.emoji, color: a.color }, prevAgent });
  const persona = agents.personaBlock(a.slug);
  deliverToSession(sessionId, `[host] The human adopted ${a.name} (${a.slug}) into this session — its persona, skills, tools/domain policy and daily budget apply from now on. Earlier turns in this chat ran without it.\n\n${persona}`);
  return { session: state.getSession(sessionId)!, agent: a };
}

/** The reverse of `adoptAgentIntoSession` — back to whatever agent (or none) ran the session before the adoption. */
function revertAgentAdoption(sessionId: string): void {
  const s = state.getSession(sessionId);
  if (!s) throw Object.assign(new Error(`unknown session: ${sessionId}`), { status: 404 });
  const prev = typeof s.metadata?.adoptedFrom === 'string' ? (s.metadata.adoptedFrom as string) : null;
  // `patchSession`'s metadata merge is additive (never deletes by omission) —
  // an explicit `undefined` is what actually clears a key, both in memory
  // (every reader here checks `typeof … === 'string'`) and on disk (JSON drops it).
  state.patchSession(sessionId, { metadata: { agent: prev || undefined, adoptedFrom: undefined } });
  claude.appendChat(sessionId, { kind: 'agent-adopt', agent: null, reverted: true });
}

async function handleAgents(req: IncomingMessage, res: ServerResponse, u: URL, p: string, m: string): Promise<void> {
  if (p === '/__api/agents' && m === 'GET') return json(res, { agents: agents.listAgentViews() });
  if (p === '/__api/agents' && m === 'POST') {
    const body = (await readBody(req)) as any;
    const { cardId, sessionId, ...input } = body || {};
    const r = agents.createAgent(input);
    if (!r.ok) {
      if (cardId && sessionId && state.getSession(String(sessionId)))
        claude.appendChat(String(sessionId), { kind: 'agent-card-update', cardId, state: 'pending', error: r.error });
      return json(res, { ok: false, error: r.error }, r.status || 400);
    }
    if (cardId && sessionId)
      settleAgentCard(String(sessionId), String(cardId), { state: 'created', agent: r.agent, error: null },
        `[host] The human confirmed the Agent card: "${r.agent.name}" ${r.agent.emoji} (slug: ${r.agent.slug}) now exists. ` +
        `Start it with create_session({agent:"${r.agent.slug}", prompt}) or open its home chat (GET /__api/agents/${r.agent.slug}/home).`);
    return json(res, r.agent, 201);
  }
  const cm = /^\/__api\/agents\/cards\/(agc_[A-Za-z0-9]+)\/cancel$/.exec(p);
  if (cm && m === 'POST') {
    const body = (await readBody(req)) as any;
    settleAgentCard(String(body.sessionId || ''), cm[1], { state: 'cancelled' }, '[host] The human cancelled the Agent card — do not create the agent.');
    return json(res, { ok: true });
  }
  // A3: Settings → Host → Budgets — agent × model × daily cap × used today.
  if (p === '/__api/agents/budgets' && m === 'GET') {
    const rows = agents.listAgentViews().map((a) => {
      const b = ledger.budgetState(a.slug)!;
      return { slug: a.slug, name: a.name, emoji: a.emoji, color: a.color, model: a.model || null, cap: b.cap, usedTokens: b.usedTokens, usedCostUsd: b.usedCostUsd, exceeded: b.exceeded, resetsAt: b.resetsAt };
    });
    return json(res, { budgets: rows, day: ledger.localDay() });
  }
  const am = /^\/__api\/agents\/([a-z0-9][a-z0-9-]{0,39})(?:\/(home|activity|connections|routine))?$/.exec(p);
  if (!am) return notFound(res);
  const slug = am[1];
  const sub = am[2];
  const a = agents.getAgent(slug);
  if (!a) return notFound(res, `unknown agent: ${slug}`);
  if (!sub && m === 'GET') return json(res, a);
  if (!sub && m === 'PATCH') {
    const body = (await readBody(req)) as any;
    const { homeSessionId: _h, slug: _s, createdAt: _c, ...patch } = body || {};
    const r = agents.updateAgent(slug, patch);
    return r.ok ? json(res, r.agent) : json(res, { ok: false, error: r.error }, r.status || 400);
  }
  if (!sub && m === 'DELETE') {
    // UX4: work sessions born from the agent stay (they just lose the badge —
    // applyAgentToSession/personaBlock both degrade gracefully for an unknown
    // slug). Two things do NOT get to outlive the agent, though:
    //  - its home chat (UX1: unreachable without the agent surface to open it
    //    from, so keeping it around would just be an orphaned session nobody
    //    can find) — torn down the same way DELETE /sessions/:id does;
    //  - cron jobs born FROM it — firing one after the agent is gone throws
    //    "unknown agent" out of applyAgentToSession on every tick (see
    //    fireCron's isolated branch), i.e. a routine that fails forever
    //    instead of a session that just lost its badge.
    const triggers = await import('./triggers.js');
    for (const c of triggers.listTriggers().filter((x: any) => x.type === 'cron' && x.agent === slug))
      triggers.deleteTrigger(c.id);
    if (a.homeSessionId && state.getSession(a.homeSessionId)) {
      const hid = a.homeSessionId;
      claude.kill(hid);
      expirePendingSetupRequests(hid, 'agent deleted');
      chrome.closeChrome(hid);
      await chrome.syncProfileToBase(hid).catch(() => {});
      if (!cfg.screen?.keepProfiles) chrome.removeSessionProfile(hid);
      pickDriver().release(hid);
      artifacts.removeSession(hid);
      state.deleteSession(hid);
    }
    const r = agents.deleteAgent(slug);
    return r.ok ? json(res, { ok: true }) : badRequest(res, r.error || 'delete failed');
  }
  if (sub === 'connections' && m === 'GET') {
    // A2: the agent's connections — every capability resolved FOR the agent
    // (own first, shared second; `resolvedFrom` says which) + its audit lines.
    const owner = caps.ownerForAgent(slug);
    const view = await caps.capabilitiesStatus({}, owner);
    return json(res, { ...view, audit: caps.readAudit(50, owner), browserProfile: fs.existsSync(chrome.agentBrowserDir(slug)) });
  }
  if (sub === 'routine' && m === 'GET') {
    // A2: the agent's routine — cron jobs whose runs are born from it + listeners its sessions armed.
    const t = await import('./triggers.js');
    const cron = t.listTriggers().filter((x: any) => x.type === 'cron' && x.agent === slug).map((x: any) => ({ ...x, nextRunAt: t.nextRunFor(x) }));
    const listeners = state.listListeners().filter((l: any) => l.agent === slug);
    return json(res, { cron, listeners });
  }
  if (sub === 'home' && m === 'GET') {
    try {
      const { session: s, created } = ensureHomeSession(a);
      return json(res, { session: state.toWireSession(s), created }, created ? 201 : 200);
    } catch (e) {
      const err = e as Error & { status?: number; budget?: unknown };
      return json(res, { error: err.message, ...(err.budget ? { budget: err.budget } : {}) }, err.status || 500);
    }
  }
  if (sub === 'activity' && m === 'GET') {
    // Episodes are per session; the agent's activity = episodes of its sessions.
    const memory = await import('./memory.js');
    const mine = state.listSessions({ archived: true }).filter((s) => s.metadata?.agent === slug);
    const ids = new Set(mine.map((s) => s.id));
    const episodes = memory
      .listMemory()
      .filter((f) => f.scope === 'episode' && [...ids].some((id) => f.path.includes(id)))
      .map((f) => ({ ...f, sessionId: [...ids].find((id) => f.path.includes(id)) || null }))
      .sort((x, y) => String(y.updatedAt).localeCompare(String(x.updatedAt)));
    // UX1: the "runs" tab lists the agent's sessions with their state AND cost —
    // per-session totals come from the WHOLE ledger, not the selected range, so a
    // run started last month still shows what it cost.
    const perSession = ledger.perSession(ledger.readActivity(slug, { kinds: ['turn'] }));
    const sessions = mine
      .map((s) => ({
        ...Object.fromEntries(AGENT_WIRE_KEYS.map((k) => [k, (s as any)[k]])),
        claudeState: s.claude?.state || 'idle',
        home: s.id === a.homeSessionId,
        ...(perSession[s.id] || { tokens: 0, costUsd: 0, turns: 0 }),
      }))
      .sort((x: any, y: any) => String(y.updatedAt).localeCompare(String(x.updatedAt)));
    // A3: the ledger (activity.jsonl) for the range — today / 7d / 30d — newest first, with totals + the budget line.
    const range = ['today', '7d', '30d'].includes(String(u.searchParams.get('range'))) ? String(u.searchParams.get('range')) : 'today';
    const entries = ledger.readActivity(slug, { since: ledger.rangeStart(range) }).reverse();
    const limit = Math.min(1000, Math.max(1, Number(u.searchParams.get('limit')) || 300));
    return json(res, { sessions, episodes, range, entries: entries.slice(0, limit), totals: ledger.totalsOf(entries), budget: ledger.budgetState(slug) });
  }
  return notFound(res);
}

async function handleSetupRequest(res: ServerResponse, body: Record<string, unknown>): Promise<void> {
  const sessionId = body.session_id as string | undefined;
  const s = sessionId && state.getSession(sessionId);
  if (!s) return badRequest(res, `unknown session_id: ${sessionId}`);
  const capability = String(body.capability || '').trim();
  // A2: a session born from an agent asks for the AGENT's connection (agent first, then the shared one).
  const owner = ownerOfSession(sessionId, capability);
  const cap = caps.getCapability(capability, sessionProbes(sessionId), owner);
  if (!cap) return badRequest(res, `unknown capability: ${capability} — use a registry id (GET /__api/setup/capabilities)`);
  // F6: never an empty why — the card and the audit fall back to the capability title.
  const why = (String(body.why || '').trim() || cap.title).slice(0, 300);
  // Already there? Answer at once — no card, no push; one audit line so
  // Settings → Connections still shows the agent asked.
  let check: caps.CheckResult;
  try { check = await cap.check(); } catch (e) { check = { ok: false, detail: (e as Error).message }; }
  if (check.ok) {
    caps.appendAudit({ sessionId: sessionId!, capability, mode: 'none', result: 'already', evidence: null, human: false, detail: why, owner });
    const r: SetupResult = { state: 'done', id: '', capability, detail: check.detail, mode: 'manual', already: true, owner: check.owner || caps.GLOBAL_OWNER } as SetupResult;
    return json(res, r);
  }
  let requested = body.mode === 'auto' || body.mode === 'manual' || body.mode === 'ask' ? (body.mode as SetupMode) : undefined;
  // A remote service the host holds is connected by the HOST (its consent
  // runner, after one press on the card) — never by an agent's own playbook.
  if (capability.startsWith('mcp:') && (await import('./lib/mcp-gateway.js')).gatewayEnabled()) requested = 'manual';
  const entry = openSetupCard(sessionId!, cap, why, requested, check.detail);
  if (entry.state === 'auto') {
    // The human already consented (start clicked); the agent runs the playbook
    // itself and closes the card with report_setup.
    const r: SetupResult = { state: 'auto', id: entry.id, capability, detail: entry.detail, mode: 'auto', playbook: cap.playbook };
    return json(res, r);
  }
  state.setClaude(sessionId!, { state: 'awaiting-input', setupRequest: { id: entry.id, capability } } as any);
  // CHAT1: long-poll legs — a 15-minute card outlives any single request.
  await respondBlocking(res, body, sessionId!, new Promise<SetupResult>((resolve) => entry.waiters.push(resolve)));
}

/**
 * Open (or attach to) the Setup card for a capability in a session's chat —
 * the core of request_setup, also used by the host itself (F8: a session whose
 * Claude account turns out to be signed out gets a `claude` card instead of
 * a dead-end "please run /login").
 */
export function openSetupCard(sessionId: string, cap: caps.Capability, why: string, requested?: SetupMode, detail = ''): PendingSetup {
  const capability = cap.id;
  // Re-request on an open card (e.g. after a failed auto → manual): attach.
  let entry = openSetupFor(sessionId, capability);
  if (!entry) {
    const owner = ownerOfSession(sessionId, capability);
    const def = caps.defaultMode(cap, {}, owner);
    // 'auto' is only honoured when the capability is auto-capable; 'ask' shows
    // the card with both choices and blocks like manual.
    const mode: SetupMode = requested === 'auto' ? (cap.autoCapable ? 'auto' : 'manual') : requested ?? def;
    const id = 'setup_' + nano();
    // Rule 3: no auto without a click. `mode` only PRESELECTS the card's
    // switch; the agent blocks until the human clicks "Connect automatically"
    // (POST /:id/start → {state:'auto'}), connects it manually, or skips.
    const e: PendingSetup = {
      id, sessionId, capability, owner, why, mode,
      state: 'pending',
      evidence: null, detail, createdAt: new Date().toISOString(), lines: [],
      timer: setupTimer(id, new Date().toISOString()),
      waiters: [],
    };
    pendingSetups.set(id, e);
    persistPendingSetups();
    claude.appendChat(sessionId, {
      kind: 'setup',
      ...setupCardPayload(e),
      title: cap.title,
      manual: cap.manual,
      autoCapable: cap.autoCapable,
      ...(cap.playbook ? { playbook: cap.playbook } : {}),
      identity: identityView(owner),
    });
    broadcast({ type: 'setup', sessionId, ...setupCardPayload(e) });
    caps.appendAudit({ sessionId, capability, mode, result: 'requested', evidence: null, human: false, detail: why, owner });
    import('./funnel.js').then((f) => { f.emit('setup.requested', { capability, mode }); f.firstTime('setup.first_request'); }).catch(() => {});
    pushIntervention(sessionId, 'action', why ? `${cap.title}: ${why}` : cap.title, `needs ${cap.title}`);
    entry = e;
  }
  return entry;
}

async function handleSetupReport(res: ServerResponse, body: Record<string, unknown>): Promise<void> {
  const sessionId = body.session_id as string | undefined;
  if (!sessionId || !state.getSession(sessionId)) return badRequest(res, `unknown session_id: ${sessionId}`);
  const capability = String(body.capability || '');
  let entry: PendingSetup | undefined = (typeof body.id === 'string' ? pendingSetups.get(body.id) : undefined) ?? openSetupFor(sessionId, capability);
  // F6: a card closed by a timeout / restart / earlier report is reopened and
  // updated by a late report; only a human "Not now" stays closed.
  let skippedByHuman = false;
  if (!entry) {
    const closed = closedSetupFor(sessionId, capability, typeof body.id === 'string' ? body.id : undefined);
    if (closed && closed.state === 'skipped') skippedByHuman = true;
    else if (closed && closed.state === 'done') {
      // Already connected and closed — a repeated success is a no-op, not a second audit line.
      if (body.ok) return json(res, { ok: true, closed: true, id: closed.id, state: 'done' });
    } else if (closed && body.ok !== undefined) entry = reopenSetup(closed, 'auto');
    else if (closed && typeof body.line === 'string') entry = reopenSetup(closed, 'auto');
  }
  const evidence = typeof body.evidence === 'string' && /^\/__artifacts\/[A-Za-z0-9_-]+\/?$/.test(body.evidence) ? body.evidence.replace(/\/?$/, '/') : null;
  const detail = String(body.detail || '').slice(0, 300);
  const human = body.human === true;
  // Progress narration (no `ok`): append a line to the open card, nothing else.
  if (body.ok === undefined && typeof body.line === 'string') {
    if (!entry) return json(res, { ok: true, closed: false, lines: [] });
    entry.lines = [...entry.lines, body.line.slice(0, 200)].slice(-20);
    broadcastSetup(entry);
    return json(res, { ok: true, closed: false, id: entry.id, lines: entry.lines });
  }
  if (!entry) {
    // Nothing to (re)open — a human skipped it, or no card ever existed. Still record what happened.
    const owner = ownerOfSession(sessionId, capability);
    caps.appendAudit({ sessionId, capability, mode: 'auto', result: body.ok ? 'done' : 'failed', evidence, human: false, detail, owner });
    if (body.ok) {
      caps.invalidateComposioCache();
      if (capability.startsWith('composio:')) caps.pruneComposioOrphans(capability.slice(9), { owner }).catch(() => {});
    }
    return json(res, { ok: true, closed: false, ...(skippedByHuman ? { reason: 'skipped by the human' } : {}) });
  }
  if (body.ok) {
    finishSetup(entry, 'done', { detail: detail || (human ? 'connected' : 'connected by the agent'), evidence, human });
    return json(res, { ok: true, closed: true, id: entry.id, state: 'done' });
  }
  // Rule 5: failure → state 'failed', card open in manual with the reason; the human can finish it.
  entry.mode = 'manual';
  entry.state = 'failed';
  entry.detail = detail || 'automatic setup failed';
  if (evidence) entry.evidence = evidence;
  caps.appendAudit({ sessionId, capability: entry.capability, mode: 'auto', result: 'failed', evidence, human: false, detail: entry.detail, owner: entry.owner });
  broadcastSetup(entry, { failed: true });
  return json(res, { ok: true, closed: false, id: entry.id, state: 'failed', mode: 'manual' });
}

/** Human flipped the Auto/Manual switch on the card — informational only (no consent yet). */
function setSetupMode(id: string, mode: SetupMode): PendingSetup | null {
  const e = pendingSetups.get(id);
  if (!e) return null;
  const cap = caps.getCapability(e.capability);
  if (mode === 'auto' && !cap?.autoCapable) mode = 'manual';
  e.mode = mode;
  if (e.state === 'auto' && mode !== 'auto') e.state = 'pending';
  broadcastSetup(e);
  return e;
}

/** The consent click ("Connect automatically"): mode auto, state auto, and the blocked agent is released with {state:'auto'}. */
function startSetupAuto(id: string): PendingSetup | { error: string } | null {
  const e = pendingSetups.get(id);
  if (!e) return null;
  const cap = caps.getCapability(e.capability);
  if (!cap?.autoCapable) return { error: `${e.capability} cannot be connected automatically` };
  // A2: an agent's playbook drives the AGENT's Chrome profile — it needs the agent's own Google identity.
  if (!caps.identityForAuto(e.owner)) return { error: e.owner === caps.GLOBAL_OWNER ? 'connect a Google identity first' : `connect a Google identity for ${e.owner} first` };
  e.mode = 'auto';
  e.state = 'auto';
  e.lines = [];
  broadcastSetup(e);
  caps.appendAudit({ sessionId: e.sessionId, capability: e.capability, mode: 'auto', result: 'requested', evidence: null, human: true, detail: 'consent given', owner: e.owner });
  const r: SetupResult = { state: 'auto', id: e.id, capability: e.capability, detail: e.detail, mode: 'auto', playbook: cap.playbook };
  for (const w of e.waiters.splice(0)) w(r);
  state.setClaude(e.sessionId, { state: 'working', setupRequest: null } as any);
  return e;
}

/** DELETE /__api/setup/:capability — disconnect a provider through its existing implementation. */
async function disconnectCapability(capability: string, owner: caps.Owner = caps.GLOBAL_OWNER): Promise<Record<string, unknown>> {
  if (capability === 'identity') {
    return { ok: caps.clearIdentity(owner), identity: null, owner };
  }
  if (capability.startsWith('composio:')) {
    const key = cfg.composioApiKey || process.env.COMPOSIO_API_KEY || '';
    if (!key) throw new Error('Composio is not signed in');
    const slug = capability.slice(9);
    const hdr = { 'x-api-key': key, 'Content-Type': 'application/json' };
    const r = await fetch('https://backend.composio.dev/api/v3.1/connected_accounts?limit=200', { headers: hdr });
    const j = (await r.json()) as any;
    if (!r.ok) throw new Error(j?.error?.message || `Composio ${r.status}`);
    // A2: only THIS owner's accounts (user_id) — disconnecting an agent's Gmail never touches the host's.
    const ids = (j.items || []).filter((c: any) => String(c.toolkit?.slug || '').toLowerCase() === slug && caps.composioOwnerOf(c) === owner).map((c: any) => c.id);
    for (const id of ids) await fetch(`https://backend.composio.dev/api/v3.1/connected_accounts/${id}`, { method: 'DELETE', headers: hdr });
    caps.invalidateComposioCache();
    return { ok: true, removed: ids.length };
  }
  if (capability.startsWith('mcp:')) {
    // M1: drop the OAuth grant at the vendor's side (`claude mcp logout`), then
    // the server registration, then our ownership record. The agent's tools
    // allowlist keeps the pattern — removing it would silently edit the agent.
    const slug = capability.slice(4);
    const spec = mcpCat.mcpSpec(slug);
    const rec = mcpConn.findConnection(owner, capability);
    const name = rec?.name || mcpCat.grantName(slug, owner);
    // The host's own grant (lib/mcp-grants.ts): forget its tokens and client.
    // Also clear any CLI grant of the same name below, so nothing is left behind.
    const hostGrants = await import('./lib/mcp-grants.js');
    hostGrants.remove(name);
    const { scope, cwd } = mcpScope(owner);
    const cli = mcpConn.readMcpState();
    if ((rec?.auth || spec?.auth) !== 'bearer' && cli.grants.has(name)) await mcpAuth.logout(name, cwd);
    if (mcpConn.readCodexMcpGrants().has(name)) await mcpAuth.codexLogout(name, rec?.url || spec?.url);
    if (cli.configured.has(name)) await mcpAuth.removeServer(name, { scope, cwd });
    mcpAuth.cancelLogin(name);
    mcpAuth.cancelLogin(name, 'codex');
    return { ok: true, removed: mcpConn.removeConnection(owner, capability), name, owner };
  }
  if (capability === 'remote') {
    const remote: any = await import('./remote.js');
    return { ok: true, remote: remote.setRemote(false) };
  }
  if (capability === 'git') {
    // Undo setGitToken: drop the github.com line from ~/.git-credentials and the env token.
    const file = path.join(HOME, '.git-credentials');
    try {
      const kept = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l && !/@github\.com$/.test(l));
      // The gate is "file exists" — an empty file would still read as authed.
      if (kept.length) fs.writeFileSync(file, kept.join('\n') + '\n', { mode: 0o600 });
      else fs.unlinkSync(file);
    } catch {}
    delete process.env.GH_TOKEN;
    delete process.env.GITHUB_TOKEN;
    return { ok: true };
  }
  if (capability === 'whatsapp') {
    const wb = await import('./whatsapp-bridge.js');
    wb.stopBridge();
    return { ok: true, status: wb.getBridgeStatus() };
  }
  if (capability === 'telemetry') {
    const tm = await import('./telemetry.js');
    return { ok: true, telemetry: tm.setEnabled(false) };
  }
  if (capability === 'desktop') {
    updateScreenConfig({ enabled: false });
    return { ok: true };
  }
  if (capability === 'claude' || capability === 'codex') throw new Error(`disconnect ${capability === 'claude' ? 'Claude' : 'Codex'} from the Accounts view`);
  if (capability.startsWith('repo:')) throw new Error('remove repositories from Setup → repositories');
  throw new Error(`${capability} has nothing to disconnect`);
}

/**
 * The session's claude process stopped (restart / interrupt / crash). F6: the
 * card stays OPEN — the human may still be mid-login — only the agent blocked
 * on it is released (its MCP is gone anyway) and the awaiting-input marker
 * cleared. A re-spawned agent re-attaches with request_setup; the human's
 * click resolves the card whenever it comes.
 */
export function detachPendingSetupRequests(sessionId: string, message = 'session ended'): void {
  for (const e of pendingSetups.values()) {
    if (e.sessionId !== sessionId) continue;
    const result: SetupResult = { state: 'timeout', id: e.id, capability: e.capability, detail: message, mode: e.mode, evidence: e.evidence };
    for (const w of e.waiters.splice(0)) w(result);
  }
  const s = state.getSession(sessionId);
  if (s && (s.claude as any)?.setupRequest) state.setClaude(sessionId, { setupRequest: null } as any);
}

/** The session itself is gone (delete / archive): close its cards for good. */
export function expirePendingSetupRequests(sessionId: string, message = 'session ended'): void {
  for (const e of [...pendingSetups.values()]) if (e.sessionId === sessionId) finishSetup(e, 'timeout', { detail: message, human: false });
}
// Cards persisted before the last host restart come back with their remaining time.
loadPendingSetups();

/** A2: Composio `user_id` for an owner — the host's accounts stay under 'default'. */
const composioUserId = (owner: caps.Owner): string => (owner === caps.GLOBAL_OWNER ? 'default' : owner);


// ---------------------------------------------------------------------------
// M1 — native remote MCP (`mcp:<service>`), the generic connect path.
// ---------------------------------------------------------------------------

/**
 * Where a grant is registered. The host's own connections go to `user` scope so
 * every session sees them (today's behaviour for the user's servers). An
 * agent's go to `local` scope with the agent's own directory as cwd, so no
 * OTHER agent's session ever sees the grant; the owner's sessions get it
 * injected explicitly by claude.js under the same name (spike: a --mcp-config
 * server only reuses a credential when the NAME matches).
 */
function mcpScope(owner: caps.Owner): { scope: 'user' | 'local'; cwd?: string } {
  const slug = caps.ownerSlug(owner);
  if (!slug) return { scope: 'user' };
  const dir = agents.agentDir(slug);
  fs.mkdirSync(dir, { recursive: true });
  return { scope: 'local', cwd: dir };
}

/** The GitHub token the host already owns (`gh auth token`) — never stored by us. */
function ghAuthToken(): string {
  if (!which('gh')) return '';
  const r = Bun.spawnSync(['gh', 'auth', 'token'], { stdout: 'pipe', stderr: 'ignore' });
  return r.exitCode === 0 ? new TextDecoder().decode(r.stdout).trim() : '';
}

/**
 * A grant reached "connected": write the ownership record (names/URLs only) and,
 * for an agent that HAS a tools allowlist, add the grant's tool pattern to it —
 * the human just asked for this service on this agent's behalf, and an allowlist
 * that silently drops the tools they just connected is a trap (A3 denies whole
 * MCP servers no pattern reaches).
 */
function recordMcpConnection(owner: caps.Owner, spec: mcpCat.McpServerSpec, name: string, url: string): { connection: mcpConn.McpConnection; toolsAdded: string | null } {
  const identity = caps.readIdentity(owner) || caps.readIdentity(caps.GLOBAL_OWNER);
  const connection = mcpConn.recordConnection(owner, { cap: `mcp:${spec.slug}`, slug: spec.slug, name, url, auth: spec.auth, byIdentity: identity?.email ?? null });
  let toolsAdded: string | null = null;
  const slug = caps.ownerSlug(owner);
  if (slug) {
    const a = agents.getAgent(slug);
    const pattern = mcpCat.grantToolPattern(name);
    if (a && a.tools?.length && !a.tools.includes(pattern)) {
      agents.updateAgent(slug, { tools: [...a.tools, pattern] });
      toolsAdded = pattern;
    }
  }
  caps.markIdentityProvider(`mcp:${spec.slug}`, owner);
  return { connection, toolsAdded };
}

type McpLoginStatus = { state: string; url: string | null; error: string | null };

/** `claude mcp login` prints the authorize URL a beat after it starts; wait for it. */
async function waitForAuthUrl(name: string, timeoutMs = 20_000, engine?: mcpConn.McpEngine): Promise<McpLoginStatus> {
  const t0 = Date.now();
  for (;;) {
    const st = mcpAuth.loginStatus(name, engine) as McpLoginStatus;
    if (st.url || st.state === 'error' || st.state === 'done' || Date.now() - t0 > timeoutMs) return st;
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** P2-4: a codex grant — `codex mcp login` under the codex MCP home; no `claude mcp add`, the session config.toml writes the url. */
async function applyCodexMcpSetup(spec: mcpCat.McpServerSpec, body: any, owner: caps.Owner, name: string, url: string): Promise<Record<string, unknown>> {
  if (spec.auth === 'bearer') throw new Error(`${spec.title} is token-based — not wired for Codex sessions yet`);
  const action = String(body?.action || '');
  const engine = 'codex' as const;
  if (action === 'cancel') return { ok: true, engine, ...mcpAuth.cancelLogin(name, engine) };
  if (action === 'poll' || action === 'status') {
    const st = mcpAuth.loginStatus(name, engine) as McpLoginStatus;
    if (mcpConn.readCodexMcpGrants().get(name)) {
      const { connection, toolsAdded } = recordMcpConnection(owner, spec, name, url);
      mcpAuth.cancelLogin(name, engine);
      return { ok: true, state: 'done', name, owner, engine, connection, ...(toolsAdded ? { toolsAdded } : {}) };
    }
    return { ...st, ok: false, name, owner, engine };
  }
  if (action === 'code' || action === 'paste' || body?.code || body?.url) {
    const r = await mcpAuth.submitCodexRedirect(name, String(body?.code || body?.url || ''));
    if (!r.ok) throw new Error(r.error || 'could not hand the redirect URL to the codex login');
    return { ...r, ok: false, name, owner, engine };
  }
  mcpAuth.startLogin(name, undefined, { engine, url });
  const st = await waitForAuthUrl(name, 20_000, engine);
  if (st.state === 'error') throw new Error(st.error || 'could not start the codex MCP login');
  if (!st.url) throw new Error(`${spec.title}: \`codex mcp login\` did not print an authorize URL`);
  return { ...st, ok: false, id: name, name, url: st.url, owner, engine, domains: spec.domains, docs: spec.docs };
}

/** Which engine a setup request is for: explicit body.engine, else the calling session's. */
function setupEngine(body: any, req: IncomingMessage): mcpConn.McpEngine {
  if (body?.engine === 'codex' || body?.engine === 'claude') return body.engine;
  const sid = String(body?.sessionId || req.headers['x-arigami-session'] || req.headers['x-session-id'] || '');
  return sid && state.getSession(sid)?.engine === 'codex' ? 'codex' : 'claude';
}

/** POST /__api/setup/mcp:<service> — {action:'start'|'poll'|'code'|'cancel'} or a bearer {token}. */
async function applyMcpSetup(slug: string, body: any, owner: caps.Owner, engine: mcpConn.McpEngine = 'claude', origin?: string): Promise<Record<string, unknown>> {
  const spec = mcpCat.mcpSpec(slug);
  if (!spec) throw new Error(`${slug} is not in the native MCP catalog`);
  if (spec.auth === 'oauth-byo-client') throw new Error(`${spec.title} needs an OAuth client of your own (no dynamic registration) — not connectable from here yet`);
  const action = String(body?.action || '');
  const name = mcpCat.grantName(spec.slug, owner);
  const url = body?.readonly && spec.readonlyUrl ? spec.readonlyUrl : spec.url;
  // With the MCP gateway on, the HOST holds the grant (lib/mcp-grants.ts): one
  // login for every engine and account, same request/response contract.
  const { gatewayEnabled } = await import('./lib/mcp-gateway.js');
  if (gatewayEnabled()) return applyHostMcpSetup(spec, body, owner, name, url, origin || browserOriginFallback());
  if (engine === 'codex') return applyCodexMcpSetup(spec, body, owner, name, url);
  const { scope, cwd } = mcpScope(owner);

  // --- bearer (GitHub PAT): no browser at all -------------------------------
  if (spec.auth === 'bearer') {
    if (action === 'poll') return { ok: mcpConn.grantLive(name, 'bearer'), name, owner };
    const token = String(body?.token || '').trim() || (spec.tokenFrom === 'gh' ? ghAuthToken() : '');
    if (!token) throw new Error(spec.tokenFrom === 'gh' ? 'no GitHub token on this host — sign in with gh first, or paste a token' : `paste a ${spec.title} token`);
    const r = await mcpAuth.addServerWithHeader(name, url, spec.headerName || 'Authorization', `${spec.headerPrefix ?? 'Bearer '}${token}`, { scope, cwd });
    if (!r.ok) throw new Error(r.output || r.error || `could not register ${spec.title}`);
    const { connection, toolsAdded } = recordMcpConnection(owner, spec, name, url);
    return { ok: true, name, owner, connection, ...(toolsAdded ? { toolsAdded } : {}) };
  }

  // --- OAuth ----------------------------------------------------------------
  if (action === 'cancel') return { ok: true, ...mcpAuth.cancelLogin(name) };
  if (action === 'poll' || action === 'status') {
    const st = mcpAuth.loginStatus(name) as { state: string; url: string | null; error: string | null };
    if (mcpConn.grantLive(name, 'oauth')) {
      const { connection, toolsAdded } = recordMcpConnection(owner, spec, name, url);
      mcpAuth.cancelLogin(name);
      return { ok: true, state: 'done', name, owner, connection, ...(toolsAdded ? { toolsAdded } : {}) };
    }
    return { ...st, ok: false, name, owner, url: st.url };
  }
  if (action === 'code' || action === 'paste' || body?.code || body?.url) {
    const r = mcpAuth.submitRedirect(name, String(body?.code || body?.url || ''));
    if (!r.ok) throw new Error(r.error || 'could not hand the redirect URL to the login');
    return { ...r, ok: false, name, owner }; // the caller polls; the exchange takes a moment
  }
  // start (default): register the server, then run `claude mcp login --no-browser`
  // and WAIT for the authorize URL it prints — the caller (card or playbook) has
  // nothing to do until then, and both would otherwise have to invent a second
  // poll just to learn where to send the human.
  const add = await mcpAuth.addServer(name, url, { scope, cwd });
  if (!add.ok) throw new Error(add.output || add.error || `could not register ${spec.title}`);
  mcpAuth.startLogin(name, cwd);
  const st = await waitForAuthUrl(name);
  if (st.state === 'error') throw new Error(st.error || 'could not start the MCP login');
  if (!st.url) throw new Error(`${spec.title}: the sign-in did not print an authorize URL — is Claude Code >= 2.1.191 on this host?`);
  return { ...st, ok: false, id: name, name, url: st.url, owner, domains: spec.domains, docs: spec.docs };
}

const browserOriginFallback = (): string => (cfg.publicUrl ? String(cfg.publicUrl).replace(/\/+$/, '') : `http://localhost:${cfg.port}`);
export const MCP_OAUTH_CALLBACK = '/__api/mcp-oauth/callback';

/**
 * The /mcp panel's Login for a catalog server (`linear`, `linear--<agent>`):
 * with the gateway on it is the host's sign-in, not `claude mcp login`, so the
 * grant serves every engine. null = not a catalog name → the CLI path as before.
 */
async function hostMcpLogin(name: string, action: 'start' | 'poll', req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const { gatewayEnabled } = await import('./lib/mcp-gateway.js');
  if (!gatewayEnabled() || !name) return null;
  const { slug, agent } = mcpCat.parseGrantName(name);
  const spec = mcpCat.mcpSpec(slug);
  if (!spec || spec.auth !== 'oauth' || mcpCat.grantName(slug, agent ? `agent:${agent}` : caps.GLOBAL_OWNER) !== name) return null;
  const owner = (agent ? `agent:${agent}` : caps.GLOBAL_OWNER) as caps.Owner;
  try {
    const r = await applyHostMcpSetup(spec, { action }, owner, name, spec.url, browserOrigin(req));
    return { name, state: r.state === 'done' ? 'done' : r.state || 'awaiting', url: (r.url as string) || null, error: (r.error as string) || null, auto: (r as any).auto || null };
  } catch (e) {
    return { name, state: 'error', url: null, error: (e as Error).message };
  }
}

async function sessionMcpRows(s: any) {
  const sm = await import('./lib/session-mcp.js');
  const grants = await import('./lib/mcp-grants.js');
  const { gatewayEnabled } = await import('./lib/mcp-gateway.js');
  const { composioKey } = await import('./lib/composio-mcp.js');
  const extensions = await import('./extensions.js');
  const agent = typeof s.metadata?.agent === 'string' && s.metadata.agent ? s.metadata.agent : null;
  const owner = agent ? `agent:${agent}` : caps.GLOBAL_OWNER;
  const codexGrants = mcpConn.readCodexMcpGrants();
  const snapshot = Array.isArray(s.claude?.capabilities?.mcpServers) ? s.claude.capabilities.mcpServers : [];
  return sm.rows({
    engine: s.engine === 'codex' ? 'codex' : 'claude',
    loaded: s.claude?.mcpLoaded?.servers || null,
    health: s.claude?.mcp?.servers || {},
    snapshot: s.engine === 'codex' ? [] : snapshot,
    hostGrant: (name) => {
      const g = grants.getGrant(name);
      return g && (g.owner === 'global' || g.owner === owner) ? { live: grants.isLive(name) } : null;
    },
    composioKey: !!composioKey(),
    extensionLoaded: (name) => extensions.getExtension(name)?.state === 'loaded',
    codexGrantLive: (name) => codexGrants.get(name) === true,
    cliTwin: (name) => s.engine !== 'codex' && mcpConn.cliRegistrations(name).length > 0,
    hostCanLogin: (name) => {
      if (!gatewayEnabled()) return false;
      const { slug } = mcpCat.parseGrantName(name);
      const spec = mcpCat.mcpSpec(slug);
      return !!spec && spec.auth === 'oauth' && mcpCat.grantName(slug, owner) === name;
    },
  });
}

/**
 * The host now holds `name`: take Claude Code's own registration of it (and its
 * token) out of the way — a same-named server in Claude's config keeps the
 * host's entry from ever connecting (mcp-connections.ts cliRegistrations). An
 * agent's grant only touches that agent's own directory.
 */
export async function retireCliTwins(name: string, owner: caps.Owner): Promise<string[]> {
  const agentDir = caps.ownerSlug(owner) ? mcpScope(owner).cwd : null;
  const regs = mcpConn.cliRegistrations(name).filter((r) => (agentDir ? r.scope === 'local' && r.cwd === agentDir : true));
  if (!regs.length) return [];
  const done: string[] = [];
  const hadToken = mcpConn.readMcpState().grants.has(name);
  for (const r of regs) {
    try {
      if (hadToken && !done.length) await mcpAuth.logout(name, r.cwd);
      await mcpAuth.removeServer(name, { scope: r.scope, cwd: r.cwd });
      done.push(r.scope === 'user' ? 'user' : `local:${r.cwd}`);
    } catch {
      /* best effort; the next connect or boot sweep tries again */
    }
  }
  if (done.length) console.log(`[mcp] ${name} is held by the host now — removed Claude Code's own registration (${done.join(', ')})`);
  return done;
}

/** Boot: a grant the host already holds must not have a CLI twin left over from before. */
export async function sweepCliTwins(): Promise<void> {
  const { gatewayEnabled } = await import('./lib/mcp-gateway.js');
  if (!gatewayEnabled()) return;
  const grants = await import('./lib/mcp-grants.js');
  for (const g of grants.listGrants()) if (grants.isLive(g.name)) await retireCliTwins(g.name, g.owner as caps.Owner).catch(() => []);
}

/** The consent runner needs a Chrome on this host (headless is enough). */
function autoConsentAvailable(): boolean {
  if (process.env.ARIGAMI_CONSENT_AUTO === '0') return false; // tests of the person's path; an operator who wants no automation
  try {
    const bin = chrome.chromeBin();
    return !!bin && (bin.includes('/') ? fs.existsSync(bin) : true);
  } catch {
    return false;
  }
}

/**
 * Walk the vendor's consent in the owner's browser (lib/consent-runner.ts) and
 * record how it went on the open sign-in, so every surface polling it (the
 * card, the dialog, the /mcp panel) shows the same thing. On success the
 * connection is recorded here too — nobody has to be polling.
 */
async function runAutoConsent(spec: mcpCat.McpServerSpec, owner: caps.Owner, name: string, url: string, authorizeUrl: string, redirect: string): Promise<void> {
  const grants = await import('./lib/mcp-grants.js');
  const { runConsent } = await import('./lib/consent-runner.js');
  grants.setAuto(name, { status: 'running' });
  const slug = caps.ownerSlug(owner);
  try {
    const r = await runConsent({
      name,
      authorizeUrl,
      redirect,
      domains: spec.domains,
      hints: spec.consent,
      profileDir: slug ? chrome.agentBrowserDir(slug) : undefined,
      identityEmail: (caps.readIdentity(owner) || caps.readIdentity(caps.GLOBAL_OWNER))?.email ?? null,
      onCode: (state, code) => grants.finishLogin(state, code),
    });
    grants.setAuto(name, { status: r.status, reason: r.reason, at: r.at, workspace: r.workspace ?? null });
    caps.appendAudit({ sessionId: 'host', capability: `mcp:${spec.slug}`, mode: 'auto', result: r.status === 'approved' ? 'ok' : r.status, evidence: r.evidence[r.evidence.length - 1] || null, human: false, detail: r.reason + (r.workspace ? ` · workspace ${r.workspace}` : ''), owner } as any);
    if (r.status === 'approved' && grants.isLive(name)) {
      recordMcpConnection(owner, spec, name, url);
      await retireCliTwins(name, owner).catch(() => []);
      try { broadcast({ type: 'setup.changed', capability: `mcp:${spec.slug}`, owner }); } catch {}
      refreshSessionsFor(name, owner);
      settleMcpCards(spec.slug, owner, false);
    }
  } catch (e) {
    grants.setAuto(name, { status: 'needs-person', reason: `automatic connect did not run: ${(e as Error).message}` });
  }
}

// ---- sessions pick up a new connection by themselves --------------------------
// A session's engine loads its MCP servers when it starts. When a connection
// arrives later, the session that could use it restarts in place (resumed, the
// conversation intact) the moment it is idle — never in the middle of a turn.
const mcpRefreshPending = new Map<string, { name: string; resume: boolean }>(); // sessionId → what arrived, and whether it was waiting for it
export function refreshSessionsFor(name: string, owner: string): void {
  for (const s of state.listSessions({} as any) as any[]) {
    if (s.archived || !claude.isRunning(s.id)) continue;
    const agent = typeof s.metadata?.agent === 'string' && s.metadata.agent ? `agent:${s.metadata.agent}` : caps.GLOBAL_OWNER;
    if (owner !== caps.GLOBAL_OWNER && owner !== agent) continue;
    const loaded = s.claude?.mcpLoaded?.servers || [];
    if (loaded.some((l: any) => l.name === name && l.via === 'gateway')) continue;
    // The session that asked for it (an open setup card) is told to carry on once it has it.
    const asked = String(s.claude?.setupRequest?.capability || '') === `mcp:${mcpCat.parseGrantName(name).slug}`;
    mcpRefreshPending.set(s.id, { name, resume: asked || !!mcpRefreshPending.get(s.id)?.resume });
  }
  tickMcpRefresh();
}

/** Close the open setup cards for a service the host now holds, telling each agent what happens next. */
function settleMcpCards(slug: string, owner: caps.Owner, human: boolean): void {
  resolveSetupsFor(`mcp:${slug}`, 'connected via Arigami for every session. Its tools load when this session reconnects, which the host does as soon as this turn ends — finish the turn with a one-line status; you will be resumed.', human, owner);
}
function tickMcpRefresh(): void {
  for (const [id, { name, resume }] of mcpRefreshPending) {
    const s = state.getSession(id) as any;
    if (!s || s.archived || !claude.isRunning(id)) {
      mcpRefreshPending.delete(id);
      continue;
    }
    if (s.claude?.state !== 'idle') continue; // mid-turn: next tick
    mcpRefreshPending.delete(id);
    try {
      claude.restart(id, { silent: true });
      claude.appendChat(id, { kind: 'system', text: `⤷ ${name} is connected now — reconnected this session so it can use it.` });
      if (resume) setTimeout(() => { try { claude.sendMessage(id, `[host] ${name} is connected and loaded in this session now. Continue the task you were on.`); } catch {} }, 1500);
    } catch {
      /* an archived / gone session */
    }
  }
}
setInterval(tickMcpRefresh, 3000).unref?.();

// ---- a grant the vendor stopped honouring: sign in again, quietly ------------
const reconsentAt = new Map<string, number>();
void import('./lib/mcp-grants.js').then((grants) =>
  grants.onNeedsLogin((name) => {
    if (Date.now() - (reconsentAt.get(name) || 0) < 60 * 60_000) return; // once an hour at most
    reconsentAt.set(name, Date.now());
    void silentReconsent(name);
  })
);
async function silentReconsent(name: string): Promise<void> {
  const grants = await import('./lib/mcp-grants.js');
  const g = grants.getGrant(name);
  const spec = g ? mcpCat.mcpSpec(g.slug) : null;
  if (!g || !spec || !g.redirect || spec.auth !== 'oauth' || !autoConsentAvailable()) return;
  const st = await grants.startLogin({ name, slug: g.slug, owner: g.owner, url: g.url }, g.redirect).catch(() => null);
  if (!st?.url) return;
  await runAutoConsent(spec, g.owner as caps.Owner, name, g.url, st.url, g.redirect);
  if (grants.isLive(name)) return;
  // It needs a person after all: say so once, early — not via an agent failing mid-task.
  const why = grants.loginStatus(name).auto?.reason || 'sign in again';
  try {
    const { notify } = await import('./notify.js');
    await notify({ title: `${spec.title} needs you to sign in again`, body: `${why}. Settings › Connections › ${spec.title}.`, url: publicUrl('/__host/#/settings/connections') as string, tag: `mcp-reconsent-${name}` });
  } catch {
    /* no channel configured */
  }
}

/** applyMcpSetup for a host-held grant: {action:'start'|'poll'|'code'|'cancel'} or a bearer {token}. */
async function applyHostMcpSetup(spec: mcpCat.McpServerSpec, body: any, owner: caps.Owner, name: string, url: string, origin: string): Promise<Record<string, unknown>> {
  const grants = await import('./lib/mcp-grants.js');
  const action = String(body?.action || '');
  const g = { name, slug: spec.slug, owner, url };
  const done = async () => {
    const { connection, toolsAdded } = recordMcpConnection(owner, spec, name, url);
    grants.cancelLogin(name);
    const replaced = await retireCliTwins(name, owner).catch(() => []);
    refreshSessionsFor(name, owner);
    settleMcpCards(spec.slug, owner, true);
    return { ok: true, state: 'done', name, owner, connection, heldBy: 'host', ...(replaced.length ? { replacedCli: replaced } : {}), ...(toolsAdded ? { toolsAdded } : {}) };
  };
  if (spec.auth === 'bearer') {
    if (action === 'poll') return { ok: grants.isLive(name), name, owner };
    const token = String(body?.token || '').trim() || (spec.tokenFrom === 'gh' ? ghAuthToken() : '');
    if (!token) throw new Error(spec.tokenFrom === 'gh' ? 'no GitHub token on this host — sign in with gh first, or paste a token' : `paste a ${spec.title} token`);
    grants.saveBearer(g, { name: spec.headerName || 'Authorization', value: `${spec.headerPrefix ?? 'Bearer '}${token}` });
    return done();
  }
  if (action === 'cancel') {
    grants.cancelLogin(name);
    return { ok: true, name, state: 'idle' };
  }
  if (action === 'poll' || action === 'status') {
    const st = grants.loginStatus(name);
    if (st.status === 'done' && grants.isLive(name)) return done();
    return { ok: false, name, owner, state: st.status === 'none' ? 'idle' : st.status, url: st.url, error: st.error, auto: st.auto || null };
  }
  if (action === 'code' || action === 'paste' || body?.code || body?.url) {
    const r = await grants.finishFromPaste(name, String(body?.code || body?.url || ''));
    if (!r.ok) throw new Error(r.error || 'could not finish the sign-in');
    return done();
  }
  const st = await grants.startLogin(g, origin + MCP_OAUTH_CALLBACK);
  if (st.status === 'done') return done();
  if (st.status === 'error' || !st.url) throw new Error(`${spec.title}: ${st.error || 'the sign-in did not produce an authorize URL'}`);
  // First the host tries on its own, in the browser where the owner is signed
  // in (lib/consent-runner.ts); the person is asked only where it stops.
  const auto = body?.auto !== false && autoConsentAvailable();
  if (auto) void runAutoConsent(spec, owner, name, url, st.url, origin + MCP_OAUTH_CALLBACK);
  let callbackHost = '';
  try { callbackHost = new URL(origin).hostname; } catch {}
  // The vendor sends the browser back to the host's own callback page, so its host is on the allowlist too.
  return { ok: false, state: 'awaiting', id: name, name, url: st.url, owner, domains: [...new Set([...spec.domains, ...(callbackHost ? [callbackHost] : [])])], docs: spec.docs, heldBy: 'host', auto: auto ? { status: 'running' } : null };
}

/** The manual payload routes (POST /__api/setup/:capability) — each delegates to the existing implementation. */
async function applyManualSetup(capability: string, body: any, req: IncomingMessage, owner: caps.Owner = caps.GLOBAL_OWNER): Promise<Record<string, unknown>> {
  const cap = caps.getCapability(capability, {}, owner);
  if (!cap) throw new Error(`unknown capability: ${capability}`);
  const action = String(body?.action || '');
  const ob = await import('./onboarding.js');
  let out: Record<string, unknown> = {};
  // Payload conventions = S2's web/src/lib/setup-api.js:
  //   token {token} · oauth {action:'start'|'code'|'cancel'|'poll'|'device', id?, code?}
  //   qr {action:'connect'|'poll'} · toggle {enable} · repo {entry} · takeover {action:'verify', email?}
  if (capability === 'claude') {
    const o: any = await import('./oauth-login.js');
    if (body?.token) out = await ob.setClaudeToken(String(body.token), body?.label ? String(body.label) : 'setup');
    else if (action === 'start' || action === 'oauth-start') return { ok: true, ...o.startLogin({ label: body?.label || 'setup', sessionId: body?.sessionId ? String(body.sessionId) : (req.headers['x-arigami-session'] as string) || null }) }; // {id, url, state}
    else if (action === 'poll') return { ok: o.loginStatus(String(body?.id || ''))?.state === 'done', ...o.loginStatus(String(body?.id || '')) };
    // F8: "can't paste? read the code from the browser" — the take-over desktop's Chrome has the callback URL.
    else if (action === 'read-browser') out = await o.readCodeFromBrowser(String(body?.id || ''), body?.sessionId ? String(body.sessionId) : (req.headers['x-arigami-session'] as string) || null);
    else if (action === 'cancel') return { ok: true, ...o.cancelLogin(body?.id) };
    else if (action === 'code' || action === 'oauth-code' || body?.code) out = await o.submitCode(body?.id, body?.code);
    else throw new Error('claude: pass {token} or {action:"start"} / {action:"code", id, code}');
  } else if (capability === 'codex') {
    const cx = await import('./codex-account.js');
    const id = String(body?.id || '');
    if (body?.token) out = await cx.addApiKeyAccount({ label: body?.label ? String(body.label) : 'setup', key: String(body.token) });
    else if (action === 'start' || action === 'oauth-start') {
      let st: any = cx.startBrowserLogin({ label: body?.label || 'setup' });
      for (let i = 0; i < 60 && st.state === 'starting'; i++) { await new Promise((r) => setTimeout(r, 250)); st = cx.loginStatus(st.id); } // the URL arrives a moment after spawn
      return { ok: true, ...st };
    }
    else if (action === 'poll') { const st = cx.loginStatus(id); return { ok: st.state === 'done', ...st }; }
    else if (action === 'cancel') return { ...cx.cancelLogin(id), ok: true };
    else if (action === 'code' || body?.code) { const r = await cx.submitCallback(id, String(body?.code || '')); return { ...r, state: r.ok ? 'awaiting' : 'error' }; }
    else throw new Error('codex: pass {token} or {action:"start"} / {action:"code", id, code}');
  } else if (capability === 'git') {
    const gl = await import('./git-login.js');
    if (body?.token) out = ob.setGitToken(String(body.token), body?.host ? String(body.host) : undefined);
    else if (action === 'device' || action === 'start' || action === 'gh-login') return { ok: false, device: gl.startGhLogin() }; // {state, code, url, error}
    else if (action === 'poll') { const d = gl.ghLoginStatus(); return { ok: d.state === 'done' || (await caps.statusOf(cap)).ok, device: d }; }
    else if (action === 'cancel' || action === 'gh-cancel') return { ok: true, device: gl.cancelGhLogin() };
    else throw new Error('git: pass {token, host?} or {action:"device"}');
  } else if (capability.startsWith('repo:')) {
    const name = capability.slice(5);
    const known = ob.listRepos().find((r) => r.name === name);
    if (!known) {
      const entry = body?.entry && typeof body.entry === 'object' ? body.entry : null;
      const url = String(entry?.source || body?.url || body?.source || '');
      if (!url) throw new Error(`repo ${name} is not registered — pass {entry:{name, source}}`);
      ob.addRepo({ ...(entry || {}), name: entry?.name || name, source: url } as any);
    }
    out = { clone: ob.cloneRepo(known ? name : String(body?.entry?.name || name)) };
  } else if (capability === 'whatsapp') {
    const wb = await import('./whatsapp-bridge.js');
    if (action === 'disconnect') { wb.stopBridge(); return { ok: true, ...wb.getBridgeStatus() }; }
    if (action === 'poll') return { ok: wb.getBridgeStatus().status === 'connected', ...wb.getBridgeStatus() };
    const { enqueueWake } = await import('./listeners.js');
    const sid = (req.headers['x-session-id'] as string) || 'ui';
    // A human's Connect / Show QR: a pairing WhatsApp has logged out is moved aside so the QR shows (WA1).
    wb.startBridge(sid, enqueueWake, { repair: true }).catch(console.error);
    return { ok: false, ...wb.getBridgeStatus() }; // {status:'starting'|'qr'|…, qr, qrUrl, user, reason?}
  } else if (capability.startsWith('composio:')) {
    const k = body?.key || body?.token;
    if (k) { ob.setComposioKey(String(k)); caps.invalidateComposioCache(); }
    if (action === 'poll') { caps.invalidateComposioCache(); return { ok: (await caps.statusOf(cap)).ok }; }
    if (action === 'connect' || action === 'start' || !k) {
      // Same flow as POST /__api/composio/connect: managed auth config → redirect link.
      const key = cfg.composioApiKey || process.env.COMPOSIO_API_KEY || '';
      if (!key) throw new Error('Composio is not signed in — pass {key} or sign in via Settings → Integrations');
      const slug = capability.slice(9);
      const hdr = { 'x-api-key': key, 'Content-Type': 'application/json' };
      const ac = await fetch('https://backend.composio.dev/api/v3.1/auth_configs', { method: 'POST', headers: hdr, body: JSON.stringify({ toolkit: { slug }, type: 'use_composio_managed_auth' }) });
      const acj = (await ac.json()) as any;
      const authConfigId = acj?.auth_config?.id;
      if (!ac.ok || !authConfigId) throw new Error(acj?.error?.message || `Composio ${ac.status}`);
      // A2: the connected account is keyed by owner — an agent's Gmail is user_id 'agent:<slug>', the host's stays 'default'.
      const link = await fetch('https://backend.composio.dev/api/v3/connected_accounts/link', { method: 'POST', headers: hdr, body: JSON.stringify({ auth_config_id: authConfigId, user_id: composioUserId(owner), redirect_url: 'https://backend.composio.dev' }) });
      const lj = (await link.json()) as any;
      if (!link.ok) throw new Error(lj?.error?.message || `Composio ${link.status}`);
      caps.invalidateComposioCache();
      return { ok: false, url: lj.redirect_url, redirectUrl: lj.redirect_url, id: lj.connected_account_id, connectionId: lj.connected_account_id, owner };
    }
  } else if (capability.startsWith('mcp:')) {
    return await applyMcpSetup(capability.slice(4), body, owner, setupEngine(body, req), browserOrigin(req));
  } else if (capability === 'identity') {
    // {action:'verify', email?} — the take-over already happened on the desktop; record who signed in.
    // F6: no email typed → read the signed-in account from the session's Chrome profile (or chrome-base).
    const email = String(body?.email || '').trim() || chrome.googleAccountEmail(String(body?.sessionId || req.headers['x-session-id'] || '') || null) || '';
    if (!email) throw new Error('identity: no Google sign-in detected in the agent\'s browser — pass the account email');
    const identity = caps.writeIdentity({ email, chromeProfile: body?.chromeProfile ? String(body.chromeProfile) : undefined }, owner);
    out = { identity, email: identity.email, owner };
  } else if (capability === 'desktop') {
    const enable = body?.enable !== false;
    updateScreenConfig({ enabled: enable });
    if (enable) { try { await desktops.ensureGlobalDesktop(); } catch (e) { out = { warning: (e as Error).message }; } }
  } else if (capability === 'remote') {
    const remote: any = await import('./remote.js');
    out = { remote: remote.setRemote(body?.enable !== false) };
  } else if (capability === 'telemetry') {
    const tm = await import('./telemetry.js');
    out = { telemetry: tm.setEnabled(body?.enable !== false) };
    try { ob.wizardAct('telemetry', 'complete'); } catch {}
  } else if (capability === 'push') {
    // Subscriptions come from the browser (POST /__api/push/subscribe); nothing to apply server-side.
    out = { hint: 'allow notifications in the cockpit on the device you want notified' };
  }
  return { ok: true, ...out };
}

// The origin an OAuth redirect_uri should use to land back on THIS request's
// device — needed so a flow like Linear connect doesn't hardcode localhost
// and dead-end when the cockpit's opened over Tailscale/LAN from a different
// device. Host comes off the Host header (proxies/tunnels preserve it).
//
// Scheme is NOT copied from the request — it's forced: OAuth providers (Linear
// included) reject a plaintext-HTTP redirect_uri for any non-loopback host,
// no exception for a private tailnet (RFC 8252 §7.3 — "native apps", which is
// what a DCR public client is treated as). So loopback gets http; anything
// else gets https on the default port — i.e. it assumes `tailscale serve`
// (real HTTPS cert) is fronting this host, not the plain-HTTP direct tailnet
// URL, which physically cannot satisfy this rule for a spec-compliant
// provider. Port is dropped for the https case for the same reason.
// C1: an explicit public URL (ARIGAMI_PUBLIC_URL) wins — it's what the
// browser actually typed, whatever proxy sits in front. C2: otherwise a
// trusted X-Forwarded-Proto/-Host from a loopback proxy (Caddy) is used; see
// server/lib/proxy-headers.ts requestOrigin for the full precedence.
function browserOrigin(req: IncomingMessage): string {
  return requestOrigin(req, { trustProxy: !!cfg.trustProxy, publicUrl: cfg.publicUrl }, `localhost:${cfg.port}`);
}

function spawnSafe(id: string): void {
  try {
    claude.ensureRunning(id);
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));
    claude.appendChat(id, {
      kind: 'error',
      text: `failed to start ${state.getSession(id)?.engine || 'claude'}: ${error.message}`,
    });
    state.setClaude(id, { state: 'dead' });
  }
}

// Spin up a session for a ticket. Shared by the launcher's POST /sessions
// ticket path and the trigger/pending queue, so a triggered session is identical
// to a hand-launched one. Mirrors the web buildTicketPayload default prompt.
// Injected when a trigger runs in autonomous mode (unattended, e.g. on EC2).
export const AUTONOMY_DIRECTIVE =
  'AUTONOMOUS MODE — you are running unattended; no human is watching this session. ' +
  'Do NOT ask the human any questions and do NOT pause for review or approval at any ' +
  'step. Make reasonable decisions yourself. If a workflow step says to request review ' +
  'or wait for the human, treat it as auto-approved and proceed all the way to ' +
  'completion. Never block waiting for input.';

// Appended to every isolated cron run's first prompt (server/triggers.ts
// fireCron) — the session only gets delivered/archived once it reports, so it
// needs to know that channel exists (report_to_master isn't obviously the
// right tool to call for a plain scheduled task otherwise).
export const CRON_REPORT_DIRECTIVE =
  'When you finish this scheduled task (or hit an error/blocker), call report_to_master with ' +
  "state:'done'|'error'|'blocked' and a short summary — that is how the result gets delivered " +
  '(push/WhatsApp/master session, per this schedule\'s config) and this session gets closed out. ' +
  "If the result isn't worth notifying anyone about, prefix summary with \"[SILENT]\" — failures " +
  'are always reported regardless.';

// The first prompt for a session that's set to run a specific skill — the
// user (or a saved trigger/preset) picked `skill` from GET /__api/skills.
export function buildSkillPrompt(skill: string, ticket?: string): string | null {
  if (!skill || !SKILL_NAME_RE.test(skill)) return null;
  const dir = skillDir(skill); // effective copy: user override wins over shipped
  if (!dir) return null;
  return (
    `Read ${dir}/SKILL.md in full and follow it exactly` +
    (ticket ? `, with $ARGUMENTS=${ticket} and $SKILL_DIR=${dir}.` : `, with $SKILL_DIR=${dir}.`)
  );
}

// A new session's first message: an explicit `skill` wins (its instructions,
// plus `prompt` merged in after as "Additional instructions" if both are
// given); otherwise `prompt` verbatim; otherwise a plain ticket stub;
// otherwise null (blank session — mirrors today's empty-launcher behavior).
// The absolute $SKILL_DIR path is only knowable server-side, so this is the
// single place that builds it — the browser-launched, triggered/pending, and
// generic POST /sessions paths all funnel through it.
export function buildFirstPrompt(opts: { skill?: string; prompt?: string; ticket?: string }): string | null {
  const skillPrompt = opts.skill ? buildSkillPrompt(opts.skill, opts.ticket) : null;
  const extra = opts.prompt && opts.prompt.trim() ? opts.prompt.trim() : null;
  if (skillPrompt && extra) return `${skillPrompt}\n\n## Additional instructions\n${extra}`;
  if (skillPrompt) return skillPrompt;
  if (extra) return extra;
  return opts.ticket ? `Work on ${opts.ticket}.` : null;
}

export function startTicketSession(opts: {
  ticket: string;
  title?: string;
  prompt?: string;
  skill?: string;
  model?: string;
  effort?: string;
  engine?: string; // 'claude' (default) | 'codex' — see Session.engine
  metadata?: Record<string, unknown>;
  permissionMode?: string;
  cwd?: string;
  autonomous?: boolean;
  injectPrompt?: string;
  folderId?: string | null;
  folderName?: string | null;
}): { id: string } {
  const id = opts.ticket;
  let prompt = buildFirstPrompt({ skill: opts.skill, prompt: opts.prompt, ticket: id })!;
  if (opts.autonomous) prompt += `\n\n${AUTONOMY_DIRECTIVE}`;
  if (opts.injectPrompt && opts.injectPrompt.trim())
    prompt += `\n\n## Additional instructions\n${opts.injectPrompt.trim()}`;
  const s = state.createSession({
    title: opts.title && opts.title !== id ? opts.title : id,
    cwd: opts.cwd || (cfg as any).reposDir || cfg.defaultCwd,
    // Autonomous runs must never hit a permission prompt (nobody to answer it).
    permissionMode: opts.autonomous ? 'bypassPermissions' : opts.permissionMode || 'bypassPermissions',
    metadata: { ticket: id, ...(opts.metadata || {}) },
    model: opts.model,
    effort: opts.effort,
    engine: opts.engine,
    folderId: opts.folderId,
    folderName: opts.folderName,
  });
  spawnSafe(s.id);
  try {
    claude.sendMessage(s.id, prompt);
  } catch {}
  return { id: s.id };
}

/**
 * A1/A2: the ONE place a session is born from an agent — inherit its engine
 * (agents.engineForSpawn) and model unless overridden, its rail color, default
 * the title to its name and stamp metadata.agent. Used by POST /__api/sessions,
 * cron fires, the agent home, @mention / `/as` and PM children. Throws on an
 * unknown agent.
 */
export function applyAgentToSession<T extends { title?: string; model?: string; engine?: string | null; metadata?: Record<string, unknown> }>(
  agentSlug: unknown,
  opts: T
): T & { color?: string } {
  if (agentSlug === undefined || agentSlug === null || agentSlug === '') return opts;
  const agent = agents.getAgent(String(agentSlug));
  if (!agent) throw new Error(`unknown agent: ${agentSlug}`);
  // A3: daily token budget — a spent agent gets no new sessions until local midnight.
  const b = ledger.budgetState(agent.slug);
  if (b?.exceeded) {
    const err = new Error(ledger.budgetRefusal(b, agent.name)) as Error & { status?: number; budget?: unknown };
    err.status = 429;
    err.budget = { ...b, name: agent.name };
    throw err;
  }
  // UX1: `agentHome` is minted by ensureHomeSession alone — a caller asking for
  // one would get a session that no longer shows in the rail.
  const { agentHome: _home, ...meta } = (opts.metadata || {}) as Record<string, unknown>;
  return {
    ...opts,
    engine: agents.engineForSpawn(opts.engine, agent),
    model: opts.model || agent.model || undefined,
    title: opts.title || agent.name,
    metadata: { ...meta, agent: agent.slug },
    color: agent.color,
  };
}

// Spin up a plain (empty) session — shared by the launcher's empty form and the
// pending queue's empty items. No first prompt unless a skill/prompt was given.
export function startEmptySession(opts: {
  title?: string;
  cwd?: string;
  permissionMode?: string;
  prompt?: string;
  skill?: string;
  model?: string;
  effort?: string;
  engine?: string; // 'claude' (default) | 'codex' — see Session.engine
  agent?: string | null; // A2: born from an agent (cron runs) — see applyAgentToSession
  metadata?: Record<string, unknown>;
  folderId?: string | null;
  folderName?: string | null;
}): { id: string } {
  const prompt = buildFirstPrompt({ skill: opts.skill, prompt: opts.prompt });
  const o = applyAgentToSession(opts.agent, opts);
  const s = state.createSession({
    title: o.title,
    cwd: o.cwd,
    permissionMode: o.permissionMode || 'bypassPermissions',
    model: o.model,
    effort: o.effort,
    engine: o.engine,
    metadata: o.metadata || {},
    color: o.color,
    folderId: opts.folderId,
    folderName: opts.folderName,
  });
  spawnSafe(s.id);
  if (prompt && prompt.trim()) {
    try {
      claude.sendMessage(s.id, prompt);
    } catch {}
  }
  return { id: s.id };
}

// Shared idle/busy delivery semantics: never interrupts a running turn — idle
// sessions get the message now, busy ones get it queued with auto-play so it
// plays as soon as the current turn ends. Used by the task_session channel
// (controller → child) and by cron's 'existing:<sessionId>' sessionMode.
export function deliverToSession(id: string, text: string): { delivered: 'now' | 'queued' } {
  const s = state.getSession(id);
  if (!s) throw new Error(`unknown session: ${id}`);
  if (s.claude?.state === 'idle') {
    claude.sendMessage(id, text);
    return { delivered: 'now' };
  }
  state.addPendingPrompt(id, text);
  state.setPromptAutoPlay(id, true);
  claude.kickAutoPlay(id); // "busy" can end between the check above and here
  return { delivered: 'queued' };
}

const shq = (v: string | number): string =>
  `'${String(v).replace(/'/g, `'\\''`)}'`;

export function defaultCleanupCmds(
  wtRaw: string | null | undefined,
  branch: string | null | undefined
): string[] {
  if (!wtRaw) return [];
  // The script runs under a POSIX shell (Git Bash on Windows), where a
  // backslash is an escape character and `dirname` only splits on `/`. git
  // itself already reports forward-slash paths; normalize in case the worktree
  // came from session metadata a skill wrote with native separators.
  const wt = toPosixPath(wtRaw);
  const script = [
    `MAIN=$(git -C ${shq(wt)} rev-parse --git-common-dir 2>/dev/null); MAIN=$(cd "$(dirname "$MAIN")" 2>/dev/null && pwd)`,
    `git -C "$MAIN" worktree remove --force ${shq(wt)} 2>/dev/null || rm -rf ${shq(wt)}`,
    `[ -n "$MAIN" ] && git -C "$MAIN" worktree prune 2>/dev/null`,
    branch
      ? `[ -n "$MAIN" ] && git -C "$MAIN" branch -D ${shq(branch)} 2>/dev/null`
      : null,
    `true`,
  ]
    .filter(Boolean)
    .join('; ');
  return [script];
}

export async function cleanupPlan(s: any): Promise<CleanupPlanResult> {
  const recorded =
    Array.isArray(s.metadata?.cleanup) && s.metadata.cleanup.length > 0;
  if (recorded) {
    return {
      removable: true,
      recorded: true,
      cmds: s.metadata.cleanup,
      worktree: (untildify(s.metadata?.worktree) as string | null) || null,
      branch: (s.metadata?.branch as string) || null,
    };
  }
  // A worker with no recorded cleanup owns no worktree of its own: a read-only
  // worker RUNS IN the master's worktree (wireWorker: cwd = parentDir), so the
  // worktreeInfo fallback below would detect the MASTER's worktree as linked and
  // generate an rm-rf against the master's live workspace — destroying a sibling
  // session. Never derive a cleanup plan for a worker from the on-disk worktree;
  // only the explicit metadata.cleanup path (mutating workers) is removable.
  if (s.metadata?.role === 'worker') {
    return { removable: false, recorded: false, cmds: [], worktree: null, branch: null };
  }
  const info = await worktreeInfo(s);
  if (info.linked && info.dir) {
    return {
      removable: true,
      recorded: false,
      cmds: defaultCleanupCmds(info.dir, info.branch),
      worktree: info.dir,
      branch: info.branch,
    };
  }
  return {
    removable: false,
    recorded: false,
    cmds: [],
    worktree: null,
    branch: null,
  };
}

// Remove the worktree a session owns — decided by the host from git state, not
// by running the shell commands in metadata.cleanup. Those were written by the
// agent that provisioned the session, and whether anything got removed used to
// depend on it having written them right (see reap.ts). They are still shown
// in the dialogs as a record of what was provisioned; they are no longer run.
async function runCleanup(s: any): Promise<reap.ReapReport> {
  return reap.reapSession(s, { worktree: true });
}

/**
 * Permanently delete a session: the one teardown every delete path uses (the
 * DELETE route, folder purge). Host-side and fixed — no agent input decides
 * what is removed.
 */
export async function destroySession(id: string): Promise<reap.ReapReport | null> {
  const s = state.getSession(id);
  if (!s) return null;
  claude.kill(id);
  expirePendingSetupRequests(id, 'session deleted');
  chrome.closeChrome(id);
  // Fold this session's logins back into chrome-base on every close
  // (T8 §4) — independent of whether the profile copy itself survives.
  // Only an agent session writes back — into the agent's own profile.
  if (chrome.profileSeedFor(id).owner !== 'global') await chrome.syncProfileToBase(id).catch(() => {});
  if (!cfg.screen?.keepProfiles) chrome.removeSessionProfile(id); // T8 §6
  pickDriver().release(id);
  // Processes (incl. detached dev servers), the owned worktree, scratch dir and
  // transcript — in that order, see reap.ts.
  const report = await reap.reapSession(s, reap.ALL);
  artifacts.removeSession(id); // published snapshots die with the session
  // A codex session's per-session $CODEX_HOME (config + thread history)
  // dies with it too. Dynamically imported: codex.ts imports this module.
  import('./codex.js').then((m) => m.removeCodexSession(id)).catch(() => {});
  state.deleteSession(id);
  return report;
}

/**
 * Compose ONE prompt out of everything the operator decided in the inbox.
 *
 * This is the only way an incoming message turns into action, and the only
 * place an outgoing reply is ever authorized — which is what makes "never
 * contact anyone on my behalf" enforceable rather than merely instructed. An
 * adapter can fill the inbox; only a human pressing submit can empty it
 * outward.
 */
function formatInboxSubmit(items: any[], note: string): string {
  const out = [
    '## Incoming messages — reviewed',
    '',
    'I went through the messages below and decided what to do with each one.',
    'For anything marked "reply": send EXACTLY the text quoted, nothing added.',
    'For anything marked "fix": do the work, then come back to me before replying.',
    'Do not contact anyone about the items I dismissed.',
    '',
  ];
  if (note) out.push(`My note: ${note}`, '');

  const verb: Record<string, string> = {
    fix: 'FIX — do the work, do not reply yet',
    reply: 'REPLY — send the text below as is',
    both: 'FIX AND REPLY — do the work, then send the text below',
    discuss: "LET'S TALK — do nothing yet, explain your thinking to me first",
    dismiss: 'DISMISSED — no action, no reply',
  };

  for (const [n, i] of items.entries()) {
    const src = i.source || {};
    out.push(
      `### ${n + 1}. ${verb[i.decision] || i.decision} · ${src.author || 'someone'} on ${src.provider || '?'}` +
        `${src.url ? ` — ${src.url}` : ''}`
    );
    out.push('', `> ${String(i.body || '').split('\n').join('\n> ')}`, '');
    if (i.context?.kind === 'code')
      out.push(`\`${i.context.path}${i.context.lines ? ` ${i.context.lines}` : ''}\``, '');
    const fix = i.enrichment?.proposal?.fix;
    if (fix && (i.decision === 'fix' || i.decision === 'both')) out.push(`What to change: ${fix}`, '');
    // The operator's own instruction outranks the proposal, and is carried for
    // EVERY decision — including dismiss, where "no action" may still need a
    // reason the agent should remember.
    if (i.noteToAgent) out.push(`My instruction for this one: ${String(i.noteToAgent)}`, '');
    const reply = i.replyOverride ?? i.enrichment?.proposal?.reply;
    if (reply && (i.decision === 'reply' || i.decision === 'both'))
      out.push('Reply to send, verbatim:', '```', String(reply), '```', '');
  }
  out.push(
    'When you have sent something, say what went where. If anything I approved',
    'turns out to be wrong once you look at the code, stop and tell me instead.'
  );
  return out.join('\n');
}

function formatReview(s: any, verdict: string, summary: string): string {
  const comments = (s.review?.comments || []).filter(
    (c: any) => !c.suggested
  );
  const label: Record<string, string> = {
    approve: '✅ Approved',
    'request-changes': '🔧 Request changes',
    comment: '💬 Comments',
  };
  const out = [
    `## Local-changes review — ${label[verdict] || '💬 Comments'}`,
    '',
  ];
  if (summary) out.push(summary, '');

  const byFile = new Map<string, any[]>();
  const features: any[] = [];
  for (const c of comments) {
    if (c.target?.kind === 'feature') features.push(c);
    else {
      const k = c.target?.path || '(general)';
      if (!byFile.has(k)) byFile.set(k, []);
      byFile.get(k)!.push(c);
    }
  }

  const fmt = (loc: string, c: any): string => {
    const line = c.resolved
      ? `- ~~${loc}${c.body}~~ _(✓ resolved)_`
      : `- ${loc}${c.body}`;
    const replies = (c.replies || []).map((r: any) => `  - ↳ ${r.body}`);
    return [line, ...replies].join('\n');
  };

  for (const [p, cs] of byFile) {
    out.push(`### ${p}`);
    for (const c of cs)
      out.push(
        fmt(c.target?.lineLabel ? `${c.target.lineLabel}: ` : '', c)
      );
    out.push('');
  }

  if (features.length) {
    out.push('### Features');
    for (const c of features)
      out.push(
        fmt(c.target?.featureTitle ? c.target.featureTitle + ': ' : '', c)
      );
    out.push('');
  }

  const open = comments.filter((c: any) => !c.resolved).length;
  if (!comments.length) {
    out.push(
      verdict === 'approve'
        ? 'No comments — the local changes look good.'
        : '(no inline comments)'
    );
  } else if (open) {
    out.push(
      '_Please address each unresolved comment above — fix it, or reply explaining why not._'
    );
  } else {
    out.push('_All comments resolved — nothing left to address._');
  }
  return out.join('\n');
}

function formatRemoteReview(s: any, verdict: string, summary: string): string {
  const comments = (s.review?.comments || []).filter(
    (c: any) => !c.suggested
  );
  const eventMap: Record<string, string> = {
    approve: 'APPROVE',
    'request-changes': 'REQUEST_CHANGES',
    comment: 'COMMENT',
  };
  const event = eventMap[verdict] || 'COMMENT';
  const withReplies = (c: any): string =>
    [c.body, ...(c.replies || []).map((r: any) => ` (follow-up: ${r.body})`)].join(
      ''
    );
  const branch = s.metadata?.branch || '';
  const prNum = s.metadata?.prNumber;
  const where = prNum
    ? `PR #${prNum}`
    : `the open PR for the current branch${branch ? ` \`${branch}\`` : ''}`;
  const out = [
    `## Publish this as a GitHub PR review (event \`${event}\`)`,
    '',
    `Post the review below to ${where} using the \`gh\` CLI. This is a REVIEW of someone else's PR — do NOT modify, fix, stage, commit, or push any code; only post the review.`,
    '',
  ];
  if (summary) out.push('**Review body:**', summary, '');

  const byFile = new Map<string, any[]>();
  const general: any[] = [];
  for (const c of comments) {
    if (c.target?.kind === 'feature' || !c.target?.path) general.push(c);
    else {
      const k = c.target.path;
      if (!byFile.has(k)) byFile.set(k, []);
      byFile.get(k)!.push(c);
    }
  }

  if (byFile.size) {
    out.push('**Inline comments** — map each to `{path, line (new-file side), body}`:', '');
    for (const [p, cs] of byFile) {
      for (const c of cs) {
        const ln = c.target?.lineLabel
          ? String(c.target.lineLabel).replace(/^L/i, '')
          : '';
        out.push(
          `- \`${p}\`${ln ? ` · line ${ln}` : ''} → ${withReplies(c)}`
        );
      }
    }
    out.push('');
  }

  if (general.length) {
    out.push('**General comments** (fold into the review body):', '');
    for (const c of general)
      out.push(
        `- ${c.target?.featureTitle ? c.target.featureTitle + ': ' : ''}${withReplies(c)}`
      );
    out.push('');
  }

  out.push(
    '### How to post',
    `1. Resolve the PR: \`gh pr view ${prNum || ''} --json number,headRefName,url\` (the worktree's branch should map to it).`,
    '2. Create the review in one API call (inline comments use the NEW-side line number):',
    '```bash',
    'gh api repos/{owner}/{repo}/pulls/<number>/reviews --input - <<\'JSON\'',
    `{ "event": "${event}", "body": "<review body>",`,
    '  "comments": [ { "path": "<path>", "line": <line>, "side": "RIGHT", "body": "<comment>" } ] }',
    'JSON',
    '```',
    '   (omit `comments` if there are no inline ones; `{owner}/{repo}` is auto-resolved by gh).',
    '3. Reply here with the review URL. If there is no PR or a line can\'t be mapped, say so instead of guessing.'
  );
  return out.join('\n');
}

async function linearTickets(facets: Record<string, unknown>): Promise<unknown> {
  // Prefer the live Linear MCP when it's authenticated; otherwise fall back to
  // the local cache / personal-API-key path in pages.js.
  try {
    const mcp = await import('./linear-mcp.js');
    if (mcp.status().connected) return await mcp.listIssuesByFacets(facets);
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));
    if (error.message === 'LINEAR_NEEDS_AUTH') return { tickets: [], needsAuth: true };
    // fall through to the cache path on any MCP error
  }
  try {
    const pages = await import('./pages.js');
    const filter = facets.assignee === 'me' ? 'assigned' : 'all';
    return await (pages as any).linear.listAssigned(filter);
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));
    return { tickets: [], error: `linear unavailable: ${error.message}` };
  }
}

// ---- Dispatcher (master/worker orchestration) ----
// See docs/DISPATCHER.md. A session that spawns a worker auto-becomes its master;
// the host stamps role/master/worktree/branch/cleanup and enforces global caps.

const SUMMARY_CAP = 2048; // ~2 KB hard cap on a worker result summary (decision 3)
const MAX_ARTIFACTS = 12;

type WireResult =
  | { deferred: true; reason: string }
  | {
      cwd: string;
      permissionMode: string;
      metadata: Record<string, unknown>;
    };

// Count live workers of a given kind across the WHOLE tree (caps are global, so
// depth never lets the fleet exceed the cap). Dead/archived don't count.
function countWorkers(kind: string): number {
  return state
    .listSessions()
    .filter(
      (s: any) =>
        s.metadata?.role === 'worker' &&
        s.metadata?.kind === kind &&
        s.claude?.state !== 'dead'
    ).length;
}

function sanitizeSubtask(subtask: string | null): string {
  return (subtask || 'work').replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 40) || 'work';
}

// Allocate a free port from the dispatcher pool for a needsServer worker. Free =
// not claimed by any live session's metadata.port. Released implicitly when the
// session is deleted. Returns null if the pool is exhausted (worker still spawns,
// just without a host-allocated port).
function allocatePort(): number | null {
  const [lo, hi] = cfg.dispatcher.portRange;
  const used = new Set(
    state
      .listSessions()
      .map((s: any) => Number(s.metadata?.port))
      .filter((n) => Number.isFinite(n) && n > 0)
  );
  for (let p = lo; p <= hi; p++) if (!used.has(p)) return p;
  return null;
}

// F7: host-made worktree for a child (dispatch worker OR full child). Forks
// off `base` (default: the master's current branch) inside the master's repo
// and returns the metadata the host stamps: worktree/branch/base/cleanup —
// metadata.worktree is what makes the reaper (reap.ts) treat it as this
// child's own, so a delete removes worktree and branch. Throws when git
// refuses (the spawn fails loudly).
async function hostWorktree(
  master: any,
  o: { subtask: string; branch?: string | null; dir?: string | null; base?: string | null; prefix?: string | null; parentDir?: string | null }
): Promise<{ dir: string; branch: string; base: string; metadata: Record<string, unknown> }> {
  // F8 (F7 follow-up): the repo is the one the CALLER named (`cwd` /
  // metadata.repo), falling back to the master's own checkout — a master whose
  // cwd is a plain workspace folder can still spawn a full child on a repo.
  const parentDir =
    o.parentDir || (untildify((master.metadata?.worktree as string) || master.cwd) as string) || HOME;
  const info = await worktreeInfo({ cwd: parentDir } as any);
  const r = await provisionChildWorktree({
    parentDir,
    subtask: o.subtask,
    branch: o.branch || null,
    dir: o.dir || null,
    prefix: o.prefix || 'child',
    base: o.base || info.branch || null,
    reposDir: cfg.reposDir,
  });
  if (!r.ok) throw new Error(`worktree add failed: ${r.error}`);
  return {
    dir: r.dir,
    branch: r.branch,
    base: r.base,
    metadata: {
      worktree: r.dir,
      branch: r.branch,
      base: r.base,
      cleanup: defaultCleanupCmds(r.dir, r.branch),
    },
  };
}

// Resolve all auto-wiring for a worker spawn: caps → worktree (mutating) → cwd +
// permission mode + metadata. Returns {deferred} when at capacity (no session is
// created — the master leaves the node ready and retries next wake, decision 14).
async function wireWorker(
  masterId: string,
  kind: 'mutating' | 'readonly',
  body: any
): Promise<WireResult> {
  const master = state.getSession(masterId);
  if (!master) throw new Error(`unknown master session: ${masterId}`);

  const cap =
    kind === 'mutating'
      ? cfg.dispatcher.maxMutating
      : cfg.dispatcher.maxReadOnly;
  if (countWorkers(kind) >= cap)
    return { deferred: true, reason: 'at-capacity' };

  const subtask = body.subtask ? String(body.subtask) : null;
  const metadata: Record<string, unknown> = {
    role: 'worker',
    master: masterId,
    kind,
    ...(subtask ? { subtask } : {}),
  };
  if (body.needsServer) {
    const port = allocatePort();
    if (port) metadata.port = port; // surfaced to the worker as $PORT (claude.js)
  }
  const parentDir =
    (untildify((master.metadata?.worktree as string) || master.cwd) as string) ||
    HOME;

  if (kind === 'mutating') {
    const safe = sanitizeSubtask(subtask);
    const r = await hostWorktree(master, {
      subtask: safe,
      branch: `dispatch/${safe}`,
      dir: path.join(cfg.reposDir, '.dispatch-worktrees', `${safe}-${nano()}`),
      base: body.base ? String(body.base) : null,
    });
    Object.assign(metadata, r.metadata);
    return {
      cwd: r.dir,
      permissionMode: body.permissionMode || 'bypassPermissions',
      metadata,
    };
  }
  // read-only: run in the parent's repo, no worktree (decision 5).
  return {
    cwd: parentDir,
    permissionMode: body.permissionMode || 'bypassPermissions',
    metadata,
  };
}

// FULL children (project folders): regular sessions under a controller — no
// worker thinning, no dispatch branch policy. The child is expected to run its
// own skill and provision itself (e.g. a ticket-workflow skill sets up its own
// worktree); the host only wires identity (role/master) + optional port, and
// caps the fleet (a dev server per child is the expensive part).
function countFullChildren(): number {
  return state
    .listSessions()
    .filter(
      (s: any) =>
        s.metadata?.role === 'child' &&
        s.metadata?.kind === 'full' &&
        s.claude?.state !== 'dead'
    ).length;
}

/** The repo a child worktree forks from: the caller's `cwd`, else `metadata.repo`, else the master's checkout. */
export function childRepoDir(body: any, masterDir: string): string {
  const named = body?.cwd ? String(body.cwd) : body?.metadata?.repo ? String(body.metadata.repo) : '';
  return (untildify(named) as string) || masterDir;
}

async function wireFullChild(masterId: string, body: any): Promise<WireResult> {
  const master = state.getSession(masterId);
  if (!master) throw new Error(`unknown master session: ${masterId}`);
  if (countFullChildren() >= cfg.dispatcher.maxChildren)
    return { deferred: true, reason: 'at-capacity' };
  const subtask = body.subtask ? String(body.subtask) : null;
  const metadata: Record<string, unknown> = {
    role: 'child',
    master: masterId,
    kind: 'full',
    ...(subtask ? { subtask } : {}),
  };
  if (body.needsServer) {
    const port = allocatePort();
    if (port) metadata.port = port;
  }
  const parentDir =
    (untildify((master.metadata?.worktree as string) || master.cwd) as string) ||
    HOME;
  // F7: `worktree: true | '<path>'` (default true when a subtask is named) →
  // the host provisions `<reposDir>/<repo>-wt-<subtask>` on `<prefix>/<subtask>-<id>`
  // off `base` and starts the child IN it, so its Changes tab works from the
  // first second and the human can merge after approval. `worktree:false` (or
  // no subtask) keeps today's behaviour: the child provisions itself.
  const wantWt =
    body.worktree === true || typeof body.worktree === 'string'
      ? body.worktree
      : body.worktree === false
        ? false
        : !!subtask;
  if (wantWt) {
    const r = await hostWorktree(master, {
      parentDir: childRepoDir(body, parentDir),
      subtask: sanitizeSubtask(subtask),
      dir: typeof wantWt === 'string' ? wantWt : null,
      base: body.base ? String(body.base) : null,
      prefix: body.branchPrefix ? String(body.branchPrefix).replace(/[^a-zA-Z0-9._-]/g, '-') : 'child',
    });
    Object.assign(metadata, r.metadata);
    return {
      cwd: r.dir,
      permissionMode: body.permissionMode || 'bypassPermissions',
      metadata,
    };
  }
  return {
    cwd: (untildify(body.cwd ? String(body.cwd) : '') as string) || parentDir,
    permissionMode: body.permissionMode || 'bypassPermissions',
    metadata,
  };
}

// ---- F7: approval + host-executed merge ----
// The child never merges. A human approval (local review verdict `approve`, or
// the ✓ Verified button of request_review) on a session that owns a branch
// stamps metadata.review with the repository, branch, and reviewed SHA; from there the merge is
// one click (web) or one tool call (merge_session) — executed by the HOST.
function principalLabel(me: any): string {
  if (!me) return 'unknown';
  if (me.kind === 'user') return me.user?.email || me.user?.name || me.user?.id || 'user';
  if (me.kind === 'session') return `session:${me.sessionId}`;
  return me.kind;
}

// Both the immutable commit and canonical git directory identify what was reviewed.
function reviewedCommit(s: any): { sha: string; repo: string; branch: string } | null {
  const cwd = untildify(s.metadata?.worktree || s.cwd) as string;
  const branch = s.metadata?.branch;
  if (!cwd || !branch) return null;
  const sha = Bun.spawnSync(['git', '-C', cwd, 'rev-parse', '--verify', `refs/heads/${branch}^{commit}`]);
  const common = Bun.spawnSync(['git', '-C', cwd, 'rev-parse', '--git-common-dir']);
  if (sha.exitCode || common.exitCode) return null;
  try {
    return { sha: Buffer.from(sha.stdout).toString().trim(), repo: fs.realpathSync(path.resolve(cwd, Buffer.from(common.stdout).toString().trim())), branch };
  } catch { return null; }
}

export function markApproved(id: string, by: string, expected?: { sha: string; repo: string; branch: string }): boolean {
  const s = state.getSession(id);
  if (!s) return false;
  const md: any = s.metadata || {};
  if (!md.branch || md.merged) return false;
  if (md.base && md.branch === md.base) return false;
  const commit = reviewedCommit(s);
  if (!commit || (expected && (commit.sha !== expected.sha || commit.repo !== expected.repo || commit.branch !== expected.branch))) return false;
  state.patchSession(id, {
    metadata: { review: { state: 'approved', at: new Date().toISOString(), by, ...commit }, mergeConflict: null },
  });
  // EXT domain event (the WS only ever carried this as a session-updated).
  try { emitLocal('review.approved', { sessionId: id, by, branch: md.branch }); } catch {}
  return true;
}

// Where the base lives: the master's checkout (its worktree or cwd), else the
// main worktree of the child's repo.
async function baseRepoRootFor(s: any): Promise<string | null> {
  const master = s.metadata?.master ? state.getSession(String(s.metadata.master)) : null;
  const candidates = [
    master ? (untildify((master.metadata?.worktree as string) || master.cwd) as string) : null,
  ].filter(Boolean) as string[];
  for (const c of candidates) {
    const info = await worktreeInfo({ cwd: c } as any);
    if (info.branch) return c;
  }
  const wt = untildify((s.metadata?.worktree as string) || s.cwd) as string;
  if (!wt) return null;
  const { repoCommonRoot } = await import('./git.js');
  const p = Bun.spawnSync(['git', '-C', wt, 'rev-parse', '--git-common-dir']);
  if (p.exitCode !== 0) return null;
  const common = Buffer.from(p.stdout).toString().trim();
  const abs = path.isAbsolute(common) ? common : path.join(wt, common);
  const root = await repoCommonRoot(path.dirname(abs));
  return root;
}

async function defaultBaseFor(root: string): Promise<string> {
  for (const b of ['main', 'master']) {
    const p = Bun.spawnSync(['git', '-C', root, 'rev-parse', '--verify', '--quiet', `refs/heads/${b}`]);
    if (p.exitCode === 0) return b;
  }
  return 'main';
}

// Who may merge a child: an admin (cookie/token), or the session that is the
// child's master / the controller of its folder. Never the child itself.
export function mayMerge(me: any, s: any): boolean {
  if (auth.isAdmin(me)) return true;
  if (me?.kind === 'session') {
    if (me.sessionId === s.id) return false;
    if (s.metadata?.master && String(s.metadata.master) === me.sessionId) return true;
    const folder = s.folderId ? state.getFolder(s.folderId as string) : null;
    if (folder?.controllerSessionId === me.sessionId) return true;
  }
  return false;
}

export async function mergeStatus(s: any) {
  const md: any = s.metadata || {};
  const root = await baseRepoRootFor(s);
  const base = md.base ? String(md.base) : root ? await defaultBaseFor(root) : 'main';
  const commit = reviewedCommit(s);
  const destination = root ? reviewedCommit({ cwd: root, metadata: { branch: md.branch } }) : null;
  const approved = md.review?.state === 'approved' && !!commit && md.review.sha === commit.sha && md.review.repo === commit.repo && md.review.branch === commit.branch && destination?.repo === commit.repo;
  const merged = md.merged || null;
  const out: any = {
    branch: md.branch || null,
    base,
    repoRoot: root,
    approved,
    approvedSha: approved ? commit!.sha : null,
    review: md.review || null,
    merged,
    conflict: md.mergeConflict || null,
    canMerge: false,
    reason: null as string | null,
  };
  if (!md.branch) { out.reason = 'no-branch'; return out; }
  if (merged) { out.reason = 'merged'; return out; }
  if (!root) { out.reason = 'no-repo'; return out; }
  const st = await baseStatus(root, base, String(md.branch));
  out.baseHead = st.head;
  out.ahead = st.ahead;
  out.dirtyFiles = st.dirtyFiles;
  if (!st.branchExists) out.reason = 'branch-missing';
  else if (!st.checkedOut) out.reason = 'base-not-checked-out';
  else if (st.dirty) out.reason = 'dirty';
  else if (st.ahead === 0) out.reason = 'nothing-to-merge';
  else if (!approved) out.reason = md.review?.state === 'approved' ? 'approval-stale' : 'not-approved';
  out.canMerge = out.reason === null;
  return out;
}

const mergeLocks = new Map<string, Promise<void>>();

export async function mergeSession(
  s: any,
  o: { strategy?: string; deleteBranch?: boolean; runCleanup?: boolean; force?: boolean },
  by: string
): Promise<any> {
  const root = await baseRepoRootFor(s);
  if (!root) return { error: 'could not resolve the base repository', status: 400 };
  const key = fs.realpathSync(root);
  const previous = mergeLocks.get(key) || Promise.resolve();
  let release!: () => void;
  const lock = new Promise<void>((resolve) => { release = resolve; });
  mergeLocks.set(key, lock);
  await previous;
  try { return await mergeSessionLocked(state.getSession(s.id) || s, o, by); }
  finally {
    release();
    if (mergeLocks.get(key) === lock) mergeLocks.delete(key);
  }
}

async function mergeSessionLocked(
  s: any,
  o: { strategy?: string; deleteBranch?: boolean; runCleanup?: boolean; force?: boolean },
  by: string
): Promise<any> {
  const md: any = s.metadata || {};
  const st = await mergeStatus(s);
  const HINT = 'merge does not run project gates — run tsc / tests / build on the base, then push';
  if (!st.branch) return { error: 'session has no branch to merge', status: 400 };
  if (st.merged) return { error: `already merged (${String(st.merged.sha).slice(0, 7)})`, status: 409 };
  if (!st.repoRoot) return { error: 'could not resolve the base repository', status: 400 };
  if (st.reason === 'not-approved' && !o.force)
    return { error: 'not approved — the human approves first (review verdict approve / ✓ Verified)', status: 409, reason: 'not-approved' };
  if (st.reason && st.reason !== 'not-approved')
    return { error: st.reason === 'dirty' ? `base worktree is dirty (${(st.dirtyFiles || []).join(', ')})` : st.reason, status: 409, reason: st.reason, files: st.dirtyFiles };
  const approvedSha = st.approvedSha || (o.force ? reviewedCommit(s)?.sha : null);
  if (!approvedSha) return { error: 'no reviewed commit', status: 409 };
  const strategy = o.strategy === 'squash' ? 'squash' : 'no-ff';
  // EXT: `merge.before` gates. This is the hook the code used to say did not
  // exist (see HINT above) — an extension can run typecheck/tests/CI here and
  // refuse. Gates FAIL CLOSED: a throw or a timeout blocks the merge with its
  // own message, because blocking is the whole point of a gate. With no
  // extension installed the call returns {ok:true} without doing anything.
  try {
    const ext = await import('./extensions.js');
    if (ext.hasGates('merge.before')) {
      const g = await ext.runGates('merge.before', { sessionId: s.id, branch: st.branch, base: st.base, repoRoot: st.repoRoot, sha: approvedSha, title: s.title || '' });
      if (!g.ok) {
        const line = `merge blocked by the "${g.ext}" extension: ${g.reason}`;
        claude.appendChat(s.id, { kind: 'merge', state: 'blocked', branch: st.branch, base: st.base, gate: g.ext, text: line });
        return { error: `merge gate failed: ${g.reason}`, reason: 'gate', gate: g.ext, status: 409 };
      }
    }
  } catch (e) {
    // The loader itself failing must not block a human's merge — only a GATE does.
    console.error('[ext] merge gates skipped:', (e as Error).message);
  }
  const message = mergeMessage({ branch: st.branch, base: st.base, title: s.title, subtask: md.subtask, sessionId: s.id, strategy });
  const r = await mergeBranch({ repoRoot: st.repoRoot, branch: st.branch, approvedSha, base: st.base, strategy, message });
  const masterId = md.master ? String(md.master) : null;
  if (!r.ok) {
    if ('conflict' in r && r.conflict) {
      state.patchSession(s.id, { metadata: { mergeConflict: { files: r.files, at: new Date().toISOString() } } });
      const line = `merge conflict — ${st.branch} → ${st.base}: ${r.files.join(', ')} — resolve, then merge again`;
      claude.appendChat(s.id, { kind: 'merge', state: 'conflict', branch: st.branch, base: st.base, files: r.files, text: line });
      if (masterId && state.getSession(masterId))
        claude.appendChat(masterId, { kind: 'merge', state: 'conflict', child: s.id, branch: st.branch, base: st.base, files: r.files, text: `[${s.title || s.id}] ${line}` });
      try { emitLocal('merge.conflict', { sessionId: s.id, branch: st.branch, base: st.base, files: r.files }); } catch {}
      return { conflict: true, files: r.files, branch: st.branch, base: st.base, status: 409 };
    }
    return { error: (r as any).error, reason: (r as any).reason, files: (r as any).files, status: 409 };
  }
  const merged = { sha: r.sha, at: new Date().toISOString(), by, strategy, base: st.base };
  state.patchSession(s.id, { metadata: { merged, mergeConflict: null } });
  const card = { kind: 'merge', state: 'merged', sha: r.sha, branch: st.branch, base: st.base, strategy, by, text: `merged ${st.branch} → ${st.base} (${r.sha.slice(0, 7)}, ${strategy})` };
  claude.appendChat(s.id, card);
  if (masterId && state.getSession(masterId))
    claude.appendChat(masterId, { ...card, child: s.id, text: `[${s.title || s.id}] ${card.text}` });
  try { emitLocal('merge.done', { sessionId: s.id, branch: st.branch, base: st.base, sha: r.sha, strategy, by }); } catch {}
  let cleanup: unknown;
  if (o.deleteBranch || o.runCleanup) {
    // the recorded cleanup removes the worktree AND deletes the branch — a
    // branch can't be deleted while a worktree has it checked out.
    try { cleanup = await runCleanup(s); } catch (e) { cleanup = { error: (e as Error).message }; }
  }
  return { ok: true, sha: r.sha, strategy, branch: st.branch, base: st.base, hint: HINT, ...(cleanup !== undefined ? { cleanup } : {}) };
}

// A session that spawns children controls a project folder. First spawn
// auto-creates it (named after the master) with the master as controller —
// every dispatch flow gets the folder UI for free. Idempotent.
function ensureProjectFolder(masterId: string) {
  const master = state.getSession(masterId);
  if (!master) return null;
  const existing = state
    .listFolders()
    .find((f) => f.controllerSessionId === masterId);
  if (existing) return existing;
  const folder = state.createFolder({
    name: state.uniqueFolderName(master.title || masterId),
    ...(master.sortOrder != null ? { sortOrder: master.sortOrder } : {}),
  });
  state.patchFolder(folder.id, { controllerSessionId: masterId });
  state.patchSession(masterId, { folderId: folder.id });
  return folder;
}

// Read + parse the master's durable plan. B32: `ORCHESTRATION.<id>.json` first;
// the shared `<cwd>/ORCHESTRATION.json` only when it is attributable to this
// session (every project controller shares the repos dir) — see orchestration.ts.
// Bounded read; never throws — returns {plan:null, planError} on any problem.
function readOrchestration(s: any): { plan: unknown; planError?: string } {
  const dir = untildify((s.metadata?.worktree as string) || s.cwd) as string;
  if (!dir) return { plan: null, planError: 'no cwd' };
  const all = state.listSessions({ archived: true }) as any[];
  const childIds = new Set(all.filter((c) => c.metadata?.master === s.id).map((c) => c.id as string));
  const isController = (c: any) => c.metadata?.role === 'controller' || c.metadata?.kind === 'controller' || all.some((k) => k.metadata?.master === c.id);
  const sharedCwd = all.some((c) => c.id !== s.id && !c.archived && isController(c) && untildify((c.metadata?.worktree as string) || c.cwd) === dir);
  const { plan, planError } = orchestration.resolvePlan(dir, { id: s.id, folderId: s.folderId ?? null }, { childIds, sharedCwd });
  return { plan, ...(planError ? { planError } : {}) };
}

// Bounded per-child summary for the Orchestration view — NEVER the chat (the one
// hard rule). Just identity + status + the capped result struct.
function childSummary(c: any) {
  return {
    id: c.id,
    title: c.title,
    status: c.status,
    color: c.color,
    archived: c.archived,
    claude_state: c.claude?.state,
    subtask: c.metadata?.subtask ?? null,
    kind: c.metadata?.kind ?? null,
    branch: c.metadata?.branch ?? null,
    worktree: c.metadata?.worktree ?? null,
    result: c.metadata?.result ?? null,
    review: c.metadata?.review ?? null,
    merged: c.metadata?.merged ?? null,
  };
}

function capResult(body: any): {
  state: string;
  summary: string;
  artifacts: unknown[];
  note: string;
  reportedAt: string;
  skillProposalId?: string;
} {
  const validStates = ['done', 'blocked', 'error', 'milestone'];
  const st = validStates.includes(body.state) ? body.state : 'milestone';
  const summary = String(body.summary ?? body.note ?? '').slice(0, SUMMARY_CAP);
  const artifacts = Array.isArray(body.artifacts)
    ? body.artifacts.slice(0, MAX_ARTIFACTS)
    : [];
  const note = String(body.note ?? '').slice(0, 280);
  // M3: a worker's retro step (dispatch/project-manager/machine-work skills)
  // can point its master at a skill_propose it filed while doing this task —
  // purely informational, never validated against skill-proposals.ts here.
  const skillProposalId = typeof body.skillProposalId === 'string' && body.skillProposalId.trim()
    ? body.skillProposalId.trim().slice(0, 64)
    : undefined;
  return { state: st, summary, artifacts, note, reportedAt: new Date().toISOString(), ...(skillProposalId ? { skillProposalId } : {}) };
}

// Memory M1.4a: on report_to_master / session close, run the same one-shot
// `claude -p` pattern as skills.ts's analyze() over a bounded transcript
// excerpt to produce an episode + up to 3 `pending` facts. Best-effort,
// fire-and-forget — never blocks or fails the caller's request.
function buildTranscriptExcerpt(id: string): string {
  const { events } = (claude as any).getChatPage(id, { limit: 150 });
  const lines: string[] = [];
  for (const e of events as any[]) {
    if (e.kind === 'user' && e.text) lines.push(`User: ${String(e.text).slice(0, 800)}`);
    else if (e.kind === 'assistant-text' && e.text) lines.push(`Assistant: ${String(e.text).slice(0, 800)}`);
  }
  return lines.join('\n').slice(-12000);
}

function triggerMemoryEpisode(id: string, trigger: string): void {
  (async () => {
    try {
      const memory = await import('./memory.js');
      const transcript = buildTranscriptExcerpt(id);
      await memory.runEpisodeHook(id, trigger, transcript);
    } catch (e) {
      console.error(`[memory] episode hook (${trigger}) failed:`, (e as Error).message);
    }
  })();
}

let VERSION = '0.0.0';
try {
  VERSION = JSON.parse(fs.readFileSync(path.join(resourceRoot(), 'package.json'), 'utf8')).version || VERSION;
} catch {}

// Session tokens (ARIGAMI_TOKEN) are only honoured while their session exists.
auth.setSessionExists((id) => !!state.getSession(id));

const publicUser = (u: any) => (u ? { id: u.id, email: u.email, role: u.role, createdAt: u.createdAt, oidc: !!u.oidcSub } : null);

// /__api/auth/* — the only API surface reachable without a credential (plus the
// reduced /__api/config). Everything here is deliberately small; see auth.ts.
async function handleAuth(req: IncomingMessage, res: ServerResponse, u: URL, p: string, m: string): Promise<void> {
  const me = (req as any).auth as import('./auth.js').Principal | null;
  if (p === '/__api/auth/me' && m === 'GET') {
    if (!me) return json(res, { error: 'unauthorized', ...auth.publicInfo() }, 401);
    return json(res, {
      user: me.kind === 'user' ? publicUser(me.user) : null,
      principal: me.kind,
      ...(me.kind === 'session' ? { sessionId: me.sessionId } : {}),
      isAdmin: auth.isAdmin(me),
      ...auth.publicInfo(),
    });
  }
  if (p === '/__api/auth/pair' && m === 'POST') {
    const b = (await readBody(req)) as any;
    const r = auth.pair(String(b.code || ''), b.email ? String(b.email) : undefined);
    if (!r.ok) {
      if (r.retryAfter) res.setHeader('retry-after', String(r.retryAfter));
      return json(res, { error: r.error }, r.status);
    }
    const ws = auth.createWebSession(r.user.id, String(req.headers['user-agent'] || ''));
    auth.setCookie(res, ws, req);
    return json(res, { user: publicUser(r.user), ...auth.publicInfo() });
  }
  if (p === '/__api/auth/logout' && m === 'POST') {
    auth.logout(req);
    auth.clearCookie(res, req);
    return json(res, { ok: true });
  }
  // K8S-3: orchestrator handoff — the control-plane already authenticated this
  // user against the company IdP and provisioned this tenant, so it can mint a
  // short-lived single-use token instead of making them find a pairing code
  // that only exists inside the pod (server/handoff.ts). Public route (every
  // /__api/auth/* path is), but it opens nothing without ARIGAMI_HANDOFF_SECRET.
  if (p === '/__api/auth/handoff' && m === 'GET') {
    const r = handoff.consume(String(u.searchParams.get('t') || ''));
    if (!r.ok) {
      res.writeHead(r.status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(
        `<!doctype html><title>Arigami — sign-in failed</title><body style="font-family:system-ui;padding:40px">` +
          `<h1>Sign-in failed</h1><p>${escapeHtml(r.error)}</p><p><a href="/__host/">Continue to this workspace</a></p>`,
      );
      return;
    }
    // This tenant belongs to the one user the orchestrator named: reuse their
    // row if they have signed in before, else create it. Admin because it is
    // their own instance — the same role `pair()` grants for the same reason.
    const user = auth.findByEmail(r.payload.email) || auth.createUser(r.payload.email, 'admin');
    const ws = auth.createWebSession(user.id, String(req.headers['user-agent'] || ''));
    // Land on the cockpit, not back on this URL: the spent token must not sit
    // in the address bar to be re-shared or re-loaded.
    res.writeHead(302, {
      location: '/__host/',
      'set-cookie': [auth.cookieHeader(ws.token, Math.floor((ws.exp - Date.now()) / 1000), req)],
      'cache-control': 'no-store',
    });
    res.end();
    return;
  }
  if (p === '/__api/auth/oidc/start' && m === 'GET') {
    if (!auth.oidcEnabled()) return json(res, { error: 'oidc not configured' }, 404);
    try {
      const { url, cookie } = await auth.oidcStart(browserOrigin(req), u.searchParams.get('redirect'), req);
      res.writeHead(302, { location: url, 'set-cookie': cookie, 'cache-control': 'no-store' });
      res.end();
      return;
    } catch (e) {
      return json(res, { error: 'oidc start failed: ' + ((e as Error)?.message || e) }, 502);
    }
  }
  if (p === '/__api/auth/oidc/callback' && m === 'GET') {
    if (!auth.oidcEnabled()) return json(res, { error: 'oidc not configured' }, 404);
    const r = await auth.oidcCallback(req, u);
    if (!r.ok) {
      res.writeHead(r.status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(`<!doctype html><title>Arigami — sign-in failed</title><body style="font-family:system-ui;padding:40px"><h1>Sign-in failed</h1><p>${escapeHtml(r.error)}</p><p><a href="/__host/">Back</a></p>`);
      return;
    }
    const ws = auth.createWebSession(r.user.id, String(req.headers['user-agent'] || ''));
    res.writeHead(302, { location: r.redirect, 'set-cookie': [auth.cookieHeader(ws.token, Math.floor((ws.exp - Date.now()) / 1000), req)], 'cache-control': 'no-store' });
    res.end();
    return;
  }
  // ---- everything below needs a signed-in principal --------------------------
  if (!me) return json(res, { error: 'unauthorized' }, 401);
  if (p === '/__api/auth/users' && m === 'GET') return json(res, { users: auth.listUsers() });
  if (!auth.isAdmin(me)) return json(res, { error: 'admin only' }, 403);
  if (p === '/__api/auth/tokens' && m === 'GET') return json(res, { tokens: auth.listApiTokens() });
  if (p === '/__api/auth/tokens' && m === 'POST') {
    const b = (await readBody(req)) as any;
    const owner = me.kind === 'user' ? me.user.id : auth.listUsers().find((x: any) => x.role === 'admin')?.id;
    if (!owner) return json(res, { error: 'no admin user to own the token' }, 409);
    const t = auth.createApiToken(owner, String(b.label || 'cli'));
    return json(res, t, 201);
  }
  let mm = /^\/__api\/auth\/tokens\/([^/]+)$/.exec(p);
  if (mm && m === 'DELETE') return json(res, { ok: auth.deleteApiToken(decodeURIComponent(mm[1])) });
  mm = /^\/__api\/auth\/users\/([^/]+)$/.exec(p);
  if (mm && m === 'DELETE') {
    const id = decodeURIComponent(mm[1]);
    if (me.kind === 'user' && me.user.id === id) return json(res, { error: 'cannot remove yourself' }, 400);
    return json(res, { ok: auth.removeUser(id) });
  }
  if (p === '/__api/auth/pairing-code' && m === 'POST') {
    // Admin re-issues a code (e.g. to pair a second device / user).
    return json(res, { code: auth.issuePairingCode() });
  }
  if (p === '/__api/auth/config' && m === 'PATCH') {
    const b = (await readBody(req)) as any;
    const patch: any = {};
    if (typeof b.cookieDays === 'number' && b.cookieDays > 0) patch.cookieDays = Math.min(365, Math.floor(b.cookieDays));
    if (b.oidc && typeof b.oidc === 'object') {
      const o = b.oidc;
      patch.oidc = {
        ...(cfg.auth.oidc || { allowedEmails: [], allowedDomains: [], autoCreate: true }),
        ...(typeof o.issuer === 'string' ? { issuer: o.issuer.trim() } : {}),
        ...(typeof o.clientId === 'string' ? { clientId: o.clientId.trim() } : {}),
        ...(typeof o.clientSecret === 'string' && o.clientSecret ? { clientSecret: o.clientSecret } : {}),
        ...(Array.isArray(o.allowedEmails) ? { allowedEmails: o.allowedEmails.map(String) } : {}),
        ...(Array.isArray(o.allowedDomains) ? { allowedDomains: o.allowedDomains.map(String) } : {}),
        ...(typeof o.autoCreate === 'boolean' ? { autoCreate: o.autoCreate } : {}),
      };
    }
    if (b.mode === 'pairing' || b.mode === 'oidc') patch.mode = b.mode; // 'off' is CLI/config-only, never from the UI
    const next = updateAuthConfig(patch);
    const { clientSecret, ...oidcPub } = next.oidc || ({} as any);
    return json(res, { auth: { ...next, oidc: next.oidc ? oidcPub : undefined } });
  }
  return json(res, { error: 'not found' }, 404);
}

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

export async function handle(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const u = new URL(req.url || '/', 'http://localhost');
  const p = u.pathname;
  const m = req.method;
  try {
    // The MCP gateway (lib/mcp-gateway.ts): a session's arigami + extension MCP
    // servers over HTTP, authenticated by the session's own token. It reads the
    // request body itself, so it must come before anything that consumes it.
    if (p.startsWith('/__mcp/s/')) {
      const gw = await import('./lib/mcp-gateway.js');
      gw.setOutboundFiler(fileOutbound);
      await gw.handle(req, res, decodeURIComponent(p.slice(gw.GATEWAY_PREFIX.length)), (req as any).auth);
      return;
    }
    if (p === '/__mcp/permission' && m === 'POST') {
      return await handlePermissionRequest(res, await readBody(req));
    }
    // CHAT1: re-attach to a blocking call whose previous HTTP leg ended with
    // {pending:true} (or died) — see respondBlocking / mcp/blocking-call.js.
    if (p === '/__mcp/wait' && m === 'POST') {
      const body = await readBody(req);
      const key = waitKeyOf(body);
      const entry = key ? blockingWaits.get(key) : undefined;
      if (!key || !entry) return notFound(res, 'unknown wait key — the request it belonged to is gone (answered and collected, expired, or the host restarted)');
      return await waitLeg(res, key, entry);
    }
    if (p === '/__mcp/screen-request' && m === 'POST') {
      // S1: no desktop → the tool asks instead of failing.
      if (!cfg.screen?.enabled) return json(res, caps.needsSetup('desktop', 'drive a browser / hand you the screen'));
      return await handleScreenRequest(res, await readBody(req));
    }
    if (p === '/__mcp/setup-request' && m === 'POST') {
      return await handleSetupRequest(res, await readBody(req));
    }
    if (p === '/__mcp/setup-report' && m === 'POST') {
      return await handleSetupReport(res, await readBody(req));
    }
    if (p === '/__mcp/agent-card' && m === 'POST') {
      return handleAgentCard(res, await readBody(req));
    }
    // ---- A1 agents (the Team section) REST (server/agents.ts) ----
    if (p === '/__api/agents' || p.startsWith('/__api/agents/')) {
      return await handleAgents(req, res, u, p, m || 'GET');
    }
    // ---- S1 JIT setup REST (server/capabilities.ts) ----
    if (p.startsWith('/__api/setup/') || p === '/__api/setup') {
      const me = (req as any).auth as import('./auth.js').Principal | null;
      const mayAct = auth.isAdmin(me) || me?.kind === 'session';
      const rest = p.slice('/__api/setup/'.length);
      // A2: `?owner=agent:<slug>` resolves for that agent (agent first, then shared);
      // a session principal defaults to its own agent; anything else is global.
      const qOwner = ownerOfRequest(u.searchParams.get('owner'), me);
      if (!qOwner) return badRequest(res, `invalid owner: ${u.searchParams.get('owner')} — "global" or "agent:<slug>"`);
      if (rest === 'capabilities' && m === 'GET') return json(res, { ...(await caps.capabilitiesStatus({}, qOwner)), audit: caps.readAudit(50, qOwner === caps.GLOBAL_OWNER && !u.searchParams.get('owner') ? undefined : qOwner) });
      if (rest.startsWith('capabilities/') && m === 'GET') {
        const id = decodeURIComponent(rest.slice('capabilities/'.length));
        const owner = caps.isOwnable(id) ? qOwner : caps.GLOBAL_OWNER;
        const qEngine = u.searchParams.get('engine');
        const probes: Partial<caps.CapabilityProbes> =
          qEngine === 'codex' || qEngine === 'claude' ? { engine: () => qEngine } : me?.kind === 'session' ? sessionProbes(me.sessionId) : {};
        const cap = caps.getCapability(id, probes, owner);
        if (!cap) return badRequest(res, `unknown capability: ${id}`);
        const why = (u.searchParams.get('why') || '').trim() || cap.title; // F6: never empty
        // CONN1: a session under an agent allowlist that excludes this capability's
        // tools must not hear "connected" — the hook would block the very next call
        // and request_setup cannot fix an allowlist. Say so, with the way out.
        if (me?.kind === 'session') {
          const pol = policy.policyFor(sessionAgent(state.getSession(me.sessionId)));
          if (policy.capabilityDenied(pol, id))
            return json(res, {
              ok: false,
              denied: true,
              capability: id,
              detail: `${cap.title} is connected on this host, but agent ${pol!.slug}'s allowlist (${(pol!.tools || []).join(', ')}) does not include its tools — calls would be blocked`,
              hint: 'do not call request_setup (it cannot change an allowlist); ask the human (request_action) to tick the tool family for this agent, or hand the task to an agent that has it',
            });
        }
        const r = await caps.ensure(id, why, probes, owner);
        return json(res, 'ok' in r ? { ...r, status: await caps.statusOf(cap, probes, owner) } : r);
      }
      if (rest === 'identity' && m === 'GET') return json(res, { identity: caps.readIdentity(qOwner), owner: qOwner });
      // DELETE /__api/setup/:capability — disconnect (identity or a provider) + audit.
      if (m === 'DELETE' && rest && !rest.includes('/')) {
        if (!mayAct) return json(res, { error: 'admin only' }, 403);
        const capability = decodeURIComponent(rest);
        const owner = caps.isOwnable(capability) ? qOwner : caps.GLOBAL_OWNER;
        const cap = caps.getCapability(capability, {}, owner);
        if (!cap) return badRequest(res, `unknown capability: ${capability}`);
        const had = capability === 'identity' ? !!caps.readIdentity(owner) : true;
        // F6: ?orphans=1 only removes stale (non-ACTIVE) Composio accounts of the toolkit.
        if (u.searchParams.get('orphans') === '1') {
          if (!capability.startsWith('composio:')) return badRequest(res, 'orphans=1 is for composio:<toolkit>');
          try {
            const pruned = await caps.pruneComposioOrphans(capability.slice(9), { owner });
            return json(res, { ok: true, capability, owner, ...pruned, status: await caps.statusOf(cap, {}, owner) });
          } catch (e) {
            return json(res, { ok: false, error: (e as Error).message, capability }, 400);
          }
        }
        try {
          const out = await disconnectCapability(capability, owner);
          if (had) caps.appendAudit({ sessionId: me?.kind === 'session' ? me.sessionId : null, capability, mode: 'manual', result: 'disconnected', evidence: null, human: true, owner });
          broadcast({ type: 'setup.changed', capability, owner });
          return json(res, { ...out, capability, owner, status: await caps.statusOf(cap, {}, owner) });
        } catch (e) {
          return json(res, { ok: false, error: (e as Error).message, capability }, 400);
        }
      }
      if (rest === 'connections' && m === 'GET') {
        const limit = Math.min(500, Math.max(1, Number(u.searchParams.get('limit')) || 50));
        const filter = u.searchParams.get('owner') ? qOwner : undefined; // no owner → every line, with its owner column
        return json(res, { owner: qOwner, identity: caps.readIdentity(qOwner), audit: caps.readAudit(limit, filter) });
      }
      if (rest === 'pending' && m === 'GET') {
        const sid = u.searchParams.get('session') || '';
        return json(res, { pending: [...pendingSetups.values()].filter((e) => !sid || e.sessionId === sid).map(setupCardPayload) });
      }
      // /__api/setup/:id/(skip|report|mode) — id = setup_…
      const idm = /^(setup_[A-Za-z0-9_-]+)\/(skip|report|mode|start)$/.exec(rest);
      if (idm && m === 'POST') {
        if (!mayAct) return json(res, { error: 'admin only' }, 403);
        const e = pendingSetups.get(idm[1]);
        if (!e) return notFound(res, `no pending setup: ${idm[1]}`);
        const body = (await readBody(req)) as any;
        if (idm[2] === 'skip') {
          finishSetup(e, 'skipped', { detail: body?.note ? String(body.note).slice(0, 200) : 'skipped by the human', human: true });
          return json(res, { ok: true, id: e.id, state: 'skipped' });
        }
        if (idm[2] === 'mode') {
          const mode = body?.mode === 'auto' ? 'auto' : body?.mode === 'ask' ? 'ask' : 'manual';
          const out = setSetupMode(e.id, mode);
          return out ? json(res, { ok: true, ...setupCardPayload(out) }) : notFound(res, 'no pending setup');
        }
        if (idm[2] === 'start') {
          // Consent click: the only path that turns a card auto and releases the agent.
          if (body?.mode && body.mode !== 'auto') return badRequest(res, 'start is for mode:"auto" — manual connections POST the payload to /__api/setup/:capability');
          const out = startSetupAuto(e.id);
          if (!out) return notFound(res, 'no pending setup');
          if ('error' in out) return json(res, { ok: false, error: out.error, ...setupCardPayload(e) }, 400);
          return json(res, { ok: true, ...setupCardPayload(out) });
        }
        // report: same body as report_setup, for the card / skills that know the id.
        return await handleSetupReport(res, { ...body, session_id: e.sessionId, id: e.id, capability: e.capability });
      }
      // POST /__api/setup/:capability — manual payload → existing implementation.
      if (m === 'POST' && rest && !rest.includes('/')) {
        if (!mayAct) return json(res, { error: 'admin only' }, 403);
        const capability = decodeURIComponent(rest);
        const body = (await readBody(req)) as any;
        // A2: the SetupCard of an agent session saves to the AGENT (body.owner /
        // the session principal / body.sessionId); Settings passes owner explicitly.
        const owner = ownerOfRequest(body?.owner ?? u.searchParams.get('owner'), me?.kind === 'session' ? me : body?.sessionId && state.getSession(String(body.sessionId)) ? ({ kind: 'session', sessionId: String(body.sessionId), user: null } as any) : me, capability);
        if (!owner) return badRequest(res, `invalid owner: ${body?.owner} — "global" or "agent:<slug>"`);
        const sProbes: Partial<caps.CapabilityProbes> = capability.startsWith('mcp:') ? { engine: () => setupEngine(body, req) } : {};
        const cap = caps.getCapability(capability, sProbes, owner);
        if (!cap) return badRequest(res, `unknown capability: ${capability}`);
        try {
          const out = await applyManualSetup(capability, body, req, owner);
          const status = await caps.statusOf(cap, sProbes, owner);
          let closed = 0;
          if (status.ok) {
            closed = resolveSetupsFor(capability, status.detail, true, owner);
            if (!closed) caps.appendAudit({ sessionId: me?.kind === 'session' ? me.sessionId : null, capability, mode: 'manual', result: 'done', evidence: null, human: true, detail: status.detail, owner });
            import('./funnel.js').then((f) => { if (!closed) f.emit('setup.completed', { capability, mode: 'manual' }); }).catch(() => {});
          }
          if (status.ok) {
            broadcast({ type: 'setup.changed', capability, owner });
            if (capability.startsWith('composio:')) caps.pruneComposioOrphans(capability.slice(9), { owner }).catch(() => {});
          }
          return json(res, { ...out, capability, status, closed });
        } catch (e) {
          return json(res, { ok: false, error: (e as Error).message, capability }, 400);
        }
      }
      return notFound(res);
    }
    // ---- host lifecycle (B4-lite: server/host-control.ts, server/version.ts) ----
    // Mutations need `X-Arigami-Confirm: yes` (no cross-site form/fetch can send
    // it without CORS, and a careless curl can't trip it). When the caller is a
    // session (MCP passes X-Arigami-Session) only masters/controllers may act.
    // TODO(C1): replace both checks with the admin role on the session cookie.
    // ---- D3 telemetry (server/telemetry.ts): status + "show what would be sent",
    // toggle (admin), rotate the anonymous id (admin). Nothing here sends.
    if (p === '/__api/telemetry' && m === 'GET') {
      const tm = await import('./telemetry.js');
      return json(res, await tm.status());
    }
    if (p === '/__api/telemetry' && m === 'POST') {
      const me = (req as any).auth as import('./auth.js').Principal | null;
      if (!auth.isAdmin(me)) return json(res, { error: 'admin only' }, 403);
      const tm = await import('./telemetry.js');
      const body = (await readBody(req)) as any;
      if (typeof body?.enabled !== 'boolean') return badRequest(res, 'enabled must be a boolean');
      tm.setEnabled(body.enabled);
      try { (await import('./onboarding.js')).wizardAct('telemetry', 'complete'); } catch { /* wizard may not care */ }
      return json(res, await tm.status());
    }
    if (p === '/__api/telemetry/rotate' && m === 'POST') {
      const me = (req as any).auth as import('./auth.js').Principal | null;
      if (!auth.isAdmin(me)) return json(res, { error: 'admin only' }, 403);
      const tm = await import('./telemetry.js');
      tm.forget();
      return json(res, await tm.status());
    }
    if (p === '/__api/version' && m === 'GET') {
      const v = await import('./version.js');
      return json(res, await v.getVersion({ refresh: u.searchParams.get('refresh') === '1' }));
    }
    // What this machine is doing, and which session is doing it. Public to any
    // signed-in caller (and to agents through the host_resources tool) because
    // the whole point is that a session can ask before it starts something
    // expensive — see server/lib/resources.ts.
    // "My browser": the owner's own profile, where they sign in once. Opening it
    // and listing it are a person's actions, never a session's.
    if (p === '/__api/browser/vault' && m === 'GET') {
      const me = (req as any).auth as import('./auth.js').Principal | null;
      if (!auth.isAdmin(me)) return json(res, { error: 'admin only' }, 403);
      const lv = await import('./lib/login-vault.js');
      return json(res, { open: lv.isVisibleOpen(), logins: lv.list(), grants: Object.keys(lv.grants()) });
    }
    if (p === '/__api/browser/vault/open' && m === 'POST') {
      const me = (req as any).auth as import('./auth.js').Principal | null;
      if (!auth.isAdmin(me)) return json(res, { error: 'admin only' }, 403);
      const body = (await readBody(req).catch(() => ({}))) as any;
      const lv = await import('./lib/login-vault.js');
      // Linux: on the shared desktop the cockpit's global screen view shows.
      // Elsewhere: a normal window on this machine's own screen.
      const display = process.platform === 'linux' ? cfg.screen?.display || ':99' : null;
      const env = display ? { ...process.env, DISPLAY: display } : process.env;
      try {
        const r = await lv.openVisible(env, body?.url ? String(body.url) : undefined);
        return json(res, { ok: true, ...r, display });
      } catch (e) {
        return json(res, { ok: false, error: (e as Error).message }, 503);
      }
    }
    // Copy/paste for the shared screen ("my browser"): the same two halves as a
    // session's desktop/type + desktop/selection, aimed at the vault Chrome.
    if ((p === '/__api/desktop/type' || p === '/__api/desktop/selection') && m === 'POST') {
      const me = (req as any).auth as import('./auth.js').Principal | null;
      if (!auth.isAdmin(me)) return json(res, { error: 'admin only' }, 403);
      const dc = await import('./lib/desktop-clipboard.js');
      const body = (await readBody(req).catch(() => ({}))) as any;
      try {
        if (p === '/__api/desktop/selection') return json(res, { ok: true, text: await dc.selectionAt(dc.portFor(null)) });
        await dc.insertAt(dc.portFor(null), String(body?.text || ''));
        return json(res, { ok: true });
      } catch (e) {
        return json(res, { ok: false, error: (e as Error).message }, 409);
      }
    }
    if (p === '/__api/host/kept-worktrees' && m === 'GET') {
      return json(res, reap.keptWorktrees());
    }
    if (p === '/__api/host/sweep' && m === 'POST') {
      return json(res, await reap.sweep());
    }
    if (p === '/__api/host/resources' && m === 'GET') {
      const r = await import('./lib/resources.js');
      const top = Number(new URL(req.url || '/', 'http://localhost').searchParams.get('top'));
      return json(res, r.sample({ topProcesses: Number.isFinite(top) && top > 0 ? Math.min(top, 100) : 12 }));
    }
    if (p === '/__api/host/status' && m === 'GET') {
      const hc = await import('./host-control.js');
      return json(res, await hc.hostStatus());
    }
    // UPD1: the `claude` CLI updater — installed/latest/lastUpdate (lib/claude-update.js).
    if (p === '/__api/host/claude' && m === 'GET') {
      const cu = await (await import('./lib/claude-update.js')).claudeUpdater();
      return json(res, cu.status());
    }
    // P1-10: the `codex` CLI row — same shape, never auto-applied.
    if (p === '/__api/host/codex' && m === 'GET') {
      const cx = await import('./lib/codex-update.js');
      const st = (await cx.codexUpdater()).status();
      const sandbox = (await import('./lib/codex-sandbox.js')).readCodexSandbox(); // P4-6
      return json(res, { ...(st.installed ? st : { ...st, installed: await cx.codexInstalled() }), sandbox });
    }
    // The self-update watcher's view: what it last saw upstream, which channel
    // this install updates through, and whether it is allowed to apply it
    // (lib/self-update.ts). Read-only — applying still goes through
    // POST /__api/host/upgrade, with its confirm header and admin check.
    if (p === '/__api/host/self-update' && m === 'GET') {
      const su = await (await import('./lib/self-update.js')).selfUpdater();
      return json(res, u.searchParams.get('check') === '1' ? await su.check() : su.status());
    }
    // ---- B4-full: export / import (server/backup.ts). Admin only; GET export
    // is a plain download (cookie or API token) so `curl -OJ` works too.
    if (p === '/__api/host/export' && m === 'GET') {
      if (!auth.isAdmin((req as any).auth)) return json(res, { error: 'admin only' }, 403);
      return await handleHostExport(req, res, {
        mode: u.searchParams.get('mode') || 'full',
        include: (u.searchParams.get('include') || '').split(',').filter(Boolean),
        memory: !['0', 'false', 'no'].includes(String(u.searchParams.get('memory') || '')),
        name: u.searchParams.get('name') || undefined,
        whatsapp: ['1', 'true', 'yes'].includes(String(u.searchParams.get('whatsapp') || '')),
      });
    }
    if (p.startsWith('/__api/host/') && (m === 'POST' || m === 'DELETE')) {
      const hc = await import('./host-control.js');
      if (String(req.headers['x-arigami-confirm'] || '').toLowerCase() !== 'yes')
        return json(res, { error: 'missing X-Arigami-Confirm: yes header' }, 428);
      const callerId = String(req.headers['x-arigami-session'] || '');
      if (callerId) {
        const caller = state.getSession(callerId);
        const isMaster = !!caller && (
          caller.metadata?.role === 'controller' ||
          caller.metadata?.kind === 'controller' ||
          state.listSessions({ archived: true }).some((s) => s.metadata?.master === callerId)
        );
        if (!isMaster) return json(res, { error: 'host control is limited to master/controller sessions' }, 403);
      }
      const sub = p.slice('/__api/host/'.length);
      if ((sub === 'export' || sub === 'import') && m === 'POST') {
        // binary bodies / streamed responses — never through readBody
        if (!auth.isAdmin((req as any).auth)) return json(res, { error: 'admin only' }, 403);
        if (sub === 'export') {
          const body: Record<string, unknown> = String(req.headers['content-type'] || '').includes('json') ? await readBody(req).catch(() => ({})) : {};
          return await handleHostExport(req, res, {
            mode: String(body.mode || u.searchParams.get('mode') || 'full'),
            include: Array.isArray(body.include) ? body.include.map(String) : [],
            memory: body.memory !== false && !['0', 'false', 'no'].includes(String(u.searchParams.get('memory') || '')),
            name: typeof body.name === 'string' ? body.name : u.searchParams.get('name') || undefined,
            whatsapp: body.whatsapp === true || ['1', 'true', 'yes'].includes(String(u.searchParams.get('whatsapp') || '')),
          });
        }
        return await handleHostImport(req, res, u, hc);
      }
      const body: Record<string, unknown> = m === 'POST' ? await readBody(req).catch(() => ({})) : {};
      const when: 'now' | 'idle' =
        u.searchParams.get('when') === 'idle' || body.whenIdle === true || body.when === 'idle' ? 'idle' : 'now';
      try {
        if (sub === 'restart' && m === 'POST') {
          const r = hc.restarts.request(when, callerId ? `session ${callerId}` : 'cockpit');
          return json(res, { ok: true, ...r, status: await hc.hostStatus() });
        }
        if (sub === 'restart' && m === 'DELETE') {
          return json(res, { ok: true, cancelled: hc.restarts.cancel(), status: await hc.hostStatus() });
        }
        if (sub === 'upgrade' && m === 'POST') {
          // dispatch/update-backend: the plan comes from the active channel's
          // backend now (git/docker/packaged) instead of always assuming git —
          // startUpgrade()'s `plan` param is the seam this uses. On the git
          // channel (every host this runs on today) backend.plan() is exactly
          // upgradePlan(root), so this is byte-identical to before.
          const { pickBackend } = await import('./lib/update-backend.js');
          const backend = pickBackend();
          const plan = backend.plan();
          if (!plan) {
            const pf = await backend.preflight();
            return json(res, { error: pf.reason || `upgrade not available on the ${backend.channel} channel`, channel: backend.channel }, 501);
          }
          // VER1: the cockpit sends when=confirm — pull/install/build, then a restart card; the
          // CLI/orchestrators may still ask for now|idle and get the old one-shot behaviour.
          const upgWhen: 'now' | 'idle' | 'confirm' =
            u.searchParams.get('when') === 'confirm' || body.when === 'confirm' ? 'confirm' : when;
          const job = await hc.startUpgrade(upgWhen, undefined, plan);
          return json(res, { ok: true, jobId: job.id, when: upgWhen, status: await hc.hostStatus() });
        }
        // UPD1: claude/check (re-probe now) · claude/update (run `claude update`,
        // deferred under memory pressure) · claude/auto {enabled} (the policy toggle).
        if ((sub.startsWith('claude/') || sub.startsWith('codex/')) && m === 'POST') {
          const cu = sub.startsWith('codex/') ? await (await import('./lib/codex-update.js')).codexUpdater() : await (await import('./lib/claude-update.js')).claudeUpdater();
          if (sub === 'claude/check' || sub === 'codex/check') return json(res, await cu.check({ force: true }));
          if (sub === 'claude/update' || sub === 'codex/update') {
            await cu.check({ force: true });
            const r = await cu.apply({ reason: 'manual' });
            if (r.deferred) return json(res, { ...r, error: `deferred: ${r.availableMb}MB available < ${r.minFreeMb}MB (memory pressure)`, status: cu.status() }, 409);
            return json(res, { ...r, status: cu.status() });
          }
          if (sub === 'claude/auto') {
            if (typeof body.enabled !== 'boolean') return badRequest(res, 'enabled must be a boolean');
            const { updateHostConfig } = await import('./lib/config.js');
            updateHostConfig({ claudeAutoUpdate: body.enabled });
            return json(res, cu.status());
          }
        }
      } catch (e) {
        const err = e as Error & { status?: number; dirty?: string[] };
        // VER1: a dirty-checkout refusal carries the file list so the card can say WHAT is dirty
        return json(res, { error: err.message, manager: hc.detectManager(), ...(err.dirty ? { dirty: err.dirty } : {}) }, err.status || 500);
      }
      return notFound(res);
    }
    if (p === '/__api/config' && m === 'GET') {
      // Anonymous callers (login screen, bin/host health) get the minimum the
      // Login screen needs — never the full config.
      //
      // `instanceId` echoes ARIGAMI_INSTANCE_ID when a launcher set it (the
      // desktop shell does). It lets that launcher tell "my own sidecar
      // answered" apart from "something answered on the port I picked", which
      // is otherwise indistinguishable and would let the window attach to an
      // unrelated host. Not a credential and never accepted as one: it is only
      // ever compared by the process that generated it, so exposing it on this
      // deliberately-public route gives an attacker nothing. Absent unless the
      // env var is set, so a plain `bin/host start` answers as before.
      if (!(req as any).auth)
        return json(res, {
          version: VERSION,
          ...(process.env.ARIGAMI_INSTANCE_ID ? { instanceId: process.env.ARIGAMI_INSTANCE_ID } : {}),
          ...auth.publicInfo(),
        });
      const { groqApiKey, composioApiKey, screen, auth: authCfg, ...pub } = cfg as any;
      const { vncPassword, ...screenPub } = screen || {};
      const { clientSecret, ...oidcPub } = authCfg?.oidc || {};
      return json(res, {
        ...pub,
        version: VERSION,
        auth: { ...authCfg, oidc: authCfg?.oidc ? oidcPub : undefined },
        ...auth.publicInfo(),
        screen: { ...screenPub, hasVncPassword: !!vncPassword },
        voiceEnabled: !!(groqApiKey || process.env.GROQ_API_KEY),
      });
    }
    // Host default engine (Settings › Host): {engine} → {defaultEngine}; unknown → claude.
    if (p === '/__api/config/default-engine' && m === 'POST') {
      if (!auth.isAdmin((req as any).auth)) return json(res, { error: 'admin only' }, 403);
      const body = (await readBody(req)) as any;
      return json(res, { defaultEngine: updateDefaultEngine(body?.engine) });
    }
    // ---- Auth (C1) ------------------------------------------------------------
    if (p.startsWith('/__api/auth/')) return await handleAuth(req, res, u, p, m || 'GET');
    // ---- Webhooks (C3) — inbound routes are public (auth.ts allowlist) and
    // authenticate themselves in server/webhooks.ts; admin routes below need
    // the admin role; events are readable by any principal (sessions poll).
    if (isInboundWebhookPath(p)) { await webhooks().handle(req, res); return; }
    if (p.startsWith('/__api/webhooks/')) {
      const wh = webhooks();
      const me = (req as any).auth as import('./auth.js').Principal | null;
      if (p === '/__api/webhooks/events' && m === 'GET')
        return json(res, { events: wh.events({ kind: u.searchParams.get('kind') || undefined, since: u.searchParams.get('since') || undefined, limit: Number(u.searchParams.get('limit')) || undefined }) });
      if (!auth.isAdmin(me)) return json(res, { error: 'admin only' }, 403);
      if (p === '/__api/webhooks/config' && m === 'GET') return json(res, wh.configView());
      if (p === '/__api/webhooks/token' && m === 'GET') return json(res, { sms: wh.smsToken() });
      if (p === '/__api/webhooks/token' && m === 'POST') {
        const body = await readBody(req);
        return json(res, { sms: wh.rotateSmsToken(body.days != null ? Number(body.days) : undefined) });
      }
      if (p === '/__api/webhooks/token' && m === 'DELETE') return json(res, { ok: wh.revokeSmsToken() });
      if ((p === '/__api/webhooks/slack/secret' || p === '/__api/webhooks/github/secret') && m === 'PUT') {
        const body = await readBody(req);
        wh.setSecret(p.includes('slack') ? 'slack' : 'github', String(body.secret || ''));
        return json(res, { ok: true });
      }
      if (p === '/__api/webhooks/custom' && m === 'POST') {
        const body = await readBody(req);
        const id = String(body.id || '').trim();
        if (!CUSTOM_ID_RE.test(id)) return badRequest(res, 'invalid id (A-Za-z0-9_.- up to 64)');
        try { return json(res, wh.addCustom(id, body.label ? String(body.label) : undefined)); }
        catch (e) { return badRequest(res, (e as Error).message); }
      }
      const cm = /^\/__api\/webhooks\/custom\/([A-Za-z0-9_.-]{1,64})$/.exec(p);
      if (cm && m === 'DELETE') return json(res, { ok: wh.removeCustom(cm[1]) });
      return notFound(res);
    }
    // ---- Share tokens (K2) — admin: every live link, revoke one / all ----------
    if (p === '/__api/share/tokens' || p.startsWith('/__api/share/')) {
      const me = (req as any).auth as import('./auth.js').Principal | null;
      if (!auth.isAdmin(me)) return json(res, { error: 'admin only' }, 403);
      const st = shareTokens();
      if (p === '/__api/share/tokens' && m === 'GET')
        return json(res, { tokens: st.list(), defaultDays: st.defaultDays, maxDays: st.maxDays, publicUrl: !!cfg.publicUrl });
      const nm = /^\/__api\/share\/tokens\/([A-Za-z0-9_-]+)$/.exec(p);
      if (nm && m === 'DELETE') return json(res, { ok: st.revoke(nm[1]) });
      if (p === '/__api/share/revoke-all' && m === 'POST') return json(res, { ok: true, revoked: st.revokeAll() });
      return notFound(res);
    }
    // ---- Composio integrations -------------------------------------------------
    // OAuth login via Composio CLI session API (no API key required upfront)
    if (p === '/__api/composio/auth/start' && m === 'POST') {
      try {
        const sessionRes = await fetch('https://backend.composio.dev/api/v3.1/cli/create-session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        if (!sessionRes.ok) return json(res, { error: `Composio session error: ${sessionRes.status}` });
        const session = await sessionRes.json() as { id: string; code: string };
        const loginUrl = `https://dashboard.composio.dev/?cliKey=${session.id}`;
        return json(res, { loginUrl, sessionId: session.id });
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        return json(res, { error: err.message });
      }
    }
    if (p === '/__api/composio/auth/status' && m === 'GET') {
      const sessionId = u.searchParams.get('sessionId') || '';
      if (!sessionId) return json(res, { authenticated: false });
      try {
        const pollRes = await fetch(`https://backend.composio.dev/api/v3.1/cli/get-session?id=${encodeURIComponent(sessionId)}`);
        if (!pollRes.ok) return json(res, { authenticated: false });
        const pollData = await pollRes.json() as { api_key?: string | null };
        if (pollData.api_key) {
          // Persist into arigami config + live cfg
          const configPath = (cfg as any).configFile as string;
          let configData: Record<string, unknown> = {};
          try { configData = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch {}
          configData.composioApiKey = pollData.api_key;
          fs.writeFileSync(configPath, JSON.stringify(configData, null, 2) + '\n');
          (cfg as any).composioApiKey = pollData.api_key;
          syncComposioKey(pollData.api_key);
          return json(res, { authenticated: true });
        }
        return json(res, { authenticated: false });
      } catch {
        return json(res, { authenticated: false });
      }
    }
    const COMPOSIO_BASE = 'https://backend.composio.dev';
    const composioKey = (): string => cfg.composioApiKey || process.env.COMPOSIO_API_KEY || '';
    const composioFetch = async (path: string, opts: RequestInit = {}) => {
      const key = composioKey();
      if (!key) throw new Error('COMPOSIO_API_KEY not configured');
      const r = await fetch(`${COMPOSIO_BASE}${path}`, {
        ...opts,
        headers: { 'x-api-key': key, 'Content-Type': 'application/json', ...(opts.headers || {}) },
      });
      const text = await r.text();
      let body: any;
      try { body = JSON.parse(text); } catch { body = { error: text }; }
      if (r.status === 401) throw Object.assign(new Error(body?.error?.message || 'Invalid API key'), { status: 401 });
      if (!r.ok) throw new Error(body?.error?.message || `Composio ${r.status}`);
      return body;
    };
    if (p === '/__api/composio/toolkits' && m === 'GET') {
      try {
        const category = u.searchParams.get('category') || '';
        const qs = `limit=200${category ? `&category=${encodeURIComponent(category)}` : ''}`;
        const [toolkitsRes, connectionsRes] = await Promise.all([
          composioFetch(`/api/v3.1/toolkits?${qs}`),
          composioFetch('/api/v3.1/connected_accounts?limit=200'),
        ]);
        const connectedSlugs = new Set(
          (connectionsRes.items || [])
            .filter((c: any) => c.status === 'ACTIVE')
            .map((c: any) => c.toolkit?.slug).filter(Boolean)
        );
        const toolkits = (toolkitsRes.items || []).map((t: any) => ({
          slug: t.slug,
          name: t.name,
          logo: `https://logos.composio.dev/api/${t.slug}`,
          description: t.description,
          categories: t.categories || [],
          connected: connectedSlugs.has(t.slug),
        }));
        return json(res, { toolkits, hasKey: !!composioKey() });
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        const isAuthError = (err as any).status === 401;
        return json(res, { error: err.message, hasKey: isAuthError ? false : !!composioKey() }, 200);
      }
    }
    if (p === '/__api/composio/connections' && m === 'GET') {
      try {
        const data = await composioFetch('/api/v3.1/connected_accounts?limit=200');
        return json(res, { connections: data.items || [] });
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        return json(res, { error: err.message }, 200);
      }
    }
    if (p === '/__api/composio/connect' && m === 'POST') {
      try {
        const body = await readBody(req);
        const { toolkitSlug } = body as any;
        if (!toolkitSlug) return badRequest(res, 'toolkitSlug required');
        // Step 1: create (or reuse) a Composio-managed auth config for this toolkit
        const authConfigRes = await composioFetch('/api/v3.1/auth_configs', {
          method: 'POST',
          body: JSON.stringify({ toolkit: { slug: toolkitSlug }, type: 'use_composio_managed_auth' }),
        });
        const authConfigId = authConfigRes?.auth_config?.id;
        if (!authConfigId) throw new Error('Failed to get auth config id from Composio');
        // Step 2: get an OAuth redirect link (v3 endpoint for managed auth)
        const key = composioKey();
        const linkRes = await fetch(`${COMPOSIO_BASE}/api/v3/connected_accounts/link`, {
          method: 'POST',
          headers: { 'x-api-key': key, 'Content-Type': 'application/json' },
          body: JSON.stringify({ auth_config_id: authConfigId, user_id: 'default', redirect_url: `${COMPOSIO_BASE}` }),
        });
        const linkData = await linkRes.json() as any;
        if (!linkRes.ok) throw new Error(linkData?.error?.message || `Composio ${linkRes.status}`);
        return json(res, { redirectUrl: linkData.redirect_url, id: linkData.connected_account_id });
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        return json(res, { error: err.message }, 200);
      }
    }
    if (p.startsWith('/__api/composio/connections/') && m === 'DELETE') {
      const connId = p.split('/')[4];
      if (!connId) return badRequest(res, 'connection id required');
      try {
        await composioFetch(`/api/v3.1/connected_accounts/${connId}`, { method: 'DELETE' });
        return json(res, { ok: true });
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        return json(res, { error: err.message }, 200);
      }
    }
    // Global (not per-session) screen-share availability — the sidebar icon
    // hides itself when this is false instead of showing a broken button.
    // ---- SMS inbound webhook — LEGACY (pre-C3), unauthenticated for one more
    // release. server/webhooks.ts answers it with a Deprecation header and a
    // rate-limited log warning; the authenticated form is /__api/webhooks/sms.
    if (p === '/__api/sms/inbound' || p.startsWith('/__api/sms/inbound/')) {
      if (await webhooks().handleLegacySms(req, res)) return;
    }

    // ---- Push notifications (PWA) -------------------------------------------
    if (p === '/__api/push/vapid-public-key' && m === 'GET') {
      const push = await import('./push.js');
      return json(res, { publicKey: push.getVapidPublicKey() });
    }
    if (p === '/__api/push/subscribe' && m === 'POST') {
      const push = await import('./push.js');
      const body = (await readBody(req)) as any;
      if (!body?.endpoint) return badRequest(res, 'missing subscription');
      push.addSubscription(body);
      return json(res, { ok: true });
    }
    if (p === '/__api/push/unsubscribe' && m === 'POST') {
      const push = await import('./push.js');
      const body = (await readBody(req)) as any;
      push.removeSubscription(body?.endpoint || '');
      return json(res, { ok: true });
    }

    if (p === '/__api/screen/status' && m === 'GET') {
      // Global (no ?session=) or a session's own machine, if it has one —
      // whichever the sidebar icon / side panel is asking about. `own` (T8c)
      // tells the caller whether `available`/`display` describe THIS session's
      // own desktop or the shared fallback — the machine side panel must never
      // render the fallback as if it were the session's, see ScreenSidePanel.jsx.
      //
      // `driver`/`viewer` (windows-remote-parity): which transport this host's
      // screen actually speaks. The cockpit used to assume RFB unconditionally
      // and open /__vnc for everyone — which on any non-x11 host (the desktop
      // app on Windows or macOS) connects to a VNC server that is not there
      // and leaves the human staring at a black "disconnected" box. The client
      // now picks its transport from this, so adding a third one later (a real
      // VNC service ON the Windows box) is a driver change, not a client one.
      const sessionId = u.searchParams.get('session') || undefined;
      const driver = pickDriver();
      const st = await driver.status(sessionId);
      const viewer = await driver.viewer(sessionId).catch(() => null);
      return json(res, {
        available: st.available,
        driver: driver.id,
        ...(viewer ? { viewer } : {}),
        ...(st.perSession != null ? { perSession: st.perSession } : {}),
        ...(sessionId ? { display: st.display, own: st.own } : {}),
      });
    }
    // Settings → screen: the VNC-auth password. Never echoed back — the UI
    // only learns whether one is set. Empty string clears it.
    if (p === '/__api/screen/settings' && m === 'GET') {
      return json(res, { hasVncPassword: !!cfg.screen?.vncPassword });
    }
    if (p === '/__api/screen/settings' && m === 'PUT') {
      const body = (await readBody(req)) as { vncPassword?: unknown };
      if (body.vncPassword != null && typeof body.vncPassword !== 'string')
        return badRequest(res, 'vncPassword must be a string');
      const next = updateScreenConfig({ vncPassword: (body.vncPassword as string) || '' });
      return json(res, { ok: true, hasVncPassword: !!next.vncPassword });
    }
    // noVNC authenticates client-side (RFB VNC-auth), so the password has to
    // reach the browser. Same trust boundary as /__vnc itself: anyone who can
    // reach this endpoint can already open the bridge.
    if (p === '/__api/screen/credentials' && m === 'GET') {
      return json(res, { password: cfg.screen?.vncPassword || '' });
    }
    // ---- Onboarding & workspace provisioning (see docs/ONBOARDING.md) ----
    if (p === '/__api/onboarding/status' && m === 'GET') {
      const ob = await import('./onboarding.js');
      return json(res, ob.status());
    }
    // ---- B3 wizard (one state machine: wizard UI = bin/host doctor = funnel) ----
    if (p === '/__api/onboarding/wizard' && m === 'GET') {
      const ob = await import('./onboarding.js');
      const gl = await import('./git-login.js');
      const view = ob.wizard();
      return json(res, { ...view, ghLogin: gl.ghLoginStatus() });
    }
    if (p === '/__api/onboarding/wizard/mode' && m === 'POST') {
      const me = (req as any).auth as import('./auth.js').Principal | null;
      if (!auth.isAdmin(me)) return json(res, { error: 'admin only' }, 403);
      const ob = await import('./onboarding.js');
      const body = (await readBody(req)) as any;
      try {
        return json(res, ob.setOnboardingMode(body?.mode === 'full' ? 'full' : 'minimal'));
      } catch (e) {
        return badRequest(res, (e as Error).message);
      }
    }
    if (p === '/__api/onboarding/wizard/reset' && m === 'POST') {
      const me = (req as any).auth as import('./auth.js').Principal | null;
      if (!auth.isAdmin(me)) return json(res, { error: 'admin only' }, 403);
      const ob = await import('./onboarding.js');
      return json(res, ob.wizardReset());
    }
    if (p === '/__api/onboarding/health' && m === 'POST') {
      const me = (req as any).auth as import('./auth.js').Principal | null;
      if (!auth.isAdmin(me)) return json(res, { error: 'admin only' }, 403);
      const ob = await import('./onboarding.js');
      try {
        const health = await ob.runHealth();
        return json(res, { health, wizard: ob.wizard() });
      } catch (e) {
        return badRequest(res, (e as Error).message);
      }
    }
    if (p.startsWith('/__api/onboarding/wizard/') && m === 'POST') {
      const me = (req as any).auth as import('./auth.js').Principal | null;
      if (!auth.isAdmin(me)) return json(res, { error: 'admin only' }, 403);
      const ob = await import('./onboarding.js');
      const step = decodeURIComponent(p.slice('/__api/onboarding/wizard/'.length));
      const body = (await readBody(req)) as any;
      const action = String(body?.action || '');
      try {
        // Generic decisions.
        if (action === 'complete' || action === 'skip' || action === 'reset')
          return json(res, ob.wizardAct(step, action));
        // Step-specific fixers. Secrets are consumed here and never echoed.
        if (step === 'claude' && action === 'token') {
          const r = await ob.setClaudeToken(String(body?.token || ''), body?.label ? String(body.label) : undefined);
          return json(res, { ...r, wizard: ob.wizard() });
        }
        if (step === 'git' && action === 'token') {
          const r = ob.setGitToken(String(body?.token || ''), body?.host ? String(body.host) : undefined);
          return json(res, { ok: r.ok, wizard: ob.wizard() });
        }
        if (step === 'git' && action === 'gh-login') {
          const gl = await import('./git-login.js');
          return json(res, { ghLogin: gl.startGhLogin(), wizard: ob.wizard() });
        }
        if (step === 'git' && action === 'gh-cancel') {
          const gl = await import('./git-login.js');
          return json(res, { ghLogin: gl.cancelGhLogin(), wizard: ob.wizard() });
        }
        if (step === 'integrations' && action === 'composio-key') {
          ob.setComposioKey(String(body?.key || ''));
          return json(res, { ok: true, wizard: ob.wizard() });
        }
        if (step === 'telemetry' && (action === 'enable' || action === 'disable')) {
          const tm = await import('./telemetry.js');
          const r = tm.setEnabled(action === 'enable');
          return json(res, { telemetry: r, wizard: ob.wizardAct('telemetry', 'complete') });
        }
        if (step === 'health' && action === 'run') {
          const health = await ob.runHealth();
          return json(res, { health, wizard: ob.wizard() });
        }
        return badRequest(res, `unknown action ${JSON.stringify(action)} for step ${step}`);
      } catch (e) {
        return badRequest(res, (e as Error).message);
      }
    }
    if (p === '/__api/onboarding/repos' && m === 'GET') {
      const ob = await import('./onboarding.js');
      return json(res, ob.listRepos().map((r) => ob.resolveRepo(r)));
    }
    if (p === '/__api/onboarding/repos' && m === 'POST') {
      const ob = await import('./onboarding.js');
      const body = (await readBody(req)) as any;
      if (!body.name || !body.source) return badRequest(res, 'name and source required');
      try {
        return json(res, ob.addRepo(body), 201);
      } catch (e) {
        return badRequest(res, (e as Error).message);
      }
    }
    // Probe a local folder the user typed into the "From local folder" picker:
    // exists? git? toolchain? which env files are copyable. Native-only (the
    // engine must be able to read the path — no-op inside a container).
    if (p === '/__api/onboarding/detect-local' && m === 'POST') {
      const ob = await import('./onboarding.js');
      const body = (await readBody(req)) as any;
      if (!body.path) return badRequest(res, 'path required');
      return json(res, ob.detectLocalSource(String(body.path)));
    }
    // ---- EXT extensions (server/extensions.ts) --------------------------------
    // Listing is readable by any signed-in principal (the cockpit shows it, and a
    // session may want to know what is installed); everything that INSTALLS,
    // enables or runs code is admin-only — the same gate as /__api/profiles.
    if (p === '/__api/extensions' && m === 'GET') {
      const ext = await import('./extensions.js');
      if (!ext.isLoaded()) await ext.reload({ reason: 'first GET' });
      return json(res, { extensions: ext.listExtensions(), apiVersion: ext.EXT_API_VERSION, dir: ext.EXT_DIR });
    }
    if (p === '/__api/listener-types' && m === 'GET') {
      const reg = await import('./listeners-registry.js');
      return json(res, { types: reg.listTypes() });
    }
    if (p.startsWith('/__api/extensions')) {
      const me = (req as any).auth as import('./auth.js').Principal | null;
      if (!auth.isAdmin(me)) return json(res, { error: 'admin only' }, 403);
      const ext = await import('./extensions.js');
      if (p === '/__api/extensions/reload' && m === 'POST') {
        const r = await ext.reload({ reason: 'REST' });
        return json(res, { ok: true, ...r });
      }
      if (p === '/__api/extensions/validate' && m === 'POST') {
        const body = (await readBody(req)) as { source?: unknown };
        const source = String(body.source || '').trim();
        if (!source) return badRequest(res, 'source required (an extension directory)');
        const dir = path.resolve(untildify(source) || source);
        return json(res, await ext.validateExtension(dir));
      }
      if (p === '/__api/extensions/add' && m === 'POST') {
        const body = (await readBody(req)) as { source?: unknown; trust?: unknown };
        const source = String(body.source || '').trim();
        if (!source) return badRequest(res, 'source required (a directory or a git URL)');
        // The caller SHOWS manifest.permissions to the human — extension code
        // runs with host privileges, so an install is a decision, not a detail.
        // `trust:true` is the second, separate decision (the TRUSTED tier: a tab
        // served without the sandbox, with the cockpit's own session); the
        // caller must have named that consequence before sending it.
        const r = await ext.addExtension(source, { trust: body.trust === true });
        return json(res, r, r.ok ? 200 : 400);
      }
      const em = /^\/__api\/extensions\/([a-z0-9][a-z0-9-]*)(?:\/(update))?$/.exec(p);
      if (em) {
        const name = em[1];
        if (em[2] === 'update' && m === 'POST') {
          const r = await ext.updateExtension(name);
          return json(res, r, r.ok ? 200 : 400);
        }
        if (m === 'PATCH') {
          const body = (await readBody(req)) as any;
          const r = await ext.patchExtension(name, {
            enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
            settings: body.settings && typeof body.settings === 'object' ? body.settings : undefined,
            secrets: body.secrets && typeof body.secrets === 'object' ? body.secrets : undefined,
            // EXT: grant/revoke the TRUSTED tier. Admin-only like the rest of
            // this block; the loader still ignores it unless the manifest asks.
            trusted: typeof body.trusted === 'boolean' ? body.trusted : undefined,
          });
          return 'error' in r ? badRequest(res, String(r.error)) : json(res, r);
        }
        if (m === 'DELETE') {
          const r = await ext.removeExtension(name);
          return json(res, r, r.ok ? 200 : 404);
        }
      }
      return notFound(res);
    }
    // One tool call into an extension's own MCP server, for the browser SDK's
    // runTool(). The manifest must declare `tools:<tool>` — a tab may only reach
    // what its author asked for in writing.
    const extTool = /^\/__api\/ext\/([a-z0-9][a-z0-9-]*)\/tool\/([A-Za-z0-9_-]{1,64})$/.exec(p);
    if (extTool && m === 'POST') {
      const [, extName, toolName] = extTool;
      const ext = await import('./extensions.js');
      if (!ext.toolPermitted(extName, toolName))
        return json(res, { error: `extension "${extName}" does not declare permission tools:${toolName}` }, 403);
      // This route runs a tool with the HOST's authority, so a session must not
      // be able to reach a sender through it and skip the owner's approval.
      if (((req as any).auth as any)?.kind === 'session') {
        const ob = await import('./lib/outbound.js');
        const declared = ((ext.getExtension(extName)?.manifest as any)?.outbound || []) as string[];
        if (ob.isOutbound(toolName, declared))
          return json(res, { error: `${toolName} sends to a person — call it as a tool; the owner approves the exact message first` }, 403);
      }
      const body = (await readBody(req)) as any;
      const r = await ext.callExtTool(extName, toolName, body?.args && typeof body.args === 'object' ? body.args : {});
      return json(res, r, r.ok ? 200 : 400);
    }
    // ---- K3 profile bundles (server/profiles.ts) ------------------------------
    // Listing/current are readable by any signed-in principal; apply/validate
    // mutate skills/memory/triggers/repos.json and are admin-only (C1).
    if (p === '/__api/profiles' && m === 'GET') {
      const pf = await import('./profiles.js');
      return json(res, { bundles: pf.listBundles(), pending: pf.getPending() });
    }
    if (p === '/__api/profiles/current' && m === 'GET') {
      const pf = await import('./profiles.js');
      return json(res, { current: pf.readProvenance(), pending: pf.getPending() });
    }
    if ((p === '/__api/profiles/apply' || p === '/__api/profiles/validate') && m === 'POST') {
      const me = (req as any).auth as import('./auth.js').Principal | null;
      if (!auth.isAdmin(me)) return json(res, { error: 'admin only' }, 403);
      const pf = await import('./profiles.js');
      const body = (await readBody(req)) as { source?: unknown };
      const source = String(body.source || '').trim();
      if (!source) return badRequest(res, 'source required (bundle name, directory, git URL, or "pending")');
      try {
        if (p === '/__api/profiles/validate') {
          const r = pf.resolveSource(source);
          const b = pf.loadBundle(r.dir, r.source);
          return json(res, { ...pf.summarize(b), ...pf.validate(b), readme: b.readme });
        }
        const report = await pf.applySource(source, { sessionId: String(req.headers['x-arigami-session'] || '') || undefined, force: (body as any).force === true });
        return json(res, { ok: report.errors.length === 0, report });
      } catch (e) {
        return badRequest(res, (e as Error).message);
      }
    }
    if (p === '/__api/onboarding/profiles' && m === 'GET') {
      const ob = await import('./onboarding.js');
      return json(res, ob.listProfiles());
    }
    if (p.startsWith('/__api/onboarding/profiles/')) {
      const ob = await import('./onboarding.js');
      const rest = p.slice('/__api/onboarding/profiles/'.length);
      const [rawName, action] = rest.split('/');
      if (action === 'apply' && m === 'POST') {
        try {
          const name = decodeURIComponent(rawName);
          // A shipped/installed Profile Bundle of that name gets the full apply
          // (repos + skills + memory seed + cron); a thin <name>.json only seeds repos.
          const pf = await import('./profiles.js');
          let bundle: string | null = null;
          try {
            bundle = pf.resolveSource(name).dir;
          } catch {
            /* not a bundle */
          }
          if (bundle) {
            const report = await pf.applySource(name, { sessionId: String(req.headers['x-arigami-session'] || '') || undefined });
            return json(res, { applied: report.name, repos: report.repos, report });
          }
          return json(res, ob.applyProfile(name));
        } catch (e) {
          return badRequest(res, (e as Error).message);
        }
      }
      return notFound(res);
    }
    if (p.startsWith('/__api/onboarding/repos/')) {
      const ob = await import('./onboarding.js');
      const rest = p.slice('/__api/onboarding/repos/'.length);
      const [rawName, action] = rest.split('/');
      const name = decodeURIComponent(rawName);
      try {
        if (!action && m === 'PATCH')
          return json(res, ob.saveRepo(name, (await readBody(req)) as any));
        if (!action && m === 'DELETE') return json(res, { ok: ob.removeRepo(name) });
        if (action === 'clone' && m === 'POST') {
          // S1: a remote clone without git credentials asks for `git` instead of failing.
          const entry = ob.listRepos().find((r) => r.name === name);
          const gate = ob.status().steps.find((st) => st.id === 'git-auth');
          if (entry && !/^(\/|~|\.)/.test(entry.source) && !ob.repoPresent(ob.resolveRepo(entry)) && gate && gate.status !== 'ok')
            return json(res, caps.needsSetup('git', `clone ${name}`));
          return json(res, ob.cloneRepo(name));
        }
        if (action === 'env' && m === 'POST') return json(res, ob.resolveEnv(name));
        if (action === 'install' && m === 'POST') return json(res, ob.installDeps(name));
      } catch (e) {
        return badRequest(res, (e as Error).message);
      }
      return notFound(res);
    }
    if (p === '/__api/voice/stt' && m === 'POST') {
      const voice = await import('./voice.js');
      const body = await readBody(req, 32e6);
      try {
        return json(res, await (voice as any).transcribe(body));
      } catch (e) {
        const error = e instanceof Error ? e : new Error(String(e));
        return json(res, { error: error.message }, 502);
      }
    }

    // ---- Triggers + the Pending-tasks queue (see docs/TRIGGERS.md) ----
    if (p === '/__api/triggers' && m === 'GET') {
      const t = await import('./triggers.js');
      return json(
        res,
        t.withNextRun(t.listTriggers())
      );
    }
    if (p === '/__api/triggers' && m === 'POST') {
      const t = await import('./triggers.js');
      const body = (await readBody(req)) as any;
      try {
        if (body.type === 'cron') {
          const trigger = await t.createCronTrigger({
            name: body.name,
            prompt: body.prompt,
            schedule: body.schedule,
            sessionMode: body.sessionMode,
            delivery: body.delivery,
            deliver: body.deliver,
            autonomous: body.autonomous,
            agent: body.agent,
            engine: body.engine,
            folderId: body.folderId,
            folderName: body.folderName,
            createdBySessionId: body.createdBySessionId,
          });
          return json(res, trigger, 201);
        }
        const trigger = await t.createTrigger({
          name: body.name,
          filters: body.filters,
          autonomous: body.autonomous,
          injectPrompt: body.injectPrompt,
          skill: body.skill,
          model: body.model,
          effort: body.effort,
          engine: body.engine,
          folderId: body.folderId,
          folderName: body.folderName,
        });
        return json(res, trigger, 201);
      } catch (e) {
        return badRequest(res, (e as Error).message);
      }
    }
    if (p.startsWith('/__api/triggers/')) {
      const rest = p.slice('/__api/triggers/'.length).split('/');
      const tid = rest[0];
      const t = await import('./triggers.js');
      // POST /__api/triggers/:id/run — fire a cron trigger now (UI "run now" / cronjob action:'run').
      if (rest[1] === 'run' && m === 'POST') {
        const r = await t.runCronNow(tid);
        return r.ok ? json(res, r) : badRequest(res, r.reason || 'run failed');
      }
      if (rest.length > 1) return notFound(res);
      if (m === 'GET') {
        const trigger = t.listTriggers().find((x: any) => x.id === tid);
        if (!trigger) return notFound(res, `no such trigger: ${tid}`);
        const nextRunAt = trigger.type === 'cron' ? t.nextRunFor(trigger) : undefined;
        return json(res, { ...trigger, ...(nextRunAt !== undefined ? { nextRunAt } : {}), log: t.getTriggerLog(tid) });
      }
      if (m === 'PATCH') {
        const body = (await readBody(req)) as any;
        try {
          const updated = t.patchTrigger(tid, body);
          return updated ? json(res, updated) : notFound(res, `no such trigger: ${tid}`);
        } catch (e) {
          return badRequest(res, (e as Error).message);
        }
      }
      if (m === 'DELETE') return json(res, { ok: t.deleteTrigger(tid) });
      return notFound(res);
    }
    if (p === '/__api/pending' && m === 'GET') {
      const t = await import('./triggers.js');
      // RES1 §3: the aggregated "waiting for you" queue rides along here too, so the
      // one endpoint answers "what is waiting for me" in full.
      const sup = await import('./supervisor-loop.js');
      const waiting = await sup.waitingQueue().catch(() => []);
      return json(res, { ...t.snapshot(), waiting });
    }
    if (p === '/__api/pending' && m === 'POST') {
      // Manually defer into the queue — a ticket or an empty (plain) session.
      const t = await import('./triggers.js');
      const body = (await readBody(req)) as any;
      if (body.kind === 'empty') {
        const item = t.deferEmpty({
          title: body.title,
          cwd: body.cwd,
          permissionMode: body.permissionMode,
          prompt: body.prompt,
          skill: body.skill,
          model: body.model,
          effort: body.effort,
          engine: body.engine,
          folderId: body.folderId,
          folderName: body.folderName,
        });
        return json(res, item, 201);
      }
      if (!body.ticket) return badRequest(res, 'ticket or kind:"empty" required');
      const item = t.deferTicket(String(body.ticket), body.title, body.prompt, {
        skill: body.skill,
        model: body.model,
        effort: body.effort,
        engine: body.engine,
        folderId: body.folderId,
        folderName: body.folderName,
      });
      return item ? json(res, item, 201) : badRequest(res, 'already queued or has a live session');
    }
    if (p === '/__api/pending/reorder' && m === 'POST') {
      const t = await import('./triggers.js');
      const body = (await readBody(req)) as any;
      if (!Array.isArray(body.order)) return badRequest(res, 'order[] required');
      return json(res, { ok: t.reorderPending(body.order.map(String)) });
    }
    if (p.startsWith('/__api/pending/')) {
      const rest = p.slice('/__api/pending/'.length);
      const t = await import('./triggers.js');
      if (rest.endsWith('/start') && m === 'POST') {
        const pid = rest.slice(0, -'/start'.length);
        const r = await t.startPending(pid);
        return r ? json(res, r) : notFound(res, `no such pending item: ${pid}`);
      }
      if (m === 'DELETE') return json(res, { ok: t.dismissPending(rest) });
      return notFound(res);
    }
    // ---- RES1 — the supervisor's read surface -------------------------------
    // /health      the per-session health map + the "waiting for you" queue + a 24h
    //              incident tally, plus per-account/model quota with reset times.
    // /health/incidents?hours=  what the supervisor actually did.
    // /waiting     the queue on its own (the rail pill polls/streams this).
    // NB: the aggregated queue does NOT live at /__api/pending — that path is
    // the trigger/ticket queue and predates this. GET /__api/pending carries a
    // `waiting` key too, so the spec's single endpoint still answers.
    if (p === '/__api/health' && m === 'GET') {
      const sup = await import('./supervisor-loop.js');
      const accountsMod = await import('./accounts.js');
      const snap = await sup.healthSnapshot();
      const { accounts } = accountsMod.listAccounts() as any;
      const { cachedUsage } = await import('./usage.js');
      const win = (w: any) => (w && typeof w.pct === 'number' ? { pct: w.pct, resetsAt: w.resetsAt || null, windowMins: w.windowMins || null } : null);
      return json(res, {
        ...snap,
        accounts: accounts.map((a: any) => ({
          ...(() => { const u: any = cachedUsage(a.id); return u?.available ? { usage: { session: win(u.session), week: win(u.week) } } : {}; })(),
          id: a.id,
          label: a.label,
          provider: a.provider,
          pool: a.pool,
          active: a.active,
          available: a.available,
          quarantineUntil: a.quarantineUntil,
          plan: a.plan,
        })),
        modelChain: cfg.modelChain,
        codexModelChain: cfg.codexModelChain,
        supervisor: cfg.supervisor,
      });
    }
    if (p === '/__api/health/incidents' && m === 'GET') {
      const sup = await import('./supervisor-loop.js');
      const hours = Math.min(24 * 30, Math.max(1, Number(u.searchParams.get('hours')) || 24));
      const list = sup.incidents(hours);
      return json(res, { hours, incidents: list.slice(-500).reverse(), count: list.length });
    }
    if (p === '/__api/waiting' && m === 'GET') {
      const sup = await import('./supervisor-loop.js');
      const waiting = await sup.waitingQueue();
      return json(res, { waiting, count: waiting.length });
    }
    if (p === '/__api/queue' && m === 'GET') {
      const t = await import('./triggers.js');
      return json(res, t.snapshot().queue);
    }
    if (p === '/__api/queue' && m === 'PATCH') {
      const t = await import('./triggers.js');
      const body = (await readBody(req)) as any;
      return json(res, t.setQueueSettings(body));
    }
    if (p === '/__api/voice/route' && m === 'POST') {
      const voice = await import('./voice.js');
      try {
        return json(res, await (voice as any).route(await readBody(req)));
      } catch (e) {
        const error = e instanceof Error ? e : new Error(String(e));
        return json(res, { error: error.message }, 502);
      }
    }
    if (p === '/__api/usage' && m === 'GET') {
      const { getUsage } = await import('./usage.js');
      const accountId = u.searchParams.get('accountId') || undefined;
      return json(res, await (getUsage as any)(accountId));
    }
    if (p === '/__api/accounts' && m === 'GET') {
      const acc = await import('./accounts.js');
      return json(res, (acc as any).listAccounts());
    }
    // The providers a human can add an account for (server/lib/providers.ts) —
    // the cockpit renders the "add account" chooser from this, never from a
    // hardcoded list, so a new provider shows up without a web change.
    if (p === '/__api/accounts/providers' && m === 'GET') {
      const pr = await import('./lib/providers.js');
      return json(res, { providers: pr.providerCatalog() });
    }
    // The paste path, per provider: claude = a setup-token / PKCE token,
    // codex = an OpenAI API key (validated against the API before it's stored).
    if (p === '/__api/accounts' && m === 'POST') {
      const acc = await import('./accounts.js');
      const pr = await import('./lib/providers.js');
      const body = (await readBody(req)) as any;
      try {
        const provider = pr.normalizeProvider(body?.provider);
        if (provider === 'codex') {
          const cx = await import('./codex-account.js');
          return json(res, await cx.addApiKeyAccount({ label: body?.label, key: body?.token }));
        }
        return json(res, (acc as any).addTokenAccount({ label: body?.label, token: body?.token }));
      } catch (e) {
        return badRequest(res, e instanceof Error ? e.message : String(e));
      }
    }
    // The browser path, per provider: claude = PKCE (server/oauth-login.js),
    // codex = `codex login` + its loopback callback (server/codex-account.ts).
    // One flow id namespace: `oauth_…` / `cdx_…` / `auth_…` say which module
    // owns it; `login/code` takes the pasted code (claude) or callback URL (codex).
    if (p === '/__api/accounts/login/start' && m === 'POST') {
      const pr = await import('./lib/providers.js');
      const body = (await readBody(req)) as any;
      const provider = pr.normalizeProvider(body?.provider);
      if (provider === 'codex') {
        const cx = await import('./codex-account.js');
        return json(res, cx.startBrowserLogin({ label: body?.label }));
      }
      const o = await import('./oauth-login.js');
      return json(res, { provider: 'claude', ...(o as any).startLogin({ label: body?.label, sessionId: body?.sessionId || (req.headers['x-arigami-session'] as string) || null }) });
    }
    if (p === '/__api/accounts/login/status' && m === 'GET') {
      const id = u.searchParams.get('id') || '';
      if (id.startsWith('cdx_')) return json(res, (await import('./codex-account.js')).loginStatus(id));
      if (id.startsWith('auth_')) return json(res, ((await import('./accounts-auth.js')) as any).authStatus(id));
      return json(res, { provider: 'claude', ...((await import('./oauth-login.js')) as any).loginStatus(id) });
    }
    if (p === '/__api/accounts/login/code' && m === 'POST') {
      const body = (await readBody(req)) as any;
      const id = String(body?.id || '');
      if (id.startsWith('cdx_')) return json(res, await (await import('./codex-account.js')).submitCallback(id, body?.code));
      if (id.startsWith('auth_')) return json(res, ((await import('./accounts-auth.js')) as any).submitCode(id, body?.code));
      return json(res, await ((await import('./oauth-login.js')) as any).submitCode(id, body?.code));
    }
    if (p === '/__api/accounts/login/cancel' && m === 'POST') {
      const body = (await readBody(req)) as any;
      const id = String(body?.id || '');
      if (id.startsWith('cdx_')) return json(res, (await import('./codex-account.js')).cancelLogin(id));
      if (id.startsWith('auth_')) return json(res, ((await import('./accounts-auth.js')) as any).cancelAuth(id));
      return json(res, ((await import('./oauth-login.js')) as any).cancelLogin(id));
    }
    if (p === '/__api/accounts/active' && m === 'POST') {
      const acc = (await import('./accounts.js')) as any;
      const pr = await import('./lib/providers.js');
      const body = (await readBody(req)) as any;
      try {
        const newId = body?.id;
        const provider = pr.normalizeProvider(acc.getAccount(newId)?.provider);
        const oldId = acc.getActiveId(provider);
        const out = acc.setActive(newId);
        // Re-point sessions that FOLLOW the active account onto the new one, so
        // switching accounts actually applies to existing sessions (the common
        // expectation). "Follows active" = unpinned (null), pinned to the old
        // active, or pinned to a since-deleted account. Sessions deliberately on
        // a different, still-existing account (e.g. moved by auto-switch) keep it.
        // Every running session restarts with --resume (conversation kept) —
        // including busy ones, whose in-flight turn is cut: the point of the
        // switch is that the user can prompt on the new account immediately.
        // Not-running sessions just get re-pinned for their next spawn.
        // Only sessions whose ENGINE consumes this provider's accounts follow —
        // a codex login switch must never restart the claude sessions.
        let repointed = 0;
        for (const s of state.listSessions({ archived: true })) {
          if (pr.providerForEngine(s.engine) !== provider) continue;
          const aid = (s.claude as any)?.accountId ?? null;
          if (aid === newId) continue;
          const follows = aid === null || aid === oldId || !acc.getAccount(aid);
          if (!follows) continue;
          if (claude.isRunning(s.id)) claude.setAccount(s.id, newId);
          else {
            // Not running: setAccount's restart path won't run, so invalidate
            // the MCP verdicts here — they were recorded under the old identity
            // and stay unverifiable until the session's next spawn.
            (claude as any).markMcpStale(s.id, 'account switched');
            state.setClaude(s.id, { accountId: newId } as any);
          }
          repointed++;
        }
        // The daemon-level `claude mcp list` caches were taken under the old
        // identity too — drop them so the next panel fetch re-checks for real.
        import('./mcp-auth.js').then((mm: any) => mm.invalidateLists()).catch(() => {});
        // Push the new active account's usage to the header immediately (no poll lag).
        import('./usage.js').then((u: any) => u.refreshAccount(newId)).catch(() => {});
        return json(res, { ...out, repointed });
      } catch (e) {
        return badRequest(res, e instanceof Error ? e.message : String(e));
      }
    }
    if (p === '/__api/accounts/pool' && m === 'POST') {
      const acc = await import('./accounts.js');
      const body = (await readBody(req)) as any;
      try {
        return json(res, (acc as any).setPool(body?.id, !!body?.pool));
      } catch (e) {
        return badRequest(res, e instanceof Error ? e.message : String(e));
      }
    }
    if (p === '/__api/accounts/remove' && m === 'POST') {
      const acc = await import('./accounts.js');
      const body = (await readBody(req)) as any;
      return json(res, { ok: (acc as any).removeAccount(body?.id) });
    }
    if (p === '/__api/accounts/auth/start' && m === 'POST') {
      const auth = await import('./accounts-auth.js');
      const body = (await readBody(req)) as any;
      return json(res, (auth as any).startAuth({ label: body?.label }));
    }
    if (p === '/__api/accounts/auth/status' && m === 'GET') {
      const auth = await import('./accounts-auth.js');
      return json(res, (auth as any).authStatus(u.searchParams.get('id') || ''));
    }
    if (p === '/__api/accounts/auth/code' && m === 'POST') {
      const auth = await import('./accounts-auth.js');
      const body = (await readBody(req)) as any;
      return json(res, (auth as any).submitCode(body?.id, body?.code));
    }
    if (p === '/__api/accounts/auth/cancel' && m === 'POST') {
      const auth = await import('./accounts-auth.js');
      const body = (await readBody(req)) as any;
      return json(res, (auth as any).cancelAuth(body?.id));
    }
    // Self-driven OAuth login (PKCE) — the reliable replacement for setup-token
    // TUI scraping. start → user approves in browser → paste code → exchange.
    if (p === '/__api/accounts/oauth/start' && m === 'POST') {
      const o = await import('./oauth-login.js');
      const body = (await readBody(req)) as any;
      // F8: a session id (body or the MCP caller header) lets the host finish the
      // exchange itself by reading the callback URL from that session's Chrome.
      return json(res, (o as any).startLogin({ label: body?.label, sessionId: body?.sessionId || (req.headers['x-arigami-session'] as string) || null }));
    }
    if (p === '/__api/accounts/oauth/read-browser' && m === 'POST') {
      const o = await import('./oauth-login.js');
      const body = (await readBody(req)) as any;
      return json(res, await (o as any).readCodeFromBrowser(body?.id, body?.sessionId || (req.headers['x-arigami-session'] as string) || null));
    }
    if (p === '/__api/accounts/oauth/status' && m === 'GET') {
      const o = await import('./oauth-login.js');
      return json(res, (o as any).loginStatus(u.searchParams.get('id') || ''));
    }
    if (p === '/__api/accounts/oauth/code' && m === 'POST') {
      const o = await import('./oauth-login.js');
      const body = (await readBody(req)) as any;
      return json(res, await (o as any).submitCode(body?.id, body?.code));
    }
    if (p === '/__api/accounts/oauth/cancel' && m === 'POST') {
      const o = await import('./oauth-login.js');
      const body = (await readBody(req)) as any;
      return json(res, (o as any).cancelLogin(body?.id));
    }
    if (p === '/__api/mcp/servers' && m === 'GET') {
      const mcp = await import('./mcp-auth.js');
      const listed = (await (mcp as any).listServers(u.searchParams.get('force') === '1', u.searchParams.get('cwd') || '')) as any[];
      const { gatewayEnabled } = await import('./lib/mcp-gateway.js');
      if (!gatewayEnabled()) return json(res, listed);
      // The host's own grants replace a CLI entry of the same name (lib/mcp-grants.ts statusOverlay).
      const grants = await import('./lib/mcp-grants.js');
      const overlay = grants.statusOverlay('global');
      const merged = listed.map((sv) => (overlay[sv.name] ? { ...sv, ...overlay[sv.name] } : sv));
      for (const [name, o] of Object.entries(overlay)) if (!merged.some((sv) => sv.name === name)) merged.push({ name, endpoint: grants.getGrant(name)?.url || '', ...o });
      return json(res, merged);
    }
    if (p === MCP_OAUTH_CALLBACK && m === 'GET') {
      const grants = await import('./lib/mcp-grants.js');
      const err = u.searchParams.get('error');
      const r = err
        ? { ok: false, name: null, error: `${err}${u.searchParams.get('error_description') ? `: ${u.searchParams.get('error_description')}` : ''}` }
        : await grants.finishLogin(u.searchParams.get('state') || '', u.searchParams.get('code') || '');
      if (r.ok && r.name) {
        const g = grants.getGrant(r.name);
        const spec = g ? mcpCat.mcpSpec(g.slug) : null;
        if (g && spec) {
          recordMcpConnection(g.owner as caps.Owner, spec, g.name, g.url);
          await retireCliTwins(g.name, g.owner as caps.Owner).catch(() => []);
          refreshSessionsFor(g.name, g.owner);
        }
        if (g) try { broadcast({ type: 'setup.changed', capability: `mcp:${g.slug}`, owner: g.owner }); } catch {}
      }
      const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
      const msg = r.ok ? 'Connected. You can close this tab.' : `Not connected: ${esc(String(r.error || 'unknown error'))}`;
      res.writeHead(r.ok ? 200 : 400, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(`<!doctype html><meta charset="utf-8"><title>Arigami</title><body style="font:15px system-ui;padding:2rem">${msg}</body>`);
      return;
    }
    if (p === '/__api/mcp/login' && m === 'POST') {
      const mcp = await import('./mcp-auth.js');
      const body = (await readBody(req)) as any;
      const viaHost = await hostMcpLogin(String(body?.name || ''), 'start', req);
      if (viaHost) return json(res, viaHost);
      return json(res, (mcp as any).startLogin(body?.name, body?.cwd));
    }
    if (p === '/__api/mcp/login/status' && m === 'GET') {
      const mcp = await import('./mcp-auth.js');
      const viaHost = await hostMcpLogin(u.searchParams.get('name') || '', 'poll', req);
      if (viaHost) return json(res, viaHost);
      return json(res, (mcp as any).loginStatus(u.searchParams.get('name') || ''));
    }
    if (p === '/__api/mcp/logout' && m === 'POST') {
      const mcp = await import('./mcp-auth.js');
      const body = (await readBody(req)) as any;
      // A host-held grant: Sign out is its disconnect (tokens, record, any CLI twin).
      const hostGrant = (await import('./lib/mcp-grants.js')).getGrant(String(body?.name || ''));
      if (hostGrant) return json(res, await disconnectCapability(`mcp:${hostGrant.slug}`, hostGrant.owner as caps.Owner));
      return json(res, await (mcp as any).logout(body?.name, body?.cwd));
    }
    if (p === '/__api/models' && m === 'GET') {
      const { getModels } = await import('./models.js');
      const list = await (getModels as any)();
      // Codex's catalog comes from the engine at runtime (app-server model/list, cached 5 min per login).
      const { refreshCodexModels, codexModels, codexVersion } = await import('./codex.js');
      const codex = await Promise.race([refreshCodexModels(), new Promise<ReturnType<typeof codexModels>>((r) => setTimeout(() => r(codexModels()), 3000))]);
      // UPD1: the picker is where new models are discovered — tell it when a
      // newer CLI (= newer list) is one click away. Cheap: the cached status.
      let cliUpdate = null;
      try {
        const s = (await (await import('./lib/claude-update.js')).claudeUpdater()).status();
        cliUpdate = { installed: s.installed, latest: s.latest, updateAvailable: s.updateAvailable, checkedAt: s.checkedAt };
      } catch {}
      return json(res, { ...list, codex, codexVersion: await codexVersion(), cliUpdate });
    }
    if (p === '/__api/models/refresh' && m === 'POST') {
      const { getModels } = await import('./models.js');
      const { refreshCodexModels, codexVersion } = await import('./codex.js');
      const [list, codex] = await Promise.all([(getModels as any)(true), refreshCodexModels({ force: true })]);
      return json(res, { ...list, codex, codexVersion: await codexVersion() });
    }
    // C3 §7.8: Tailscale Funnel for ONLY /__api/webhooks (public internet →
    // the self-authenticating webhook routes; nothing else leaves the tailnet).
    if (p === '/__api/remote/funnel' && (m === 'GET' || m === 'POST')) {
      const remote = await import('./remote.js');
      if (m === 'GET') return json(res, (remote as any).funnelStatus());
      const body = await readBody(req);
      return json(res, await (remote as any).setFunnel(!!(body as any).enable));
    }
    if (p === '/__api/remote' && (m === 'GET' || m === 'POST')) {
      const remote = await import('./remote.js');
      if (m === 'GET') return json(res, (remote as any).remoteStatus());
      const body = await readBody(req);
      return json(res, (remote as any).setRemote(!!(body as any).enable));
    }
    if (p === '/__api/linear/tickets' && m === 'GET') {
      const g = (k: string) => u.searchParams.get(k) || '';
      const labels = g('labels')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      return json(
        res,
        await linearTickets({
          assignee: g('assignee') || 'me',
          state: g('state'),
          label: g('label'), // legacy single-label still honoured
          labels,
          labelOp: g('labelOp') === 'and' ? 'and' : 'or',
          priority: g('priority'),
          query: g('query'),
          orderBy: g('orderBy') || 'updatedAt',
        })
      );
    }
    if (p === '/__api/linear/labels' && m === 'GET') {
      const mcp = await import('./linear-mcp.js');
      try {
        return json(res, mcp.status().connected ? await mcp.listLabels() : []);
      } catch {
        return json(res, []);
      }
    }
    if (p === '/__api/linear/statuses' && m === 'GET') {
      const mcp = await import('./linear-mcp.js');
      try {
        return json(res, mcp.status().connected ? await mcp.listStatuses() : []);
      } catch {
        return json(res, []);
      }
    }
    if (p === '/__api/linear/status' && m === 'GET') {
      const mcp = await import('./linear-mcp.js');
      return json(res, mcp.status());
    }
    if (p === '/__api/linear/connect' && m === 'POST') {
      const mcp = await import('./linear-mcp.js');
      try {
        return json(res, await mcp.startAuth(browserOrigin(req)));
      } catch (e) {
        const error = e instanceof Error ? e : new Error(String(e));
        return json(res, { error: error.message }, 502);
      }
    }
    if (p === '/__api/linear/disconnect' && m === 'POST') {
      const mcp = await import('./linear-mcp.js');
      mcp.disconnect();
      return json(res, { ok: true });
    }
    if (p === '/__api/slack/status' && m === 'GET') {
      const s = await import('./slack.js');
      return json(res, s.status());
    }
    if (p === '/__api/slack/connect' && m === 'POST') {
      // Store a Slack user token (xoxp-…). Validated via auth.test before save.
      const body = (await readBody(req)) as any;
      const s = await import('./slack.js');
      try {
        return json(res, { ok: true, ...(await s.setToken(String(body.token || ''))) });
      } catch (e) {
        const error = e instanceof Error ? e : new Error(String(e));
        return badRequest(res, error.message);
      }
    }
    if (p === '/__api/slack/disconnect' && m === 'POST') {
      const s = await import('./slack.js');
      s.disconnect();
      return json(res, { ok: true });
    }
    // F8: the host-mcp `whatsapp` tool — needs_setup when the bridge is not
    // connected, else proxied to the WhatsApp MCP server (server/whatsapp-proxy.ts).
    if (p === '/__api/whatsapp/tool' && m === 'POST') {
      const wp = await import('./whatsapp-proxy.js');
      const body = (await readBody(req)) as any;
      // An agent's send goes to the owner first (lib/outbound.ts).
      const who = (req as any).auth as import('./auth.js').Principal | null;
      if (String(body?.tool || '') === 'send_message' && who?.kind === 'session') {
        const args = body?.args && typeof body.args === 'object' ? body.args : {};
        return json(res, await fileOutbound(who.sessionId, { via: 'whatsapp', tool: 'send_message', args }, body?.why ? String(body.why) : undefined), 202);
      }
      return json(res, await wp.callWhatsapp(String(body?.tool || ''), body?.args && typeof body.args === 'object' ? body.args : {}, body?.why ? String(body.why) : undefined));
    }
    if (p === '/__api/whatsapp/status' && m === 'GET') {
      const wb = await import('./whatsapp-bridge.js');
      return json(res, wb.getBridgeStatus());
    }
    if (p === '/__api/whatsapp/connect' && m === 'POST') {
      const wb = await import('./whatsapp-bridge.js');
      const { enqueueWake } = await import('./listeners.js');
      const sessionId = req.headers['x-session-id'] as string || 'ui';
      // Fire and forget — UI polls /status every 3s for updates. {repair:true}:
      // a pairing WhatsApp has logged out is moved aside so this shows a QR (WA1).
      wb.startBridge(sessionId, enqueueWake, { repair: true }).catch(console.error);
      return json(res, wb.getBridgeStatus());
    }
    if (p === '/__api/whatsapp/disconnect' && m === 'POST') {
      const wb = await import('./whatsapp-bridge.js');
      wb.stopBridge();
      return json(res, { ok: true });
    }
    if (p === '/__api/linear/oauth/callback' && m === 'GET') {
      const mcp = await import('./linear-mcp.js');
      const code = u.searchParams.get('code');
      const st = u.searchParams.get('state') || undefined;
      const err = u.searchParams.get('error');
      const page = (title: string, body: string) =>
        `<!doctype html><meta charset=utf-8><title>${title}</title>` +
        `<body style="font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f6f4ef">` +
        `<div style="text-align:center;max-width:420px;padding:28px;border:1.5px solid #2a2a2a;border-radius:14px;background:#fff;box-shadow:4px 4px 0 rgba(0,0,0,.18)">${body}</div>`;
      if (err) {
        res.writeHead(400, { 'content-type': 'text/html' });
        res.end(page('Linear — error', `<h2 style="margin:0 0 8px">Authorization failed</h2><p style="color:#9c3b33">${err}</p>`));
        return;
      }
      if (!code) {
        res.writeHead(400, { 'content-type': 'text/html' });
        res.end(page('Linear — error', '<h2>Missing authorization code</h2>'));
        return;
      }
      try {
        await mcp.finishAuth(code, st);
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(
          page('Linear connected', '<h2 style="margin:0 0 8px">✓ Linear connected</h2><p style="color:#555">You can close this tab and return to Arigami.</p><script>setTimeout(()=>window.close(),1200)</script>')
        );
        return;
      } catch (e) {
        const error = e instanceof Error ? e : new Error(String(e));
        res.writeHead(502, { 'content-type': 'text/html' });
        res.end(page('Linear — error', `<h2 style="margin:0 0 8px">Could not finish auth</h2><p style="color:#9c3b33">${error.message}</p>`));
        return;
      }
    }
    if (p === '/__api/linear/tools' && m === 'GET') {
      const mcp = await import('./linear-mcp.js');
      try {
        return json(res, await mcp.listTools());
      } catch (e) {
        const error = e instanceof Error ? e : new Error(String(e));
        return json(res, { error: error.message }, 502);
      }
    }
    {
      const tm = p.match(/^\/__api\/linear\/ticket\/([A-Za-z]+-\d+)$/);
      if (tm && m === 'GET') {
        const mcp = await import('./linear-mcp.js');
        try {
          if (mcp.status().connected) {
            const issue = await mcp.getIssue(tm[1]);
            if (issue) return json(res, issue);
          }
        } catch { /* fall back to cache/API-key path */ }
        const pages = await import('./pages.js');
        const t = await (pages as any).linear.getTicket(tm[1]);
        return t ? json(res, t) : notFound(res, `no such ticket: ${tm[1]}`);
      }
    }

    if (p === '/__api/skills' && m === 'GET') {
      const skills = await import('./skills.js');
      return json(res, skills.listSkills());
    }
    if (p === '/__api/skills/graph' && m === 'GET') {
      const skills = await import('./skills.js');
      return json(res, skills.getAnalysis());
    }
    if (p === '/__api/skills/analyze' && m === 'POST') {
      const skills = await import('./skills.js');
      try {
        return json(res, await skills.analyze());
      } catch (e) {
        const error = e instanceof Error ? e : new Error(String(e));
        return json(res, { error: error.message }, 502);
      }
    }
    {
      const sm = p.match(/^\/__api\/skills\/([a-z0-9][a-z0-9-]*)$/);
      if (sm) {
        const skills = await import('./skills.js');
        if (m === 'GET') {
          const sk = skills.readSkill(sm[1]);
          return sk ? json(res, sk) : notFound(res, `no such skill: ${sm[1]}`);
        }
        if (m === 'PUT') {
          const body = (await readBody(req)) as any;
          const r = skills.writeSkill(sm[1], String(body?.content ?? ''));
          return 'error' in r ? badRequest(res, r.error) : json(res, r);
        }
      }
    }

    // ---- Skill proposals (M3: server/skill-proposals.ts — staged under
    // $ARIGAMI_DIR/skill-proposals/, never written into skills/ except via apply) --
    if (p === '/__api/skill-proposals' && m === 'GET') {
      const sp = await import('./skill-proposals.js');
      return json(res, sp.listProposals());
    }
    if (p === '/__api/skill-proposals' && m === 'POST') {
      const sp = await import('./skill-proposals.js');
      const body = (await readBody(req)) as any;
      const r = sp.proposeSkill({
        name: body.name,
        content: body.content,
        patch: body.patch,
        rationale: body.rationale,
        evidence: body.evidence,
        sessionId: body.sessionId,
      });
      return 'error' in r ? badRequest(res, r.error) : json(res, r.proposal);
    }
    {
      const spm = p.match(/^\/__api\/skill-proposals\/(skp_[a-z0-9]+)(?:\/(apply|reject|quarantine))?$/);
      if (spm) {
        const [, id, action] = spm;
        const sp = await import('./skill-proposals.js');
        if (!action && m === 'GET') {
          const r = sp.getProposal(id);
          return 'error' in r ? notFound(res, r.error) : json(res, r);
        }
        if (action === 'apply' && m === 'POST') {
          const r = sp.applyProposal(id);
          return 'error' in r ? badRequest(res, r.error) : json(res, r);
        }
        if (action === 'reject' && m === 'POST') {
          const body = (await readBody(req)) as any;
          const r = sp.rejectProposal(id, body?.reason);
          return 'error' in r ? badRequest(res, r.error) : json(res, r);
        }
        if (action === 'quarantine' && m === 'POST') {
          const body = (await readBody(req)) as any;
          const r = sp.quarantineProposal(id, body?.reason);
          return 'error' in r ? badRequest(res, r.error) : json(res, r);
        }
      }
    }

    // ---- Memory (M1: server/memory.ts — $ARIGAMI_DIR/memory/, shared by every
    // session/worker on this instance) ------------------------------------------
    if (p === '/__api/memory' && m === 'GET') {
      const memory = await import('./memory.js');
      const agent = u.searchParams.get('agent') || null;
      return json(res, { files: memory.listMemory(agent), bootstrap: memory.getMemoryBootstrap(agent) });
    }
    if (p === '/__api/memory/write' && m === 'POST') {
      const memory = await import('./memory.js');
      const body = (await readBody(req)) as any;
      const r = memory.writeMemory({
        target: body.target,
        action: body.action,
        content: body.content,
        old_text: body.old_text,
        source: body.source || 'agent',
        sessionId: body.sessionId,
        agent: body.agent || null, // A1: agent namespace (host-mcp defaults it from ARIGAMI_AGENT)
      });
      return r.ok ? json(res, r) : badRequest(res, r.error || 'invalid memory write');
    }
    if (p === '/__api/memory/search' && m === 'GET') {
      const memory = await import('./memory.js');
      return json(res, {
        hits: memory.searchMemory({
          query: u.searchParams.get('query') || '',
          scope: u.searchParams.get('scope') || undefined,
          limit: Number(u.searchParams.get('limit')) || undefined,
          agent: u.searchParams.get('agent') || null,
        }),
      });
    }
    if (p === '/__api/memory/get' && m === 'GET') {
      const memory = await import('./memory.js');
      const r = memory.getMemoryFile(u.searchParams.get('path') || '');
      return 'error' in r ? notFound(res, r.error) : json(res, r);
    }
    if (p === '/__api/memory/log' && m === 'GET') {
      const memory = await import('./memory.js');
      return json(res, memory.getLog(Number(u.searchParams.get('limit')) || 100));
    }
    if (p.startsWith('/__api/memory/log/') && p.endsWith('/undo') && m === 'POST') {
      const memory = await import('./memory.js');
      const seq = Number(p.slice('/__api/memory/log/'.length, -'/undo'.length));
      const r = memory.undoLog(seq);
      return r.ok ? json(res, r) : badRequest(res, r.error || 'undo failed');
    }
    // ---- LEARN1: autonomous memory learning (server/memory-learning.ts) ------
    // GET  /memory/learning            status: mode, pending, next run, recent runs, manual-block preview
    // POST /memory/learning/run        "Learn now" — one triage run; applies in auto mode (or {apply:true})
    // POST /memory/learning/apply      manual mode: apply a stored run {runId, keys?} or approve pre-pass clusters {keys}
    // POST /memory/learning/mode       {mode:'auto'|'manual', minBatch?, maxAgeHours?}
    // POST /memory/learning/undo/:seq  revert one applied line by its write-log seq
    if (p === '/__api/memory/learning' || p.startsWith('/__api/memory/learning/')) {
      const ml = (await import('./memory-learning.js')).learner();
      const sub = p.slice('/__api/memory/learning'.length).replace(/^\//, '');
      if (!sub && m === 'GET') return json(res, ml.status({ runs: Number(u.searchParams.get('runs')) || 20, preview: u.searchParams.get('preview') !== '0' }));
      if (m !== 'POST') return notFound(res);
      if (!auth.isAdmin((req as any).auth)) return json(res, { error: 'admin only' }, 403);
      const body = ((await readBody(req)) || {}) as any;
      try {
        if (sub === 'run') {
          const apply = typeof body.apply === 'boolean' ? body.apply : undefined;
          return json(res, { ok: true, run: await ml.run({ trigger: 'manual', apply }) });
        }
        if (sub === 'apply') {
          const keys = Array.isArray(body.keys) ? body.keys.map(String) : undefined;
          if (body.runId) return json(res, { ok: true, run: ml.applyRun(String(body.runId), keys) });
          if (!keys) return badRequest(res, 'runId or keys required');
          return json(res, { ok: true, run: ml.approveClusters(keys) });
        }
        if (sub === 'mode') {
          const { updateMemoryLearningConfig } = await import('./lib/config.js');
          const patch: any = {};
          if (body.mode !== undefined) {
            if (body.mode !== 'auto' && body.mode !== 'manual') return badRequest(res, "mode must be 'auto' or 'manual'");
            patch.mode = body.mode;
          }
          if (body.minBatch !== undefined) { const n = Number(body.minBatch); if (!(n >= 1 && n <= 1000)) return badRequest(res, 'minBatch must be 1..1000'); patch.minBatch = Math.round(n); }
          if (body.maxAgeHours !== undefined) { const n = Number(body.maxAgeHours); if (!(n >= 1 && n <= 24 * 30)) return badRequest(res, 'maxAgeHours must be 1..720'); patch.maxAgeHours = Math.round(n); }
          if (!Object.keys(patch).length) return badRequest(res, 'nothing to change');
          updateMemoryLearningConfig(patch);
          return json(res, ml.status({ preview: false }));
        }
        if (sub.startsWith('undo/')) {
          const seq = Number(sub.slice('undo/'.length));
          if (!Number.isFinite(seq)) return badRequest(res, 'bad seq');
          const r = ml.undo(seq);
          return r.ok ? json(res, r) : badRequest(res, r.error || 'undo failed');
        }
      } catch (e) {
        const err = e as Error & { status?: number };
        return json(res, { error: err.message }, err.status || 500);
      }
      return notFound(res);
    }
    if (p === '/__api/memory/pending' && m === 'GET') {
      const memory = await import('./memory.js');
      return json(res, memory.listPending());
    }
    if (p.startsWith('/__api/memory/pending/')) {
      const rest = p.slice('/__api/memory/pending/'.length);
      const memory = await import('./memory.js');
      if (rest.endsWith('/approve') && m === 'POST') {
        const r = memory.approvePending(rest.slice(0, -'/approve'.length));
        return r.ok ? json(res, r) : badRequest(res, r.error || 'approve failed');
      }
      if (rest.endsWith('/reject') && m === 'POST') {
        const r = memory.rejectPending(rest.slice(0, -'/reject'.length));
        return r.ok ? json(res, r) : notFound(res, 'no such pending fact');
      }
      return notFound(res);
    }

    // ---- Brain (M4: server/brain.ts — the singleton `metadata.kind:'brain'`
    // session + its optional heartbeat cron). A thin layer over M1-M3's APIs. --
    if (p === '/__api/brain' && m === 'GET') {
      const brain = await import('./brain.js');
      const s = brain.findBrainSession();
      return json(res, { sessionId: s && !s.archived ? s.id : null, heartbeat: brain.getHeartbeatStatus() });
    }
    if (p === '/__api/brain/session' && m === 'POST') {
      const brain = await import('./brain.js');
      const r = await brain.ensureBrainSession();
      return json(res, r);
    }
    if (p === '/__api/brain/heartbeat' && m === 'PUT') {
      const brain = await import('./brain.js');
      const body = (await readBody(req)) as any;
      try {
        const r = await brain.setHeartbeat(!!body.enabled, typeof body.every === 'string' ? body.every : undefined);
        return json(res, r);
      } catch (e) {
        const error = e instanceof Error ? e : new Error(String(e));
        return badRequest(res, error.message);
      }
    }

    // ---- rail folders --------------------------------------------------------
    if (p === '/__api/folders' && m === 'GET') return json(res, state.listFolders());
    if (p === '/__api/folders' && m === 'POST') {
      const body = (await readBody(req)) as any;
      try {
        return json(res, state.createFolder({ name: body?.name, sortOrder: body?.sortOrder }), 201);
      } catch (e) {
        if (e instanceof state.FolderNameTakenError) return json(res, { error: e.message, existingId: e.existingId }, 409);
        throw e;
      }
    }
    // Atomic drop application (membership + root order + in-folder order) — one
    // broadcast burst, no half-applied drops. Must precede the folder-id matcher.
    if (p === '/__api/rail/reorder' && m === 'POST') {
      const body = (await readBody(req)) as any;
      const moves: any[] = Array.isArray(body?.moves) ? body.moves : [];
      // Snapshot pre-move membership: dragging a session in/out of a PROJECT
      // folder changes the controller's authority, so it gets a thin wake.
      const pre = new Map<string, string | null>(
        moves.map((mv) => [
          String(mv.sessionId),
          state.getSession(String(mv.sessionId))?.folderId || null,
        ])
      );
      state.railReorder(body || {});
      try {
        const listeners = await import('./listeners.js');
        for (const mv of moves) {
          const sid = String(mv.sessionId);
          const before = pre.get(sid) || null;
          const after = state.getSession(sid)?.folderId || null;
          if (before === after) continue;
          const sess: any = state.getSession(sid);
          const label = sess?.metadata?.ticket || sess?.title || sid;
          const beforeCtl = before ? state.getFolder(before)?.controllerSessionId : null;
          const afterCtl = after ? state.getFolder(after)?.controllerSessionId : null;
          if (afterCtl && afterCtl !== sid)
            listeners.enqueueWake(
              afterCtl,
              `adopted: session ${sid} ("${label}") joined your project folder — you can task it now`,
              `adopt:${sid}`
            );
          if (beforeCtl && beforeCtl !== sid && beforeCtl !== afterCtl)
            listeners.enqueueWake(
              beforeCtl,
              `removed: session ${sid} ("${label}") left your project folder — it is no longer yours to task`,
              `remove:${sid}`
            );
        }
      } catch {}
      return json(res, { ok: true });
    }
    // Upgrade a folder to a PROJECT folder: spawn a dedicated controller session
    // seeded with the project-manager skill + the current member list.
    {
      const fmp = p.match(/^\/__api\/folders\/([^/]+)\/make-project$/);
      if (fmp && m === 'POST') {
        const folder = state.getFolder(fmp[1]);
        if (!folder) return notFound(res, `no such folder: ${fmp[1]}`);
        if (folder.controllerSessionId)
          return badRequest(res, 'already a project folder');
        const body = (await readBody(req)) as any;
        const kids = state.folderChildren(fmp[1]);
        // Default cwd: the most common repo among the members.
        const counts = new Map<string, number>();
        for (const k of kids) {
          const c = untildify(k.cwd) as string;
          if (c) counts.set(c, (counts.get(c) || 0) + 1);
        }
        const cwd =
          (untildify(body?.cwd ? String(body.cwd) : '') as string) ||
          [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ||
          (untildify(cfg.defaultCwd) as string);
        const ctl = state.createSession({
          title: body?.title || `${folder.name} · manager`,
          cwd,
          metadata: { role: 'controller', kind: 'controller' },
        });
        state.patchSession(ctl.id, { folderId: folder.id });
        state.patchFolder(folder.id, { controllerSessionId: ctl.id });
        spawnSafe(ctl.id);
        const roster = kids
          .map((k: any) => `- ${k.id} · ${k.metadata?.ticket || k.title} (${k.status || 'no status'})`)
          .join('\n');
        try {
          claude.sendMessage(
            ctl.id,
            `Use the project-manager skill. You are the controller of the project folder "${folder.name}" (folder ${folder.id}).\n\n` +
              `Current member sessions you manage:\n${roster || '- (none yet)'}\n\n` +
              `Ask the human what this project should achieve if it isn't obvious from the members.`
          );
        } catch {}
        return json(res, state.getSession(ctl.id), 201);
      }
    }
    {
      const fm = p.match(/^\/__api\/folders\/([^/]+)$/);
      if (fm) {
        const folder = state.getFolder(fm[1]);
        if (!folder) return notFound(res, `no such folder: ${fm[1]}`);
        if (m === 'GET')
          return json(res, { ...folder, children: state.folderChildren(fm[1]) });
        if (m === 'PATCH') {
          try {
            return json(res, state.patchFolder(fm[1], (await readBody(req)) as any));
          } catch (e) {
            if (e instanceof state.FolderNameTakenError) return json(res, { error: e.message, existingId: e.existingId }, 409);
            throw e;
          }
        }
        if (m === 'DELETE') {
          // api.del sends no body — the mode rides the query string.
          const mode = u.searchParams.get('mode') === 'purge' ? 'purge' : 'ungroup';
          if (mode === 'purge') {
            // Kill every child; workers before the controller so its watchdog
            // listeners don't fire on dying children. Differential cleanup:
            // only sessions that OWN a worktree run cleanup — a readonly
            // worker's cwd is the master's shared worktree and cleaning it
            // would rm-rf a live sibling's checkout.
            const children = state.folderChildren(fm[1], { archived: true });
            const ctl = folder.controllerSessionId;
            const ordered = [
              ...children.filter((s: any) => s.id !== ctl),
              ...children.filter((s: any) => s.id === ctl),
            ];
            // Same teardown as a single delete. The read-only-worker guard
            // (never remove the master's shared checkout) lives in
            // reap.ownedWorktree, so it holds here too.
            for (const child of ordered) {
              try {
                await destroySession(child.id);
              } catch (e) {
                console.error(`[folders] purge of ${child.id} failed:`, (e as Error).message);
              }
            }
          }
          state.deleteFolder(fm[1]);
          return json(res, { ok: true, mode });
        }
        return notFound(res);
      }
    }

    if (p === '/__api/sessions' && m === 'GET') {
      // Wire form (see state.toWireSession): capabilities slimmed, finished
      // workers' result.summary capped. Full detail: GET /__api/sessions/:id,
      // or ?full=1 for bearer/internal callers (host-mcp list_sessions — masters
      // read child results from it); browsers always get the slim form.
      const archived = u.searchParams.get('archived') === 'true';
      const full = u.searchParams.get('full') === '1' && canReadFullList((req as any).auth ?? null);
      return json(res, full ? state.listSessions({ archived }) : state.listSessionsForWire({ archived }));
    }
    if (p === '/__api/sessions' && m === 'POST') {
      const body = (await readBody(req)) as any;
      // Dispatch path: a master spawning a child. `mutating`/`readonly` = thin
      // dispatch workers (host does ALL wiring: parent, role, worktree, branch,
      // cleanup, caps). `full` = a regular session under a project controller —
      // no thinning, the child provisions itself (runs whatever skill it's told).
      const kind =
        body.kind === 'mutating' || body.kind === 'readonly' || body.kind === 'full'
          ? body.kind
          : null;
      if (body.master && kind) {
        const wired =
          kind === 'full'
            ? await wireFullChild(String(body.master), body)
            : await wireWorker(String(body.master), kind, body);
        if ('deferred' in wired) return json(res, wired); // at-capacity → no session
        body.cwd = wired.cwd;
        body.permissionMode = wired.permissionMode;
        body.metadata = { ...(body.metadata || {}), ...wired.metadata };
      }
      // S1: cwd names a registered repo that isn't cloned (or a path that
      // doesn't exist) → ask for `repo:<name>` instead of spawning claude in
      // a missing directory.
      if (body.cwd && !(body.master && kind)) {
        const want = path.resolve(untildify(String(body.cwd)) as string);
        if (!fs.existsSync(want)) {
          const ob = await import('./onboarding.js');
          const hit = ob.listRepos().map((r) => ob.resolveRepo(r)).find((r) => path.resolve(ob.repoDir(r)) === want || r.name === path.basename(want));
          return json(res, caps.needsSetup(`repo:${hit ? hit.name : path.basename(want)}`, `open a session in ${body.cwd}`));
        }
      }
      // UX1: only ensureHomeSession mints an agent home — a client-supplied
      // `agentHome` would hide the session from the Sessions section for good.
      if (body.metadata && typeof body.metadata === 'object' && 'agentHome' in body.metadata) {
        const { agentHome: _drop, ...rest } = body.metadata as Record<string, unknown>;
        body.metadata = rest;
      }
      // A1: born from an agent — inherit its model (unless overridden), its
      // rail color, stamp metadata.agent; the persona + agent memory go into the
      // first turn in claude.js. An unknown agent is refused, never ignored.
      let agentColor: string | undefined;
      // P2-5: a child's engine = explicit → its agent's → its master's → cfg.defaultEngine.
      if (body.master) body.engine = agents.engineForSpawn(body.engine, body.agent ? agents.getAgent(String(body.agent)) : null, state.getSession(String(body.master))) || undefined;
      try {
        const o = applyAgentToSession(body.agent, { title: body.title, model: body.model, engine: body.engine, metadata: body.metadata });
        body.title = o.title;
        body.model = o.model;
        body.engine = o.engine;
        body.metadata = o.metadata;
        agentColor = o.color;
      } catch (e) {
        const err = e as Error & { status?: number; budget?: unknown };
        // A5 (#11): the 429 carries the structured budget so the UI localises it.
        return err.status
          ? json(res, { error: err.message, ...(err.budget ? { budget: err.budget } : {}) }, err.status)
          : notFound(res, err.message);
      }
      const s = state.createSession({
        title: body.title,
        cwd: body.cwd,
        permissionMode: body.permissionMode,
        metadata: body.metadata,
        model: body.model,
        effort: body.effort,
        color: agentColor,
        engine: body.engine,
        // Generic project-folder assignment, honored regardless of which
        // creation path sent it (web launcher, create_session tool, cron
        // isolated runs, ticket sessions). The dispatch path below still wins
        // when both are given — spawning a master/kind child always lands it
        // in that master's project folder.
        folderId: body.folderId,
        folderName: body.master && kind ? undefined : body.folderName,
      });
      // needs_screen (T8): allocate the desktop BEFORE the first spawn so
      // claude.js picks up metadata.screen.display and injects DISPLAY into
      // the session's env from the start. Not fatal — a failed allocation
      // just leaves the session on the lazy path (first request_screen/
      // capture_screen/browser-open allocates it instead).
      if (body.needsScreen) {
        try { await pickDriver().ensure(s.id); } catch (e) { console.error('[desktop] needs_screen alloc failed:', (e as Error).message); }
      }
      spawnSafe(s.id);
      // Only build a skill/ticket-fallback prompt when the caller gave us
      // something to build from — leaves the dispatch/worker path (which
      // always sends its own explicit task prompt) untouched.
      const ticketId = body.metadata?.ticket ? String(body.metadata.ticket) : undefined;
      const prompt =
        body.skill || body.prompt || ticketId
          ? buildFirstPrompt({ skill: body.skill, prompt: body.prompt, ticket: ticketId })
          : null;
      if (prompt) {
        try {
          claude.sendMessage(s.id, prompt);
        } catch {}
      }
      if (body.master && kind) {
        // Spawning children makes the master a project-folder controller; the
        // new child lands inside its folder (tree mode's replacement).
        const pf = ensureProjectFolder(String(body.master));
        if (pf) state.patchSession(s.id, { folderId: pf.id });
        // Auto-arm the worker watchdog (crash/stall backstop) targeting the master.
        try {
          const listeners = await import('./listeners.js');
          listeners.registerWorkerWatchdog(
            String(body.master),
            s.id,
            body.subtask ? String(body.subtask) : null
          );
        } catch (e) {
          console.error('[dispatch] watchdog arm failed:', (e as Error).message);
        }
      }
      return json(res, state.getSession(s.id), 201);
    }
    // Manual flat-mode rail reorder — must precede the session-id matcher below.
    if (p === '/__api/sessions/reorder' && m === 'POST') {
      const body = (await readBody(req)) as any;
      if (!Array.isArray(body.order)) return badRequest(res, 'order[] required');
      state.reorderSessions(body.order.map(String));
      return json(res, { ok: true });
    }

    const parts = p.split('/').filter(Boolean);
    if (parts[0] !== '__api' || parts[1] !== 'sessions' || !parts[2])
      return notFound(res);
    const id = parts[2];
    const s = state.getSession(id);
    if (!s) return notFound(res, `no such session: ${id}`);
    const sub = parts.slice(3).join('/');

    if (!sub) {
      if (m === 'GET') return json(res, s);
      if (m === 'PATCH') {
        const body = (await readBody(req)) as any;
        const wasArchived = (s as any).archived;
        // G5: `set_metadata({patch:{needs_server:true}})` from a MAIN session —
        // allocate a pool port into metadata.port (same pool as workers). Idempotent.
        if (body.metadata && typeof body.metadata === 'object' && body.metadata.needs_server === true) {
          delete body.metadata.needs_server;
          if (!s.metadata?.port) {
            const port = allocatePort();
            if (port) body.metadata.port = port;
          }
        }
        // UX1: `agentHome` is minted by ensureHomeSession alone — set_metadata
        // must not be able to hide a session from the Sessions section.
        if (body.metadata && typeof body.metadata === 'object' && 'agentHome' in body.metadata) {
          const { agentHome: _drop, ...rest } = body.metadata as Record<string, unknown>;
          body.metadata = rest;
        }
        const updated = state.patchSession(id, body);
        if (body.archived === true && !wasArchived) {
          claude.kill(id);
          expirePendingSetupRequests(id, 'session archived');
          state.stopListenersForSession(id); // listeners die with their session
          // Desktop dies with the session's activity (T8) — the Chrome profile
          // copy is kept (only removed on DELETE) so unarchiving picks up where
          // it left off.
          chrome.closeChrome(id);
          pickDriver().release(id);
          triggerMemoryEpisode(id, 'archive');

          // The session's processes stop with it — including dev servers the
          // agent detached, which killing the agent alone never reached. Files
          // stay unless the operator asked for the worktree to go.
          const cleanup = await reap.reapSession(s, {
            processes: true,
            worktree: u.searchParams.get('runCleanup') === 'true',
          });
          return json(res, { ...state.getSession(id), cleanup });
        }
        if (body.archived === false && wasArchived) spawnSafe(id);
        return json(res, updated);
      }
      if (m === 'DELETE') {
        // Always the full teardown. `?runCleanup=true` is still accepted from
        // older clients and ignored: whether a worktree goes is the host's call
        // from git state, not a flag the caller has to remember.
        const cleanup = await destroySession(id);
        return json(res, { ok: true, cleanup });
      }
      return notFound(res);
    }

    // A3: the agent policy of this session (mcp/host-mcp.js hides the tools it
    // lists as hidden; `?names=a,b` = the names to classify).
    if (sub === 'policy' && m === 'GET') {
      const pol = policy.policyFor(sessionAgent(s));
      const names = String(u.searchParams.get('names') || '').split(',').map((x) => x.trim()).filter(Boolean);
      return json(res, {
        agent: sessionAgent(s),
        restrictive: policy.isRestrictive(pol),
        tools: pol?.tools ?? null,
        domains: pol?.domains ?? null,
        autoApprove: pol?.autoApprove ?? [],
        hidden: names.filter((n) => !policy.toolAllowed(pol, n)),
      });
    }
    // A3: the PreToolUse hook (mcp/policy-hook.js) asks before every tool call.
    if (sub === 'policy/check' && m === 'POST') {
      const body = (await readBody(req)) as any;
      const v = policy.checkToolCall(policy.policyFor(sessionAgent(s)), String(body?.tool_name || ''), body?.input ?? {}, id);
      return json(res, v);
    }
    if (sub === 'tabs' && m === 'POST') {
      const body = (await readBody(req)) as any;
      // A3: a url tab from a session born from an agent must stay inside its domain allowlist.
      if (body?.type === 'url') {
        const v = policy.checkToolCall(policy.policyFor(sessionAgent(s)), 'open_tab', { url: body.url }, id);
        if (!v.allow) return json(res, { error: v.reason }, 403);
      }
      try {
        return json(res, state.addTab(id, body), 201);
      } catch (e) {
        const error = e instanceof Error ? e : new Error(String(e));
        return badRequest(res, error.message);
      }
    }
    if (parts[3] === 'tabs' && parts[4]) {
      const tabId = parts[4];
      if (m === 'PATCH') {
        const tab = state.patchTab(id, tabId, await readBody(req));
        return tab
          ? json(res, tab)
          : notFound(res, `no such tab: ${tabId}`);
      }
      if (m === 'DELETE') {
        try {
          return state.deleteTab(id, tabId)
            ? json(res, { ok: true })
            : notFound(res, `no such tab: ${tabId}`);
        } catch (e) {
          const error = e instanceof Error ? e : new Error(String(e));
          return badRequest(res, error.message);
        }
      }
      return notFound(res);
    }
    if (sub === 'activate-tab' && m === 'POST') {
      const { tabId } = (await readBody(req)) as any;
      const updated = state.activateTab(id, tabId);
      return updated
        ? json(res, updated)
        : notFound(res, `no such tab: ${tabId}`);
    }
    if (sub === 'listeners' && m === 'GET') {
      return json(res, state.listListeners({ sessionId: id }));
    }
    if (sub === 'listeners' && m === 'POST') {
      const body = (await readBody(req)) as any;
      const type = body.type || 'github-pr';
      const core = type === 'github-pr' || type === 'linear-issue' || type === 'slack' || type === 'whatsapp' || type === 'sms' || type === 'host-load';
      // EXT: any type an extension registered is as valid as a core one.
      if (!core) {
        const reg = await import('./listeners-registry.js');
        if (!reg.has(type)) return badRequest(res, `unsupported listener type: ${type}`);
        try {
          const listeners = await import('./listeners.js');
          const l = await listeners.registerExtListener(id, type, body);
          if (body.folderId || (typeof body.folderName === 'string' && body.folderName.trim())) state.patchSession(id, { folderId: state.resolveSessionFolder(body) });
          return json(res, l, 201);
        } catch (e) {
          return badRequest(res, e instanceof Error ? e.message : String(e));
        }
      }
      if (type === 'whatsapp') {
        // WAFILT1: contacts is an array of strings (one contact = one-element array).
        if (body.contacts != null && (!Array.isArray(body.contacts) || body.contacts.some((c: unknown) => typeof c !== 'string')))
          return badRequest(res, 'contacts must be an array of strings — for one contact pass a one-element array');
        // S1: bridge not paired/connected → needs_setup instead of a dead listener.
        const wb = await import('./whatsapp-bridge.js');
        if (wb.getBridgeStatus().status !== 'connected') return json(res, caps.needsSetup('whatsapp', 'watch your WhatsApp messages'));
      }
      try {
        const listeners = await import('./listeners.js');
        const l =
          type === 'linear-issue'
            ? await listeners.registerLinearIssueListener(id, body)
            : type === 'slack'
              ? await listeners.registerSlackListener(id, body)
              : type === 'whatsapp'
                ? await listeners.registerWhatsappListener(id, body)
                : type === 'sms'
                  ? listeners.registerSmsListener(id, body)
                  : type === 'host-load'
                    ? listeners.registerHostLoadListener(id, body)
                    : await listeners.registerGithubPrListener(id, body);
        if (body.folderId || (typeof body.folderName === 'string' && body.folderName.trim())) state.patchSession(id, { folderId: state.resolveSessionFolder(body) });
        return json(res, l, 201);
      } catch (e) {
        const error = e instanceof Error ? e : new Error(String(e));
        return badRequest(res, error.message);
      }
    }
    if (parts[3] === 'listeners' && parts[4]) {
      const lid = parts[4];
      const l = state.getListener(lid);
      if (!l || l.sessionId !== id) return notFound(res, `no such listener: ${lid}`);
      if (m === 'GET') {
        const listeners = await import('./listeners.js');
        return json(res, { ...l, log: listeners.getListenerLog(lid) });
      }
      if (m === 'DELETE') {
        const listeners = await import('./listeners.js');
        return json(res, { ok: listeners.removeWhatsappListener(lid) });
      }
      return notFound(res);
    }
    // Controller → child command channel (task_session). Authority is the
    // FOLDER, not metadata.master: dragging a session out of a project folder
    // revokes tasking immediately, even if the old master pointer survives.
    // Never interrupts: idle → send now; busy → the child's pending-prompts
    // queue with auto-play (same queue the human uses, so no collision).
    if (sub === 'task' && m === 'POST') {
      const body = (await readBody(req)) as any;
      const text = typeof body.text === 'string' ? body.text.trim() : '';
      const from = typeof body.from === 'string' ? body.from : '';
      if (!text) return badRequest(res, 'text required');
      if (!from) return badRequest(res, 'from (your session id) required');
      const folder = s.folderId ? state.getFolder(s.folderId as string) : null;
      if (!folder || folder.controllerSessionId !== from)
        return json(
          res,
          { error: `not authorized: session ${id} is not in your project folder` },
          403
        );
      const fromLabel = state.getSession(from)?.title || from;
      const wrapped = `[Task from your project controller (${fromLabel})]\n\n${text}`;
      // RES1 §3: the controller is now waiting on this child. The supervisor
      // checks the child actually got the ask and re-delivers it if not; the
      // pointer is cleared the moment the child reports (or the host synthesizes).
      state.patchSession(from, {
        metadata: { waitingOn: { sessionId: id, since: new Date().toISOString(), what: text.slice(0, 400) } },
      });
      if (s.claude?.state === 'idle') {
        try {
          claude.sendMessage(id, wrapped);
        } catch (e) {
          return json(res, { error: (e as Error).message }, 500);
        }
        return json(res, { ok: true, delivered: 'now' });
      }
      state.addPendingPrompt(id, wrapped);
      state.setPromptAutoPlay(id, true);
      claude.kickAutoPlay(id);
      return json(res, {
        ok: true,
        delivered: 'queued',
        note: 'child is busy — the task is in its pending-prompt queue and will auto-play when the turn ends',
      });
    }
    // PEER1: ad hoc peer-to-peer session messaging, unrestricted by the
    // project-folder/controller hierarchy task_session enforces above. This is
    // the host-native stand-in for Claude Code CLI's own cross-session
    // SendMessage — that mechanism is entirely internal to the `claude` binary
    // (peers find each other via a local socket registry, e.g. /tmp/cc-socks,
    // that this server never creates or reads) and codex sessions never join
    // it at all, so ListAgents/SendMessage cannot see or reach a codex-engine
    // session no matter what. This route instead goes through the same
    // session-object layer every session already has (any signed-in principal
    // may already read/patch any session id here — see auth.ts's
    // canReadFullList and the lack of an id === principal.sessionId guard on
    // this whole sub-route family), so it works for any engine pairing.
    // Never interrupts: idle → send now; busy → the pending-prompts queue with
    // auto-play, same as task_session, so an unrelated peer ping can't hijack
    // a turn in progress.
    if (sub === 'send' && m === 'POST') {
      const body = (await readBody(req)) as any;
      const text = typeof body.text === 'string' ? body.text.trim() : '';
      const from = typeof body.from === 'string' ? body.from : '';
      if (!text) return badRequest(res, 'text required');
      if (!from) return badRequest(res, 'from (your session id) required');
      if (s.archived) return json(res, { error: `session ${id} is archived` }, 409);
      const fromLabel = state.getSession(from)?.title || from;
      const wrapped = `[Message from ${fromLabel} (peer session)]\n\n${text}`;
      if (s.claude?.state === 'idle') {
        try {
          claude.sendMessage(id, wrapped);
        } catch (e) {
          return json(res, { error: (e as Error).message }, 500);
        }
        return json(res, { ok: true, delivered: 'now' });
      }
      state.addPendingPrompt(id, wrapped);
      state.setPromptAutoPlay(id, true);
      claude.kickAutoPlay(id);
      return json(res, {
        ok: true,
        delivered: 'queued',
        note: 'target is busy — the message is in its pending-prompt queue and will auto-play when the turn ends',
      });
    }
    // A4: composer @mention / `/as <agent> <text>` → a session born from the
    // agent (or its home chat), with a receipt line in this chat.
    if (sub === 'delegate' && m === 'POST') {
      const body = (await readBody(req)) as any;
      const agentSlug = String(body.agent || '').trim();
      const text = typeof body.text === 'string' ? body.text.trim() : '';
      const mode = body.mode === 'as' ? 'as' : 'mention';
      if (!agentSlug) return badRequest(res, 'agent required');
      if (!text) return badRequest(res, 'text required');
      try {
        const r = await delegateToAgent(id, agentSlug, text, mode);
        return json(res, { ok: true, ...r, url: sessionPath(r.target) }, 201);
      } catch (e) {
        const err = e as Error & { status?: number; budget?: unknown };
        return json(res, { error: err.message, ...(err.budget ? { budget: err.budget } : {}) }, err.status || 500);
      }
    }
    // UX2: "Adopt agent" — this session takes on an existing agent from its next
    // turn on, without spawning anything. Reversible via .../adopt-agent/revert.
    if (sub === 'adopt-agent' && m === 'POST') {
      const body = (await readBody(req)) as any;
      const agentSlug = String(body.agent || '').trim();
      if (!agentSlug) return badRequest(res, 'agent required');
      try {
        const r = adoptAgentIntoSession(id, agentSlug);
        return json(res, { ok: true, session: state.toWireSession(r.session), agent: r.agent });
      } catch (e) {
        const err = e as Error & { status?: number; budget?: unknown };
        return json(res, { error: err.message, ...(err.budget ? { budget: err.budget } : {}) }, err.status || 500);
      }
    }
    if (sub === 'adopt-agent/revert' && m === 'POST') {
      try {
        revertAgentAdoption(id);
        return json(res, { ok: true, session: state.getSession(id) });
      } catch (e) {
        const err = e as Error & { status?: number };
        return json(res, { error: err.message }, err.status || 500);
      }
    }
    // A4: `/agent new [name]` → the create-agent card (the human edits + confirms).
    if (sub === 'agent-card' && m === 'POST') {
      const body = (await readBody(req)) as any;
      const draft = (body.draft && typeof body.draft === 'object' ? body.draft : {}) as agents.AgentInput;
      let name = String(body.name || draft.name || '').trim();
      if (!name) {
        // Unnamed → a placeholder the human renames on the card; never collide with an existing slug.
        name = 'New agent';
        for (let i = 2; agents.getAgent(agents.slugify(name)); i++) name = `New agent ${i}`;
      }
      const r = openPendingAgentCard(id, { ...draft, name });
      if ('error' in r) return json(res, { error: r.error }, r.status);
      return json(res, { ok: true, cardId: r.cardId, slug: r.slug, state: 'pending' }, 201);
    }
    if (sub === 'message' && m === 'POST') {
      const body = (await readBody(req, 32e6)) as any;
      const text = typeof body.text === 'string' ? body.text : '';
      const attachments = Array.isArray(body.attachments)
        ? body.attachments
        : [];
      if (!text.trim() && !attachments.length)
        return badRequest(res, 'text or attachments required');
      try {
        claude.sendMessage(id, text, attachments);
      } catch (e) {
        // A5 (#5): a turn past the agent's daily cap is refused with the same 429
        // line as a new session — and with the structured budget for the UI (#11).
        const error = e as Error & { status?: number; budget?: unknown };
        return json(res, { error: error.message, ...(error.budget ? { budget: error.budget } : {}) }, error.status || 500);
      }
      return json(res, { ok: true });
    }
    // ZIP: the streamed sibling of .../message — the composer uploads a large
    // file (archives especially) here FIRST and gets back a descriptor (with
    // the archive tree, if it extracted one); the actual send still goes
    // through .../message, referencing this path instead of re-sending bytes.
    if (sub === 'attachments' && m === 'POST') {
      let file = '';
      try {
        const spooled = await spoolAttachment(req, claude.UPLOAD_SPOOL_DIR, ATTACHMENT_MAX_BYTES);
        file = spooled.file;
        const descriptor = claude.receiveStreamedAttachment(id, spooled.file, spooled.filename, spooled.contentType);
        return json(res, { ok: true, ...descriptor }, 201);
      } catch (e) {
        const err = e as Error & { status?: number };
        return json(res, { error: err.message }, err.status || 500);
      } finally {
        try { if (file && fs.existsSync(file)) fs.rmSync(file, { force: true }); } catch {}
      }
    }
    // ZIP2: a chip pulled off the composer before sending (or a dedup-skipped
    // re-drag) reclaims its spooled copy + extraction dir instead of leaking
    // disk until someone cleans ~/.arigami/uploads by hand.
    if (sub === 'attachments' && m === 'DELETE') {
      const target = u.searchParams.get('path') || '';
      if (!target) return badRequest(res, 'path required');
      const removed = claude.removeStreamedAttachment(id, target);
      return json(res, { ok: removed });
    }
    // CHAT1: the "Question for you" card — resolves the AskUserQuestion
    // permission with the picks (the CLI's own answer channel, same turn), or
    // falls back to a normal user message when nothing is pending any more.
    // The reply says which: {delivered:'tool'|'message'}.
    if (sub === 'question/answer' && m === 'POST') {
      const body = (await readBody(req)) as any;
      const toolUseId = typeof body.toolUseId === 'string' ? body.toolUseId : '';
      const content = typeof body.content === 'string' ? body.content.trim() : '';
      const answers = Array.isArray(body.answers) ? (body.answers as QuestionAnswer[]) : null;
      if (!content && !answers?.length) return badRequest(res, 'content or answers required');
      try {
        return json(res, answerQuestion(id, { toolUseId, content, answers }));
      } catch (e) {
        const error = e instanceof Error ? e : new Error(String(e));
        return json(res, { error: error.message, ...((error as any).budget ? { budget: (error as any).budget } : {}) }, (error as any).status || 500);
      }
    }
    // ---- pending prompts (queued while the session is busy) ----
    if (sub === 'prompts' && m === 'POST') {
      const body = (await readBody(req)) as any;
      const text = typeof body.text === 'string' ? body.text.trim() : '';
      if (!text) return badRequest(res, 'text required');
      const prompt = state.addPendingPrompt(id, text);
      // The session may be idle already (queued deliberately, or the turn ended
      // while the composer was open) — with auto-play on, that queue must start
      // moving now; nothing else would kick it until the NEXT turn ends.
      if (prompt) claude.kickAutoPlay(id);
      return prompt ? json(res, prompt, 201) : notFound(res);
    }
    if (sub === 'prompts/reorder' && m === 'POST') {
      const body = (await readBody(req)) as any;
      if (!Array.isArray(body.order)) return badRequest(res, 'order[] required');
      const updated = state.reorderPendingPrompts(id, body.order.map(String));
      return updated ? json(res, { ok: true }) : notFound(res);
    }
    if (sub === 'prompts/autoplay' && m === 'POST') {
      const body = (await readBody(req)) as any;
      const updated = state.setPromptAutoPlay(id, !!body.on);
      // Flipping the switch ON over a waiting queue is itself a "play now".
      if (updated && body.on) claude.kickAutoPlay(id);
      return updated ? json(res, { ok: true, on: !!body.on }) : notFound(res);
    }
    if (parts[3] === 'prompts' && parts[4] && parts[5] === 'play' && m === 'POST') {
      try {
        const ok = claude.playPendingPrompt(id, parts[4]);
        return ok ? json(res, { ok: true }) : notFound(res, `no such prompt: ${parts[4]}`);
      } catch (e) {
        const error = e as Error & { status?: number; budget?: unknown };
        return json(res, { error: error.message, ...(error.budget ? { budget: error.budget } : {}) }, error.status || 500);
      }
    }
    if (parts[3] === 'prompts' && parts[4] && m === 'DELETE') {
      const removed = state.removePendingPrompt(id, parts[4]);
      return removed ? json(res, { ok: true }) : notFound(res, `no such prompt: ${parts[4]}`);
    }
    // ---- logins: one site at a time, only with the owner's approval ----------
    // (login-vault.ts). The agent learns WHICH sites have a login — never a value.
    if (sub === 'logins' && m === 'GET') {
      const lv = await import('./lib/login-vault.js');
      return json(res, { sites: lv.list() });
    }
    if ((sub === 'login-request' || sub === 'login-save') && m === 'POST') {
      const body = (await readBody(req)) as any;
      const raw = String(body?.site || '').trim();
      if (!raw) return badRequest(res, 'site required');
      const reason = String(body?.reason || '').slice(0, 200);
      const lv = await import('./lib/login-vault.js');
      const ls = await import('./lib/login-sites.js');
      if (sub === 'login-request') {
        const d = lv.detect(raw);
        const dec = ls.decide(d.site, d.storageOrigins.length ? ['(unread)'] : []);
        if (dec.policy === 'never')
          return json(res, { available: false, site: d.site.id, policy: 'never', reason: dec.reason, next: "sign in fresh: open the site's login page, then request_screen so the human types the credentials themselves" });
        if (!d.present)
          return json(res, { available: false, site: d.site.id, reason: "there is no login for this site in the owner's browser", next: "sign in fresh: open the site's login page, then request_screen so the human types the credentials themselves" });
        if (lv.grants()[d.site.id]) {
          const r = await lv.transfer(id, raw);
          return json(res, { available: true, autoApproved: true, ...r, ...(r.ok ? {} : { next: 'sign in fresh with request_screen' }) });
        }
        const unknown = dec.source === 'default' || dec.source === 'storage';
        const action = {
          id: 'act_' + nano(),
          at: new Date().toISOString(),
          kind: LOGIN_KIND,
          login: { site: d.site.id, label: d.site.label },
          prompt:
            `Use your ${d.site.label} login in this session?` +
            (reason ? ` — ${reason}` : '') +
            (unknown ? ` (${d.site.label} is not a site Arigami knows: the first try may ask you to sign in again in your own browser.)` : ''),
          buttons: [
            { label: `Use my ${d.site.label} login`, value: 'use', style: 'primary' },
            { label: `Always for ${d.site.label}`, value: 'always' },
            { label: 'Sign in fresh', value: 'fresh' },
            { label: 'No', value: 'deny', style: 'danger' },
          ],
        };
        state.patchSession(id, { action });
        pushIntervention(id, 'action', action.prompt, 'waiting for your answer');
        return json(res, { available: true, pending: true, site: d.site.id, note: 'Stop and wait: the host messages you the outcome after the human answers. Do not sign in yourself meanwhile.' }, 202);
      }
      const site = ls.resolve(raw);
      if (ls.decide(site).policy === 'never') return json(res, { ok: false, site: site.id, reason: 'this site must not be copied' }, 409);
      const action = {
        id: 'act_' + nano(),
        at: new Date().toISOString(),
        kind: LOGIN_SAVE_KIND,
        login: { site: site.id, label: site.label },
        prompt: `Save this session's ${site.label} login to your own browser, so future sessions can ask for it?` + (reason ? ` — ${reason}` : ''),
        buttons: [
          { label: 'Save to my browser', value: 'save', style: 'primary' },
          { label: 'No', value: 'deny' },
        ],
      };
      state.patchSession(id, { action });
      pushIntervention(id, 'action', action.prompt, 'waiting for your answer');
      return json(res, { pending: true, site: site.id, note: 'Wait: the host messages you after the human answers.' }, 202);
    }
    // A sender asked to send (ext-mcp, or any caller holding this session's
    // token): the owner decides on a card; nothing is sent here.
    if (sub === 'outbound' && m === 'POST') {
      const body = (await readBody(req)) as any;
      const via = body?.via === 'whatsapp' ? 'whatsapp' : body?.via === 'ext' ? 'ext' : null;
      if (!via || !body?.tool) return badRequest(res, 'via and tool required');
      if (via === 'ext' && !/^[a-z0-9][a-z0-9-]*$/.test(String(body.ext || ''))) return badRequest(res, 'ext required');
      const exec = { via, ...(via === 'ext' ? { ext: String(body.ext) } : {}), tool: String(body.tool), args: body.args && typeof body.args === 'object' ? body.args : {} } as import('./lib/outbound.js').OutboundExec;
      return json(res, await fileOutbound(id, exec, body?.why ? String(body.why) : undefined), 202);
    }
    if (sub === 'action' && m === 'POST') {
      const { prompt, buttons, kind: rawKind } = (await readBody(req)) as any;
      if (!prompt || !Array.isArray(buttons))
        return badRequest(res, 'prompt and buttons required');
      // A3: the card carries the agent (avatar/name in the UI) and the action
      // `kind`; a kind the human already auto-approved is answered at once.
      const kind = rawKind !== undefined && rawKind !== null && String(rawKind).trim() ? String(rawKind).trim().toLowerCase() : null;
      if (kind && !agents.ACTION_KIND_RE.test(kind)) return badRequest(res, `invalid kind: ${kind} — lowercase letters, digits, :._- (max 40)`);
      const ag = sessionAgent(s) ? agents.getAgent(sessionAgent(s)!) : null;
      const action: Record<string, unknown> = { id: 'act_' + nano(), at: new Date().toISOString(), prompt, buttons, ...(kind ? { kind } : {}) };
      if (kind === 'review') action.reviewCommit = reviewedCommit(s);
      if (ag) action.agent = { slug: ag.slug, name: ag.name, emoji: ag.emoji, color: ag.color };
      if (ag && kind !== 'review' && kind && (ag.autoApprove || []).includes(kind)) {
        const pick = buttons.find((b: any) => b?.style === 'primary') || buttons[0];
        const value = String(pick?.value ?? '');
        ledger.appendActivity(ag.slug, { kind: 'action', sessionId: id, detail: String(prompt).slice(0, 200), actionKind: kind, value, auto: true });
        claude.appendChat(id, { kind: 'action-auto', actionId: action.id, prompt, actionKind: kind, value, label: pick?.label || value, agent: action.agent });
        try {
          claude.sendMessage(id, value);
        } catch (e) {
          return json(res, { error: (e as Error).message }, 500);
        }
        return json(res, { ...action, autoApproved: true, value }, 201);
      }
      state.patchSession(id, { action });
      // The card is part of the conversation: it sits in the transcript where it was raised,
      // so it scrolls up with the chat once the human keeps talking (the live card renders
      // inline while this action is still the current one; afterwards a one-line record).
      claude.appendChat(id, { kind: 'action-request', actionId: action.id, prompt: String(prompt), actionKind: kind, ...(action.agent ? { agent: action.agent } : {}) });
      pushIntervention(id, 'action', String(prompt), 'waiting for your answer');
      return json(res, action, 201);
    }
    if (sub === 'action/answer' && m === 'POST') {
      const { actionId, value, autoApprove } = (await readBody(req)) as any;
      if (value === undefined) return badRequest(res, 'value required');
      // A3: the human's answer goes to the agent's ledger; "auto-approve this
      // kind from now on" adds the kind to agent.json autoApprove.
      const cur = state.getSession(id)?.action as any;
      if (!cur || !actionId || cur.id !== actionId)
        return json(res, { error: 'This request has expired. Use the current action card.' }, 409);
      if (!cur.buttons?.some((b: any) => b.value === value)) return badRequest(res, 'value is not a current action option');
      const cardKind = cur.kind;
      if ([LOGIN_KIND, LOGIN_SAVE_KIND, SHARE_KIND, OUTBOUND_KIND, 'review'].includes(cardKind) && (req as any).auth?.kind === 'session')
        return json(res, { error: 'only a person can answer this card' }, 403);
      if (cardKind === 'review' && value === 'verified' && (cur.reviewCommit || state.getSession(id)?.metadata?.branch) &&
          (!cur.reviewCommit || !markApproved(id, principalLabel((req as any).auth), cur.reviewCommit)))
        return json(res, { error: 'The reviewed commit has changed. Request a new review.' }, 409);
      const agSlug = sessionAgent(s);
      if (agSlug && cur) {
        ledger.appendActivity(agSlug, { kind: 'action', sessionId: id, detail: String(cur.prompt || '').slice(0, 200), actionKind: cur.kind || null, value: String(value), auto: false, by: principalLabel((req as any).auth) });
        if (autoApprove === true && cur.kind && cur.kind !== 'review') {
          const a = agents.getAgent(agSlug);
          if (a) agents.updateAgent(agSlug, { autoApprove: [...new Set([...(a.autoApprove || []), cur.kind])] });
        }
      }
      state.patchSession(id, { action: null });
      claude.kickAutoPlay(id); // the hold is gone; if no turn starts below, the queue resumes
      try { emitLocal('action.answered', { sessionId: id, actionId: (cur as any)?.id || null, kind: cur?.kind || null, value: String(value) }); } catch {}
      // A5 (#2): the share card is the ONLY place an agent's public link is minted
      // — the answer carries the link (or the refusal) back into the session.
      if (cardKind === OUTBOUND_KIND && (cur as any).outbound) {
        const exec = (cur as any).outbound as import('./lib/outbound.js').OutboundExec;
        const ob = await import('./lib/outbound.js');
        const d = ob.describe(exec);
        let line: string;
        if (String(value) === 'send') {
          // Exactly what the card showed — the stored arguments, nothing re-read.
          let r: any;
          try {
            if (exec.via === 'whatsapp') {
              const wp = await import('./whatsapp-proxy.js');
              r = await wp.callWhatsapp('send_message', exec.args);
            } else if (exec.via === 'mcp') {
              const gr = await import('./lib/mcp-grants.js');
              const out: any = await gr.callTool(String(exec.server || ''), exec.tool, exec.args);
              r = out?.isError ? { ok: false, error: String((out.content || []).map((c: any) => c.text || '').join('\n') || 'tool error') } : { ok: true, result: out };
            } else if (exec.via === 'composio') {
              const cm = await import('./lib/composio-mcp.js');
              r = await cm.execute(exec.tool, exec.args, { id: String(exec.account || ''), userId: String(exec.user || 'default') });
            } else {
              const ext = await import('./extensions.js');
              r = await ext.callExtTool(String(exec.ext), exec.tool, exec.args);
            }
          } catch (e) {
            r = { ok: false, error: (e as Error).message };
          }
          line = r?.ok
            ? `[host] SENT on ${d.channel}${d.to ? ` to ${d.to}` : ''}, exactly as the owner approved it.`
            : `[host] The owner approved, but sending on ${d.channel} failed: ${r?.error || 'unknown error'}. Tell them; do not retry on your own.`;
        } else {
          line = `[host] The owner chose NOT to send the ${d.channel} message${d.to ? ` to ${d.to}` : ''}. Nothing was sent. Do not send it another way.`;
        }
        try {
          claude.sendMessage(id, line);
        } catch (e) {
          return json(res, { error: (e as Error).message }, 500);
        }
        return json(res, { ok: true });
      }
      if ((cardKind === LOGIN_KIND || cardKind === LOGIN_SAVE_KIND) && (cur as any).login?.site) {
        const { site, label } = (cur as any).login as { site: string; label: string };
        const lv = await import('./lib/login-vault.js');
        let line: string;
        const v = String(value);
        if (cardKind === LOGIN_SAVE_KIND) {
          if (v === 'save') {
            const r = await lv.saveToVault(id, site).catch((e) => ({ ok: false, error: (e as Error).message }) as any);
            line = r.ok
              ? `[host] The human SAVED this session's ${label} login to their own browser. Future sessions can ask for it with request_login.`
              : `[host] Saving the ${label} login failed: ${r.error}`;
          } else line = `[host] The human chose NOT to save the ${label} login. It stays in this session only.`;
        } else if (v === 'use' || v === 'always') {
          if (v === 'always') lv.grantAlways(site);
          const r = await lv.transfer(id, site).catch((e) => ({ ok: false, error: (e as Error).message }) as any);
          line = r.ok
            ? `[host] The human APPROVED their ${label} login for this session; it is now in your browser${r.check ? ` (checked: ${r.check.url})` : ''}. Open the site and continue.`
            : `[host] The human approved, but the ${label} login could not be used: ${r.error}. Sign in fresh: open the login page, then request_screen so the human types the credentials themselves.`;
          // Some sites allow one session only: check the owner kept theirs.
          if (r.ok)
            setTimeout(() => {
              lv.vaultStillLoggedIn(site)
                .then((kept) => {
                  if (kept === false)
                    claude.appendChat(id, { kind: 'system', text: `⚠ Copying the ${label} login logged YOUR browser out — ${label} allows one session. Arigami will not offer to copy it again; sign in again in your own browser.` });
                })
                .catch(() => {});
            }, 120_000).unref?.();
        } else if (v === 'fresh') {
          line = `[host] The human wants a FRESH ${label} sign-in, not their own login. Open the site's login page, then call request_screen so the human types the credentials themselves — do not ask for a password in the chat.`;
        } else {
          line = `[host] The human REFUSED the ${label} login. Do not sign in to ${label} and do not ask again in this turn.`;
        }
        try {
          claude.sendMessage(id, line);
        } catch (e) {
          return json(res, { error: (e as Error).message }, 500);
        }
        return json(res, { ok: true });
      }
      if (cur?.kind === SHARE_KIND && cur.share) {
        let line: string;
        if (String(value) === 'approve') {
          try {
            const sh = artifacts.share(id, cur.share.artifactId, { days: cur.share.days });
            line = `[host] The human APPROVED the public link for "${cur.share.title || cur.share.artifactId}": ${sh.share_url} (expires ${sh.exp}). Hand this link to them as-is — never a localhost URL.`;
          } catch (e) {
            line = `[host] The human approved the public link but minting it failed: ${(e as Error).message}`;
          }
        } else {
          line = `[host] The human REFUSED a public link for "${cur.share.title || cur.share.artifactId}". No link exists; the artifact stays inside the cockpit. Do not ask again in this turn.`;
        }
        try {
          claude.sendMessage(id, line);
        } catch (e) {
          return json(res, { error: (e as Error).message }, 500);
        }
        return json(res, { ok: true });
      }
      try {
        claude.sendMessage(id, String(value));
      } catch (e) {
        const error = e instanceof Error ? e : new Error(String(e));
        return json(res, { error: error.message }, 500);
      }
      return json(res, { ok: true });
    }
    // Dismiss the sticky action bar without answering — the human chose none of
    // the options and just wants it gone. The request_action tool_use already
    // returned, so the model isn't blocked; clearing the state is enough.
    if (sub === 'action/dismiss' && m === 'POST') {
      const { actionId } = (await readBody(req)) as any;
      if (!actionId || (state.getSession(id)?.action as any)?.id !== actionId)
        return json(res, { error: 'This request has expired. Use the current action card.' }, 409);
      state.patchSession(id, { action: null });
      claude.kickAutoPlay(id); // dismissing the card releases a held queue
      return json(res, { ok: true });
    }
    if (sub === 'permission/answer' && m === 'POST') {
      const body = (await readBody(req)) as any;
      if (
        !body.requestId ||
        !['allow', 'deny'].includes(body.behavior)
      ) {
        return badRequest(
          res,
          'requestId and behavior (allow|deny) required'
        );
      }
      const out = answerPermission(id, body);
      return out
        ? json(res, out)
        : notFound(res, `no pending permission request: ${body.requestId}`);
    }
    if (sub === 'screen-request/answer' && m === 'POST') {
      const body = (await readBody(req)) as any;
      if (!body.requestId) return badRequest(res, 'requestId required');
      const out = answerScreenRequest(id, body);
      return out
        ? json(res, out)
        : notFound(res, `no pending screen request: ${body.requestId}`);
    }
    // The card tells us whether the human is watching or driving: snapshots
    // only run in Watch (privacy — nothing is recorded while they type).
    if (sub === 'screen-request/mode' && m === 'POST') {
      const body = (await readBody(req)) as any;
      if (!body.requestId) return badRequest(res, 'requestId required');
      const mode = body.mode === 'control' ? 'control' : 'watch';
      const entry = pendingScreenRequests.get(String(body.requestId));
      if (!entry || entry.sessionId !== id) return notFound(res, `no pending screen request: ${body.requestId}`);
      return json(res, { ok: true, mode, tracking: screens.setAutoSnapshotMode(String(body.requestId), mode) });
    }
    // capture_screen: one frame of the shared desktop → screenshot chat event.
    if (sub === 'screenshot' && m === 'POST') {
      const body = (await readBody(req)) as any;
      const caption = body.caption ? String(body.caption).slice(0, 300) : undefined;
      if (!cfg.screen?.enabled) return json(res, { ok: false, error: 'screen share disabled', ...caps.needsSetup('desktop', 'take a screenshot') });
      try {
        const r = await screens.takeScreenshot(id, { caption });
        // Same screen as the previous screenshot → no new card (T9); the
        // agent gets the existing url so it can still reference it.
        if (r.status === 'duplicate') return json(res, { ok: true, duplicate: true, url: r.url, ts: r.ts });
        if (r.status === 'throttled') return json(res, { ok: true, throttled: true });
        const ev = r.event;
        return json(res, { ok: true, url: ev.url, ts: ev.ts, width: ev.width, height: ev.height });
      } catch (e) {
        return json(res, { ok: false, error: `screenshot failed: ${(e as Error).message}` }, 503);
      }
    }
    // BROWSE1: browser_open — like the legacy `browser` route below (same
    // openChrome underneath) but ALSO navigates + screenshots + returns
    // {url,title}, matching the browser_* tool contract in the spec.
    if (sub === 'browser/open' && m === 'POST') {
      const body = (await readBody(req).catch(() => ({}))) as any;
      const url = body?.url ? String(body.url) : undefined;
      if (url) {
        const v = policy.checkToolCall(policy.policyFor(sessionAgent(s)), 'browser_open', { url }, id);
        if (!v.allow) return json(res, { error: v.reason }, 403);
      }
      try {
        return json(res, await browserActions.open(id, url));
      } catch (e) {
        return json(res, { ok: false, error: `browser open failed: ${(e as Error).message}` }, 503);
      }
    }
    // Chrome helper (T8 §3): opens (or reports already-open) this session's
    // browser on its own desktop + profile copy. Used by skills/_lib/chrome.sh.
    if (sub === 'browser' && m === 'POST') {
      const body = (await readBody(req)) as any;
      try {
        const r = await chrome.openChrome(id, body?.url ? String(body.url) : undefined);
        return json(res, { ok: true, ...r });
      } catch (e) {
        return json(res, { ok: false, error: `browser open failed: ${(e as Error).message}` }, 503);
      }
    }
    // BROWSE1: browser_* host tools — an agent with `browser` (or `desktop`)
    // actually driving the session Chrome over CDP/xdotool (server/lib/
    // browser-actions.ts), not just proxying a url into a cockpit iframe.
    // Domain allowlist (A3) is enforced here, same as `tabs` does for open_tab.
    if (sub === 'browser/navigate' && m === 'POST') {
      const body = (await readBody(req)) as any;
      const v = policy.checkToolCall(policy.policyFor(sessionAgent(s)), 'browser_navigate', { url: body?.url }, id);
      if (!v.allow) return json(res, { error: v.reason }, 403);
      try {
        return json(res, await browserActions.navigate(id, String(body?.url || '')));
      } catch (e) {
        return json(res, { ok: false, error: (e as Error).message }, 503);
      }
    }
    if (sub === 'browser/snapshot' && m === 'POST') {
      const body = (await readBody(req).catch(() => ({}))) as any;
      try {
        return json(res, await browserActions.snapshot(id, body?.caption ? String(body.caption).slice(0, 300) : undefined));
      } catch (e) {
        return json(res, { ok: false, error: (e as Error).message }, 503);
      }
    }
    if (sub === 'browser/click' && m === 'POST') {
      const body = (await readBody(req)) as any;
      try {
        return json(res, await browserActions.click(id, { x: body?.x, y: body?.y, text: body?.text }));
      } catch (e) {
        return json(res, { ok: false, error: (e as Error).message }, 400);
      }
    }
    if (sub === 'browser/type' && m === 'POST') {
      const body = (await readBody(req)) as any;
      try {
        return json(res, await browserActions.type(id, String(body?.text || ''), body?.submit === true));
      } catch (e) {
        return json(res, { ok: false, error: (e as Error).message }, 400);
      }
    }
    if (sub === 'browser/scroll' && m === 'POST') {
      const body = (await readBody(req).catch(() => ({}))) as any;
      try {
        return json(res, await browserActions.scroll(id, { x: body?.x, y: body?.y, dx: body?.dx, dy: body?.dy }));
      } catch (e) {
        return json(res, { ok: false, error: (e as Error).message }, 400);
      }
    }
    if (sub === 'browser/close' && m === 'POST') {
      return json(res, browserActions.close(id));
    }
    // screen-agnostic connect-*: a screenshot of the front TAB only (CDP
    // Page.captureScreenshot), not the desktop/root window — what
    // skills/_lib/connect.sh's `shot` calls instead of scrot/import.
    if (sub === 'browser/screenshot' && m === 'POST') {
      try {
        const png = await browserActions.screenshot(id);
        return json(res, { ok: true, base64: png.toString('base64') });
      } catch (e) {
        return json(res, { ok: false, error: (e as Error).message }, 503);
      }
    }
    // T8c / BROWSE1: explicit allocation for the machine side panel's empty
    // state — the same ensureDesktop() the browser_* tools and request_screen
    // use lazily, exposed so the HUMAN can trigger "give this session its own
    // machine" from a button instead of only the agent.
    if (sub === 'screen/allocate' && m === 'POST') {
      try {
        const info = await pickDriver().ensure(id);
        return json(res, { ok: true, display: String(info.display) });
      } catch (e) {
        return json(res, { ok: false, error: (e as Error).message }, 503);
      }
    }
    // save_browser_logins(): sync this session's cookies/Login Data/Local
    // Storage back to chrome-base on demand (T8 §4) — same op the takeover
    // and delete flows trigger automatically.
    if (sub === 'browser/sync-logins' && m === 'POST') {
      // A2: an agent session syncs into the AGENT's own profile. Nothing reaches
      // the owner's browser this way any more — not a plain session's logins and
      // not `shared:true`: that is save_login, one site, with the owner's OK.
      const body = (await readBody(req).catch(() => ({}))) as any;
      if (chrome.profileSeedFor(id).owner === 'global' || body?.shared === true)
        return json(res, { ok: false, error: "logins reach the owner's browser only one site at a time, with their approval — call save_login({ site })" }, 409);
      const r = await chrome.syncProfileToBase(id);
      return json(res, r);
    }
    // F8: the take-over modal's "type into the desktop" field — the human's
    // clipboard does not cross VNC, so text typed in the cockpit is inserted
    // into whatever has focus on the session desktop (CDP, else XTEST).
    if (sub === 'desktop/type' && m === 'POST') {
      const body = (await readBody(req)) as any;
      try {
        const cdp = await import('./lib/chrome-cdp.js');
        return json(res, await cdp.typeIntoDesktop(id, String(body?.text || ''), body?.enter ? 'Enter' : undefined));
      } catch (e) {
        return json(res, { ok: false, error: (e as Error).message }, 400);
      }
    }
    // Copy from the remote screen: what is selected in the session's focused
    // page, for the viewer to put on the owner's clipboard (desktop-clipboard.ts).
    if (sub === 'desktop/selection' && m === 'POST') {
      const dc = await import('./lib/desktop-clipboard.js');
      try {
        return json(res, { ok: true, text: await dc.selectionAt(dc.portFor(id)) });
      } catch (e) {
        return json(res, { ok: false, error: (e as Error).message }, 409);
      }
    }
    // F8: the session's real browser tabs (urls only) — what the PKCE reader sees.
    if (sub === 'browser/tabs' && m === 'GET') {
      const cdp = await import('./lib/chrome-cdp.js');
      return json(res, { tabs: (await cdp.listTabs(id)).map((t) => ({ url: t.url, title: t.title, type: t.type })) });
    }
    // ---- OPENUI pilot: render_ui — an OpenUI Lang block as a chat card ----
    // Same shape as an extension's appendCard: one transcript event, no side
    // effects; the web card parses/renders it and degrades on bad input.
    if (sub === 'ui' && m === 'POST') {
      const body = (await readBody(req, 256e3)) as any;
      const ui = typeof body.ui === 'string' ? body.ui : '';
      if (!ui.trim()) return badRequest(res, 'ui (OpenUI Lang source) required');
      if (ui.length > OPENUI_MAX_CHARS) return badRequest(res, `ui too long (${ui.length} > ${OPENUI_MAX_CHARS} chars)`);
      if (!/^\s*root\s*=/m.test(ui)) return badRequest(res, 'ui must define `root = Stack([...])`');
      const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim().slice(0, 120) : undefined;
      const ev = claude.appendChat(id, { kind: 'openui', ui, ...(title ? { title } : {}) });
      return json(res, { ok: true, event_id: ev.id }, 201);
    }
    // ---- Published artifacts (A1) — publish_artifact tool + card buttons ----
    if (sub === 'artifacts' && m === 'GET') return json(res, artifacts.list(id));
    if (sub === 'artifacts' && m === 'POST') {
      const body = (await readBody(req)) as any;
      // A5 (#2): publishing is a revocable family now — the REST guard is the
      // fourth layer under --disallowedTools / the hook / the host-MCP filter.
      const pubAgent = sessionAgent(s) ? agents.getAgent(sessionAgent(s)!) : null;
      if (pubAgent && !policy.toolAllowed(policy.policyOf(pubAgent), 'publish_artifact'))
        return json(res, { error: `agent "${pubAgent.name}" may not publish artifacts (no "publish" tool) — hand the file path to the human instead` }, 403);
      let r: artifacts.PublishResult;
      try {
        r = artifacts.publish(id, {
          path: String(body.path || ''),
          title: String(body.title || '').slice(0, 200),
          entry: body.entry ? String(body.entry) : undefined,
        });
      } catch (e) {
        const err = e as artifacts.PublishError;
        return json(res, { error: err.message }, err.status || 500);
      }
      const { artifact, warnings } = r;
      if (sessionAgent(s)) ledger.appendActivity(sessionAgent(s)!, { kind: 'artifact', sessionId: id, detail: artifact.title || artifact.id, artifactId: artifact.id });
      // K2: share:true mints an expiring cookie-less link for THIS version.
      // A5 (#2): from an agent session that link waits for the human's approval.
      let share_url: string | null = null;
      let share_exp: string | null = null;
      let share_pending = false;
      if (body.share === true) {
        const gate = shareGate(s, (req as any).auth);
        if (gate.mode === 'deny') {
          warnings.push(`no share link: agent "${gate.agent!.name}" may not mint public links (no "publish" tool)`);
        } else if (gate.mode === 'ask') {
          askShareApproval(id, gate.agent!, artifact.id, artifact.title, body.share_days != null ? Number(body.share_days) : undefined);
          share_pending = true;
          warnings.push('a public link needs the human: an approval card is open in this session — the link arrives as a message once they approve');
        } else {
          try {
            const sh = artifacts.share(id, artifact.id, { days: body.share_days != null ? Number(body.share_days) : undefined });
            share_url = sh.share_url;
            share_exp = sh.exp;
            warnings.push(...sh.warnings);
          } catch (e) {
            warnings.push(`share link failed: ${(e as Error).message}`);
          }
        }
      }
      const ev = claude.appendChat(id, {
        kind: 'artifact',
        artifactId: artifact.id,
        title: artifact.title,
        path: artifact.path,
        entry: artifact.entry,
        version: artifact.version,
        bytes: artifact.bytes,
        files: artifact.files,
        warnings,
        ...(share_url ? { shareUrl: share_url, shareExp: share_exp } : {}),
      });
      if (body.open !== false) {
        // Re-publish: point the existing tab at the same path (it's stable),
        // just make it active again; else open a fresh URL tab.
        const existing = (s as any).tabs.find((t: any) => t.type === 'url' && t.url === artifact.path);
        if (existing) state.activateTab(id, existing.id);
        else state.addTab(id, { type: 'url', title: artifact.title, url: artifact.path });
      }
      if (body.notify === true) {
        import('./push.js')
          .then((push) => { if (!push.hasSubscriptions()) return; return push.sendPush({
            title: `${(s as any).title || 'Arigami'} — ${artifact.title}`.slice(0, 80),
            body: `Artifact published (v${artifact.version})`,
            tag: `artifact:${artifact.id}`,
            sessionId: id,
            url: artifact.path, // relative — the SW resolves it on whatever origin the phone uses
          }); })
          .catch(() => {});
      }
      return json(res, {
        ok: true,
        artifact_id: artifact.id,
        path: artifact.path,
        version: artifact.version,
        bytes: artifact.bytes,
        files: artifact.files,
        warnings,
        share_url,
        share_exp,
        ...(share_pending ? { share_pending: true } : {}),
        event_id: ev?.id,
      });
    }
    // K2: share links. POST mints (current version), DELETE revokes every live
    // link of the artifact, GET lists them (nonce/exp only — never the token).
    if (parts[3] === 'artifacts' && parts[4] && parts[5] === 'share' && !parts[6]) {
      try {
        if (m === 'POST') {
          const body = (await readBody(req)) as any;
          const days = body?.days != null ? Number(body.days) : undefined;
          // A5 (#2): same gate as share:true on publish — an agent asks first.
          const gate = shareGate(s, (req as any).auth);
          if (gate.mode === 'deny')
            return json(res, { error: `agent "${gate.agent!.name}" may not mint public links (no "publish" tool)` }, 403);
          if (gate.mode === 'ask') {
            const art = artifacts.list(id).find((x: any) => x.id === parts[4]);
            if (!art) return notFound(res, 'no such artifact');
            askShareApproval(id, gate.agent!, parts[4], art.title || parts[4], days);
            return json(res, {
              ok: true,
              pending: true,
              share_url: null,
              message: 'a public link needs the human: an approval card is open in this session — the link arrives as a message once they approve',
            }, 202);
          }
          const r = artifacts.share(id, parts[4], { days });
          return json(res, { ok: true, ...r });
        }
        if (m === 'DELETE') return json(res, { ok: true, ...artifacts.unshare(id, parts[4]) });
        if (m === 'GET') return json(res, { tokens: artifacts.listShares(parts[4]) });
      } catch (e) {
        const err = e as artifacts.PublishError;
        return json(res, { error: err.message }, err.status || 500);
      }
    }
    if (parts[3] === 'artifacts' && parts[4] && !parts[5] && m === 'DELETE') {
      return artifacts.remove(id, parts[4]) ? json(res, { ok: true }) : notFound(res, 'no such artifact');
    }
    if (parts[3] === 'screens' && parts[4] && !parts[5] && m === 'GET') {
      const file = screens.screenFilePath(id, parts[4]);
      if (!file || !fs.existsSync(file)) return notFound(res, 'no such screenshot');
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'private, max-age=31536000, immutable' });
      fs.createReadStream(file).pipe(res);
      return;
    }
    if (sub === 'interrupt' && m === 'POST') {
      return json(res, { ok: claude.interrupt(id) });
    }
    // Kill + respawn the claude proc in place (--resume) — worktree, metadata
    // and chat survive; MCP server connections are re-established.
    if (sub === 'restart' && m === 'POST') {
      try {
        return json(res, { ok: true, claude: claude.restart(id) });
      } catch (e) {
        const error = e instanceof Error ? e : new Error(String(e));
        return json(res, { error: error.message }, 500);
      }
    }
    // Probe TRUE MCP availability for this session: `claude mcp list` in the
    // session's cwd under the session's account env, folded into the live
    // claude.mcp health map the /mcp panel renders (updates arrive via the
    // session-updated broadcast). force=true bypasses the short probe cache.
    // The session's MCP servers as they really are (lib/session-mcp.ts) — what the /mcp panel renders.
    if (sub === 'mcp/servers' && m === 'GET') {
      return json(res, { servers: await sessionMcpRows(s) });
    }
    if (sub === 'mcp/check' && m === 'POST') {
      try {
        const body = (await readBody(req)) as any;
        return json(res, { ok: true, mcp: await (claude as any).checkMcp(id, !!body?.force) });
      } catch (e) {
        const error = e instanceof Error ? e : new Error(String(e));
        return json(res, { error: error.message }, 500);
      }
    }
    if (sub === 'permission-mode' && m === 'POST') {
      const { mode } = (await readBody(req)) as any;
      try {
        return json(res, claude.setPermissionMode(id, mode));
      } catch (e) {
        const error = e instanceof Error ? e : new Error(String(e));
        return badRequest(res, error.message);
      }
    }
    if (sub === 'model' && m === 'POST') {
      const { model, modelChain } = (await readBody(req)) as any;
      if (modelChain !== undefined && modelChain !== null && !Array.isArray(modelChain))
        return badRequest(res, 'modelChain must be an array of `claude --model` values');
      try {
        return json(res, claude.setModel(id, model, modelChain === undefined ? {} : { chain: modelChain }));
      } catch (e) {
        const error = e instanceof Error ? e : new Error(String(e));
        return badRequest(res, error.message);
      }
    }
    // RES1: climb back to the top rung of the model ladder NOW, without waiting
    // for the quota reset the supervisor is counting down to.
    if (sub === 'model/restore' && m === 'POST') {
      const to = claude.restoreModel(id);
      if (!to) return badRequest(res, 'this session is already on the top rung of its model chain');
      return json(res, { ok: true, model: to });
    }
    if (sub === 'effort' && m === 'POST') {
      const { effort } = (await readBody(req)) as any;
      try {
        return json(res, (claude as any).setEffort(id, effort));
      } catch (e) {
        const error = e instanceof Error ? e : new Error(String(e));
        return badRequest(res, error.message);
      }
    }
    // Context-window auto-compact threshold, expressed as a % of the session's
    // current model window (null/0 disables it). Applied as a real `claude
    // --autocompact <tokens>` spawn flag, not a message-injection guess.
    if (sub === 'autocompact' && m === 'POST') {
      const { pct } = (await readBody(req)) as any;
      try {
        return json(res, (claude as any).setAutoCompact(id, pct));
      } catch (e) {
        const error = e instanceof Error ? e : new Error(String(e));
        return badRequest(res, error.message);
      }
    }
    // Drop the conversation and start fresh in the same tab: respawns the
    // claude proc WITHOUT --resume (worktree/branch/metadata/tabs survive —
    // only the conversation itself resets).
    if (sub === 'clear' && m === 'POST') {
      try {
        return json(res, { ok: true, claude: (claude as any).clearConversation(id) });
      } catch (e) {
        const error = e instanceof Error ? e : new Error(String(e));
        return json(res, { error: error.message }, 500);
      }
    }
    if (sub === 'account' && m === 'POST') {
      const { accountId } = (await readBody(req)) as any;
      try {
        return json(res, (claude as any).setAccount(id, accountId));
      } catch (e) {
        const error = e instanceof Error ? e : new Error(String(e));
        return badRequest(res, error.message);
      }
    }
    if (sub === 'chat' && m === 'GET') {
      // CHATWS: ?seq=N → the one FULL event (the "more" button of a clipped
      // tool result). ?clip=CHARS (any mode) caps long strings per event —
      // the cockpit passes it; every other consumer keeps the full rows.
      const seqOne = Number(u.searchParams.get('seq'));
      if (seqOne > 0) {
        const ev = (claude as any).getChatEvent(id, seqOne);
        return ev ? json(res, ev) : json(res, { error: 'no such event' }, 404);
      }
      const clip = Math.max(0, Number(u.searchParams.get('clip')) || 0);
      // Paginated mode: ?limit=N&before=SEQ → { events, hasMore, oldestSeq }
      const limit = Number(u.searchParams.get('limit'));
      if (limit > 0) {
        const beforeSeq = Number(u.searchParams.get('before')) || Infinity;
        return json(res, (claude as any).getChatPage(id, { limit, beforeSeq, clip }));
      }
      const evs = claude.getChat(id, Number(u.searchParams.get('since')) || 0);
      return json(res, clip ? (claude as any).clipEvents(evs, clip) : evs);
    }
    if (sub === 'cleanup' && m === 'GET') {
      // `preview` is what a delete will actually do; the rest is the legacy
      // plan shape older clients read.
      return json(res, { ...(await cleanupPlan(s)), preview: await reap.preview(s) });
    }
    // Dispatcher: a worker reports up to its master. Atomic persist-then-wake —
    // write the capped result to the worker's own metadata.result FIRST, then
    // enqueue a thin pointer to the master (queue-until-idle). Persist-before-wake
    // kills the publish-before-write race (decision 12).
    // G5: allocate a host port for THIS session (main sessions included — the
    // worker path does it at spawn via needsServer). Idempotent: returns the
    // existing metadata.port if one is already held. 503 when the pool is dry.
    if (sub === 'allocate-port' && m === 'POST') {
      const existing = Number(s.metadata?.port);
      if (Number.isFinite(existing) && existing > 0) return json(res, { port: existing, existing: true });
      const port = allocatePort();
      if (!port) return json(res, { error: 'port pool exhausted' }, 503);
      state.patchSession(id, { metadata: { port } });
      return json(res, { port, existing: false });
    }
    if (sub === 'report' && m === 'POST') {
      const body = (await readBody(req)) as any;
      // Resolve the master: the recorded parent pointer, or an explicit override
      // the worker passes (covers a worker spawned outside the dispatch path, or a
      // missing pointer). An override back-fills metadata.master so the tree links
      // up and later reports resolve on their own.
      const recorded = (s.metadata?.master as string) || null;
      const master = recorded || (body.master ? String(body.master) : null);
      const result = capResult(body);
      const metaPatch: Record<string, unknown> = { result };
      if (!recorded && body.master) metaPatch.master = String(body.master);
      state.patchSession(id, { metadata: metaPatch });
      // Reflect terminal state on the rail so the tree/list shows it at a glance.
      const statusMap: Record<string, string> = {
        done: 'Done',
        blocked: 'Blocked',
        error: 'Error',
        milestone: s.status,
      };
      if (statusMap[result.state] && statusMap[result.state] !== s.status)
        state.patchSession(id, { status: statusMap[result.state] });
      // A blocked worker needs a human even when its master is woken — the
      // master can't log in / pay / solve a CAPTCHA on its behalf.
      if (result.state === 'blocked')
        pushIntervention(id, 'blocked', result.note || result.summary || 'worker is blocked', 'blocked');
      triggerMemoryEpisode(id, 'report');
      // An isolated cron run (M2): deliver via its own push/whatsapp/master
      // config (not the dispatch master-wake below) and auto-archive once
      // terminal — the session was spun up fresh for this one run.
      if (s.metadata?.cronTriggerId) {
        const triggers = await import('./triggers.js');
        const { archive } = await triggers.onCronReport(id, result);
        if (archive) state.patchSession(id, { archived: true });
        return json(res, { ok: true, cron: true, archived: archive });
      }
      if (!master)
        return json(res, {
          ok: true,
          master: null,
          warning:
            'no master is recorded for this session and none was provided — the result was persisted but nobody was woken. Pass master:"<session id>" to target one.',
        });
      const subtask = (s.metadata?.subtask as string) || s.title;
      const pointer = `worker ${id} (${subtask}) → ${result.state}${result.note ? `: ${result.note}` : ''}`;
      // RES1 §3: the master is no longer waiting on this child.
      try {
        const sup = await import('./supervisor-loop.js');
        sup.clearWaitingOn(master, id);
      } catch {
        /* the supervisor is optional — a report must never fail on it */
      }
      try {
        const listeners = await import('./listeners.js');
        listeners.enqueueWake(master, pointer, `report:${id}`);
      } catch (e) {
        const error = e instanceof Error ? e : new Error(String(e));
        return json(res, { ok: true, master, warning: `wake failed: ${error.message}` });
      }
      return json(res, { ok: true, master, delivered: 'queued' });
    }
    // Dispatcher: bounded read for the Orchestration tab — the plan + per-child
    // summaries. NEVER reads a worker's chat (the one hard rule).
    if (sub === 'orchestration' && m === 'GET') {
      const { plan, planError } = readOrchestration(s);
      const children = state
        .listSessions({ archived: true })
        .filter((c: any) => c.metadata?.master === id)
        .map(childSummary);
      return json(res, { id, plan, ...(planError ? { planError } : {}), children });
    }
    if (sub === 'open-editor' && m === 'POST') {
      // Open the session's worktree (or cwd) in the local desktop editor. The
      // `code` CLI shim is often not on PATH, so on macOS we fall back to
      // `open -a` against the installed app, which doesn't need the shim. On
      // Windows the shim IS the normal entrypoint, but it's `code.cmd` — a batch
      // file, which spawn() can only run through cmd.
      const dir =
        (untildify(s.metadata?.worktree as string | undefined) as string | null) ||
        (untildify(s.cwd) as string | null);
      if (!dir) return badRequest(res, 'session has no worktree or cwd');
      const editor = String((cfg as unknown as Record<string, unknown>).editorApp || 'Visual Studio Code');
      const codeBin = isWin ? which('code') : null;
      const cmd =
        process.platform === 'darwin'
          ? ['open', '-a', editor, dir]
          : isWin
            ? ['cmd', '/c', codeBin || 'code', dir]
            : ['code', dir];
      try {
        const proc = Bun.spawn(cmd, { stdout: 'ignore', stderr: 'pipe' });
        const code = await proc.exited;
        if (code !== 0) {
          const err = await new Response(proc.stderr).text();
          return json(res, { error: err.trim() || `editor exited ${code}` }, 500);
        }
        return json(res, { ok: true, dir, editor });
      } catch (e) {
        const error = e instanceof Error ? e : new Error(String(e));
        return json(res, { error: error.message }, 500);
      }
    }
    if (sub === 'changes' && m === 'GET') {
      return json(res, await changesFor(s, u.searchParams.get('mode'), u.searchParams.get('base')));
    }
    if (sub === 'changes/diff' && m === 'GET') {
      return json(
        res,
        await changeDiff(
          s,
          u.searchParams.get('path'),
          u.searchParams.get('mode'),
          u.searchParams.get('base')
        )
      );
    }
    if (sub === 'changes/refs' && m === 'GET') {
      return json(res, {
        ...(await prStatus(s, u.searchParams.get('base'))),
        ...(await listBaseRefs(s)),
      });
    }
    // ---- F7: merge after approval (executed by the host) ----
    if (sub === 'merge/status' && m === 'GET') {
      return json(res, await mergeStatus(s));
    }
    if (sub === 'merge' && m === 'POST') {
      const me = (req as any).auth;
      if (!mayMerge(me, s))
        return json(res, { error: 'only the human (admin) or this session\'s master/controller may merge' }, 403);
      const body = ((await readBody(req).catch(() => null)) || {}) as any;
      const r = await mergeSession(
        s,
        {
          strategy: body.strategy,
          deleteBranch: body.deleteBranch === true,
          runCleanup: body.runCleanup === true,
          force: body.force === true && auth.isAdmin(me),
        },
        principalLabel(me)
      );
      const { status, ...payload } = r;
      return json(res, payload, status || 200);
    }
    // ---- status summary ----
    // Enable + generate (first run reads the whole transcript). body.autoUpdate
    // seeds the checkbox.
    if (sub === 'summary' && m === 'POST') {
      const body = ((await readBody(req).catch(() => null)) || {}) as any;
      // Seed the record so autoUpdate/lang stick and the popover shows "generating".
      state.setStatusSummary(id, {
        text: s.statusSummary?.text || '',
        autoUpdate: body.autoUpdate ?? s.statusSummary?.autoUpdate ?? false,
        lang: body.lang === 'en' || body.lang === 'he' ? body.lang : body.lang === 'auto' ? 'auto' : s.statusSummary?.lang ?? 'auto',
        atSeq: s.statusSummary?.atSeq ?? 0,
      });
      try {
        return json(res, claude.summarizeSession(id, { full: !s.statusSummary }));
      } catch (e) {
        return badRequest(res, (e as Error).message);
      }
    }
    // Regenerate now (fold the delta; ?full=true forces a fresh whole-transcript read).
    if (sub === 'summary/update' && m === 'POST') {
      try {
        return json(res, claude.summarizeSession(id, { full: u.searchParams.get('full') === 'true' }));
      } catch (e) {
        return badRequest(res, (e as Error).message);
      }
    }
    // Write path from the headless run's set_status_summary MCP tool.
    if (sub === 'summary/result' && m === 'POST') {
      const body = (await readBody(req)) as any;
      const text = typeof body.text === 'string' ? body.text : '';
      const updated = state.setStatusSummary(id, {
        text,
        tldr: typeof body.tldr === 'string' ? body.tldr : undefined,
        atSeq: Number.isFinite(body.atSeq) ? Number(body.atSeq) : s.statusSummary?.atSeq ?? 0,
      });
      return updated ? json(res, { ok: true }) : notFound(res);
    }
    // Toggle auto-update without regenerating.
    if (sub === 'summary' && m === 'PATCH') {
      const body = (await readBody(req)) as any;
      let updated: unknown = s.statusSummary ? s : null;
      if ('autoUpdate' in body) updated = state.setSummaryAutoUpdate(id, !!body.autoUpdate);
      if (typeof body.lang === 'string') {
        updated = state.setSummaryLang(id, body.lang === 'en' || body.lang === 'he' ? body.lang : 'auto');
        // Regenerate in the new language (full, so a Hebrew brief isn't folded
        // into an English one or vice-versa) so the switch is immediately visible.
        if (updated) { try { claude.summarizeSession(id, { full: true }); } catch {} }
      }
      return updated ? json(res, { ok: true }) : notFound(res, 'no summary to toggle');
    }
    // Turn the feature off.
    if (sub === 'summary' && m === 'DELETE') {
      state.clearStatusSummary(id);
      return json(res, { ok: true });
    }
    if (sub === 'changes/explain' && m === 'POST') {
      const body = (await readBody(req)) as any;
      try {
        return json(
          res,
          claude.explainChanges(
            id,
            body.mode === 'pr' ? 'pr' : body.mode === 'work' ? 'work' : 'uncommitted'
          )
        );
      } catch (e) {
        const error = e instanceof Error ? e : new Error(String(e));
        return badRequest(res, error.message);
      }
    }
    if (sub === 'changes/explanation' && m === 'POST') {
      const body = (await readBody(req)) as any;
      // The headless explain/review runs pass `mode` explicitly (they know
      // which comparison they were asked for). Older callers only pass `base`
      // — keep inferring from it for backward compatibility, but that
      // inference can only ever land on 'pr'/'uncommitted', never 'work'.
      const mode =
        body.mode === 'pr' || body.mode === 'uncommitted' || body.mode === 'work'
          ? body.mode
          : !body.base || body.base === 'HEAD'
            ? 'uncommitted'
            : 'pr';
      const identity = await changeIdentity(s, mode, typeof body.baseRef === 'string' ? body.baseRef : null);
      state.setChangesExplanation(id, mode, {
        language: typeof body.language === 'string' ? body.language : null,
        generatedAt: new Date().toISOString(),
        mode,
        identity: identity ?? undefined,
        files: Array.isArray(body.files) ? body.files : [],
        features: Array.isArray(body.features) ? body.features : [],
      });
      if (body.activate !== false) state.activateTab(id, '__changes');
      return json(res, { ok: true });
    }
    // ---- inbox: things people said to us (state.ts InboxItem) --------------
    if (parts[3] === 'inbox' && !parts[4] && m === 'GET') {
      return json(res, { items: state.listInbox(id) });
    }
    // An adapter (an extension listener, a skill) appends here. Dedup by
    // source.ref happens in state, so an at-least-once poller is safe to retry.
    if (parts[3] === 'inbox' && !parts[4] && m === 'POST') {
      const body = (await readBody(req)) as any;
      const list = Array.isArray(body?.items) ? body.items : [];
      const bad = list.find((i: any) => !i?.source?.ref || typeof i?.body !== 'string');
      if (bad) return badRequest(res, 'each item needs source.ref and a string body');
      const added = state.addInboxItems(id, list);
      if (added === null) return notFound(res, `no such session: ${id}`);
      // Enrichment is triggered HERE and not by the adapter. If the adapter
      // were core code it could remember; but an adapter is an extension, and "every provider must also kick the enrichment" is a rule
      // that the third one will forget. Fire-and-forget: a failed draft must
      // never fail the ingest, or a poller retries forever.
      if (added.some((i) => i.signal)) {
        try {
          (claude as any).enrichInbox(id);
        } catch (e) {
          console.error('[inbox] enrich failed:', (e as Error)?.message);
        }
      }
      return json(res, { added: added.length, items: added }, 201);
    }
    // Where the headless enrichment run posts its drafts back. Whitelisted:
    // the run may fill the agent's OWN fields and nothing else — it cannot set
    // a decision, edit the person's body, or mark anything settled. A model
    // that could decide would make the submit gate decorative.
    if (parts[3] === 'inbox' && parts[4] === 'enrich' && m === 'POST') {
      const body = (await readBody(req)) as any;
      const list = Array.isArray(body?.items) ? body.items : [];
      let updated = 0;
      for (const r of list) {
        if (!r?.id) continue;
        const ok = state.patchInboxItem(id, String(r.id), {
          enriching: false,
          enrichment: {
            explanation: String(r.explanation || ''),
            explanationDir: r.explanation_dir ? String(r.explanation_dir) : null,
            proposal: {
              fix: r.fix == null ? null : String(r.fix),
              reply: r.reply == null ? null : String(r.reply),
              replyDir: r.reply_dir ? String(r.reply_dir) : null,
            },
          },
        });
        if (ok) updated++;
      }
      return json(res, { ok: true, updated });
    }
    // The "explain it" button on a low-signal item: force a run for one that
    // the signal gate skipped.
    if (parts[3] === 'inbox' && parts[4] === 'enrich-now' && m === 'POST') {
      try {
        return json(res, (claude as any).enrichInbox(id, { force: true }));
      } catch (e) {
        const error = e instanceof Error ? e : new Error(String(e));
        return badRequest(res, error.message);
      }
    }
    if (parts[3] === 'inbox' && parts[4] === 'submit' && m === 'POST') {
      const body = (await readBody(req)) as any;
      const note = body?.note ? String(body.note) : '';
      const decided = state.settleInbox(id, note);
      if (!decided.length && !note.trim()) return badRequest(res, 'nothing decided to submit');
      try {
        claude.sendMessage(id, formatInboxSubmit(decided, note));
      } catch (e) {
        const error = e instanceof Error ? e : new Error(String(e));
        return json(res, { error: error.message }, 500);
      }
      return json(res, { ok: true, submitted: decided.length });
    }
    if (parts[3] === 'inbox' && parts[4] === 'clear' && m === 'POST') {
      return json(res, { ok: !!state.clearInbox(id) });
    }
    // Record a decision, an edited reply, or a note to the agent. Deliberately
    // a whitelist: the body, the source and the context are what a PERSON
    // wrote, and nothing the cockpit does may rewrite them.
    if (parts[3] === 'inbox' && parts[4] && m === 'PATCH') {
      const body = (await readBody(req)) as any;
      const patch: Record<string, unknown> = {};
      const DECISIONS = ['fix', 'reply', 'both', 'discuss', 'dismiss'];
      if ('decision' in body)
        patch.decision = body.decision === null || DECISIONS.includes(body.decision)
          ? body.decision
          : undefined;
      if (patch.decision === undefined && 'decision' in body)
        return badRequest(res, `decision must be null or one of ${DECISIONS.join(', ')}`);
      for (const k of ['replyOverride', 'noteToAgent'] as const)
        if (k in body) patch[k] = body[k] === null ? null : String(body[k]);
      if (!Object.keys(patch).length) return badRequest(res, 'nothing to patch');
      const next = state.patchInboxItem(id, parts[4], patch);
      return next ? json(res, next) : notFound(res, `no such inbox item: ${parts[4]}`);
    }
    if (parts[3] === 'review') {
      if (parts[4] === 'comment' && !parts[5] && m === 'POST') {
        const body = (await readBody(req)) as any;
        if (!body.target || !body.body)
          return badRequest(res, 'target and body required');
        return json(
          res,
          state.addReviewComment(id, {
            target: body.target,
            body: String(body.body),
            dir: body.dir || null,
          }),
          201
        );
      }
      if (parts[4] === 'comment' && parts[5] && parts[6] === 'reply') {
        const cid = parts[5];
        const rid = parts[7];
        if (!rid && m === 'POST') {
          const body = (await readBody(req)) as any;
          if (!body.body) return badRequest(res, 'body required');
          const r = state.addReviewReply(id, cid, {
            body: String(body.body),
            dir: body.dir || null,
          });
          return r
            ? json(res, r, 201)
            : notFound(res, `no such comment: ${cid}`);
        }
        if (rid && m === 'PATCH') {
          const body = (await readBody(req)) as any;
          const r = state.patchReviewReply(id, cid, rid, {
            body: body.body != null ? String(body.body) : undefined,
          });
          return r
            ? json(res, r)
            : notFound(res, `no such reply: ${rid}`);
        }
        if (rid && m === 'DELETE') {
          return json(res, { ok: state.removeReviewReply(id, cid, rid) });
        }
        return notFound(res);
      }
      if (parts[4] === 'comment' && parts[5] && m === 'DELETE') {
        return json(res, { ok: state.removeReviewComment(id, parts[5]) });
      }
      if (parts[4] === 'comment' && parts[5] && m === 'PATCH') {
        const body = (await readBody(req)) as any;
        const patch: Record<string, unknown> = {};
        if ('resolved' in body) patch.resolved = body.resolved !== false;
        if (typeof body.body === 'string') patch.body = body.body;
        if (body.accept === true || body.suggested === false)
          patch.suggested = false;
        const c = state.patchReviewComment(id, parts[5], patch);
        return c
          ? json(res, c)
          : notFound(res, `no such comment: ${parts[5]}`);
      }
      if (parts[4] === 'auto' && m === 'POST') {
        const body = (await readBody(req)) as any;
        try {
          return json(
            res,
            claude.reviewChanges(
              id,
              body.mode === 'pr' ? 'pr' : body.mode === 'work' ? 'work' : 'uncommitted'
            )
          );
        } catch (e) {
          const error = e instanceof Error ? e : new Error(String(e));
          return badRequest(res, error.message);
        }
      }
      if (parts[4] === 'suggestions' && m === 'POST') {
        const body = (await readBody(req)) as any;
        const list = (Array.isArray(body.comments) ? body.comments : []).filter(
          (c: any) => c && c.body
        );
        const mapped = list.map((c: any) => {
          const kind = ['line', 'file', 'feature'].includes(c.kind)
            ? c.kind
            : c.line != null
              ? 'line'
              : 'file';
          const target =
            kind === 'line'
              ? {
                  kind: 'line',
                  path: String(c.path || ''),
                  lineLabel:
                    c.line != null ? `L${Math.round(c.line)}` : undefined,
                }
              : kind === 'feature'
                ? {
                    kind: 'feature',
                    key: String(
                      c.featureTitle || c.path || c.body
                    ).slice(0, 60),
                    featureTitle: String(c.featureTitle || c.path || ''),
                  }
                : { kind: 'file', path: String(c.path || '') };
          return {
            target,
            body: String(c.body),
            dir: c.dir || null,
            suggested: true,
          };
        });
        const added = state.addReviewComments(id, mapped);
        state.activateTab(id, '__changes');
        return json(res, { ok: true, added: added?.length || 0 });
      }
      if (parts[4] === 'submit' && m === 'POST') {
        const body = (await readBody(req)) as any;
        const verdict = ['approve', 'request-changes', 'comment'].includes(
          body.verdict
        )
          ? body.verdict
          : 'comment';
        const target = body.target === 'remote' ? 'remote' : 'local';
        const summary = body.summary ? String(body.summary) : '';
        const msg =
          target === 'remote'
            ? formatRemoteReview(s, verdict, summary)
            : formatReview(s, verdict, summary);
        try {
          claude.sendMessage(id, msg);
        } catch (e) {
          const error = e instanceof Error ? e : new Error(String(e));
          return json(res, { error: error.message }, 500);
        }
        state.clearReview(id);
        if (target === 'local' && verdict === 'approve') {
          state.patchSession(id, { status: 'Approved' });
          markApproved(id, principalLabel((req as any).auth)); // F7
        }
        const sessTab =
          (s as any).tabs.find((t: any) => t.type === 'session') ||
          (s as any).tabs[0];
        if (sessTab) state.activateTab(id, sessTab.id);
        return json(res, { ok: true });
      }
      return notFound(res);
    }
    if (parts[3] === 'bg' && parts[4]) {
      const shellId = parts[4];
      if (parts[5] === 'output' && m === 'GET') {
        const out = claude.bgOutput(id, shellId);
        return out
          ? json(res, out)
          : notFound(res, `no such background shell: ${shellId}`);
      }
      if (parts[5] === 'kill' && m === 'POST') {
        return json(res, { ok: claude.bgKill(id, shellId) });
      }
      return notFound(res);
    }
    return notFound(res);
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));
    if (!res.headersSent)
      return json(
        res,
        { error: error.message },
        error.message.includes('JSON') ? 400 : 500
      );
    try {
      res.end();
    } catch {}
  }
}
