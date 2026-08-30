// A4 — the {kind:'delegated'} receipt line: a composer @mention or `/as` handed
// the text to an agent.
// UX1 — the line says WHICH of the two things happened, in words:
//   home    → "נפתח בבית של <agent>"      + [פתח בית]  → the agent surface, בית tab
//   session → "נוצר סשן עבודה «title» עם <agent>" + [פתח סשן] → the work session
//   child   → the same, plus "in this project"
// (it used to read "הוקצה ל-<agent>" with the destination as a small suffix —
// which is exactly the confusion this spec is about).
import { useT } from '../lib/i18n.js';
import { AgentAvatar } from './AgentCard.jsx';

export const openSession = (id) => window.dispatchEvent(new CustomEvent('host:select-session', { detail: { id } }));
export const openAgent = (slug, tab) => window.dispatchEvent(new CustomEvent('host:open-agent', { detail: { slug, tab } }));

const short = (s, n = 44) => (s && s.length > n ? `${s.slice(0, n - 1)}…` : s || '');

export function DelegatedLine({ event }) {
  const t = useT();
  const a = event.agent || {};
  const how = ['child', 'home', 'session'].includes(event.how) ? event.how : 'session';
  const name = a.name || a.slug || '';
  const title = short(event.targetTitle);
  const home = how === 'home';
  const label = home
    ? t('chat.delegatedHome', { name })
    : t(how === 'child' ? 'chat.delegatedWorkChild' : 'chat.delegatedWork', { title, name });
  return (
    <div data-delegated-line={a.slug} data-delegated-how={how} className="my-1.5 flex flex-wrap items-center gap-1.5 rounded-[8px] border border-dashed border-[var(--term-accent-border)] px-2.5 py-1.5 font-mono text-[10.5px] text-[var(--term-accent-fg)]">
      <AgentAvatar agent={a} size={14} />
      <span className="font-bold">{label}</span>
      {event.delivered === 'queued' && <span className="text-[var(--term-accent-dim)]">· {t('chat.delegatedQueued')}</span>}
      {event.text && <span dir="auto" className="min-w-0 flex-1 truncate">{event.text}</span>}
      {(home ? !!a.slug : !!event.target) && (
        <button
          type="button"
          {...(home ? { 'data-delegated-open-home': a.slug } : { 'data-delegated-open': event.target })}
          onClick={() => (home ? openAgent(a.slug, 'home') : openSession(event.target))}
          className="ms-auto cursor-pointer rounded bg-[var(--term-accent-border)] px-1.5 hover:opacity-80"
        >
          {t(home ? 'chat.delegatedOpenHome' : 'chat.delegatedOpenSession')} →
        </button>
      )}
    </div>
  );
}

export default DelegatedLine;
