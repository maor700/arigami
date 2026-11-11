// VAULT4 end-to-end (test/_vault-card-chrome.ts in a child, its own ARIGAMI_DIR): a real host, a real Chrome as the
// session browser on a local form, a real Chrome as the owner's cockpit tab running the built web/dist and the vault
// worker, and the agent's blocking vault_fill. What the owner sees on the card and what the agent gets, with the vault
// locked, after one unlock, under the one-time grant, and on another origin. Skipped where no Chrome is installed, and
// where the cockpit is not built.
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpDir } from './_tmp.js';
import { findChromeBin } from '../server/lib/platform.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const chrome = findChromeBin();
const built = fs.existsSync(path.join(ROOT, 'web', 'dist', 'index.html'));

test.skipIf(!chrome || !built)('the vault card: a locked vault is said and Fill answers; one unlock fills, its grant (one entry, named fields, this session, this origin, a time) fills the next field by itself; another origin or an unlisted field waits; Stop revokes; a stale card and a dead socket are settled by the HTTP answer', () => {
  const script = "const __out=[];globalThis.emit=(o)=>__out.push(o);try{await import('./test/_vault-card-chrome.ts');process.stdout.write('\\nRESULT '+JSON.stringify(__out[0]));}catch(e){process.stdout.write('\\nERROR '+String(e&&e.stack||e));}";
  const r = spawnSync('bun', ['-e', script], { cwd: ROOT, env: { ...process.env, ARIGAMI_DIR: tmpDir('arigami-vault-e2e-'), ARIGAMI_PORT: '', E2E_ROOT: '' }, encoding: 'utf8', timeout: 260_000 });
  const line = (r.stdout || '').split('\n').find((l) => l.startsWith('RESULT ') || l.startsWith('ERROR '));
  if (!line || line.startsWith('ERROR ')) throw new Error(`child: ${line || r.stdout?.slice(-500)} ${r.stderr?.slice(-800)}`);
  const o = JSON.parse(line.slice(7));
  if (o.error) throw new Error(`fixture stopped at: ${o.error} cockpit=${JSON.stringify(o.cockpit)?.slice(0, 300)} host=${JSON.stringify(o.hostLogTail)}`);
  expect(o.vaultPut).toBe(200);
  expect(o.catalogPut).toBe(200);
  // 1. the vault is locked in the owner's tab: the card says so (the host's names-only `saved` says there is something
  //    to unlock for), the unlock row is on the card, and Fill is NOT a dead button — a real tap gets a hint, nothing is
  //    sent, the host keeps the request, the agent keeps waiting
  expect(o.cardLocked).toMatchObject({ fillDisabled: false, state: 'locked', unlockRow: true, fillFrom: [], grant: false, error: null });
  expect(o.afterFillTap.error).toMatch(/Type the id_number first, or unlock the vault/);
  expect(o.stillPendingAfterTap).toBe(true);
  expect(o.fill1Early).toBe('pending');
  // 2. the master typed on the card: the saved entry's button and the grant tick appear; one tap fills the marked field
  //    (masked), the card goes, the agent hears "filled" — and never the value
  expect(o.cardUnlocked).toMatchObject({ fillFrom: ['Dana'], grant: true, unlockRow: false });
  // the tick says, in one line, what it would allow: the entry's field NAMES, this session by name, this host, the time — and that later fields are out
  expect(o.grantText).toContain('Dana: id_number · Visa: card_number, expiry · Visa CVV: cvv'); // every entry of the origin, names only
  expect(o.grantText).toContain('still by tap: phone'); // saved in two entries → the owner picks each time
  expect(o.grantText).toContain('“vault e2e”');
  expect(o.grantText).toContain('127.0.0.1');
  expect(o.grantText).toMatch(/up to 30 min/);
  expect(o.grantText).toMatch(/Nothing saved later is included/);
  expect(o.fill1).toMatchObject({ status: 'filled', field: 'id_number', where: 'session-browser' });
  expect(o.page1).toEqual({ id: '123456782', masked: 'disc', phone: '' });
  expect(o.cardGoneAfterFill).toBe(true);
  // 3. one approval, three entries: cvv (its own entry, the agent's hint "Dana" ignored), the card number and the expiry's
  //    month (into the select, inert afterwards) land with no tap, within seconds; the ambiguous phone waits for the owner
  expect(o.fill2).toMatchObject({ status: 'filled', field: 'cvv' });
  expect(o.fill2Ms).toBeLessThan(10_000);
  expect(o.page2).toEqual({ cvv: '321', masked: 'disc' });
  expect(o.fillCard).toMatchObject({ status: 'filled', field: 'card_number' });
  expect(o.fillExp).toMatchObject({ status: 'filled', field: 'expiry' });
  expect(o.pageCard).toEqual({ cn: '4111111111111111', month: '3', inert: true });
  expect(o.cardAmb).toMatchObject({ fillFrom: ['Dana'], grantOn: true, autoError: null }); // the agent's hint narrows what the owner is offered to TAP — it never picks for the automatic fill
  expect(o.fillAmbEarly).toBe('pending');
  expect(o.pageAmb).toBe('');
  expect(o.fillAmb).toMatchObject({ status: 'cancelled', field: 'phone' });
  expect(o.grantLine).toBe(true);
  expect(o.leak).toBe(false);
  // 4. another origin of the same server (localhost): no entry, no grant — the card waits for the owner and says
  //    nothing is saved for this address; Cancel comes back to the agent as one reason, the page stays empty
  expect(o.otherPending).toBe(true);
  expect(o.card3).toMatchObject({ state: 'noEntry', fillFrom: [], grant: false, grantOn: false, fillDisabled: false });
  expect(o.fill3Early).toBe('pending');
  expect(o.fill3).toMatchObject({ status: 'cancelled', field: 'id_number', host: 'localhost' });
  expect(o.page3).toBe('');
  // 4b. G-1: the entry also holds a sign-in (username + password); the grant's text does not list them, and a vault_fill
  //     for `password` under the live grant is NOT automatic — the card waits with the saved entry's button, nothing lands
  expect(o.grantText).not.toMatch(/password|username/);
  expect(o.cardRole).toMatchObject({ fillFrom: ['Dana'], grantOn: true, autoError: null });
  expect(o.fillPwEarly).toBe('pending');
  expect(o.pageRole).toBe('');
  expect(o.fillPw).toMatchObject({ status: 'cancelled', field: 'password' });
  // 5. a field the grant does not name (email — never on the entry): no automatic fill, the card waits and still shows the
  //    grant; Stop revokes it (the line goes); Cancel reaches the agent
  expect(o.card5).toMatchObject({ grantOn: true, fillFrom: [], state: 'noEntry' });
  expect(o.fill5Early).toBe('pending');
  expect(o.card5AfterStop).toMatchObject({ grantOn: false });
  expect(o.fill5).toMatchObject({ status: 'cancelled', field: 'email' });
  // 5b. the vault worker dies under the owner's tap (terminated + unreachable): the tap fails with one reason, no button
  //     stays busy, the card asks for the vault password again (the worker is gone, so the vault counts as locked), the
  //     owner unlocks and taps once more, the agent — still waiting — gets "filled"
  expect(o.workersKilled).toBeGreaterThan(0);
  expect(o.cardWorkerDead.error).toMatch(/^the vault worker could not be reached — unlock the vault again/); // a fixed phrase: no raw error, no value
  expect(o.cardWorkerDead.done).toBe('failed');
  // the TOOL ends now — blocked, with the fixed line of the filtered code — not "expired" ten minutes later
  expect(o.fillW).toMatchObject({ status: 'blocked', field: 'id_number', host: '127.0.0.1' });
  expect(o.fillW.reason).toMatch(/failed in the owner's cockpit: the owner's vault worker could not be reached; nothing was filled/);
  expect(o.fillW.next).toMatch(/call vault_fill\(\{site:"127\.0\.0\.1", field:"id_number"\}\) once more/);
  // 5c. the same, with NO tap: under a fresh grant the AUTOMATIC fill meets a dead worker → the card shows the miss, the host is
  //     acknowledged by code for that exact request, the agent's tool ends blocked within seconds; the field stays empty
  expect(o.autoDead).toMatchObject({ status: 'blocked', field: 'cvv' });
  expect(o.autoDead.reason).toMatch(/vault worker could not be reached/);
  expect(o.autoDeadMs).toBeLessThan(10_000);
  expect(o.pageAutoDead).toBe('');
  expect(o.cardAutoDead === null || o.cardAutoDead.autoError).toBeTruthy();
  // the vault counts as locked in that tab; the agent's next request shows the unlock row; after the unlock nothing is stuck on busy; the tap fills
  expect(o.cardWorkerRetry.unlockRow).toBe(true);
  expect(o.busyAfterWorkerDeath).toEqual([false, false, false]); // Cancel, I'll type it myself, Fill from Dana
  expect(o.fillW2).toMatchObject({ status: 'filled', field: 'id_number' });
  expect(o.pageW).toBe('123456782');
  // 6. two cockpit tabs; A's socket is cut, B fills: the agent is served once; A's stale copy, tapped, is told by the HTTP
  //    answer that the request is gone — outcome shown, nothing left to press, nothing filled twice
  expect(o.fill6).toMatchObject({ status: 'filled', field: 'id_number' });
  expect(o.bCardGone).toBe(true);
  expect(o.aStale).toMatchObject({ fillFrom: ['Dana'] });
  expect(o.aAfterStaleTap).toMatchObject({ done: 'gone', buttons: 0 });
  expect(o.aAfterStaleTap.error).toMatch(/no longer open/);
  expect(o.page6).toBe('123456782');
  // 7. B's socket is cut too: its tap lands over HTTP, the agent hears "filled", and the card settles itself on the answer
  expect(o.fill7).toMatchObject({ status: 'filled', field: 'cvv' });
  expect(o.bDone).toMatchObject({ done: 'filled', buttons: 0 });
  expect(o.page7).toBe('321');
}, 280_000);
