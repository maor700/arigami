// The AskUserQuestion card — "Question for you": the CLI's structured
// question, answered by clicks (or number keys while focus is in the card) and
// delivered through the tool's own answer channel. A multiSelect question or
// a multi-question card collects picks and sends them on Submit. OPENUI phase 2: a host library component on
// CardFrame; the option buttons keep their own styling (chosen / settled /
// live) and every focus, keyboard, stale and "answer failed" rule is as it was.
import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { Icon } from './ChatIcon.jsx';
import { useT, dirOf, dirIn } from '../lib/i18n.js';
import BidiText, { Isolated } from './BidiText.jsx';
import { keysBlocked, UNDO_MS } from '../openui/keys.js';
import { faCheck, faXmark } from '@fortawesome/free-solid-svg-icons';
import { defineHostComponent, loose, str, any, bool, z } from '../openui/define.js';
import { CardFrame, Btn, ErrorNote } from '../openui/primitives.jsx';

const optLabel = (o) => (typeof o === 'string' ? o : o?.label ?? '');
// A multi-select answer travels as one string, the labels comma-joined (the
// CLI's own AskUserQuestion convention); the echoed answer is split back.
const answerText = (v) => (Array.isArray(v) ? v.join(', ') : v);
const hasPick = (v) => (Array.isArray(v) ? v.length > 0 : v != null);

function QuestionCardView({ props: { sessionId, event, live, stale } }) {
  const t = useT();
  // The chosen label per question index (an array of labels for a
  // multiSelect question) — purely local until the answer is posted.
  const [picked, setPicked] = useState({});
  const [skipped, setSkipped] = useState({});
  const [busy, setBusy] = useState(false);
  // CHAT1: what became of the answer — null | 'tool' | 'message' | {error}.
  const [outcome, setOutcome] = useState(null);
  // A one-tap card's skip waits UNDO_MS before it is sent: {qi} | null.
  const [pendingSkip, setPendingSkip] = useState(null);
  const skipTimer = useRef(null);
  const cardRef = useRef(null);
  const questions = Array.isArray(event.input?.questions) ? event.input.questions : [];
  // A multiSelect question, or several questions on one card, collect picks
  // and go out only on an explicit Submit — so a first tap can't send a
  // half-made answer. A lone single-select question keeps one-tap.
  const needsSubmit = questions.length > 1 || questions.some((q) => !!q?.multiSelect);
  // CHAT1: picks that already reached the host (the permission-answer the
  // server echoed, folded onto this event) survive a reload and show on the
  // other device. A card the host closed WITHOUT an answer ('deny': timed
  // out, session restarted) says so — a click still works, the answer then
  // goes in as a normal message.
  const serverAnswers = event.answers && typeof event.answers === 'object' ? event.answers : null;
  // OPENUI phase 3: a closed card (host closed it without an answer, or the
  // transcript moved past it) accepts NO answers — the options freeze. The
  // old "a click still sends a plain message" fallback is gone: it answered a
  // question nothing was waiting on.
  const closed = (event.answered === 'deny' && !serverAnswers) || !!stale;
  const sent = outcome === 'tool' || outcome === 'message' || !!serverAnswers;

  // Answer the whole AskUserQuestion once every question has a pick (or is
  // skipped). The host resolves the tool's pending permission with the picks
  // (the CLI's own answer channel — the blocked turn resumes at once) and
  // says whether it did ({delivered:'tool'}) or had to send a plain message
  // because nothing was pending any more ({delivered:'message'}).
  const allAnswered = (p, sk) => questions.every((_q, qi) => hasPick(p[qi]) || sk[qi]);

  const submit = async (finalPicked, finalSkipped) => {
    setBusy(true);
    setOutcome(null);
    const answers = questions.map((q, qi) => ({
      question: q.question || q.header || `Question ${qi + 1}`,
      answer: !finalSkipped[qi] && hasPick(finalPicked[qi]) ? answerText(finalPicked[qi]) : null,
    }));
    const content = answers.map((a) => `${a.question}: ${a.answer ?? '(no answer)'}`).join('\n');
    try {
      let delivered = 'message';
      if (event.toolUseId) {
        const r = await api.post(`/sessions/${sessionId}/question/answer`, { toolUseId: event.toolUseId, content, answers });
        delivered = r?.delivered === 'message' ? 'message' : 'tool';
      } else {
        // Fallback for events without a tool_use id: deliver as a message.
        await api.post(`/sessions/${sessionId}/message`, { text: content });
      }
      setOutcome(delivered);
      window.dispatchEvent(new CustomEvent('host:focus-input')); // back to the composer
    } catch (e) {
      // The answer did NOT reach the session: say so and put the buttons
      // back — never a card that looks answered while the chat waits. A
      // Submit card keeps its picks so Submit can simply be pressed again.
      setOutcome({ error: String(e?.message || e).replace(/^HTTP \d+ — /, '') });
      if (!needsSubmit) {
        setPicked({});
        setSkipped({});
      }
    }
    setBusy(false);
  };

  const frozen = closed || busy || sent;

  const choose = (qi, label) => {
    if (frozen || pendingSkip) return;
    if (needsSubmit) {
      // Collect only: a multiSelect option toggles, a single-select one
      // replaces the previous pick. Nothing is sent until Submit.
      const cur = picked[qi];
      const next = questions[qi]?.multiSelect
        ? (Array.isArray(cur) ? cur : []).includes(label)
          ? cur.filter((l) => l !== label)
          : [...(Array.isArray(cur) ? cur : []), label]
        : label;
      setPicked({ ...picked, [qi]: next });
      if (skipped[qi]) setSkipped({ ...skipped, [qi]: false });
      setOutcome(null);
      return;
    }
    if (picked[qi] != null || skipped[qi]) return;
    const np = { ...picked, [qi]: label };
    setPicked(np);
    if (allAnswered(np, skipped)) submit(np, skipped);
  };

  // Escape hatch: leave this question unanswered ('(no answer)' in the result) —
  // e.g. none of the options fit, or the turn behind it already died. On a
  // Submit card it only marks the question (Undo puts it back); a one-tap
  // card sends the skip after UNDO_MS unless Undo is pressed first.
  const skip = (qi) => {
    if (frozen || pendingSkip || skipped[qi]) return;
    if (needsSubmit) {
      setSkipped({ ...skipped, [qi]: true });
      setPicked({ ...picked, [qi]: undefined });
      return;
    }
    if (picked[qi] != null) return;
    setPendingSkip({ qi });
  };
  const unskip = (qi) => setSkipped({ ...skipped, [qi]: false });

  const commitSkipRef = useRef(null);
  commitSkipRef.current = () => {
    if (!pendingSkip) return;
    const ns = { ...skipped, [pendingSkip.qi]: true };
    setPendingSkip(null);
    setSkipped(ns);
    if (allAnswered(picked, ns)) submit(picked, ns);
  };
  useEffect(() => {
    if (!pendingSkip) return;
    skipTimer.current = setTimeout(() => commitSkipRef.current(), UNDO_MS);
    cardRef.current?.querySelector('[data-undo]')?.focus();
    return () => clearTimeout(skipTimer.current);
  }, [pendingSkip]);
  // Leaving the chat mid-countdown still sends the skip the human asked for.
  useEffect(() => () => { if (skipTimer.current) commitSkipRef.current?.(); }, []);
  const undoSkip = () => {
    clearTimeout(skipTimer.current);
    skipTimer.current = null;
    setPendingSkip(null);
  };

  // Keyboard: number keys (1–9) pick in the focused question (else the first
  // unanswered one), arrows move between options, Esc/s skip. Only while
  // focus is INSIDE this card — a stray Esc that closes a menu, a palette or
  // a dialog elsewhere never answers (or skips) the question.
  const activeQi = questions.findIndex((q, qi) => !hasPick(picked[qi]) && !skipped[qi]);
  const keysLive = live && !frozen && !pendingSkip && (needsSubmit || activeQi >= 0);
  useEffect(() => {
    // Only the LIVE question grabs focus. `live` (computed in ChatPane) = the
    // session is awaiting-input AND this is the most-recent question card —
    // so earlier unanswered questions in the same transcript don't also bind
    // handlers and fight over focus.
    if (!keysLive || activeQi < 0) return;
    const first = cardRef.current?.querySelector(`[data-qi="${activeQi}"] button[data-opt]`);
    if (first && !cardRef.current.contains(document.activeElement)) first.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keysLive, activeQi]);
  const onKeyRef = useRef(null);
  onKeyRef.current = (e) => {
    const card = cardRef.current;
    const el = document.activeElement;
    if (!card || !el || !card.contains(el) || keysBlocked(e, card)) return;
    const focusedQi = Number(el.closest?.('[data-qi]')?.getAttribute('data-qi'));
    const qi = Number.isInteger(focusedQi) && !skipped[focusedQi] ? focusedQi : activeQi;
    const opts = qi >= 0 && Array.isArray(questions[qi]?.options) ? questions[qi].options : [];
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      // Move the highlight between the option buttons; Enter (or Space) then
      // activates the focused one (native button activation).
      const btns = [...card.querySelectorAll('button[data-opt]')];
      if (!btns.length) return;
      e.preventDefault(); e.stopPropagation();
      const cur = btns.indexOf(el);
      const step = e.key === 'ArrowDown' ? 1 : -1;
      const start = cur < 0 ? (step > 0 ? -1 : 0) : cur;
      btns[(start + step + btns.length) % btns.length].focus();
    } else if (/^[1-9]$/.test(e.key)) {
      const idx = Number(e.key) - 1;
      if (idx < opts.length) {
        e.preventDefault(); e.stopPropagation();
        choose(qi, optLabel(opts[idx]));
      }
    } else if (e.key === 'Escape' || e.key === 's' || e.key === 'S') {
      if (qi < 0) return;
      e.preventDefault(); e.stopPropagation();
      skip(qi);
    }
  };
  useEffect(() => {
    if (!keysLive) return;
    const onKey = (e) => onKeyRef.current(e);
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [keysLive]);

  const canSubmit = needsSubmit && !frozen && allAnswered(picked, skipped);

  return (
    <CardFrame ref={cardRef} tone="accent" live={!closed && !serverAnswers} label={t('chat.questionForYou')} data-question-card={event.toolUseId || ''} data-question-state={closed ? 'closed' : serverAnswers ? 'answered' : 'open'} data-live={(live && !closed) || undefined}>
      {questions.map((q, qi) => {
        const options = Array.isArray(q.options) ? q.options : [];
        const multi = !!q.multiSelect;
        const local = picked[qi];
        const echoed = serverAnswers ? serverAnswers[q.question] : undefined;
        const chosenSet = hasPick(local)
          ? (Array.isArray(local) ? local : [local])
          : typeof echoed === 'string' && echoed
            ? (multi ? echoed.split(', ') : [echoed])
            : [];
        const wasSkipped = skipped[qi] || (!!serverAnswers && !chosenSet.length);
        const skipPending = pendingSkip?.qi === qi;
        // One-tap: a question freezes on its first pick. Submit card: the
        // options stay live until the whole card is sent.
        const settled = closed || sent || (!needsSubmit && chosenSet.length > 0);
        // the question's language decides its mixed-script options (see dirIn)
        const qDir = dirOf([q.header, q.question, ...options.map((o) => (typeof o === 'string' ? o : `${o?.label ?? ''} ${o?.description ?? ''}`))].join(' '));
        return (
          <div key={qi} data-qi={qi} className="mt-3 first:mt-2.5">
            {q.header && (
              <BidiText text={q.header} dir={dirIn(q.header, qDir)} className="mb-0.5 text-xs tracking-[0.06em] text-[var(--term-accent-dim)] uppercase" />
            )}
            {q.question && (
              <BidiText text={q.question} dir={dirIn(q.question, qDir)} lines className="mb-2 text-[13px] leading-snug text-[var(--term-accent-fg)]" />
            )}
            {multi && !settled && !wasSkipped && (
              <div data-multi-hint className="-mt-1 mb-2 text-xs text-[var(--term-accent-dim)]">{t('chat.selectSeveral')}</div>
            )}
            {wasSkipped || skipPending ? (
              <span className="flex flex-wrap items-center gap-2 text-xs text-[var(--term-accent-dim)]">
                <span><Icon icon={faXmark} /> {skipPending ? t('chat.skipping') : t('chat.skipped')}</span>
                {(skipPending || (skipped[qi] && needsSubmit && !frozen)) && (
                  <button
                    type="button"
                    data-undo
                    onClick={() => (skipPending ? undoSkip() : unskip(qi))}
                    className="cursor-pointer rounded font-medium text-[var(--term-accent-strong)] underline underline-offset-2 outline-none focus-visible:outline-2 focus-visible:outline-ring coarse:min-h-11 coarse:px-2"
                  >
                    {t('chat.undo')}
                  </button>
                )}
              </span>
            ) : (
              <>
            <div className="flex flex-col gap-1.5" role={multi ? 'group' : undefined}>
              {options.map((opt, oi) => {
                const label = optLabel(opt);
                const description = typeof opt === 'string' ? '' : opt?.description ?? '';
                const isChosen = chosenSet.includes(label);
                const dim = settled && !isChosen;
                return (
                  <button
                    key={oi}
                    type="button"
                    data-opt={!settled ? '' : undefined}
                    role={multi ? 'checkbox' : undefined}
                    aria-checked={multi ? isChosen : undefined}
                    aria-pressed={!multi && needsSubmit ? isChosen : undefined}
                    disabled={busy || settled}
                    onClick={() => choose(qi, label)}
                    className={`cursor-pointer rounded-md border px-3 py-2 text-start outline-none transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring disabled:cursor-default coarse:min-h-11 ${
                      isChosen
                        ? 'border-[var(--term-accent-strong)] bg-[var(--term-hover)]'
                        : dim
                          ? 'border-[var(--term-accent-border)] bg-transparent opacity-40'
                          : 'border-[var(--term-accent-border)] bg-transparent hover:bg-[var(--term-hover)]'
                    }`}
                  >
                    <span
                      dir={dirIn(label, qDir)}
                      className="flex items-center text-[13px] font-medium text-[var(--term-accent-strong)]"
                    >
                      {multi && (
                        <span
                          aria-hidden
                          data-checkbox={isChosen ? 'on' : 'off'}
                          className={`me-2 inline-flex size-4 shrink-0 items-center justify-center rounded-[4px] border text-[10px] ${
                            isChosen ? 'border-[var(--term-accent-strong)] bg-[var(--term-accent-strong)] text-[var(--term-bg)]' : 'border-[var(--term-accent-dim)]'
                          }`}
                        >
                          {isChosen && <Icon icon={faCheck} />}
                        </span>
                      )}
                      {oi < 9 && !settled && (
                        <span className="me-1.5 text-xs text-[var(--term-accent-dim)]">{oi + 1}</span>
                      )}
                      <span className="min-w-0"><Isolated text={label} /></span>
                      {isChosen && !multi && <Icon icon={faCheck} className="ms-1" />}
                    </span>
                    {description && (
                      <BidiText
                        as="span"
                        text={description}
                        dir={dirIn(description, qDir)}
                        className="mt-0.5 block text-xs leading-snug text-[var(--term-accent-dim)]"
                      />
                    )}
                  </button>
                );
              })}
            </div>
            {!settled && (
              <button
                type="button"
                disabled={busy || !!pendingSkip}
                onClick={() => skip(qi)}
                className="mt-1.5 cursor-pointer text-xs text-[var(--term-accent-dim)] underline-offset-2 hover:underline disabled:cursor-default disabled:opacity-50 coarse:min-h-11"
              >
                {t('chat.skipThisQuestion')}
              </button>
            )}
              </>
            )}
          </div>
        );
      })}
      {needsSubmit && !closed && !sent && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Btn
            variant="primary"
            data-question-submit
            disabled={!canSubmit}
            onClick={() => submit(picked, skipped)}
            className="coarse:min-h-11"
          >
            {t('chat.submitAnswers')}
          </Btn>
          {!canSubmit && !busy && (
            <span className="text-xs text-[var(--term-accent-dim)]">{t('chat.answerEveryQuestion')}</span>
          )}
        </div>
      )}
      {outcome && typeof outcome === 'object' && (
        <ErrorNote data-question-error label={t('chat.answerFailed')}>{outcome.error}</ErrorNote>
      )}
      {outcome === 'message' && (
        <div data-question-note dir="auto" className="mt-2.5 text-xs text-[var(--term-accent-dim)]">{t('chat.answerSentAsMessage')}</div>
      )}
      {closed && !outcome && !Object.values(picked).some(hasPick) && (
        <div data-question-closed dir="auto" className="mt-2.5 text-xs text-[var(--term-accent-dim)]">{t('chat.questionClosed')}</div>
      )}
    </CardFrame>
  );
}


export const QuestionCardDef = defineHostComponent({
  name: 'QuestionCard',
  description: 'Host: AskUserQuestion — the human picks answers; delivered through the tool\'s answer channel',
  props: loose({
    sessionId: z.string(),
    live: bool,
    stale: bool,
    event: loose({ toolUseId: str, input: any, answered: str, answers: any }),
  }),
  component: QuestionCardView,
});

export default function QuestionCard({ sessionId, event, live, stale }) {
  return <QuestionCardView props={{ sessionId, event, live, stale }} />;
}
