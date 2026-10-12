// Pure logic of the repo status screens (components/setup/RepoList.jsx) — no DOM, unit-testable.
// The server (GET /__api/onboarding/repos) reports one entry per REGISTERED repo with a real `state`:
//   cloned | not_cloned | cloning | failed   (+ progress while cloning, error/errorCode when failed).

/** How one repo row renders. */
export function repoRowModel(r) {
  const state = r?.state || (r?.present ? 'cloned' : 'not_cloned');
  const needsGit = state === 'failed' && r?.errorCode === 'git_auth_missing';
  return {
    state,
    pill: state === 'cloned' ? 'ok' : state === 'cloning' ? 'running' : state === 'failed' ? 'failed' : 'todo',
    canClone: state === 'not_cloned' || state === 'failed',
    cloneKey: state === 'failed' ? 'setup.repo.retry' : r?.local ? 'setup.repo.copy' : 'setup.repo.download',
    needsGit,
    // The text for a failure: our own sentence for the known cause (translated), git's message otherwise.
    errorKey: needsGit ? 'setup.repo.err.gitMissing' : state === 'failed' && r?.errorCode === 'git_auth_rejected' ? 'setup.repo.err.gitRejected' : null,
    errorRaw: state === 'failed' ? r?.error || '' : '',
    progress: state === 'cloning' ? r?.progress || '' : '',
  };
}

/** The wizard's repo step is done only when at least one registered repo is actually on disk. */
export const anyCloned = (repos) => (repos || []).some((r) => repoRowModel(r).state === 'cloned');

/** Keep polling while any clone is in flight. */
export const anyCloning = (repos) => (repos || []).some((r) => r?.state === 'cloning');

/** Names whose state just became 'cloned' (so the wizard can refresh its step state). */
export function newlyCloned(prev, next) {
  const was = new Map((prev || []).map((r) => [r.name, r.state]));
  return (next || []).filter((r) => r.state === 'cloned' && was.has(r.name) && was.get(r.name) !== 'cloned').map((r) => r.name);
}

/** What to tell the user after "add": the response of POST /onboarding/repos. */
export function addOutcome(res) {
  if (res?.existing && (res.state === 'cloned' || res.present)) return 'already';
  if (res?.existing) return 'cloning-existing';
  return 'added';
}
