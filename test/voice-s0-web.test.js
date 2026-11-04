// Settings › Connections › Notifications carries the notify.whatsappJid field:
// saved through POST /config/notify, the paired account's own JID offered.
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

const web = (p) => path.resolve(import.meta.dir, '../web/src', p);
const read = (p) => fs.readFileSync(web(p), 'utf8');

test('the WhatsApp target field: own JIDs suggested, save goes to /config/notify, searchable', () => {
  const src = read('components/settings/Connections.jsx');
  expect(src).toContain('data-notify-jid');
  expect(src).toContain("api.post('/config/notify', { whatsappJid: jid.trim() })");
  expect(src).toContain('wa?.ownJids?.phone');
  expect(src).toContain('<Notifications wa={wa} />');
  expect(read('components/settings/Find.jsx')).toContain("['settings.notify.whatsapp', 'connections', 'notifications'");
  for (const loc of ['en', 'he']) {
    const l = read(`locales/${loc}.js`);
    for (const k of ['settings.notify.whatsapp', 'settings.notify.whatsapp.hint', 'settings.notify.whatsapp.useMine', 'settings.notify.whatsapp.save']) expect(l).toContain(`'${k}':`);
  }
});
