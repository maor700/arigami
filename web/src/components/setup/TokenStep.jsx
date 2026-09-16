// S2 — manual.kind 'token': paste a secret (Claude setup-token / API key,
// GitHub PAT, Composio API key). The value is POSTed once and never kept in
// component state afterwards; the server verifies before storing.
import { useState } from 'react';
import { useT } from '../../lib/i18n.js';
import * as setupApi from '../../lib/setup-api.js';
import { capFamily } from './registry.js';
import { BTN, BTN2, INPUT, ErrorBox, useAction } from './shared.jsx';

export default function TokenStep({ capability, onDone, onCancel, placeholder, autoFocus = false }) {
  const t = useT();
  const [token, setToken] = useState('');
  const { busy, err, run } = useAction();
  const fam = capFamily(capability);
  const ph = placeholder || t(`setup.token.placeholder.${['claude', 'codex', 'git', 'composio'].includes(fam) ? fam : 'generic'}`);

  const save = () =>
    run(async () => {
      const r = await setupApi.connect(capability, { token: token.trim() });
      if (r && r.ok === false) throw new Error(r.error || r.detail || 'rejected');
      setToken('');
      onDone?.(r);
    });

  return (
    <div className="flex flex-col gap-2">
      <input
        className={INPUT}
        type="password"
        value={token}
        onChange={(e) => setToken(e.target.value)}
        placeholder={ph}
        spellCheck={false}
        autoComplete="off"
        autoFocus={autoFocus}
        aria-label={t('setup.token.label')}
        onKeyDown={(e) => e.key === 'Enter' && token.trim() && save()}
      />
      <div className="flex flex-wrap gap-2">
        <button type="button" className={BTN} disabled={busy || !token.trim()} onClick={save}>
          {busy ? t('setup.token.saving') : t('setup.token.save')}
        </button>
        {onCancel && <button type="button" className={BTN2} onClick={onCancel}>{t('setup.cancel')}</button>}
      </div>
      <ErrorBox err={err} />
    </div>
  );
}
