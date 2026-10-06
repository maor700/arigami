// Folder (= project) names are unique: trimmed, whitespace-collapsed, case-insensitive.
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runInChild } from './_child.js';

function isolatedEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-fold-'));
  return { env: { ARIGAMI_DIR: dir, ARIGAMI_STATE_FILE: path.join(dir, 'state.json') } };
}

test('createFolder refuses a name that exists (any case / spacing); resolveSessionFolder reuses it', () => {
  const { env } = isolatedEnv();
  const r = runInChild(
    `
    const st = await import('./server/state.js');
    st.load?.();
    const a = st.createFolder({ name: 'CR' });
    let dup = null;
    for (const n of ['CR', ' cr ', 'Cr']) {
      try { st.createFolder({ name: n }); dup = 'created'; } catch (e) { dup = e.name + ':' + (e.existingId === a.id); }
    }
    emit({ dup });
    emit({ same: st.resolveSessionFolder({ folderName: '  cr' }) === a.id });
    emit({ count: st.listFolders().length });
    `,
    env
  );
  expect(r.ok).toBe(true);
  expect(r.out[0].dup).toBe('FolderNameTakenError:true');
  expect(r.out[1].same).toBe(true);
  expect(r.out[2].count).toBe(1);
});

test('patchFolder refuses renaming onto another folder, allows renaming to its own name; uniqueFolderName suffixes', () => {
  const { env } = isolatedEnv();
  const r = runInChild(
    `
    const st = await import('./server/state.js');
    st.load?.();
    const a = st.createFolder({ name: 'CR' });
    const b = st.createFolder({ name: 'Triage' });
    let clash = null;
    try { st.patchFolder(b.id, { name: 'cr' }); clash = 'renamed'; } catch (e) { clash = e.name; }
    const self = st.patchFolder(a.id, { name: 'CR' }); // its own name is fine
    emit({ clash, self: self?.name, u1: st.uniqueFolderName('CR'), u2: st.uniqueFolderName('Fresh') });
    st.createFolder({ name: 'CR (2)' });
    emit({ u3: st.uniqueFolderName('CR') });
    `,
    env
  );
  expect(r.ok).toBe(true);
  expect(r.out[0]).toEqual({ clash: 'FolderNameTakenError', self: 'CR', u1: 'CR (2)', u2: 'Fresh' });
  expect(r.out[1].u3).toBe('CR (3)');
});
