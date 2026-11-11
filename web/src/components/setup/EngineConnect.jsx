// Connect an AI engine — Claude and Codex as TWO EQUAL choices, side by side:
// same card, same numbered steps, same primary button, same live state. Used by
// the chat's setup card, the Setup screen and the wizard, so a person who only
// has Codex (or only Claude) is never pushed to the other.
//
//   card     title · 3 numbered steps (the current one is highlighted) ·
//            ONE primary button · "use a token instead" · live state / failure
//   states   not installed → install line + Check again;
//            connecting → waiting + what to do; failed → reason + Try again;
//            connected → green "<name> is connected"
// An engine already connected does not hide the other one: it stays a normal
// card, with a quiet "optional" line.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '../../lib/i18n.js';
import { Icon } from '../ChatIcon.jsx';
import * as setupApi from '../../lib/setup-api.js';
import OAuthCodeStep from './OAuthCodeStep.jsx';
import { BTN2 } from './shared.jsx';
import { Badge } from '../ui/badge.jsx';
import { faCheck, faRotateRight } from '@fortawesome/free-solid-svg-icons';

export const ENGINE_SPECS = [
  { id: 'claude', name: 'Claude', flow: 'pkce', install: 'npm i -g @anthropic-ai/claude-code' },
  { id: 'codex', name: 'Codex', flow: 'codex', install: 'npm i -g @openai/codex' },
];

/** {claude, codex} → true when at least one engine can run (pure; the Setup screen and tests use it). */
export const anyEngineConnected = (engines) => ENGINE_SPECS.some((e) => !!engines?.[e.id]?.ok);

function EngineCard({ spec, cap, otherOk, sessionId, owner, onChanged, onDone }) {
  const t = useT();
  const [phase, setPhase] = useState('idle'); // idle | waiting | error — from the OAuth step
  const ok = !!cap?.ok;
  const cli = cap?.data?.cli !== false;
  const step = ok ? 4 : phase === 'waiting' ? 2 : phase === 'error' ? 1 : 1;
    return (
    <section data-engine={spec.id} data-connected={ok ? 'true' : 'false'} className="flex min-w-0 flex-col rounded-lg border border-hair bg-panel px-4 py-4">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-medium text-fg">{t(`setup.engine.${spec.id}.connect`)}</h3>
        {ok && <Badge status="ok" className="ms-auto"><Icon icon={faCheck} /> {t('setup.engine.connected', { name: spec.name })}</Badge>}
      </div>
      <div className="mt-0.5 text-xs text-fgdim">{t(`setup.engine.${spec.id}.sub`)}</div>
      {!ok && (
        <>
          <ol className="mt-3 flex flex-col gap-1.5">
            {[1, 2, 3].map((n) => (
              <li key={n} className={`flex items-start gap-2 text-xs leading-snug ${n === step ? 'font-medium text-fg' : 'text-fgdim'}`}>
                <span className={`mt-px inline-flex size-[18px] shrink-0 items-center justify-center rounded-full border text-2xs font-medium tabular-nums ${n === step ? 'border-foreground bg-foreground text-background' : n < step ? 'border-transparent bg-ok text-white' : 'border-input text-fgdim'}`}>
                  {n < step ? <Icon icon={faCheck} /> : n}
                </span>
                <span>{t(`setup.engine.${spec.id}.step${n}`)}</span>
              </li>
            ))}
          </ol>
          <div className="mt-auto pt-3">
            {!cli ? (
              <>
                <p className="text-xs leading-snug text-fgdim">{t(`wizard.${spec.id}.noCli`)}</p>
                <code dir="ltr" className="mt-1.5 block rounded-md border border-hair bg-muted px-2 py-1.5 font-mono text-xs select-all">{spec.install}</code>
                <button type="button" onClick={onChanged} className={`${BTN2} mt-2`}><Icon icon={faRotateRight} /> {t('setup.engine.recheck')}</button>
              </>
            ) : (
              <OAuthCodeStep
                capability={spec.id}
                manual={{ kind: 'oauth', flow: spec.flow, token: true }}
                sessionId={sessionId}
                owner={owner}
                signInLabel={t(`setup.engine.${spec.id}.connect`)}
                neutral
                onPhase={setPhase}
                onDone={(r) => { onChanged?.(); onDone?.(spec.id, r); }}
              />
            )}
          </div>
          {otherOk && <div className="mt-2 text-xs text-fgdim">{t('setup.engine.have', { name: spec.id === 'claude' ? 'Codex' : 'Claude' })}</div>}
        </>
      )}
    </section>
  );
}

/**
 * Both engines, side by side. `engines` ({claude, codex}: {ok, data:{cli}}) may be
 * passed in (the Setup screen already holds them); otherwise this polls the host
 * itself, so a sign-in that finishes in another window turns the card green.
 */
export default function EngineConnect({ engines: given, onChanged, onDone, sessionId, owner, intro = true }) {
  const t = useT();
  const [own, setOwn] = useState(null);
  const poll = !given;
  const refresh = useCallback(async () => {
    try {
      const ov = await setupApi.overview();
      const cap = (id) => ov?.capabilities?.find((c) => c.id === id) || null;
      setOwn({ claude: cap('claude'), codex: cap('codex') });
    } catch { /* keep the last view */ }
  }, []);
  useEffect(() => {
    if (!poll) return undefined;
    refresh();
    const id = setInterval(refresh, 3000);
    return () => clearInterval(id);
  }, [poll, refresh]);
  const changedRef = useRef(onChanged);
  changedRef.current = onChanged;
  const changed = useCallback(() => { if (poll) refresh(); changedRef.current?.(); }, [poll, refresh]);
  const engines = given || own;
  return (
    <div>
      {intro && <p className="mb-3 text-sm leading-relaxed text-fgdim">{t('setup.engine.intro')}</p>}
      <div className="grid gap-3 sm:grid-cols-2">
        {ENGINE_SPECS.map((spec) => (
          <EngineCard
            key={spec.id}
            spec={spec}
            cap={engines?.[spec.id]}
            otherOk={!!engines?.[spec.id === 'claude' ? 'codex' : 'claude']?.ok}
            sessionId={sessionId}
            owner={owner}
            onChanged={changed}
            onDone={onDone}
          />
        ))}
      </div>
    </div>
  );
}
