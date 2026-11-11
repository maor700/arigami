// The PR tab's checks (server/assets/card.jsx): what a failed GitHub Actions job printed, and re-running a run's
// failed jobs — with the host's gh login. Other check providers (deploy previews, visual tests) only link out.
import { execFile } from 'node:child_process';

const gh = (args: string[], input?: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const child = execFile('gh', args, { timeout: 45000, maxBuffer: 64 * 1024 * 1024 }, (err, out, errOut) =>
      err ? reject(new Error(String(errOut || err.message).trim().slice(0, 300))) : resolve(String(out))
    );
    if (input !== undefined) child.stdin?.end(input);
  });

/** `https://github.com/<o>/<r>/actions/runs/<run>/job/<job>` → its ids; anything else is not an Actions job. */
export function actionsIds(url: string): { runId: string; jobId: string } | null {
  const m = /\/actions\/runs\/(\d+)\/job\/(\d+)/.exec(String(url || ''));
  return m ? { runId: m[1], jobId: m[2] } : null;
}

/**
 * The part of a job's log worth reading: every `##[error]` line with the lines that led to it (timestamps and colour
 * codes removed), or the tail when the job marked no error.
 */
export function logExcerpt(raw: string, before = 12, cap = 160): { lines: string[]; errors: number } {
  const lines = String(raw || '')
    .split('\n')
    .map((l) => l.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/^﻿?\d{4}-\d\d-\d\dT[\d:.]+Z ?/, '').replace(/\r$/, ''));
  const errorAt = lines.map((l, i) => (/##\[error\]/.test(l) ? i : -1)).filter((i) => i >= 0);
  if (!errorAt.length) return { lines: lines.filter((l) => l.trim()).slice(-40), errors: 0 };
  const keep = new Set<number>();
  for (const i of errorAt) for (let k = Math.max(0, i - before); k <= i; k++) keep.add(k);
  const out: string[] = [];
  let last = -2;
  for (const i of [...keep].sort((a, b) => a - b)) {
    if (i !== last + 1 && out.length) out.push('…');
    out.push(lines[i].replace('##[error]', '✕ '));
    last = i;
  }
  return { lines: out.slice(-cap), errors: errorAt.length };
}

export async function jobLog(owner: string, repo: string, jobId: string) {
  return logExcerpt(await gh(['api', '--allow-escape-sequences', `repos/${owner}/${repo}/actions/jobs/${jobId}/logs`]));
}

export async function rerunFailed(owner: string, repo: string, runId: string): Promise<void> {
  await gh(['api', '-X', 'POST', `repos/${owner}/${repo}/actions/runs/${runId}/rerun-failed-jobs`]);
}
