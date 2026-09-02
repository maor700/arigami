// B32 — which ORCHESTRATION.json is THIS controller's plan?
//
// Masters write their durable plan to their cwd (dispatch / project-manager
// skills). Every project controller runs in the same cwd (the repos dir), so a
// plain `<cwd>/ORCHESTRATION.json` is whichever controller wrote last — the
// Orchestration tab of one project showed another project's nodes. Resolution
// now prefers a per-session file and only accepts the shared one when it can
// be tied to this session (or nobody else could own it).
import fs from 'node:fs';
import path from 'node:path';

export const MAX_PLAN_BYTES = 256 * 1024;

/** `ORCHESTRATION.<sessionId>.json` — the unambiguous per-session plan file. */
export function planFileFor(dir: string, sessionId: string): string {
  return path.join(dir, `ORCHESTRATION.${sessionId}.json`);
}

/**
 * Does this plan belong to session `id`?
 *   true  — it names the session (`master` / `sessionId` / `controller`), its
 *           folder (`folderId`), or any of its children in a node
 *   false — it names a DIFFERENT session/folder, or only other people's children
 *   null  — the plan carries no ownership hint at all
 */
export function planBelongsTo(plan: any, s: { id: string; folderId?: string | null }, childIds: Set<string> = new Set()): boolean | null {
  if (!plan || typeof plan !== 'object') return null;
  const owner = [plan.master, plan.sessionId, plan.controller].find((v) => typeof v === 'string' && v);
  if (owner) return owner === s.id;
  if (typeof plan.folderId === 'string' && plan.folderId) return !!s.folderId && plan.folderId === s.folderId;
  const nodes = Array.isArray(plan.nodes) ? plan.nodes : [];
  const named = nodes.flatMap((n: any) => [n?.session, n?.sessionId, n?.worker]).filter((v: unknown): v is string => typeof v === 'string' && !!v);
  if (!named.length) return null;
  return named.some((sid: string) => childIds.has(sid));
}

function readPlanFile(file: string): { plan: unknown; planError?: string } {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    if (raw.length > MAX_PLAN_BYTES) return { plan: null, planError: `${path.basename(file)} too large` };
    return { plan: JSON.parse(raw) };
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));
    return { plan: null, planError: /ENOENT/.test(error.message) ? 'no ORCHESTRATION.json yet' : error.message };
  }
}

/**
 * Resolve the plan for a controller: `ORCHESTRATION.<id>.json` first; then the
 * shared `ORCHESTRATION.json` if it belongs to this session — or carries no
 * hint and nobody else shares this cwd (`sharedCwd=false`). A shared cwd with an
 * unattributable plan is reported, never shown as if it were ours.
 */
export function resolvePlan(
  dir: string,
  s: { id: string; folderId?: string | null },
  opts: { childIds?: Set<string>; sharedCwd?: boolean } = {},
): { plan: unknown; planError?: string; file?: string } {
  const own = planFileFor(dir, s.id);
  if (fs.existsSync(own)) return { ...readPlanFile(own), file: own };
  const shared = path.join(dir, 'ORCHESTRATION.json');
  const r = readPlanFile(shared);
  if (!r.plan) return r;
  const belongs = planBelongsTo(r.plan, s, opts.childIds);
  if (belongs === true || (belongs === null && !opts.sharedCwd)) return { ...r, file: shared };
  return {
    plan: null,
    planError: belongs === false
      ? `ORCHESTRATION.json in ${dir} belongs to another controller — write ${path.basename(own)} (or set "master": "${s.id}" in the plan)`
      : `ORCHESTRATION.json in ${dir} is shared with other controllers and names no owner — write ${path.basename(own)} (or set "master": "${s.id}" in the plan)`,
  };
}
