// S2 — the {kind:'setup'} chat card (host.request_setup). The agent hit a
// capability that isn't connected and asked instead of failing; this card is
// where the human decides:
//   header      "The agent needs <capability> — <why>"
//   mode        AUTO (default when a Google identity is connected and the
//               capability is auto-capable) / MANUAL
//   auto        consent text listing exactly what the agent will do, then
//               [Connect automatically] [Not now]. The click resolves the
//               tool call with {state:'auto'}; the agent runs the playbook and
//               narrates here (AutoConnect) until report_setup closes the card.
//   manual      the manual.kind component (TokenStep / OAuthCodeStep / …).
//   done/failed/skipped/timeout — frozen line, evidence link when present;
//               a failure drops back to MANUAL with the reason (rule 5).
// Every link is host-relative so the card works from a phone.
import { useState } from 'react';
import { useT } from '../../lib/i18n.js';
import { Icon } from '../../lib/icons.js';
import { useStore } from '../../lib/store.js';
import * as setupApi from '../../lib/setup-api.js';
import { stepFor } from './index.js';
import { capTitle, capFamily, consentKeys, manualFor } from './registry.js';
import AutoConnect, { EvidenceLink } from './AutoConnect.jsx';
import { Pill, ErrorBox } from './shared.jsx';
import { faCheck, faXmark, faWandMagicSparkles, faHand, faShieldHalved, faCircleNotch } from '@fortawesome/free-solid-svg-icons';
import { defineHostComponent, loose, str, any, bool, z } from '../../openui/define.js';
import { CardFrame, Btn } from '../../openui/primitives.jsx';

export const TERMINAL = new Set(['done', 'failed', 'skipped', 'timeout']);

// Card phase from the event (+ an optimistic local override after a manual
// step succeeded and the server patch hasn't arrived yet).
export function derivePhase(event, local) {
  if (local && TERMINAL.has(local)) return local;
  const s = event?.state || 'pending';
  if (s === 'running') return 'auto';
  return ['pending', 'auto', 'done', 'failed', 'skipped', 'timeout'].includes(s) ? s : 'pending';
}

// AUTO is the default only when it can actually run: capability is
// auto-capable AND a Google identity is connected (rule: no auto without a
// click, but the switch is preselected).
export function defaultMode(event) {
  if (event?.mode === 'manual' || event?.mode === 'auto') return event.mode;
  const auto = event?.autoCapable ?? manualFor(event?.capability).autoCapable;
  return auto && event?.identity ? 'auto' : 'manual';
}

function ModeSwitch({ mode, onChange, autoAllowed, identity }) {
  const t = useT();
  const seg = (v, icon, label) => (
    <button
      type="button"
      role="radio"
      aria-checked={mode === v}
      disabled={v === 'auto' && !autoAllowed}
      onClick={() => onChange(v)}
      className={`flex-1 cursor-pointer rounded-[6px] px-2.5 py-1 text-[11px] font-bold disabled:cursor-default disabled:opacity-40 ${mode === v ? 'bg-brand text-[#1a1a1a]' : 'text-[var(--term-accent-fg)]'}`}
    >
      <Icon icon={icon} /> {label}
    </button>
  );
  return (
    <div>
      <div role="radiogroup" className="flex gap-1 rounded-[8px] border border-[var(--term-accent-border)] p-0.5">
        {seg('auto', faWandMagicSparkles, t('setup.mode.auto'))}
        {seg('manual', faHand, t('setup.mode.manual'))}
      </div>
      {!autoAllowed && (
        <div className="mt-1 text-[11.5px] md:text-[10.5px] text-[var(--term-accent-dim)]">
          {identity ? t('setup.mode.autoUnavailable') : t('setup.mode.needsIdentity')}
        </div>
      )}
    </div>
  );
}

function Consent({ capability, identity }) {
  const t = useT();
  const keys = consentKeys(capability);
  const name = capTitle(t, capability);
  return (
    <div className="rounded-[8px] border border-dashed border-[var(--term-accent-border)] px-3 py-2 text-[11.5px] leading-relaxed text-[var(--term-accent-fg)]">
      <div className="font-bold"><Icon icon={faShieldHalved} /> {t('setup.consent.title', { name })}</div>
      <ul className="mt-1 list-disc ps-5">
        {identity?.email && <li>{t('setup.consent.identity', { email: identity.email })}</li>}
        {keys.map((k) => <li key={k}>{t(k, { name })}</li>)}
        <li>{t('setup.consent.noPasswords')}</li>
        <li>{t('setup.consent.evidence')}</li>
      </ul>
    </div>
  );
}

// OPENUI phase 2: a host library component on CardFrame/Btn; the manual step
// components (TokenStep, OAuthCodeStep…) stay native inside it.
function SetupCardView({ props: { sessionId, event } }) {
  const t = useT();
  const [override, setOverride] = useState(null); // the human's explicit auto/manual pick
  const [local, setLocal] = useState(null); // optimistic terminal state
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const phase = derivePhase(event, local);
  const capability = event.capability;
  const manual = event.manual || manualFor(capability).manual;
  const autoCapable = event.autoCapable ?? manualFor(capability).autoCapable;
  const identity = event.identity || null;
  const autoAllowed = !!autoCapable && !!identity;
  const title = capTitle(t, capability);
  // A2: a card raised by a session born from an agent connects the AGENT (its
  // identity / Composio account) — say so, by the agent's name.
  const { agents } = useStore();
  const ownerSlug = typeof event.owner === 'string' && event.owner.startsWith('agent:') ? event.owner.slice(6) : null;
  const ownerAgent = ownerSlug ? (agents || []).find((a) => a.slug === ownerSlug) : null;

  // A failure reported by the agent flips the card to MANUAL with the reason
  // (rule 5) unless the human explicitly picks auto again.
  const mode = override ?? (phase === 'failed' ? 'manual' : defaultMode(event));

  const call = async (fn) => {
    setBusy(true);
    setErr(null);
    try { await fn(); } catch (e) { setErr(e?.message || String(e)); } finally { setBusy(false); }
  };
  const changeMode = (m) => {
    setOverride(m);
    setupApi.setMode(event.requestId, m).catch(() => {}); // informational; old hosts 404
  };
  const startAuto = () => call(() => setupApi.start(event.requestId, 'auto'));
  const notNow = () => call(async () => { await setupApi.skip(event.requestId); setLocal('skipped'); });
  const manualDone = (r) => {
    setLocal('done');
    // Tell the server the human finished the manual path (it re-checks and
    // resolves the agent's request_setup). Old hosts: 404, ignored.
    setupApi.report(event.requestId, { ok: true, mode: 'manual', detail: r?.detail || r?.email || '' , human: true }).catch(() => {});
  };

  const Step = stepFor(manual.kind);
  const stepProps = {
    capability,
    manual,
    sessionId,
    requestId: event.requestId,
    owner: event.owner,
    onDone: manualDone,
    ...(manual.kind === 'toggle' ? { enabled: !!event.enabled } : {}),
    ...(manual.kind === 'repo' ? { have: event.have || [] } : {}),
  };

  const terminal = TERMINAL.has(phase);
  const termLabel = {
    done: t('setup.card.done', { name: title }),
    failed: t('setup.card.failed', { name: title }),
    skipped: t('setup.card.skipped', { name: title }),
    timeout: t('setup.card.timeout', { name: title }),
  }[phase];

  // F6: one live status line the owner can trust instead of typing "connected" in chat.
  const waiting = phase === 'pending' || phase === 'failed';
  const statusLine = waiting ? t('setup.card.waiting') : phase === 'auto' ? t('setup.card.connecting') : phase === 'done' ? t('setup.card.completed') : null;

  return (
    <CardFrame
      tone="accent"
      live={!terminal}
      data-setup-phase={phase}
      className={waiting ? 'setup-waiting' : ''}
      label={<>{t('setup.card.needs', { name: title })}{event.why && event.why !== event.title ? <span className="font-normal"> — {event.why}</span> : null}</>}
      meta={ownerSlug && (
        <span data-setup-owner={event.owner} dir="auto" className="rounded-full border border-[var(--term-accent-border)] px-2 py-px text-[11.5px] md:text-[10px] text-[var(--term-accent-fg)]">
          {ownerAgent?.emoji ? `${ownerAgent.emoji} ` : ''}{t('setup.card.owner', { name: ownerAgent?.name || ownerSlug })}
        </span>
      )}
      right={<Pill status={phase} />}
    >
      {statusLine && (
        <div dir="auto" data-setup-status={phase} className={`mt-1.5 flex items-center gap-1.5 text-[11px] font-semibold ${phase === 'done' ? 'text-[#2f7d4f]' : 'text-[var(--term-accent-fg)]'}`}>
          {waiting && <span className="pulse-yellow inline-block h-[6px] w-[6px] rounded-full bg-brand" />}
          {phase === 'auto' && <Icon icon={faCircleNotch} spin />}
          {phase === 'done' && <Icon icon={faCheck} />}
          <span>{statusLine}</span>
        </div>
      )}
      {capFamily(capability) === 'identity' && !terminal && (
        <div dir="auto" className="mt-1.5 text-[11.5px] leading-snug text-[var(--term-accent-dim)]">
          {t('setup.card.identityIntro')} <span className="font-semibold text-[var(--term-accent-fg)]">{t('setup.card.identityHint')}</span>
        </div>
      )}

      {terminal && (
        <div className="mt-2.5 flex flex-wrap items-center gap-2 font-mono text-[11.5px] md:text-[10.5px] text-[var(--term-accent-dim)]">
          <span className={phase === 'done' ? 'text-[#2f7d4f]' : phase === 'failed' ? 'text-[#9c3b33]' : ''}>
            <Icon icon={phase === 'done' ? faCheck : faXmark} /> {termLabel}
          </span>
          {event.detail && <span dir="auto">— {event.detail}</span>}
          {event.evidence && <EvidenceLink sessionId={sessionId} evidence={event.evidence} title={title} />}
        </div>
      )}

      {phase === 'failed' && event.detail && (
        <div dir="auto" className="mt-2 rounded-[8px] border border-[#e2c4c0] bg-[#FBECEA] px-3 py-2 text-[11.5px] text-[#9c3b33]">{t('setup.card.failedManual')}</div>
      )}

      {phase === 'auto' && (
        <div className="mt-2.5">
          <AutoConnect
            sessionId={sessionId}
            state="auto"
            header={false}
            lines={event.lines || []}
            detail={event.detail}
            onManual={() => changeMode('manual')}
            onCancel={notNow}
          />
        </div>
      )}

      {(phase === 'pending' || phase === 'failed') && (
        <div className="mt-2.5 flex flex-col gap-2.5">
          {autoCapable && (
            <ModeSwitch mode={mode} onChange={changeMode} autoAllowed={autoAllowed} identity={identity} />
          )}
          {mode === 'auto' && autoAllowed ? (
            <>
              <Consent capability={capability} identity={identity} />
              <div className="flex flex-wrap items-center justify-end gap-2">
                <Btn variant="secondary" disabled={busy} onClick={notNow}>{t('setup.notNow')}</Btn>
                <Btn variant="primary" disabled={busy} onClick={startAuto}>
                  <Icon icon={faWandMagicSparkles} /> {t('setup.connectAuto')}
                </Btn>
              </div>
            </>
          ) : (
            <>
              {/* the manual step components use the panel palette — give them a solid panel inside the dark card */}
              <div className="rounded-[8px] border border-border bg-panel px-3 py-2.5 text-fg">
                <Step {...stepProps} />
              </div>
              <div className="flex flex-wrap items-center justify-end gap-2">
                <Btn variant="secondary" disabled={busy} onClick={notNow}>{t('setup.notNow')}</Btn>
              </div>
            </>
          )}
        </div>
      )}
      <ErrorBox err={err} />
    </CardFrame>
  );
}

export const SetupCardDef = defineHostComponent({
  name: 'SetupCard',
  description: 'Host: request_setup — the agent needs a capability; the human connects it (auto / manual)',
  props: loose({
    sessionId: z.string(),
    event: loose({ requestId: str, capability: str, why: str, title: str, state: str, mode: str, autoCapable: bool, identity: any, owner: str, manual: any, lines: any, detail: any, evidence: str, enabled: bool, have: any }),
  }),
  component: SetupCardView,
});

export default function SetupCard({ sessionId, event }) {
  return <SetupCardView props={{ sessionId, event }} />;
}
