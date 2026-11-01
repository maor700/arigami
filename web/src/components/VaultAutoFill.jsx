// VAULT1 — "automatic" sign-ins: a site the owner marked "remember this choice" after filling it from the vault is
// filled again without a tap, by whichever cockpit tab has the vault unlocked — only with exactly one saved entry for
// that exact origin. Anything else (locked vault, no entry, two accounts) leaves the card up for the owner.
// VAULT4 — named fields (kind 'field') are automatic ONLY under this tab's one-time grant for that session + exact
// origin (lib/vault-grants.js): exactly one matching entry → filled with auto+grant; a miss or an error leaves the card
// up and says why. A form, a sign-in's "remember" choice and the owner's Chrome (target 'shared') never get this.
import { useEffect, useRef } from 'react';
import { useStore } from '../lib/store.js';
import { useVault, matchVault, fillFromVault, matchVaultField, fillVaultField } from '../lib/vault.js';
import { coversRequest, noteAuto, pruneGrants, grantCount } from '../lib/vault-grants.js';

export default function VaultAutoFill() {
  const { sessions } = useStore();
  const vault = useVault();
  const tried = useRef(new Set());
  useEffect(() => {
    // a grant dies with its session
    if (grantCount() && Array.isArray(sessions) && sessions.length) pruneGrants(sessions.map((s) => s.id));
    if (!vault.unlocked) return;
    for (const s of sessions || []) {
      const r = s.credentialRequest;
      if (!r || tried.current.has(r.requestId)) continue;
      if (r.kind === 'field') {
        if (!coversRequest(s.id, r)) continue;
        tried.current.add(r.requestId);
        const field = r.fields[0];
        matchVaultField(r.origin, field, r.entry)
          .then((m) => {
            if (m.length !== 1) throw new Error(m.length ? `${m.length} saved entries hold ${field} for this site — pick one` : `no saved ${field} for this exact address`);
            return fillVaultField({ sessionId: s.id, requestId: r.requestId, origin: r.origin, field, entryId: m[0].id, ...(r.part && r.part !== 'value' ? { part: r.part } : {}), auto: true, grant: true });
          })
          .then(() => noteAuto(r.requestId, null))
          .catch((e) => noteAuto(r.requestId, e?.message || e)); // the card stays up and shows this
        continue;
      }
      // a sign-in: only the per-site "remember" choice, as before (a form is the owner's to fill)
      if (r.pref !== 'auto' || r.kind) continue;
      tried.current.add(r.requestId);
      matchVault(r.origin)
        .then((m) => {
          const exact = m.filter((x) => x.exact);
          if (exact.length !== 1) return;
          return fillFromVault({ sessionId: s.id, requestId: r.requestId, origin: r.origin, fields: r.fields, entryId: exact[0].id, remember: true, auto: true, exact: r.target === 'shared' });
        })
        .catch(() => { /* the card stays up; the owner answers it */ });
    }
  }, [sessions, vault.unlocked]);
  return null;
}
