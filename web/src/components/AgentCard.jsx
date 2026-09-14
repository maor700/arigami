// A1 — the {kind:'agent-card'} chat card (host create_agent / update_agent).
//   pending    the agent proposed a draft; the human edits the fields here and
//              clicks [Create agent] → POST /__api/agents {…, cardId, sessionId}
//              (the host patches the card to `created` and tells the session)
//              or [Cancel] → POST /__api/agents/cards/:cardId/cancel.
//   created    frozen summary + links to the agent page / home chat.
//   updated    update_agent applied — which fields changed.
//   cancelled  the human said no.
// Same visual language as SetupCard/MergeCard (term accent vars, host-relative
// links only — the card must work from a phone).
import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api.js';
import { Icon } from '../lib/icons.js';
import { useT } from '../lib/i18n.js';
import { useModels } from '../lib/models.js';
import { toastError } from '../lib/toast.js';
import { engineLabel } from '../lib/engines.js';
import { EngineToggle, agentModelOptions } from './EngineToggle.jsx';
import { faCheck, faXmark, faUserAstronaut, faCircleNotch, faCaretDown, faCaretRight } from '@fortawesome/free-solid-svg-icons';

// A3: families are expanded + ENFORCED by the host (server/agent-policy.ts FAMILIES).
export const TOOL_FAMILIES = ['desktop', 'browser', 'whatsapp', 'gmail', 'calendar', 'drive', 'git', 'sessions', 'triggers', 'web', 'publish'];

const btnPrimary = 'cursor-pointer rounded-[7px] border-[1.5px] border-ink bg-brand px-3.5 py-1.5 text-[11.5px] font-bold text-[#1a1a1a] shadow-[2px_2px_0_#2a2a2a] disabled:opacity-50';
const btnSecondary = 'cursor-pointer rounded-[7px] border-[1.5px] border-[var(--term-accent-border)] bg-transparent px-3 py-1.5 text-[11.5px] font-bold text-[var(--term-accent-fg)] hover:bg-[var(--term-accent-border)] disabled:opacity-50';
const field = 'w-full rounded-[6px] border-[1.5px] border-[var(--term-accent-border)] bg-transparent px-2 py-1 font-mono text-[11px] text-[var(--term-accent-strong)] outline-none focus:border-[var(--term-accent-fg)]';
const label = 'mb-0.5 block font-mono text-[11px] md:text-[9.5px] tracking-[0.06em] text-[var(--term-accent-dim)] uppercase';

// The emoji-in-a-ring avatar every agent surface uses (rail row, card, page).
export function AgentAvatar({ agent, size = 22, className = '' }) {
  const color = agent?.color || '#c4c4c4';
  return (
    <span
      data-agent-avatar={agent?.slug}
      className={`inline-flex shrink-0 items-center justify-center rounded-full ${className}`}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.58), background: `${color}22`, border: `1.5px solid ${color}`, lineHeight: 1 }}
      aria-hidden="true"
    >
      {agent?.emoji || '🤖'}
    </span>
  );
}

function useSkillNames() {
  const [skills, setSkills] = useState(null);
  useEffect(() => {
    let stop = false;
    api.get('/skills').then((r) => { if (!stop) setSkills((r?.skills || []).map((s) => s.name)); }).catch(() => { if (!stop) setSkills([]); });
    return () => { stop = true; };
  }, []);
  return skills;
}

function Pill({ state }) {
  const t = useT();
  const cls = state === 'created' || state === 'updated'
    ? 'border-[#8fcf9a] bg-[#e8f6ea] text-[#2a6b35]'
    : state === 'cancelled'
      ? 'border-[var(--term-accent-border)] text-[var(--term-accent-dim)]'
      : 'border-[#e6d27a] bg-chip/60 text-fgdim';
  return <span data-agent-card-state={state} className={`rounded-full border px-2 py-0.5 font-mono text-[11px] md:text-[9.5px] font-bold ${cls}`}>{t(`agent.card.${state}`)}</span>;
}

export default function AgentCard({ sessionId, event }) {
  const t = useT();
  const { models } = useModels();
  const skillNames = useSkillNames();
  const state = event.state || 'pending';
  const d0 = event.draft || {};
  const [draft, setDraft] = useState(() => ({
    name: d0.name || '',
    slug: d0.slug || '',
    emoji: d0.emoji || '🤖',
    color: d0.color || '',
    engine: d0.engine || '',
    model: d0.model || '',
    persona: d0.persona || '',
    skills: Array.isArray(d0.skills) ? d0.skills : [],
    tools: Array.isArray(d0.tools) ? d0.tools : [],
    budget: d0.budget?.tokensPerDay ? String(d0.budget.tokensPerDay) : '',
  }));
  const [busy, setBusy] = useState(false);
  const [advanced, setAdvanced] = useState(false); // simple by default: name + emoji + persona
  const [err, setErr] = useState(event.error || null);
  useEffect(() => { if (event.error) setErr(event.error); }, [event.error]);

  const agent = event.agent || null;
  const preview = useMemo(() => ({ slug: draft.slug, emoji: draft.emoji, color: draft.color || agent?.color || '#6A4FC4' }), [draft.slug, draft.emoji, draft.color, agent]);
  const set = (k) => (e) => setDraft((cur) => ({ ...cur, [k]: e.target.value }));
  const toggle = (k, v) => setDraft((cur) => ({ ...cur, [k]: cur[k].includes(v) ? cur[k].filter((x) => x !== v) : [...cur[k], v] }));

  const confirm = async () => {
    setBusy(true);
    setErr(null);
    try {
      const body = {
        name: draft.name.trim(),
        slug: draft.slug.trim() || undefined,
        emoji: draft.emoji.trim() || '🤖',
        ...(draft.color ? { color: draft.color } : {}),
        engine: draft.engine || null,
        model: draft.model || null,
        persona: draft.persona,
        skills: draft.skills,
        tools: draft.tools,
        ...(Number(draft.budget) > 0 ? { budget: { tokensPerDay: Number(draft.budget) } } : {}),
        cardId: event.cardId,
        sessionId,
      };
      await api.post('/agents', body);
    } catch (e) {
      const msg = e?.body?.error || e?.message || String(e);
      setErr(msg);
      toastError(msg);
    } finally {
      setBusy(false);
    }
  };
  const cancel = async () => {
    setBusy(true);
    try { await api.post(`/agents/cards/${event.cardId}/cancel`, { sessionId }); } catch (e) { toastError(e?.message || String(e)); } finally { setBusy(false); }
  };
  const openPage = (slug) => { window.location.hash = `#/agents/${encodeURIComponent(slug)}`; };

  const title = event.action === 'update' ? t('agent.card.update') : t('agent.card.create');
  const shown = agent || preview;

  return (
    <div data-agent-card={state} className="my-2.5 rounded-[10px] border border-[var(--term-accent-border)] bg-[var(--term-accent-bg)] p-3">
      <div className="flex flex-wrap items-center gap-2 font-mono text-[11px]">
        {state === 'pending' && <span className="pulse-yellow h-[7px] w-[7px] rounded-full bg-brand" />}
        <AgentAvatar agent={shown} size={22} />
        <span dir="auto" className="font-bold text-[var(--term-accent-strong)]">
          <Icon icon={faUserAstronaut} /> {title}
          {(agent?.name || draft.name) ? <span className="font-normal"> — {agent?.name || draft.name}</span> : null}
        </span>
        <span className="ms-auto"><Pill state={state} /></span>
      </div>

      {state === 'pending' && (
        <div className="mt-2.5 grid grid-cols-1 gap-2 sm:grid-cols-2">
          <div className="grid grid-cols-[1fr_64px] gap-2 sm:col-span-2">
            <div>
              <label className={label}>{t('agent.card.name')}</label>
              <input data-agent-field="name" dir="auto" value={draft.name} onChange={set('name')} className={field} />
            </div>
            <div>
              <label className={label}>{t('agent.card.emoji')}</label>
              <input data-agent-field="emoji" value={draft.emoji} onChange={set('emoji')} className={`${field} text-center`} />
            </div>
          </div>
          <div className="sm:col-span-2">
            <label className={label}>{t('agent.card.persona')}</label>
            <textarea data-agent-field="persona" dir="auto" rows={5} value={draft.persona} onChange={set('persona')} className={`${field} resize-y leading-relaxed`} />
          </div>
          <button type="button" data-agent-advanced onClick={() => setAdvanced((v) => !v)} className="flex cursor-pointer items-center gap-1 font-mono text-[11.5px] md:text-[10.5px] text-[var(--term-accent-dim)] hover:text-[var(--term-accent-strong)] sm:col-span-2">
            <Icon icon={advanced ? faCaretDown : faCaretRight} /> {t('agent.card.advanced')}
          </button>
          {advanced && (
            <>
              <div>
                <label className={label}>{t('agent.card.slug')}</label>
                <input data-agent-field="slug" value={draft.slug} onChange={set('slug')} placeholder="marketing-lead" className={field} />
              </div>
              <EngineToggle
                data-agent-field="engine"
                className="sm:col-span-2"
                label={t('agent.card.engine')}
                options={{ engine: draft.engine, model: draft.model }}
                onChange={(o) => setDraft((cur) => ({ ...cur, engine: o.engine || '', model: o.model || '' }))}
              />
              <div>
                <label className={label}>{t('agent.card.model')}</label>
                <select data-agent-field="model" value={draft.model} onChange={set('model')} className={field}>
                  <option value="">{t('agent.card.modelDefault')}</option>
                  {agentModelOptions(draft.engine, models, draft.model).map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                </select>
              </div>
              <div>
                <label className={label}>{t('agent.card.budget')}</label>
                <input data-agent-field="budget" type="number" min="0" value={draft.budget} onChange={set('budget')} placeholder={t('agent.card.budgetNone')} className={field} />
              </div>
              <div className="sm:col-span-2">
                <label className={label}>{t('agent.card.tools')}</label>
                <div className="flex flex-wrap gap-x-3 gap-y-1">
                  {TOOL_FAMILIES.map((id) => (
                    <label key={id} className="flex cursor-pointer items-center gap-1 font-mono text-[11.5px] md:text-[10.5px] text-[var(--term-accent-fg)]">
                      <input type="checkbox" checked={draft.tools.includes(id)} onChange={() => toggle('tools', id)} /> {t(`agent.tool.${id}`)}
                    </label>
                  ))}
                </div>
              </div>
              <div className="sm:col-span-2">
                <label className={label}>{t('agent.card.skills')}</label>
                {skillNames === null ? (
                  <span className="font-mono text-[11.5px] md:text-[10.5px] text-[var(--term-accent-dim)]"><Icon icon={faCircleNotch} spin /></span>
                ) : skillNames.length === 0 ? (
                  <span className="font-mono text-[11.5px] md:text-[10.5px] text-[var(--term-accent-dim)]">{t('agent.card.noSkills')}</span>
                ) : (
                  <div className="flex max-h-[96px] flex-wrap gap-x-3 gap-y-1 overflow-y-auto thin-scroll">
                    {skillNames.map((n) => (
                      <label key={n} className="flex cursor-pointer items-center gap-1 font-mono text-[11.5px] md:text-[10.5px] text-[var(--term-accent-fg)]">
                        <input type="checkbox" checked={draft.skills.includes(n)} onChange={() => toggle('skills', n)} /> {n}
                      </label>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
          {err && <div dir="auto" className="rounded-[8px] border border-[#e2c4c0] bg-[#FBECEA] px-3 py-1.5 font-mono text-[11.5px] md:text-[10.5px] text-[#9c3b33] sm:col-span-2">{err}</div>}
          <div className="flex flex-wrap items-center gap-2 sm:col-span-2">
            <button type="button" data-agent-confirm onClick={confirm} disabled={busy || !draft.name.trim()} className={btnPrimary}>
              {busy ? t('agent.card.creating') : t('agent.card.confirm')}
            </button>
            <button type="button" data-agent-cancel onClick={cancel} disabled={busy} className={btnSecondary}>{t('agent.card.cancel')}</button>
          </div>
        </div>
      )}

      {state !== 'pending' && (
        <div className="mt-2 flex flex-wrap items-center gap-2 font-mono text-[11.5px] md:text-[10.5px] text-[var(--term-accent-dim)]">
          <span className={state === 'cancelled' ? '' : 'text-[#2f7d4f]'}>
            <Icon icon={state === 'cancelled' ? faXmark : faCheck} />{' '}
            {state === 'created' && t('agent.card.createdLine', { name: agent?.name || draft.name })}
            {state === 'updated' && t('agent.card.updatedLine', { name: agent?.name || '', fields: (event.patch || []).join(', ') })}
            {state === 'cancelled' && t('agent.card.cancelledLine')}
          </span>
          {agent?.slug && (
            <>
              <button type="button" onClick={() => openPage(agent.slug)} className="cursor-pointer underline hover:text-[var(--term-accent-strong)]">{t('agent.card.openPage')}</button>
              {agent.skills?.length ? <span dir="auto">· {agent.skills.join(', ')}</span> : null}
              {agent.engine === 'codex' ? <span>· {engineLabel(agent.engine)}</span> : null}
              {agent.model ? <span>· {agent.model}</span> : null}
            </>
          )}
        </div>
      )}
      {state !== 'pending' && agent?.persona && (
        <pre dir="auto" className="mt-1.5 max-h-[140px] overflow-auto whitespace-pre-wrap rounded-[8px] border border-[var(--term-accent-border)] px-2.5 py-1.5 text-[11.5px] md:text-[10.5px] leading-relaxed text-[var(--term-accent-fg)] thin-scroll">{agent.persona}</pre>
      )}
    </div>
  );
}
