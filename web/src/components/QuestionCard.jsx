// The AskUserQuestion card — "Question for you": the CLI's structured
// question, answered by clicks (or number keys) and delivered through the
// tool's own answer channel. OPENUI phase 2: a host library component on
// CardFrame; the option buttons keep their own styling (chosen / settled /
// live) and every focus, keyboard, stale and "answer failed" rule is as it was.
import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { Icon } from '../lib/icons.js';
import { useT } from '../lib/i18n.js';
import { keysBlocked } from '../openui/keys.js';
import { faCheck, faXmark } from '@fortawesome/free-solid-svg-icons';
import { defineHostComponent, loose, str, any, bool, z } from '../openui/define.js';
import { CardFrame, ErrorNote } from '../openui/primitives.jsx';

function QuestionCardView({ props: { sessionId, event, live, stale } }) {
  const t = useT();
  // The chosen label per question index — purely local, the answer is posted
  // as a normal chat message (same call ChatFooter uses).
  const [picked, setPicked] = useState({});
  const [skipped, setSkipped] = useState({});
  const [busy, setBusy] = useState(false);
  // CHAT1: what became of the answer — null | 'tool' | 'message' | {error}.
  const [outcome, setOutcome] = useState(null);
  const questions = Array.isArray(event.input?.questions) ? event.input.questions : [];
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

  // Answer the whole AskUserQuestion once every question has a pick (or is
  // skipped). The host resolves the tool's pending permission with the picks
  // (the CLI's own answer channel — the blocked turn resumes at once) and
  // says whether it did ({delivered:'tool'}) or had to send a plain message
  // because nothing was pending any more ({delivered:'message'}).
  const allAnswered = (p, sk) => questions.every((_q, qi) => p[qi] != null || sk[qi]);

  const submit = async (finalPicked, finalSkipped) => {
    setBusy(true);
    setOutcome(null);
    const answers = questions.map((q, qi) => ({
      question: q.question || q.header || `Question ${qi + 1}`,
      answer: finalPicked[qi] != null ? finalPicked[qi] : null,
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
      // back — never a card that looks answered while the chat waits.
      setOutcome({ error: String(e?.message || e).replace(/^HTTP \d+ — /, '') });
      setPicked({});
      setSkipped({});
    }
    setBusy(false);
  };

  const choose = (qi, label) => {
    if (closed || busy || picked[qi] != null || skipped[qi]) return;
    const np = { ...picked, [qi]: label };
    setPicked(np);
    if (allAnswered(np, skipped)) submit(np, skipped);
  };

  // Escape hatch: leave this question unanswered ('(no answer)' in the result) —
  // e.g. none of the options fit, or the turn behind it already died.
  const skip = (qi) => {
    if (closed || busy || picked[qi] != null || skipped[qi]) return;
    const ns = { ...skipped, [qi]: true };
    setSkipped(ns);
    if (allAnswered(picked, ns)) submit(picked, ns);
  };

  // Keyboard: answer the first unanswered question with number keys (1–9),
  // Esc/s to skip. Focus the first option so arrows/Enter work too. Only while a
  // question is outstanding, so digits don't get captured once you're done.
  const cardRef = useRef(null);
  const activeQi = questions.findIndex((q, qi) => picked[qi] == null && !skipped[qi]);
  useEffect(() => {
    // Only the LIVE question grabs focus and the arrow/number/Esc keys. `live`
    // (computed in ChatPane) = the session is awaiting-input AND this is the
    // most-recent question card — so earlier unanswered questions in the same
    // transcript don't also bind handlers and fight over focus.
    if (!live || closed || activeQi < 0 || busy) return;
    cardRef.current?.querySelector('button[data-opt]')?.focus();
    const onKey = (e) => {
      if (keysBlocked(e, cardRef.current)) return;
      const el = document.activeElement;
      const opts = Array.isArray(questions[activeQi]?.options) ? questions[activeQi].options : [];
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        // Move the highlight between the active question's option buttons; Enter
        // then picks the focused one (native button activation).
        const btns = [...(cardRef.current?.querySelectorAll('button[data-opt]') || [])];
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
          const o = opts[idx];
          choose(activeQi, typeof o === 'string' ? o : o?.label ?? '');
        }
      } else if (e.key === 'Escape' || e.key === 's' || e.key === 'S') {
        e.preventDefault(); e.stopPropagation();
        skip(activeQi);
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeQi, busy, live, closed]);

  return (
    <CardFrame ref={cardRef} tone="accent" live={!closed && !serverAnswers} label={t('chat.questionForYou')} data-question-card={event.toolUseId || ''} data-question-state={closed ? 'closed' : serverAnswers ? 'answered' : 'open'} data-live={(live && !closed) || undefined}>
      {questions.map((q, qi) => {
        const options = Array.isArray(q.options) ? q.options : [];
        const chosen = picked[qi] != null ? picked[qi] : serverAnswers ? serverAnswers[q.question] : undefined;
        const wasSkipped = skipped[qi] || (!!serverAnswers && chosen == null);
        return (
          <div key={qi} className="mt-3 first:mt-2.5">
            {q.header && (
              <div className="mb-0.5 font-mono text-[11.5px] md:text-[10px] tracking-[0.06em] text-[var(--term-accent-dim)] uppercase">
                {q.header}
              </div>
            )}
            {q.question && (
              <div className="mb-2 text-[12px] leading-snug text-[var(--term-accent-fg)]">{q.question}</div>
            )}
            {wasSkipped ? (
              <span className="font-mono text-[11.5px] md:text-[10.5px] text-[var(--term-accent-dim)]"><Icon icon={faXmark} /> {t('chat.skipped')}</span>
            ) : (
              <>
            <div className="flex flex-col gap-1.5">
              {options.map((opt, oi) => {
                const label = typeof opt === 'string' ? opt : opt?.label ?? '';
                const description = typeof opt === 'string' ? '' : opt?.description ?? '';
                const isChosen = chosen === label;
                const settled = chosen != null || closed;
                return (
                  <button
                    key={oi}
                    type="button"
                    data-opt={qi === activeQi && !closed ? '' : undefined}
                    disabled={busy || settled}
                    onClick={() => choose(qi, label)}
                    className={`cursor-pointer rounded-[7px] border-[1.5px] px-3 py-2 text-left outline-none transition-shadow focus-visible:border-brand focus-visible:shadow-[0_0_0_2px_var(--term-accent-strong)] disabled:cursor-default ${
                      isChosen
                        ? 'border-ink bg-brand text-[#1a1a1a] shadow-[2px_2px_0_#2a2a2a]'
                        : settled
                          ? 'border-[var(--term-accent-border)] bg-transparent opacity-40'
                          : 'border-[var(--term-accent-border)] bg-[var(--term-accent-bg)] hover:border-brand'
                    }`}
                  >
                    <span
                      className={`block text-[12px] font-bold ${isChosen ? 'text-[#1a1a1a]' : 'text-[var(--term-accent-strong)]'}`}
                    >
                      {oi < 9 && !settled && (
                        <span className="mr-1.5 font-mono text-[11.5px] md:text-[10px] text-[var(--term-accent-dim)]">{oi + 1}</span>
                      )}
                      {label}
                      {isChosen && <Icon icon={faCheck} className="ml-1" />}
                    </span>
                    {description && (
                      <span
                        className={`mt-0.5 block text-[11px] leading-snug ${isChosen ? 'text-[#4a3f12]' : 'text-[var(--term-accent-dim)]'}`}
                      >
                        {description}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
            {chosen == null && !closed && (
              <button
                type="button"
                disabled={busy}
                onClick={() => skip(qi)}
                className="mt-1.5 cursor-pointer font-mono text-[11.5px] md:text-[10.5px] text-[var(--term-accent-dim)] underline-offset-2 hover:underline disabled:cursor-default disabled:opacity-50"
              >
                {t('chat.skipThisQuestion')}
              </button>
            )}
              </>
            )}
          </div>
        );
      })}
      {outcome && typeof outcome === 'object' && (
        <ErrorNote data-question-error label={t('chat.answerFailed')}>{outcome.error}</ErrorNote>
      )}
      {outcome === 'message' && (
        <div data-question-note dir="auto" className="mt-2.5 font-mono text-[11.5px] md:text-[10.5px] text-[var(--term-accent-dim)]">{t('chat.answerSentAsMessage')}</div>
      )}
      {closed && !outcome && !Object.keys(picked).length && (
        <div data-question-closed dir="auto" className="mt-2.5 font-mono text-[11.5px] md:text-[10.5px] text-[var(--term-accent-dim)]">{t('chat.questionClosed')}</div>
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
