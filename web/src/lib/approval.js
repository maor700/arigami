// ONE approve action (docs/REVIEW-AND-MERGE.md): the review card's button and
// the Changes tab's button are the same action with the same label. The host
// decides what approving means for the session (server/lib/review-approval.ts);
// these helpers only render it.

// 'verified' = the value of review cards raised before the rename.
export const isApproveValue = (v) => v === 'approve' || v === 'verified';

// Mirror of the host's approvalCurrent: is the session's approval stamp about
// what is under review now? `approval` = the review card's {mode, sha}.
export function approvalIsCurrent(md, approval, actionAt) {
  const r = md?.review;
  if (r?.state !== 'approved') return false;
  const mode = approval?.mode || 'local';
  if (mode === 'pr-review' ? r.target !== 'github' : r.target === 'github') return false;
  if (r.sha || approval?.sha) return !!r.sha && r.sha === approval?.sha;
  return !actionAt || String(r.at || '') >= String(actionAt);
}

// What Approve will do here — one line under the button: [i18n key, params].
export function approveEffect(approval) {
  const a = approval || {};
  if (a.mode === 'pr-review') return ['chat.approveEffectPrReview', { n: a.pr }];
  if (a.mode === 'pr-own') return ['chat.approveEffectPrOwn', { n: a.pr }];
  if (a.mode === 'unknown') return ['chat.approveEffectUnknown', { n: a.pr }];
  if (a.branch && a.base) return ['chat.approveEffectBranch', { branch: a.branch, base: a.base }];
  return ['chat.approveEffectLocal', {}];
}
