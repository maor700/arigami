// Isolated design prototype; not imported by the host.
// Inputs must already be owner-authorized; this is NOT an authorization boundary.
const modes = new Set(['supervised', 'full']);

export function resolveAutonomy({ session, project, parent } = {}) {
  const entries = [['session', session], ['project', project], ['parent', parent]];
  for (const [source, mode] of entries) {
    if (mode !== undefined && !modes.has(mode)) {
      throw new TypeError(`Invalid ${source} autonomy mode`);
    }
  }
  const [source, mode] = entries.find(([, mode]) => mode !== undefined)
    ?? ['default', 'supervised'];
  return Object.freeze({ mode, source });
}

export function autonomyDirective(policy) {
  if (!modes.has(policy.mode)) throw new TypeError('Invalid autonomy mode');
  const behavior = policy.mode === 'full'
    ? 'Choose reasonable defaults and record assumptions. Do not ask workflow questions or wait for workflow approval. Complete all required checks and continue within the assigned scope. Report an indispensable missing fact or denied operation as blocked without asking for approval.'
    : 'Follow the owner’s task and applicable workflow review checkpoints.';
  return `Arigami session autonomy: ${policy.mode}. ${behavior} The owner’s explicit task restrictions and higher-priority instructions remain binding. This session policy takes precedence over conflicting skill workflow conventions, including skills read later. Never invent a human approval or bypass an enforced host restriction.`;
}

export function reviewCheckpoint(policy, { checksPassed, explicitlyRequiresHumanReview = false }) {
  if (!modes.has(policy.mode)) throw new TypeError('Invalid autonomy mode');
  if (checksPassed !== true) return { outcome: 'blocked', reason: 'checks-incomplete-or-failed' };
  if (explicitlyRequiresHumanReview || policy.mode === 'supervised') {
    return { outcome: 'await-human', source: 'owner-task-or-supervised-policy' };
  }
  return { outcome: 'continue', source: 'autonomy-policy' };
}
