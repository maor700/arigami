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
import { Section, StatusPill, Field, Toggle, CopyRow, ErrorLine, BTN, BTN_PRIMARY, BTN_SM, ROW, LIST, INPUT } from './shared.jsx';

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
              <span className="min-w-0 flex-1">
                <span className="block truncate">
                  <span className="font-medium">{c.title || capTitle(t, c.id)}</span>
                  <span dir="ltr" className="ms-2 font-mono text-xs text-fgdim">
                    {(c.data?.kinds || []).join('/')}
                    {u ? ` · ${t('settings.connections.voice.usage', { usd: fmtUsd(u.usd) })}` : ''}
                    {cap ? ` / $${fmtUsd(cap)}` : ''}
                  </span>
                </span>
                <span className="block truncate text-[11px] text-fgdim" data-voice-privacy>{t('settings.connections.voice.privacy')}</span>
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
      {present.some((c) => c.id === 'telephony:twilio' && c.ok) && <PhoneSetup admin={admin} tick={budget?.month} />}
      {present.some((c) => c.id === 'telephony:twilio' && c.ok) && <OutboundSetup admin={admin} tick={budget?.month} />}
    </Section>
  );
}

// Stage 2 (docs/VOICE.md): owner number, PIN, the webhook URLs for the Twilio console, a signature self-test.
// Rendered only while telephony:twilio is connected; the PIN is write-only (the host keeps a hash).
export function PhoneSetup({ admin, tick, initial = null }) {
  const t = useT();
  const [view, setView] = useState(initial); // `initial`: tests render without effects
  const [owner, setOwner] = useState(initial?.ownerNumber || '');
  const [pin, setPin] = useState('');
  const [pub, setPub] = useState(initial?.publicUrl || '');
  const [test, setTest] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const load = () => api.get('/voice/phone').then((v) => { setView(v); setOwner(v.ownerNumber || ''); setPub(v.publicUrl || ''); }).catch((e) => setErr(String(e?.message || e)));
  useEffect(() => { load(); }, [tick]);
  const post = async (body) => {
    setBusy(true); setErr('');
    try { const v = await api.post('/voice/phone', body); setView(v); setOwner(v.ownerNumber || ''); setPub(v.publicUrl || ''); setPin(''); }
    catch (e) { setErr(String(e?.message || e)); }
    finally { setBusy(false); }
  };
  const runTest = async () => {
    setBusy(true); setTest(null);
    try { setTest(await api.post('/voice/phone/test-signature', {})); } catch (e) { setTest({ ok: false, detail: String(e?.message || e) }); } finally { setBusy(false); }
  };
  if (!view) return null;
  const dirtyOwner = owner !== (view.ownerNumber || '');
  const dirtyPub = pub !== (view.publicUrl || '');
  return (
    <div className="mt-4" data-phone-setup>
      <div className="text-sm font-medium text-fg">{t('settings.connections.phone')}</div>
      <div className="mb-1 text-xs text-fgdim">{t('settings.connections.phone.hint')}</div>
      <ErrorLine>{err}</ErrorLine>
      {view.lockedUntil > 0 && <div className="text-xs text-err" data-phone-locked>{t('settings.connections.phone.locked', { when: new Date(view.lockedUntil).toLocaleTimeString() })}</div>}
      {view.live > 0 && <div className="text-xs text-fgdim" data-phone-live>📞 {t('settings.connections.phone.live')}</div>}
      <Field label={t('settings.connections.phone.owner')} hint={t('settings.connections.phone.owner.hint')}>
        <span className="flex items-center gap-2">
          <input dir="ltr" type="tel" inputMode="tel" placeholder="+9725…" className={`${INPUT} w-44`} value={owner} disabled={!admin || busy} onChange={(e) => setOwner(e.target.value)} data-phone-owner />
          {dirtyOwner && <button type="button" className={BTN_PRIMARY} disabled={busy} onClick={() => post({ ownerNumber: owner })}>{t('settings.connections.phone.save')}</button>}
        </span>
      </Field>
      <Field label={<>{t('settings.connections.phone.pin')} <span className="ms-1 font-normal text-fgdim" data-phone-pin-state>{view.pinSet ? '✓ ' + t('settings.connections.phone.pin.set') : t('settings.connections.phone.pin.unset')}</span></>} hint={t('settings.connections.phone.pin.hint')}>
        <span className="flex items-center gap-2">
          <input dir="ltr" type="password" inputMode="numeric" autoComplete="off" pattern="[0-9]*" maxLength={8} className={`${INPUT} w-28`} value={pin} disabled={!admin || busy} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} aria-label={t('settings.connections.phone.pin')} data-phone-pin />
          <button type="button" className={BTN_PRIMARY} disabled={!admin || busy || !/^\d{4,8}$/.test(pin)} onClick={() => post({ pin })}>{t('settings.connections.phone.pin.save')}</button>
          {view.pinSet && <button type="button" className={BTN_SM} disabled={!admin || busy} onClick={() => post({ clearPin: true })}>{t('settings.connections.phone.pin.reset')}</button>}
        </span>
      </Field>
      <div className="py-3 border-b border-hair">
        <div className="text-sm font-medium text-fg">{t('settings.connections.phone.urls')}</div>
        <div className="text-xs text-fgdim">{t('settings.connections.phone.urls.hint')}</div>
        {view.voiceUrl ? (
          <div data-phone-urls>
            <CopyRow url={view.voiceUrl} />
            <CopyRow url={view.statusUrl} />
          </div>
        ) : <div className="mt-1 text-xs text-err" data-phone-no-url>{t('settings.connections.phone.urls.none')}</div>}
        <div className="mt-2 flex items-center gap-2">
          <button type="button" className={BTN} disabled={busy || !view.voiceUrl} onClick={runTest} data-phone-test>{t('settings.connections.phone.test')}</button>
          {test && <span className={`text-xs ${test.ok ? 'text-fgdim' : 'text-err'}`} data-phone-test-result>{test.ok ? t('settings.connections.phone.test.ok', { url: test.url }) : test.detail}</span>}
        </div>
      </div>
      <Field label={t('settings.connections.phone.publicUrl')} hint={t('settings.connections.phone.publicUrl.hint')}>
        <span className="flex items-center gap-2">
          <input dir="ltr" type="url" placeholder="https://…" className={`${INPUT} w-56`} value={pub} disabled={!admin || busy} onChange={(e) => setPub(e.target.value)} data-phone-public-url />
          {dirtyPub && <button type="button" className={BTN_PRIMARY} disabled={busy} onClick={() => post({ publicUrl: pub })}>{t('settings.connections.phone.save')}</button>}
        </span>
      </Field>
    </div>
  );
}

// Stage 4a (docs/VOICE.md): calls/SMS to others — the agent's number, caller IDs (+ Twilio verification), disclosure, caps,
// quiet hours, voicemail. Rendered only while telephony:twilio is connected; every call/SMS still needs a Send card.
export function OutboundSetup({ admin, tick, initial = null }) {
  const t = useT();
  const [view, setView] = useState(initial);
  const [draft, setDraft] = useState({});
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [verify, setVerify] = useState(null); // {code, number, state:'waiting'|'verified'|'not-yet'}
  useEffect(() => { api.get('/voice/outbound').then(setView).catch((e) => setErr(String(e?.message || e))); }, [tick]);
  useEffect(() => {
    if (verify?.state !== 'waiting') return undefined;
    let n = 0;
    const id = setInterval(async () => {
      n += 1;
      try {
        const r = await api.post('/voice/phone/caller-id', { action: 'check', number: verify.number });
        if (r.verified) { setVerify((v) => ({ ...v, state: 'verified' })); setView(r.view); }
        else if (n >= 36) setVerify((v) => ({ ...v, state: 'not-yet' }));
      } catch { /* keep polling */ }
    }, 5000);
    return () => clearInterval(id);
  }, [verify?.state, verify?.number]);
  if (!view) return null;
  const s = view.settings || {};
  const val = (k, d) => (draft[k] !== undefined ? draft[k] : d);
  const set = (k) => (e) => setDraft((x) => ({ ...x, [k]: e.target.value }));
  const post = async (body) => {
    setBusy(true); setErr('');
    try { const v = await api.post('/voice/outbound', body); setView((cur) => ({ ...v, accountNumbers: cur?.accountNumbers })); setDraft({}); }
    catch (e) { setErr(String(e?.message || e)); }
    finally { setBusy(false); }
  };
  const saveSettings = (patch) => post({ settings: patch });
  const startVerify = async () => {
    setBusy(true); setErr('');
    try { const r = await api.post('/voice/phone/caller-id', { action: 'start' }); setVerify({ code: r.code, number: r.number, state: 'waiting' }); }
    catch (e) { setErr(String(e?.message || e)); }
    finally { setBusy(false); }
  };
  const ownerVerified = (view.callerIds || []).length > 0;
  const commit = (k, path) => () => {
    if (draft[k] === undefined) return;
    const v = draft[k];
    const patch = path === 'quiet' ? { quiet: { [k]: v } } : path === 'disclosure' ? { disclosure: { [k.slice(4)]: v } } : { [k]: ['maxMinutes', 'maxCallsPerDay', 'maxSmsPerDay'].includes(k) ? Number(v) : v };
    saveSettings(patch);
  };
  const num = (k) => <input type="number" min="0" className={`${INPUT} w-20`} value={val(k, String(s[k] ?? ''))} disabled={!admin || busy} onChange={set(k)} onBlur={commit(k)} data-outbound-field={k} />;
  return (
    <div className="mt-4" data-outbound-setup>
      <div className="text-sm font-medium text-fg">{t('settings.connections.outbound')}</div>
      <div className="mb-1 text-xs text-fgdim">{t('settings.connections.outbound.hint')}</div>
      <ErrorLine>{err}</ErrorLine>
      {view.quietNow && <div className="text-xs text-fgdim" data-outbound-quiet>🌙 {t('settings.connections.outbound.quietNow', { why: view.quietNow })}</div>}
      <div className="text-xs text-fgdim" data-outbound-today>{t('settings.connections.outbound.today', { calls: view.today?.calls || 0, maxCalls: s.maxCallsPerDay, sms: view.today?.sms || 0, maxSms: s.maxSmsPerDay })}</div>
      <Field label={t('settings.connections.outbound.number')} hint={t('settings.connections.outbound.number.hint')}>
        <span className="flex items-center gap-2">
          {view.accountNumbers?.length ? (
            <select dir="ltr" className={INPUT} value={view.number || ''} disabled={!admin || busy} onChange={(e) => post({ number: e.target.value })} data-outbound-number-pick>
              <option value="">{t('settings.connections.outbound.number.pick')}</option>
              {view.accountNumbers.map((n) => <option key={n.number} value={n.number}>{n.number}{n.name && n.name !== n.number ? ` · ${n.name}` : ''}{n.sms ? '' : ' · no SMS'}</option>)}
              {view.number && !view.accountNumbers.some((n) => n.number === view.number) && <option value={view.number}>{view.number}</option>}
            </select>
          ) : <input dir="ltr" type="tel" placeholder="+972…" className={`${INPUT} w-44`} value={val('number', view.number || '')} disabled={!admin || busy} onChange={set('number')} data-outbound-number />}
          {draft.number !== undefined && draft.number !== (view.number || '') && <button type="button" className={BTN_PRIMARY} disabled={busy} onClick={() => post({ number: draft.number })}>{t('settings.connections.phone.save')}</button>}
        </span>
      </Field>
      {view.smsUrl && (
        <div className="py-2 border-b border-hair" data-outbound-sms-url>
          <div className="text-xs text-fgdim">{t('settings.connections.outbound.smsUrl')}</div>
          <CopyRow url={view.smsUrl} />
        </div>
      )}
      <Field label={t('settings.connections.outbound.callerId')} hint={t('settings.connections.outbound.callerId.hint')}>
        <select className={INPUT} value={s.callerId || 'agent'} disabled={!admin || busy} onChange={(e) => saveSettings({ callerId: e.target.value })} data-outbound-caller-id>
          <option value="agent">{t('settings.connections.outbound.callerId.agent')}</option>
          <option value="owner" disabled={!ownerVerified}>{t('settings.connections.outbound.callerId.owner')}</option>
        </select>
      </Field>
      <div className="py-3 border-b border-hair" data-outbound-verify>
        <div className="text-sm font-medium text-fg">{t('settings.connections.outbound.verify')}</div>
        <div className="text-xs text-fgdim">{t('settings.connections.outbound.verify.hint')}</div>
        {(view.callerIds || []).map((c) => (
          <div key={c.number} className="mt-1 flex items-center gap-2 text-xs" data-outbound-verified={c.number}>
            <span dir="ltr" className="font-mono">✓ {c.number}</span>
            {admin && <button type="button" className="cursor-pointer text-fgdim hover:text-err" disabled={busy} onClick={() => post({ removeCallerId: c.number })}>{t('setup.connections.disconnect')}</button>}
          </div>
        ))}
        {verify?.code && verify.state !== 'verified' && (
          <div className="mt-2" data-outbound-code>
            <div className="text-xs text-fgdim">{t('settings.connections.outbound.verify.code', { number: verify.number })}</div>
            <div dir="ltr" className="font-mono text-2xl tracking-widest text-fg">{verify.code}</div>
            {verify.state === 'not-yet' && <div className="text-xs text-err">{t('settings.connections.outbound.verify.notYet')}</div>}
          </div>
        )}
        {verify?.state === 'verified' && <div className="mt-1 text-xs text-fgdim" data-outbound-verify-ok>✓ {t('settings.connections.outbound.verify.ok')}</div>}
        <div className="mt-2 flex items-center gap-2">
          <button type="button" className={BTN} disabled={!admin || busy || verify?.state === 'waiting'} onClick={startVerify} data-outbound-verify-start>{t('settings.connections.outbound.verify.start')}</button>
          {verify?.code && verify.state !== 'verified' && <button type="button" className={BTN_SM} disabled={busy} onClick={() => setVerify((v) => ({ ...v, state: 'waiting' }))}>{t('settings.connections.outbound.verify.check')}</button>}
        </div>
      </div>
      <Field label={t('settings.connections.outbound.ownerName')} hint={t('settings.connections.outbound.ownerName.hint')}>
        <input className={`${INPUT} w-40`} value={val('ownerName', s.ownerName || '')} disabled={!admin || busy} onChange={set('ownerName')} onBlur={commit('ownerName')} data-outbound-owner-name />
      </Field>
      <Field label={t('settings.connections.outbound.disclosure')} hint={t('settings.connections.outbound.disclosure.hint')}>
        <span className="flex flex-col gap-1">
          <input dir="rtl" className={`${INPUT} w-72`} value={val('dis_he', s.disclosure?.he || '')} disabled={!admin || busy} onChange={set('dis_he')} onBlur={commit('dis_he', 'disclosure')} data-outbound-disclosure="he" />
          <input dir="ltr" className={`${INPUT} w-72`} value={val('dis_en', s.disclosure?.en || '')} disabled={!admin || busy} onChange={set('dis_en')} onBlur={commit('dis_en', 'disclosure')} data-outbound-disclosure="en" />
        </span>
      </Field>
      <Field label={t('settings.connections.outbound.amd')} hint={t('settings.connections.outbound.amd.hint')}>
        <select className={INPUT} value={s.amd || 'voicemail'} disabled={!admin || busy} onChange={(e) => saveSettings({ amd: e.target.value })} data-outbound-amd>
          <option value="voicemail">{t('settings.connections.outbound.amd.voicemail')}</option>
          <option value="hangup">{t('settings.connections.outbound.amd.hangup')}</option>
          <option value="off">{t('settings.connections.outbound.amd.off')}</option>
        </select>
      </Field>
      <Field label={t('settings.connections.outbound.caps')} hint={t('settings.connections.outbound.caps.hint', { usd: (view.usdPerMin || 0).toFixed(3) })}>
        <span className="flex items-center gap-2 text-xs text-fgdim">{num('maxMinutes')} {t('settings.connections.outbound.caps.minutes')} {num('maxCallsPerDay')} {t('settings.connections.outbound.caps.calls')} {num('maxSmsPerDay')} {t('settings.connections.outbound.caps.sms')}</span>
      </Field>
      <Field label={t('settings.connections.outbound.quiet')} hint={t('settings.connections.outbound.quiet.hint')}>
        <span dir="ltr" className="flex items-center gap-2">
          <input type="time" className={INPUT} value={val('start', s.quiet?.start || '21:00')} disabled={!admin || busy} onChange={set('start')} onBlur={commit('start', 'quiet')} data-outbound-quiet-start />
          –
          <input type="time" className={INPUT} value={val('end', s.quiet?.end || '08:00')} disabled={!admin || busy} onChange={set('end')} onBlur={commit('end', 'quiet')} data-outbound-quiet-end />
        </span>
      </Field>
      <Field label={t('settings.connections.outbound.shabbat')}>
        <Toggle on={s.quiet?.shabbat !== false} disabled={!admin || busy} onChange={(v) => saveSettings({ quiet: { shabbat: v } })} data-outbound-shabbat={s.quiet?.shabbat !== false ? '1' : '0'} />
      </Field>
      <Field label={t('settings.connections.outbound.transfer')}>
        <Toggle on={s.allowTransfer !== false} disabled={!admin || busy} onChange={(v) => saveSettings({ allowTransfer: v })} data-outbound-transfer={s.allowTransfer !== false ? '1' : '0'} />
      </Field>
    </div>
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
