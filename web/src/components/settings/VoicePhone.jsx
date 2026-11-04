// Settings › Connections › "Voice & phone" (docs/VOICE.md): the voice/telephony providers with a stored key, the
// one kill-switch, a monthly USD cap per provider and this month's estimated usage. Renders NOTHING while no
// provider has a key — a host without voice sees no change at all.
import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { useT } from '../../lib/i18n.js';
import { toastError } from '../../lib/toast.js';
import { capTitle } from '../setup/registry.js';
import { Icon } from '../../lib/icons.js';
import { faCheck } from '@fortawesome/free-solid-svg-icons';
import { Section, StatusPill, Field, Toggle, BTN_PRIMARY, ROW, LIST, INPUT } from './shared.jsx';

// A provider counts as present once the host holds a key for it (ok, rejected or switched off alike).
export const voicePresent = (caps) => (caps || []).filter((c) => c.ok || c.data?.hasKey);

const fmtUsd = (n) => (Math.round((Number(n) || 0) * 100) / 100).toFixed(2);

export function VoicePhoneSection({ caps, budget, admin, busy, onConnect, onDisconnect, onChanged }) {
  const t = useT();
  const [draft, setDraft] = useState({}); // id → cap text being edited
  const present = voicePresent(caps);
  if (!present.length) return null;
  const enabled = budget ? budget.enabled !== false : !present.some((c) => c.data?.disabled);
  const save = async (patch) => {
    try { await api.post('/voice/budget', patch); onChanged?.(); } catch (e) { toastError(String(e?.message || e)); }
  };
  const commitCap = (id) => {
    const v = String(draft[id] ?? '').trim();
    setDraft((d) => { const n = { ...d }; delete n[id]; return n; });
    const cur = budget?.caps?.[id];
    const next = v === '' ? null : Number(v);
    if (next !== null && !(next >= 0)) return;
    if ((next || null) === (cur || null)) return;
    save({ caps: { [id]: next } });
  };
  return (
    <Section id="voice" title={t('settings.connections.voice')}>
      <div className="mb-2 text-xs text-fgdim">{t('settings.connections.voice.hint')}</div>
      <Field label={t('settings.connections.voice.enabled')} hint={t('settings.connections.voice.enabled.hint')}>
        <Toggle on={enabled} disabled={!admin || busy} onChange={(v) => save({ enabled: v })} data-voice-enabled={enabled ? '1' : '0'} />
      </Field>
      <div className={LIST} data-voice-list>
        {present.map((c) => {
          const u = budget?.usage?.[c.id];
          const cap = budget?.caps?.[c.id];
          const stopped = u?.state === 'soft-stopped';
          return (
            <div key={c.id} className={ROW} data-voice-row={c.id}>
              <StatusPill status={c.ok ? 'ok' : stopped ? 'todo' : 'off'} label={c.ok ? (stopped ? t('settings.connections.voice.softStopped') : t('setup.connections.on')) : c.data?.disabled ? t('setup.connections.off') : c.data?.rejected ? t('setup.state.failed') : t('settings.connections.voice.keyStored')} />
              <span className="min-w-0 flex-1 truncate">
                <span className="font-medium">{c.title || capTitle(t, c.id)}</span>
                <span dir="ltr" className="ms-2 font-mono text-xs text-fgdim">
                  {(c.data?.kinds || []).join('/')}
                  {u ? ` · ${t('settings.connections.voice.usage', { usd: fmtUsd(u.usd) })}` : ''}
                  {cap ? ` / $${fmtUsd(cap)}` : ''}
                </span>
              </span>
              {admin && (
                <input
                  type="number"
                  min="0"
                  step="1"
                  inputMode="decimal"
                  aria-label={`${t('settings.connections.voice.cap')} · ${c.title || c.id}`}
                  placeholder={t('settings.connections.voice.noCap')}
                  className={`${INPUT} w-24`}
                  value={draft[c.id] ?? (cap ? String(cap) : '')}
                  onChange={(e) => setDraft((d) => ({ ...d, [c.id]: e.target.value }))}
                  onBlur={() => commitCap(c.id)}
                  onKeyDown={(e) => e.key === 'Enter' && commitCap(c.id)}
                />
              )}
              <button type="button" disabled={busy} onClick={() => onDisconnect?.(c)} className="cursor-pointer text-xs text-fgdim hover:text-err coarse:min-h-11">{t('setup.connections.disconnect')}</button>
              <button type="button" className={c.ok ? 'cursor-pointer text-xs text-fgdim hover:text-fg coarse:min-h-11' : BTN_PRIMARY} onClick={() => onConnect?.(c)}>
                {c.ok ? <><Icon icon={faCheck} /> {t('setup.connections.reconnect')}</> : t('setup.connections.connect')}
              </button>
            </div>
          );
        })}
      </div>
    </Section>
  );
}

// Loads GET /voice/budget only while a provider is present, re-reads on `tick`.
export function useVoiceBudget(active, tick) {
  const [budget, setBudget] = useState(null);
  useEffect(() => {
    if (!active) { setBudget(null); return; }
    api.get('/voice/budget').then(setBudget).catch(() => setBudget(null));
  }, [active, tick]);
  return budget;
}
