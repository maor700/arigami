// A4 — the {kind:'delegated'} receipt line: a composer @mention or `/as` handed
// the text to an agent — "הוקצה ל-<agent>" + where it went (a child session /
// a new session / the agent's home chat) + a link that opens it.
import { useT } from '../lib/i18n.js';
import { AgentAvatar } from './AgentCard.jsx';

export const openSession = (id) => window.dispatchEvent(new CustomEvent('host:select-session', { detail: { id } }));

export function DelegatedLine({ event }) {
  const t = useT();
  const a = event.agent || {};
  const how = ['child', 'home', 'session'].includes(event.how) ? event.how : 'session';
  return (
    <div data-delegated-line={a.slug} className="my-1.5 flex flex-wrap items-center gap-1.5 rounded-[8px] border border-dashed border-[var(--term-accent-border)] px-2.5 py-1.5 font-mono text-[10.5px] text-[var(--term-accent-fg)]">
      <AgentAvatar agent={a} size={14} />
      <span className="font-bold">{t('chat.delegatedTo', { name: a.name || a.slug || '' })}</span>
      <span className="text-[var(--term-accent-dim)]">
        · {t(`chat.delegatedHow.${how}`)}
        {event.delivered === 'queued' ? ` · ${t('chat.delegatedQueued')}` : ''}
      </span>
      {event.text && <span dir="auto" className="min-w-0 flex-1 truncate">{event.text}</span>}
      {event.target && (
        <button
          type="button"
          data-delegated-open={event.target}
          onClick={() => openSession(event.target)}
          className="ms-auto cursor-pointer rounded bg-[var(--term-accent-border)] px-1.5 hover:opacity-80"
        >
          {t('chat.delegatedOpen')} →
        </button>
      )}
    </div>
  );
}

export default DelegatedLine;
