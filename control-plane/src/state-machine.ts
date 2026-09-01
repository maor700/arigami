// Tenant lifecycle state machine (PRD-ARIGAMI-K8S.md §2):
//   provisioning → running → dormant → archived → deleted
//
// K8S-2 only drives provisioning→running (the provisioner) and the two
// admin actions (suspend→dormant, delete→deleted from anywhere). The
// dormant→archived and archived→deleted edges exist here because the schema
// asked for them, but nothing AUTOMATES them yet — that's K8S-3 (dormancy
// automation / reconcile). Documented, not a contradiction: an edge being
// legal in the state machine is not the same as something driving it today.
export type TenantState = 'provisioning' | 'running' | 'dormant' | 'archived' | 'deleted';

export const TENANT_STATES: readonly TenantState[] = ['provisioning', 'running', 'dormant', 'archived', 'deleted'];

// Adjacency list of legal forward/lateral edges. `deleted` is reachable from
// every non-deleted state (an admin can delete a tenant at any point in its
// life; provisioner failures also route here) but is otherwise terminal —
// nothing transitions OUT of deleted.
const EDGES: Record<TenantState, TenantState[]> = {
  provisioning: ['running', 'deleted'],
  running: ['dormant', 'deleted'],
  dormant: ['running', 'archived', 'deleted'],
  archived: ['running', 'deleted'],
  deleted: [],
};

export function canTransition(from: TenantState, to: TenantState): boolean {
  if (from === to) return false;
  return (EDGES[from] || []).includes(to);
}

export class IllegalTransitionError extends Error {
  constructor(from: TenantState, to: TenantState) {
    super(`illegal tenant state transition: ${from} -> ${to}`);
    this.name = 'IllegalTransitionError';
  }
}

// Throwing variant for call sites that should never see an illegal edge
// silently ignored (the provisioner, the admin routes).
export function transition(from: TenantState, to: TenantState): TenantState {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);
  return to;
}
