// Settings › Connections › Channels: WhatsApp (one card, on the JIT QrStep —
// this replaces the old duplicate WhatsAppBridge block), the SMS share-token
// (AUDIT2: the hub now lists WhatsApp in its unified "connected" list and
// renders only `Webhooks` inside the Advanced drawer; the default export is
// the whole old section, kept for compatibility), the SMS share-token
// URL for the phone's forwarder, Slack/GitHub webhook secrets, custom HMAC
// hooks and the Tailscale Funnel toggle that exposes ONLY /__api/webhooks.
import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { useStore } from '../../lib/store.js';
import { useT } from '../../lib/i18n.js';
import { confirmDialog } from '../../lib/confirm.js';
import { toastError } from '../../lib/toast.js';
import QrStep from '../setup/QrStep.jsx';
import { Section, SettingCard, StatusPill, Field, Toggle, CopyRow, ErrorLine, BTN_SM, BTN_DANGER, INPUT, ROW } from './shared.jsx';

export function WhatsApp({ onChanged }) {
  const t = useT();
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const load = () => api.get('/whatsapp/status').then(setStatus).catch(() => setStatus({ status: 'disconnected' }));
  useEffect(() => { load(); }, []);
  const s = status?.status ?? 'disconnected';
  const disconnect = async () => {
    setBusy(true);
    try { await api.post('/whatsapp/disconnect', {}); } catch (e) { toastError(String(e?.message || e)); }
    setBusy(false); setOpen(false); load(); onChanged?.();
  };
  const pill = s === 'connected' ? <StatusPill status="ok" label={t('setup.state.ok')} />
    : s === 'qr' || s === 'starting' ? <StatusPill status="running" label={t('setup.state.running')} />
      : <StatusPill status="off" label={t('setup.state.todo')} />;
  return (
    <SettingCard
      title="WhatsApp"
      pill={status ? pill : null}
      hint={s === 'connected' ? `${t('settings.channels.whatsapp.linked')}${status?.user ? ` · ${status.user}` : ''}` : t('settings.channels.whatsapp.hint')}
      actions={s === 'connected'
        ? <button type="button" disabled={busy} onClick={disconnect} className={BTN_DANGER}>{t('setup.connections.disconnect')}</button>
        : !open && <button type="button" onClick={() => setOpen(true)} className={BTN_SM}>{t('setup.connections.connect')}</button>}
    >
      {open && s !== 'connected' && (
        <div className="mt-2 border-t border-hair pt-2">
          <QrStep capability="whatsapp" initial={status} onDone={() => { setOpen(false); load(); onChanged?.(); }} />
        </div>
      )}
    </SettingCard>
  );
}

export function Webhooks() {
  const t = useT();
  const { auth } = useStore();
  const [cfgv, setCfgv] = useState(null);
  const [funnel, setFunnel] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [secretDraft, setSecretDraft] = useState({ slack: '', github: '' });
  const [customId, setCustomId] = useState('');
  const [fresh, setFresh] = useState(null); // {id, secret, url} shown once
  const admin = !!auth?.isAdmin || auth?.authMode === 'off';

  const load = () => {
    if (!admin) return;
    api.get('/webhooks/config').then(setCfgv).catch(() => setCfgv(null));
    api.get('/remote/funnel').then(setFunnel).catch(() => setFunnel(null));
  };
  useEffect(() => { load(); }, [admin]);
  if (!admin) return null;

  const run = async (fn) => {
    setBusy(true); setErr('');
    try { await fn(); } catch (e) { setErr(String(e?.message || e)); toastError(String(e?.message || e)); } finally { setBusy(false); }
  };
  const rotate = () => run(async () => {
    if (cfgv?.sms && !(await confirmDialog(t('chrome.webhooks.sms.rotateConfirm')))) return;
    await api.post('/webhooks/token', {}); load();
  });
  const revoke = () => run(async () => { if (await confirmDialog(t('chrome.webhooks.sms.revokeConfirm'))) { await api.del('/webhooks/token'); load(); } });
  const saveSecret = (kind) => run(async () => { await api.put(`/webhooks/${kind}/secret`, { secret: secretDraft[kind] }); setSecretDraft((d) => ({ ...d, [kind]: '' })); load(); });
  const addCustom = () => run(async () => { const r = await api.post('/webhooks/custom', { id: customId.trim() }); setFresh(r); setCustomId(''); load(); });
  const delCustom = (id) => run(async () => { if (await confirmDialog(t('chrome.webhooks.custom.removeConfirm', { id }))) { await api.del(`/webhooks/custom/${id}`); load(); } });
  const toggleFunnel = (on) => run(async () => {
    if (on && !(await confirmDialog(t('chrome.webhooks.funnel.confirm')))) return;
    const r = await api.post('/remote/funnel', { enable: on });
    setFunnel(r); if (r?.error) setErr(r.error);
  });

  if (!cfgv) return <div className="py-3 font-mono text-[11px] text-fgdim">{t('chrome.webhooks.loading')}</div>;
  const sms = cfgv.sms;
  const input = `${INPUT} w-[180px]`;
  return (
    <>
      {!cfgv.publicUrl && <div className="mb-2 text-[11px] text-fgdim">{t('chrome.webhooks.noPublicUrl')}</div>}
      <SettingCard
        title={t('chrome.webhooks.sms')}
        pill={<StatusPill status={sms ? (sms.live ? 'ok' : 'error') : 'off'} label={sms ? (sms.live ? t('setup.state.ok') : t('chrome.webhooks.sms.expired')) : t('setup.state.todo')} />}
        hint={sms ? (sms.live ? t('chrome.webhooks.sms.live', { date: new Date(sms.exp).toLocaleDateString() }) : t('chrome.webhooks.sms.expired')) : t('chrome.webhooks.sms.none')}
        actions={<>
          <button type="button" disabled={busy} onClick={rotate} className={BTN_SM}>{sms ? t('chrome.webhooks.sms.rotate') : t('chrome.webhooks.sms.create')}</button>
          {sms && <button type="button" disabled={busy} onClick={revoke} className={BTN_SM}>{t('chrome.webhooks.sms.revoke')}</button>}
        </>}
      >
        {sms && <CopyRow url={sms.url + '&from={sms_number}&body={sms_message}'} />}
      </SettingCard>

      {['slack', 'github'].map((kind) => (
        <SettingCard
          key={kind}
          title={t(`chrome.webhooks.${kind}`)}
          pill={<StatusPill status={cfgv[kind].configured ? 'ok' : 'off'} label={cfgv[kind].configured ? t('chrome.webhooks.secret.set', { source: cfgv[kind].source }) : t('chrome.webhooks.secret.missing')} />}
          hint={<span dir="ltr" className="font-mono">{cfgv[kind].url}</span>}
          actions={<>
            <input type="password" autoComplete="off" value={secretDraft[kind]} onChange={(e) => setSecretDraft((d) => ({ ...d, [kind]: e.target.value }))} placeholder={t('chrome.webhooks.secret.placeholder')} className={input} disabled={cfgv[kind].source === 'env'} />
            <button type="button" disabled={busy || cfgv[kind].source === 'env'} onClick={() => saveSecret(kind)} className={BTN_SM}>{secretDraft[kind] ? t('chrome.webhooks.secret.save') : t('chrome.webhooks.secret.clear')}</button>
          </>}
        />
      ))}

      <SettingCard
        title={t('chrome.webhooks.custom')}
        hint={t('chrome.webhooks.custom.hint')}
        actions={<>
          <input type="text" value={customId} onChange={(e) => setCustomId(e.target.value)} placeholder="my-hook" className={input} />
          <button type="button" disabled={busy || !/^[A-Za-z0-9_.-]{1,64}$/.test(customId.trim())} onClick={addCustom} className={BTN_SM}>{t('chrome.webhooks.custom.add')}</button>
        </>}
      >
        {fresh && (
          <div className="mt-2 border-t border-hair pt-2 text-[11px]">
            <div className="text-fgdim">{t('chrome.webhooks.custom.once', { id: fresh.id })}</div>
            <CopyRow url={fresh.secret} />
            <CopyRow url={fresh.url} />
            <button type="button" onClick={() => setFresh(null)} className={BTN_SM}>{t('chrome.webhooks.custom.done')}</button>
          </div>
        )}
        {cfgv.custom.length > 0 && (
          <div className="mt-2 border-t border-hair pt-1">
            {cfgv.custom.map((c) => (
              <div key={c.id} className={ROW}>
                <span dir="ltr" className="min-w-0 flex-1 truncate font-mono">{c.path}{c.label ? ` · ${c.label}` : ''}</span>
                <button type="button" disabled={busy} onClick={() => delCustom(c.id)} className={BTN_SM}>{t('chrome.webhooks.custom.remove')}</button>
              </div>
            ))}
          </div>
        )}
      </SettingCard>

      {funnel?.loggedIn && (
        <Field label={t('chrome.webhooks.funnel')} hint={funnel.funnel ? t('chrome.webhooks.funnel.on', { url: funnel.funnelUrl || '' }) : t('chrome.webhooks.funnel.off')}>
          <Toggle on={!!funnel.funnel} disabled={busy} onChange={toggleFunnel} />
        </Field>
      )}
      <ErrorLine>{err}</ErrorLine>
    </>
  );
}

export default function Channels({ onChanged }) {
  const t = useT();
  return (
    <Section id="channels" title={t('settings.connections.channels')}>
      <WhatsApp onChanged={onChanged} />
      <Webhooks />
    </Section>
  );
}
