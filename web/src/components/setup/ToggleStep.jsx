// S2 — manual.kind 'toggle': one on/off decision (push notifications,
// remote access via tailscale serve, telemetry, desktop). `push` is a
// browser-side subscription (lib/push.js); the rest POST {enable}.
import { useState } from 'react';
import { useT } from '../../lib/i18n.js';
import * as setupApi from '../../lib/setup-api.js';
import { subscribePush, unsubscribePush } from '../../lib/push.js';
import { capFamily } from './registry.js';
import { BTN, BTN2, ErrorBox, OkLine, useAction } from './shared.jsx';

export default function ToggleStep({ capability, enabled = false, detail = '', pinned = false, onDone }) {
  const t = useT();
  const fam = capFamily(capability);
  const [on, setOn] = useState(!!enabled);
  const { busy, err, run } = useAction();

  const decide = (next) =>
    run(async () => {
      let r;
      if (fam === 'push') {
        r = next ? await subscribePush() : await unsubscribePush();
        if (next && !r) throw new Error(t('setup.toggle.pushDenied'));
      } else {
        r = await setupApi.connect(capability, { enable: next });
        if (r && r.ok === false) throw new Error(r.error || r.reason || 'failed');
      }
      setOn(next);
      onDone?.({ enabled: next, ...(r && typeof r === 'object' ? r : {}) });
    });

  const bodyKey = `setup.toggle.${['push', 'remote', 'telemetry', 'desktop'].includes(fam) ? fam : 'generic'}.body`;
  return (
    <div className="flex flex-col gap-2">
      <p className="text-[12px] leading-relaxed text-fgdim">{t(bodyKey)}</p>
      {detail && <div dir="ltr" className="font-mono text-[11.5px] md:text-[10.5px] text-fgdim">{detail}</div>}
      {on && <OkLine>{t('setup.toggle.on')}</OkLine>}
      {!pinned && (
        <div className="flex flex-wrap gap-2">
          <button type="button" className={on ? BTN2 : BTN} disabled={busy || on} onClick={() => decide(true)}>{t('setup.toggle.enable')}</button>
          <button type="button" className={BTN2} disabled={busy || !on} onClick={() => decide(false)}>{t('setup.toggle.disable')}</button>
        </div>
      )}
      <ErrorBox err={err} />
    </div>
  );
}
