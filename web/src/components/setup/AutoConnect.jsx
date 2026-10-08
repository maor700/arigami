// S2 — AUTO mode in progress: the agent is driving its own Chrome through
// the connect-<provider> playbook. Shows a spinner, the narration lines the
// session pushes (`setup-update {lines:[…]}`), and — once report_setup has
// run — the single evidence screenshot as a host-relative artifact link.
import { useT } from '../../lib/i18n.js';
import { Icon } from '../../lib/icons.js';
import { api } from '../../lib/api.js';
import { faCircleNotch, faCheck, faXmark, faArrowUpRightFromSquare, faImage } from '@fortawesome/free-solid-svg-icons';

// Always rendered inside the chat card (term-accent palette), never on a panel.
const btn = 'inline-flex cursor-pointer items-center gap-1 rounded-[6px] border border-[var(--term-accent-border)] px-2 py-0.5 font-mono text-[11.5px] md:text-[10.5px] text-[var(--term-accent-fg)] hover:bg-[var(--term-accent-border)] disabled:opacity-50';

// Evidence is `/__artifacts/<id>/` (relative — works from the phone). Offer
// "open as tab" (sandboxed iframe in the session) plus a plain relative link.
export function EvidenceLink({ sessionId, evidence, title }) {
  const t = useT();
  if (!evidence) return null;
  const openTab = () => api.post(`/sessions/${encodeURIComponent(sessionId)}/tabs`, { type: 'url', title: title || 'evidence', url: evidence }).catch(() => {});
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <a href={evidence} target="_blank" rel="noopener noreferrer" className={btn}><Icon icon={faImage} /> {t('setup.auto.evidence')} <Icon icon={faArrowUpRightFromSquare} /></a>
      {sessionId && <button type="button" className={btn} onClick={openTab}>{t('setup.auto.evidenceTab')}</button>}
    </span>
  );
}

// `header={false}` when the card already shows its own live status line (F6).
export default function AutoConnect({ sessionId, state = 'auto', lines = [], detail = '', evidence = null, onManual, onCancel, header = true }) {
  const t = useT();
  const running = state === 'auto';
  return (
    <div className="flex flex-col gap-2">
      {header && (
        <div className="flex items-center gap-2 text-[12.5px] font-semibold text-[var(--term-accent-fg)]">
          {running ? <Icon icon={faCircleNotch} spin /> : state === 'done' ? <span className="text-ok"><Icon icon={faCheck} /></span> : <span className="text-err"><Icon icon={faXmark} /></span>}
          <span>{t(running ? 'setup.auto.running' : state === 'done' ? 'setup.auto.done' : 'setup.auto.failed')}</span>
        </div>
      )}
      {lines.length > 0 && (
        <ol dir="auto" className="max-h-[160px] overflow-auto rounded-[8px] border border-[var(--term-accent-border)] px-3 py-2 font-mono text-[11.5px] md:text-[10.5px] leading-relaxed text-[var(--term-accent-dim)]">
          {lines.slice(-30).map((l, i) => <li key={i}>› {l}</li>)}
        </ol>
      )}
      {detail && <div dir="auto" className="text-[11.5px] text-[var(--term-accent-dim)]">{detail}</div>}
      {evidence && <EvidenceLink sessionId={sessionId} evidence={evidence} />}
      {running && (onManual || onCancel) && (
        <div className="flex flex-wrap gap-2 text-[11px]">
          {onManual && <button type="button" className={btn} onClick={onManual}>{t('setup.auto.switchManual')}</button>}
          {onCancel && <button type="button" className={btn} onClick={onCancel}>{t('setup.notNow')}</button>}
        </div>
      )}
    </div>
  );
}
