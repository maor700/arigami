// K8S-3 — what to show a user while their workspace is being built.
//
// The old "starting" page was a meta-refresh with no information: the user
// stared at one sentence for a minute with no idea whether anything was
// happening, then got dropped on a pairing screen. This module supplies the
// REAL state behind a progress view, read from Kubernetes itself — no fake
// timers, no invented percentages. If we cannot tell two phases apart from
// what k8s reports, they are ONE step with an honest label rather than two
// that pretend to know.
//
// Split on purpose: `podSnapshot` does the IO (two cheap kubectl reads),
// `stepsFor` is pure and is what the tests drive.
import type { Config } from './config.js';
import type { Tenant } from './db.js';
import { fullname, tenantPod } from './provisioner.js';

export type StepState = 'done' | 'active' | 'pending' | 'failed';
export interface Step {
  key: string;
  label: string;
  state: StepState;
}

export interface PodSnapshot {
  exists: boolean;
  /** Pending | Running | Succeeded | Failed | Unknown */
  phase: string;
  ready: boolean;
  /** ContainerCreating | ImagePullBackOff | ErrImagePull | CrashLoopBackOff | '' */
  waitingReason: string;
  /** the org bundle finished applying (read from the host's own boot log) */
  bundleApplied: boolean;
  /** operator-facing detail for a stuck pod */
  message: string;
}

export const EMPTY_SNAPSHOT: PodSnapshot = { exists: false, phase: '', ready: false, waitingReason: '', bundleApplied: false, message: '' };

/** How long before we stop saying "nearly there" and admit something is wrong. */
export const SLOW_MS = 4 * 60_000;

async function run(cmd: string[], timeoutMs = 8000): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => {
    try { proc.kill(); } catch {}
  }, timeoutMs);
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  return { code, stdout, stderr };
}

/**
 * Live pod state. Best-effort by design: this feeds a progress page, so any
 * failure degrades to "we cannot see it yet" (the generic starting view),
 * never to an error the user has to care about.
 */
export async function podSnapshot(cfg: Config, t: Tenant): Promise<PodSnapshot> {
  const res = await run(['kubectl', '-n', t.ns, 'get', 'pod', tenantPod(t.ns), '-o', 'json']);
  if (res.code !== 0) return { ...EMPTY_SNAPSHOT };
  let pod: any;
  try { pod = JSON.parse(res.stdout); } catch { return { ...EMPTY_SNAPSHOT }; }

  const status = pod?.status || {};
  const cs = (status.containerStatuses || [])[0] || {};
  const waiting = cs.state?.waiting || {};
  const snap: PodSnapshot = {
    exists: true,
    phase: String(status.phase || ''),
    ready: !!cs.ready,
    waitingReason: String(waiting.reason || ''),
    bundleApplied: false,
    message: String(waiting.message || status.message || ''),
  };

  // Only once the container is actually running is there a host log to read —
  // and only then can we tell "booting" from "applying the org bundle", which
  // is the slowest and most reassuring-to-name part of a first boot.
  if (snap.phase === 'Running' && !snap.ready) {
    const logs = await run(['kubectl', '-n', t.ns, 'logs', tenantPod(t.ns), '--tail=20']);
    if (logs.code === 0) snap.bundleApplied = /ARIGAMI_BUNDLE (applied|apply failed)/.test(logs.stdout);
  }
  return snap;
}

export interface Progress {
  /** machine-readable stage, for the client to decide when to redirect */
  phase: 'queued' | 'space' | 'image' | 'starting' | 'configuring' | 'ready' | 'stuck' | 'unavailable';
  steps: Step[];
  /** honest headline shown above the steps */
  title: string;
  detail: string;
  slow: boolean;
  failed: boolean;
}

// Order matters and follows what actually happens in the pod: the org bundle
// is applied by the host DURING boot, before it ever starts listening
// (server/index.ts calls applyBundleEnv before server.listen), so "configure"
// precedes "start" — the workspace answering is the LAST thing to happen.
const STEP_LABELS: [string, string][] = [
  ['account', 'Your account'],
  ['space', 'Reserving your private space'],
  ['image', 'Fetching the workspace image'],
  ['configure', 'Applying your organisation’s setup'],
  ['start', 'Starting your workspace'],
];

function build(active: string | null, doneThrough: number, failedKey?: string): Step[] {
  return STEP_LABELS.map(([key, label], i) => {
    if (key === failedKey) return { key, label, state: 'failed' as StepState };
    if (i < doneThrough) return { key, label, state: 'done' as StepState };
    if (key === active) return { key, label, state: 'active' as StepState };
    return { key, label, state: 'pending' as StepState };
  });
}

/**
 * Pure: (tenant state, pod snapshot, elapsed) → what the page shows. Every
 * branch here is a state Kubernetes actually reports; nothing is inferred from
 * a timer except `slow`, which only ever adds a caveat, never progress.
 */
export function stepsFor(state: string, snap: PodSnapshot, elapsedMs: number, orgName = 'your organisation'): Progress {
  const slow = elapsedMs > SLOW_MS;
  const configureLabel = `Applying ${orgName}’s setup`;
  const withOrg = (p: Progress): Progress => ({
    ...p,
    steps: p.steps.map((s) => (s.key === 'configure' ? { ...s, label: configureLabel } : s)),
  });

  if (state === 'running')
    return withOrg({
      phase: 'ready',
      steps: build(null, STEP_LABELS.length),
      title: 'Your workspace is ready',
      detail: 'Taking you in…',
      slow: false,
      failed: false,
    });

  if (state !== 'provisioning' && state !== 'dormant')
    return withOrg({
      phase: 'unavailable',
      steps: build(null, 1),
      title: `Your workspace is ${state}`,
      detail: 'Contact your organisation admin to reactivate it.',
      slow: false,
      failed: true,
    });

  // A pod that cannot pull its image never resolves on its own — say so
  // instead of spinning a hopeful spinner for five minutes.
  if (/ImagePullBackOff|ErrImagePull|InvalidImageName/.test(snap.waitingReason))
    return withOrg({
      phase: 'stuck',
      steps: build(null, 2, 'image'),
      title: 'Your workspace could not start',
      detail: 'The workspace image could not be fetched. This needs an administrator — they can see the details in the tenant list.',
      slow,
      failed: true,
    });

  if (/CrashLoopBackOff/.test(snap.waitingReason))
    return withOrg({
      phase: 'stuck',
      steps: build(null, 3, 'start'),
      title: 'Your workspace keeps restarting',
      detail: 'It started but did not stay up. This needs an administrator.',
      slow,
      failed: true,
    });

  if (!snap.exists)
    return withOrg({
      phase: 'space',
      steps: build('space', 1),
      title: 'Setting up your workspace',
      detail: 'Reserving a private, isolated space for your account.',
      slow,
      failed: false,
    });

  if (snap.phase === 'Pending' || snap.waitingReason === 'ContainerCreating' || snap.waitingReason === 'PodInitializing')
    return withOrg({
      phase: 'image',
      steps: build('image', 2),
      title: 'Setting up your workspace',
      detail: 'Fetching the workspace image. First-time setups take the longest here.',
      slow,
      failed: false,
    });

  if (snap.phase === 'Running' && !snap.ready)
    return snap.bundleApplied
      ? withOrg({
          phase: 'starting',
          steps: build('start', 4),
          title: 'Almost there',
          detail: 'Your settings are in place — waiting for the workspace to answer.',
          slow,
          failed: false,
        })
      : withOrg({
          phase: 'configuring',
          steps: build('configure', 3),
          title: 'Setting up your workspace',
          detail: 'Installing your organisation’s skills, agents and repositories.',
          slow,
          failed: false,
        });

  // Pod says Ready but the tenant row has not flipped yet: the provisioner is
  // still finishing `helm --wait`. Real, brief, and worth naming.
  if (snap.ready)
    return withOrg({
      phase: 'starting',
      steps: build('start', 4),
      title: 'Almost there',
      detail: 'Finishing the last checks.',
      slow,
      failed: false,
    });

  return withOrg({
    phase: 'queued',
    steps: build('space', 1),
    title: 'Setting up your workspace',
    detail: 'Getting started…',
    slow,
    failed: false,
  });
}
