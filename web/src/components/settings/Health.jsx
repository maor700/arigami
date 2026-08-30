// Settings › Host › Health (RES1 §4) — what the supervisor did while nobody was
// looking. Three blocks: the live health of every session, the account/model
// quota picture (who is quarantined and until when, which sessions are running a
// rung below their model), and the last 24h of incidents from
// $ARIGAMI_DIR/incidents.jsonl. Read-only apart from one button: take a
// downgraded session back to the top rung without waiting for the reset.
import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { useStore } from '../../lib/store.js';
import { useT } from '../../lib/i18n.js';
import { relTime, untilTime } from '../../lib/time.js';
import { toastError } from '../../lib/toast.js';
import { Section, SettingCard, StatusPill, BTN_SM, ROW, LIST } from './shared.jsx';

const DOT = { grey: '#9a9a9a', blue: '#2C6BD6', amber: '#CE8324', red: '#E0594F' };
const OUTCOME_PILL = { ok: 'ok', failed: 'error', escalated: 'todo' };

export default function Health() {
  const t = useT();
  const { sessions, waiting } = useStore();
  const [snap, setSnap] = useState(null);
  const [log, setLog] = useState(null);
  const [busy, setBusy] = useState('');

  const load = () => {
    api.get('/health').then(setSnap).catch(() => setSnap(null));
    api.get('/health/incidents?hours=24').then(setLog).catch(() => setLog(null));
  };
  useEffect(() => { load(); }, []);
  // A fresh incident means the picture just changed — pull it again.
  useEffect(() => { if (snap) load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [waiting?.length]);

  const titleOf = (id) => sessions.find((s) => s.id === id)?.title || id;
  const rows = snap?.sessions || [];
  const unhealthy = rows.filter((r) => r.state !== 'IDLE_OK' && r.state !== 'RUNNING');
  const downgraded = sessions.filter((s) => (s.claude?.modelRung || 0) > 0);

  const restore = async (id) => {
    setBusy(id);
    try {
      await api.post(`/sessions/${id}/model/restore`);
      load();
    } catch (e) {
      toastError(e?.message || String(e));
    } finally {
      setBusy('');
    }
  };

  return (
    <Section id="health" title={t('health.title')} onRefresh={load}>
      <SettingCard
        title={t('health.sessions')}
        hint={t('health.sessions.hint')}
        pill={
          <StatusPill
            status={snap?.supervisor?.enabled === false ? 'off' : unhealthy.length ? 'todo' : 'ok'}
            label={
              snap?.supervisor?.enabled === false
                ? t('health.supervisorOff')
                : t('health.everyN', { n: snap?.supervisor?.tickSec ?? 30 })
            }
          />
        }
      >
        {!rows.length ? (
          <div className="mt-1 text-[11px] text-fgdim italic">{t('health.noSessions')}</div>
        ) : (
          <div className={LIST}>
            {rows.map((r) => (
              <div key={r.sessionId} className={ROW}>
                <span className="flex min-w-0 items-center gap-2">
                  <span className="h-[7px] w-[7px] shrink-0 rounded-full" style={{ background: DOT[r.dot] || DOT.grey }} />
                  <span className="min-w-0 truncate">{r.title || titleOf(r.sessionId)}</span>
                </span>
                <span className="flex shrink-0 items-center gap-2 font-mono text-[10px] text-fgdim">
                  {r.model && <span>{r.modelRung ? `↓ ${r.model}` : r.model}</span>}
                  <span>{t(`rail.health.${r.state}`)}</span>
                  <span>{relTime(r.since)}</span>
                </span>
              </div>
            ))}
          </div>
        )}
      </SettingCard>

      <SettingCard title={t('health.quota')} hint={t('health.quota.hint', { chain: (snap?.modelChain || []).join(' → ') || '—' })}>
        <div className={LIST}>
          {(snap?.accounts || []).map((a) => (
            <div key={a.id} className={ROW}>
              <span className="min-w-0 truncate">
                {a.label}
                {a.active && <span className="ms-1.5 text-[10px] text-fgdim">{t('health.active')}</span>}
              </span>
              <span className="shrink-0 font-mono text-[10px] text-fgdim">
                {a.available
                  ? t('health.accountOk')
                  : t('health.accountLimited', { when: untilTime(a.quarantineUntil) || '—' })}
              </span>
            </div>
          ))}
          {!(snap?.accounts || []).length && (
            <div className="py-1.5 text-[11px] text-fgdim italic">{t('health.noAccounts')}</div>
          )}
        </div>
        {downgraded.length > 0 && (
          <div className={LIST}>
            {downgraded.map((s) => (
              <div key={s.id} className={ROW}>
                <span className="min-w-0 truncate">
                  {s.title}
                  <span className="ms-1.5 font-mono text-[10px] text-fgdim">
                    {t('health.downgraded', {
                      from: s.claude?.modelDowngradedFrom || '—',
                      to: s.claude?.modelChoice || '—',
                      when: untilTime(s.claude?.modelRestoreAt) || '—',
                    })}
                  </span>
                </span>
                <button type="button" disabled={busy === s.id} onClick={() => restore(s.id)} className={BTN_SM}>
                  {t('health.restoreNow', { model: s.claude?.modelDowngradedFrom || '' })}
                </button>
              </div>
            ))}
          </div>
        )}
      </SettingCard>

      <SettingCard
        title={t('health.incidents')}
        hint={t('health.incidents.hint')}
        pill={<StatusPill status={log?.count ? 'pending' : 'ok'} label={t('health.incidentCount', { n: log?.count ?? 0 })} />}
      >
        {!log?.incidents?.length ? (
          <div className="mt-1 text-[11px] text-fgdim italic">{t('health.noIncidents')}</div>
        ) : (
          <div className={LIST}>
            {log.incidents.slice(0, 50).map((i, n) => (
              <div key={`${i.ts}:${n}`} className={ROW}>
                <span className="flex min-w-0 flex-col">
                  <span className="min-w-0 truncate">
                    {t(`health.action.${i.action}`)}
                    <span className="ms-1.5 text-[10.5px] text-fgdim">{titleOf(i.sessionId)}</span>
                  </span>
                  {i.reason && <span className="font-mono text-[9.5px] text-fgdim">{i.reason}</span>}
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  <StatusPill status={OUTCOME_PILL[i.outcome] || 'pending'} label={t(`health.outcome.${i.outcome || 'ok'}`)} />
                  <span className="font-mono text-[10px] text-fgdim">{relTime(i.ts)}</span>
                </span>
              </div>
            ))}
          </div>
        )}
      </SettingCard>
    </Section>
  );
}
