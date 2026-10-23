// VAULT1 — "automatic" sign-ins: a site the owner marked "remember this choice" after filling it from the vault is
// filled again without a tap, by whichever cockpit tab has the vault unlocked — only with exactly one saved entry for
// that exact origin. Anything else (locked vault, no entry, two accounts) leaves the card up for the owner.
import { useEffect, useRef } from 'react';
import { useStore } from '../lib/store.js';
import { useVault, matchVault, fillFromVault } from '../lib/vault.js';

export default function VaultAutoFill() {
  const { sessions } = useStore();
  const vault = useVault();
  const tried = useRef(new Set());
  useEffect(() => {
    if (!vault.unlocked) return;
    for (const s of sessions || []) {
      const r = s.credentialRequest;
      if (!r || r.pref !== 'auto' || tried.current.has(r.requestId)) continue;
      tried.current.add(r.requestId);
      matchVault(r.origin)
        .then((m) => {
          const exact = m.filter((x) => x.exact);
          if (exact.length !== 1) return;
          return fillFromVault({ sessionId: s.id, requestId: r.requestId, origin: r.origin, fields: r.fields, entryId: exact[0].id, remember: true, auto: true });
        })
        .catch(() => { /* the card stays up; the owner answers it */ });
    }
  }, [sessions, vault.unlocked]);
  return null;
}
