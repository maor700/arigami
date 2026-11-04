// notify.whatsappJid settings surface: updateNotifyConfig persists + patches the
// live cfg; ownJids() reads the paired account from creds.json (device suffix dropped).
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { runInChild } from './_child.js';
import { tmpDir } from './_tmp.js';

test('updateNotifyConfig writes config.json and the live cfg; empty clears', () => {
  const dir = tmpDir('arigami-notify-cfg-');
  const r = runInChild(
    `
    const c = await import('./server/lib/config.js');
    const a = c.updateNotifyConfig({ whatsappJid: '972500000000@s.whatsapp.net' });
    const live = c.cfg.notify.whatsappJid;
    const file = JSON.parse(require('node:fs').readFileSync(process.env.ARIGAMI_DIR + '/config.json', 'utf8'));
    const b = c.updateNotifyConfig({ whatsappJid: '' });
    emit({ a, live, file: file.notify, port: file.port, b, liveAfter: c.cfg.notify.whatsappJid });
    `,
    { ARIGAMI_DIR: dir, ARIGAMI_STATE_FILE: path.join(dir, 'state.json') }
  );
  expect(r.ok).toBe(true);
  const o = r.out[0];
  expect(o.a).toEqual({ whatsappJid: '972500000000@s.whatsapp.net' });
  expect(o.live).toBe('972500000000@s.whatsapp.net');
  expect(o.file).toEqual({ whatsappJid: '972500000000@s.whatsapp.net' });
  expect(o.port).toBeDefined(); // the rest of the file survived the merge
  expect(o.b).toEqual({ whatsappJid: '' });
  expect(o.liveAfter).toBe('');
});

test('ownJids: paired → phone + lid without the device suffix; unpaired → null', () => {
  const dir = tmpDir('arigami-ownjid-');
  const wa = path.join(dir, 'wa');
  fs.mkdirSync(path.join(wa, 'auth_info'), { recursive: true });
  fs.writeFileSync(path.join(wa, 'auth_info/creds.json'), JSON.stringify({ me: { id: '972500000000:12@s.whatsapp.net', lid: '123456789:3@lid', name: 'Me' } }));
  const env = { ARIGAMI_DIR: dir, ARIGAMI_STATE_FILE: path.join(dir, 'state.json'), ARIGAMI_WA_MCP_DIR: wa, ARIGAMI_WA_DATA_DIR: path.join(wa, 'data') };
  const r = runInChild("const wb = await import('./server/whatsapp-bridge.js'); emit(wb.ownJids());", env);
  expect(r.ok).toBe(true);
  expect(r.out[0]).toEqual({ phone: '972500000000@s.whatsapp.net', lid: '123456789@lid' });
  const bare = runInChild("const wb = await import('./server/whatsapp-bridge.js'); emit({ own: wb.ownJids() });", { ...env, ARIGAMI_WA_MCP_DIR: path.join(dir, 'none') });
  expect(bare.ok).toBe(true);
  expect(bare.out[0].own).toBe(null);
});
