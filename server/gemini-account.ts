// Gemini accounts: identity, plan tier and quota of the machine's `agy` login (accounts.js `gemini-home`).
// The token file belongs to agy: read-only here, never logged, copied or handed to a session.
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { geminiTokenFile, geminiHomeOverride } from './lib/gemini-home.js';
import { findAgy } from './lib/gemini-cli.js';

const ENDPOINT = 'https://daily-cloudcode-pa.googleapis.com/v1internal';
const TTL_MS = 5 * 60_000;
const PLAN_TTL_MS = 60 * 60_000;
const RENEW_MIN_MS = 60 * 60_000; // agy's token lives an hour
const DEMAND_MS = 15 * 60_000;
const ARCH = process.arch === 'x64' ? 'amd64' : process.arch;
const USER_AGENT = `antigravity/1.1.24 ${process.platform}/${ARCH}`;

export interface GeminiWindow {
  pct: number; // USED percent, like every other provider's window
  resetsAt: string | null;
  windowMins: number;
}
export interface GeminiUsage {
  available: boolean;
  reason?: string;
  session?: GeminiWindow | null;
  week?: GeminiWindow | null;
  /** the Claude/GPT-through-Google group — its own buckets, not Gemini's */
  thirdParty?: { session: GeminiWindow | null; week: GeminiWindow | null } | null;
  limitReached?: boolean;
  fetchedAt?: number;
}
const agyBin = (): string => findAgy() || 'agy';

/** agy's login as the host needs it; null when signed out or unreadable. */
export function readGeminiLogin(file = geminiTokenFile()): { token: string; email: string | null; expiresAt: number | null } | null {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    const token = j?.token?.access_token;
    if (typeof token !== 'string' || !token) return null;
    const exp = Date.parse(j.token.expiry || '');
    return { token, email: typeof j.id_token_email === 'string' ? j.id_token_email : null, expiresAt: Number.isFinite(exp) ? exp : null };
  } catch {
    return null;
  }
}

const pctUsed = (remaining: unknown): number => Math.max(0, Math.min(100, Math.round((1 - (typeof remaining === 'number' ? remaining : 0)) * 100)));
const WINDOW_MINS: Record<string, number> = { '5h': 300, weekly: 7 * 24 * 60 };
// proto3 JSON drops zero values: a bucket with no remainingFraction is an empty one.
const win = (b: any, mins: number): GeminiWindow => ({ pct: pctUsed(b?.remainingFraction), resetsAt: b?.resetTime || null, windowMins: mins });

function bucketsOf(group: any): { session: GeminiWindow | null; week: GeminiWindow | null } {
  const out: { session: GeminiWindow | null; week: GeminiWindow | null } = { session: null, week: null };
  for (const b of Array.isArray(group?.buckets) ? group.buckets : []) {
    const mins = WINDOW_MINS[b?.window];
    if (mins === 300) out.session = win(b, mins);
    else if (mins) out.week = win(b, mins);
  }
  return out;
}

/** retrieveUserQuotaSummary + fetchAvailableModels → the cockpit's {session, week} shape (pure). */
export function normalizeGeminiQuota(summary: any, models: any, now = Date.now()): GeminiUsage {
  const groups: any[] = Array.isArray(summary?.groups) ? summary.groups : [];
  const is3p = (g: any) => (g?.buckets || []).some((b: any) => String(b?.bucketId || '').startsWith('3p-'));
  const third = groups.find(is3p);
  const own = groups.find((g) => !is3p(g) && /gemini/i.test(`${g?.displayName || ''} ${g?.description || ''}`));
  let { session, week } = own ? bucketsOf(own) : { session: null, week: null };
  if (!session) {
    // Every Gemini model reports the one shared 5-hour bucket; take the tightest reading.
    let tight: any = null;
    for (const [id, m] of Object.entries<any>(models?.models || {})) {
      const q = m?.quotaInfo;
      if (!/^gemini-/.test(id) || !q || (q.remainingFraction === undefined && !q.resetTime)) continue;
      if (!tight || (q.remainingFraction ?? 0) < (tight.remainingFraction ?? 0)) tight = q;
    }
    if (tight) session = win(tight, 300);
  }
  if (!session && !week) return { available: false, reason: 'unavailable' };
  const tp = third ? bucketsOf(third) : null;
  return {
    available: true,
    session,
    week,
    thirdParty: tp && (tp.session || tp.week) ? tp : null,
    limitReached: (session?.pct ?? 0) >= 100 || (week?.pct ?? 0) >= 100,
    fetchedAt: now,
  };
}

// ---- live calls (few: every result is cached) --------------------------------

type Fetch = typeof fetch;
async function cloudCall(ep: string, token: string, body: unknown, fetchImpl: Fetch): Promise<{ status: number; json: any }> {
  const res = await fetchImpl(`${ENDPOINT}:${ep}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'user-agent': USER_AGENT },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  let json: any = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}

function run(args: string[], timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile(agyBin(), args, { timeout: timeoutMs, env: process.env }, (err, stdout) => resolve(err ? null : String(stdout)));
    } catch {
      resolve(null);
    }
  });
}

let versionCache: { at: number; value: string | null } | null = null;
/** `agy --version`, cached per host process (a failed probe retries after a minute). */
export async function geminiVersion(force = false): Promise<string | null> {
  if (!force && versionCache && (versionCache.value || Date.now() - versionCache.at < 60_000)) return versionCache.value;
  const out = await run(['--version'], 5000);
  versionCache = { at: Date.now(), value: out?.match(/\d+\.\d+\.\d+\S*/)?.[0] || null };
  return versionCache.value;
}

/** One cheap agy run (`agy models`: no model call) makes agy renew its own lapsed token; it cannot be pointed at another gemini home, so none there. */
const renewViaCli = async (): Promise<unknown> => (geminiHomeOverride() ? null : run(['models'], 20_000));

interface Deps { file?: string; fetchImpl?: Fetch; now?: () => number; refreshLogin?: () => Promise<unknown> }

let usageCache: { at: number; data: GeminiUsage } | null = null;
let loginRefreshAt = 0;
let demandAt = 0;

/** Someone is looking at the Gemini account (Accounts, Settings › Host) — the only time the host may run agy to renew a lapsed token. */
export function noteGeminiDemand(now = Date.now()): void {
  demandAt = now;
}

/** A usable login: a lapsed token is renewed by agy itself, through one `agy` run — only while someone is looking, at most hourly. */
async function freshLogin(d: Deps) {
  const now = (d.now || Date.now)();
  let login = readGeminiLogin(d.file);
  if (login?.expiresAt && login.expiresAt <= now + 30_000 && now - demandAt < DEMAND_MS && now - loginRefreshAt >= RENEW_MIN_MS) {
    loginRefreshAt = now;
    await (d.refreshLogin || renewViaCli)();
    login = readGeminiLogin(d.file);
  }
  return login;
}

/** The Gemini 5-hour bucket (used %, reset time) of the machine's agy login, cached 5 minutes. Never throws. */
export async function geminiUsage(opts: Deps & { force?: boolean } = {}): Promise<GeminiUsage> {
  const now = (opts.now || Date.now)();
  // A reading (or an HTTP refusal) is kept 5 minutes; signed-out / lapsed-token states are local reads, retried each poll.
  const keep = usageCache && (usageCache.data.available || /^http-/.test(usageCache.data.reason || '')) ? TTL_MS : 0;
  if (!opts.force && usageCache && now - usageCache.at < keep) return usageCache.data;
  const data = await fetchGeminiUsage(opts);
  // A lapsed token or a network blip says nothing new: keep serving the last good reading.
  if (!data.available && usageCache?.data.available && (data.reason === 'token-expired' || data.reason === 'fetch-failed')) return usageCache.data;
  usageCache = { at: now, data };
  return data;
}

async function fetchGeminiUsage(d: Deps): Promise<GeminiUsage> {
  const f = d.fetchImpl || fetch;
  const now = (d.now || Date.now)();
  const login = await freshLogin(d);
  if (!login) return { available: false, reason: 'no-credentials' };
  if (login.expiresAt && login.expiresAt <= now) return { available: false, reason: 'token-expired' };
  try {
    const [summary, models] = await Promise.all([
      cloudCall('retrieveUserQuotaSummary', login.token, {}, f),
      cloudCall('fetchAvailableModels', login.token, {}, f),
    ]);
    const bad = [summary, models].find((r) => r.status === 401) || (summary.status >= 400 && models.status >= 400 ? models : null);
    if (bad) return { available: false, reason: `http-${bad.status}` };
    return normalizeGeminiQuota(summary.status < 400 ? summary.json : null, models.status < 400 ? models.json : null, now);
  } catch {
    return { available: false, reason: 'fetch-failed' };
  }
}

let planCache: { at: number; askedAt: number; email: string | null; plan: string | null } | null = null;

/** Who the agy login is and its plan tier (loadCodeAssist, cached an hour). Never throws. */
export async function geminiIdentity(opts: Deps = {}): Promise<{ email: string | null; plan: string | null }> {
  const now = (opts.now || Date.now)();
  const login = await freshLogin(opts);
  if (!login) return { email: null, plan: null };
  const mine = planCache?.email === login.email ? planCache : null;
  if (mine?.plan && now - mine.at < PLAN_TTL_MS) return { email: login.email, plan: mine.plan };
  let plan: string | null = null;
  // A lapsed token asks nothing; a call that gave no plan is not repeated for 5 minutes.
  const ask = (!login.expiresAt || login.expiresAt > now) && !(mine && now - mine.askedAt < TTL_MS);
  if (ask) {
    try {
      const metadata = { ideType: 'ANTIGRAVITY', platform: `${process.platform}_${ARCH}`.toUpperCase(), pluginType: 'GEMINI' };
      const r = await cloudCall('loadCodeAssist', login.token, { metadata }, opts.fetchImpl || fetch);
      if (r.status < 400) plan = r.json?.paidTier?.name || r.json?.currentTier?.name || null;
    } catch {}
  }
  planCache = { at: plan ? now : mine?.at || 0, askedAt: ask ? now : mine?.askedAt || 0, email: login.email, plan: plan || mine?.plan || null };
  return { email: login.email, plan: planCache.plan };
}

/** Settings › Host row: is agy installed and signed in, as whom, on which plan. */
export async function geminiHostStatus(): Promise<{ installed: string | null; signedIn: boolean; email: string | null; plan: string | null }> {
  noteGeminiDemand();
  const [installed, ident] = await Promise.all([geminiVersion(), geminiIdentity()]);
  return { installed, signedIn: !!readGeminiLogin(), email: ident.email, plan: ident.plan };
}

/** Test seam: forget every cached reading. */
export function resetGeminiCaches(): void {
  usageCache = null;
  planCache = null;
  loginRefreshAt = 0;
  demandAt = 0;
  versionCache = null;
}
