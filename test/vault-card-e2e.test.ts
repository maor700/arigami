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

test.skipIf(!chrome || !built)('the vault card: a locked vault is said and Fill answers; one unlock fills, and its grant fills the next field of the same session + origin by itself — another origin waits for the owner', () => {
  const script = "const __out=[];globalThis.emit=(o)=>__out.push(o);try{await import('./test/_vault-card-chrome.ts');process.stdout.write('\\nRESULT '+JSON.stringify(__out[0]));}catch(e){process.stdout.write('\\nERROR '+String(e&&e.stack||e));}";
  const r = spawnSync('bun', ['-e', script], { cwd: ROOT, env: { ...process.env, ARIGAMI_DIR: tmpDir('arigami-vault-e2e-'), ARIGAMI_PORT: '', E2E_ROOT: '' }, encoding: 'utf8', timeout: 170_000 });
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
  expect(o.fill1).toMatchObject({ status: 'filled', field: 'id_number', where: 'session-browser' });
  expect(o.page1).toEqual({ id: '123456782', masked: 'disc', phone: '' });
  expect(o.cardGoneAfterFill).toBe(true);
  // 3. the next field, same session + exact origin: filled with no tap, within seconds; the card that flashed up shows
  //    the grant; the chat says it was the owner's one-time approval
  expect(o.fill2).toMatchObject({ status: 'filled', field: 'phone' });
  expect(o.fill2Ms).toBeLessThan(10_000);
  expect(o.page2).toEqual({ phone: '0500000000', masked: 'disc' });
  expect(o.grantLine).toBe(true);
  expect(o.leak).toBe(false);
  // 4. another origin of the same server (localhost): no entry, no grant — the card waits for the owner and says
  //    nothing is saved for this address; Cancel comes back to the agent as one reason, the page stays empty
  expect(o.otherPending).toBe(true);
  expect(o.card3).toMatchObject({ state: 'noEntry', fillFrom: [], grant: false, grantOn: false, fillDisabled: false });
  expect(o.fill3Early).toBe('pending');
  expect(o.fill3).toMatchObject({ status: 'cancelled', field: 'id_number', host: 'localhost' });
  expect(o.page3).toBe('');
}, 180_000);
