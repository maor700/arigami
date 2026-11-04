// S2 — manual.kind 'token': paste a secret (Claude setup-token / API key,
// GitHub PAT, Composio API key). The value is POSTed once and never kept in
// component state afterwards; the server verifies before storing.
import { useState } from 'react';
import { useT } from '../../lib/i18n.js';
import * as setupApi from '../../lib/setup-api.js';
import { capFamily } from './registry.js';
import { BTN, BTN2, INPUT, ErrorBox, useAction } from './shared.jsx';

export default function TokenStep({ capability, manual, onDone, onCancel, placeholder, autoFocus = false }) {
  const t = useT();
  const [token, setToken] = useState('');
  const [extra, setExtra] = useState({}); // the other named fields of a multi-field provider (Twilio: sid)
  const { busy, err, run } = useAction();
  const fam = capFamily(capability);
  // A provider with several named fields (manual.fields) renders one input per field; 'token' stays the secret.
  const fields = Array.isArray(manual?.fields) && manual.fields.length > 1 ? manual.fields : null;
  const others = (fields || []).filter((f) => f.name !== 'token');
  const first = manual?.fields?.[0];
  const ph = placeholder || (['claude', 'codex', 'git', 'composio'].includes(fam) ? t(`setup.token.placeholder.${fam}`) : (fields ? fields.find((f) => f.name === 'token') : first)?.placeholder || t('setup.token.placeholder.generic'));
  const complete = !!token.trim() && others.every((f) => String(extra[f.name] || '').trim());

  const save = () =>
    run(async () => {
      const payload = { token: token.trim() };
      for (const f of others) payload[f.name] = String(extra[f.name] || '').trim();
      const r = await setupApi.connect(capability, payload);
      if (r && r.ok === false) throw new Error(r.error || r.detail || 'rejected');
      setToken('');
      setExtra({});
      onDone?.(r);
    });

  return (
    <div className="flex flex-col gap-2">
      {others.map((f) => (
        <input
          key={f.name}
          data-token-field={f.name}
          className={INPUT}
          type={f.secret ? 'password' : 'text'}
          value={extra[f.name] || ''}
          onChange={(e) => setExtra((x) => ({ ...x, [f.name]: e.target.value }))}
          placeholder={f.placeholder || f.label}
          spellCheck={false}
          autoComplete="off"
          aria-label={f.label}
        />
      ))}
      <input
        className={INPUT}
        type="password"
        value={token}
        onChange={(e) => setToken(e.target.value)}
        placeholder={ph}
        spellCheck={false}
        autoComplete="off"
        autoFocus={autoFocus}
        aria-label={fields ? fields.find((f) => f.name === 'token')?.label || t('setup.token.label') : t('setup.token.label')}
        onKeyDown={(e) => e.key === 'Enter' && complete && save()}
      />
      <div className="flex flex-wrap gap-2">
        <button type="button" className={BTN} disabled={busy || !complete} onClick={save}>
          {busy ? t('setup.token.saving') : t('setup.token.save')}
        </button>
        {onCancel && <button type="button" className={BTN2} onClick={onCancel}>{t('setup.cancel')}</button>}
      </div>
      <ErrorBox err={err} />
    </div>
  );
}
