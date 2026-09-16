/**
 * EXT — a card an extension wrote into the transcript
 * (`appendChat(id, {kind:'ext-card', title, body, buttons})`).
 *
 * OPENUI phase 2: a host library component (define.js) built from the shared
 * primitives; ChatPane renders it through HostCard. Deliberately minimal, and
 * deliberately forgiving: an extension is user code, so a card with a
 * missing/odd field must degrade, never break the transcript. Every field is
 * optional; a card with nothing renderable renders nothing. `buttons[]` are
 * `{label, prompt}` — pressing one sends the prompt to the session as an
 * ordinary message, which is all a card is allowed to do.
 */
import { useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api } from '../lib/api.js';
import { useT, dirOf } from '../lib/i18n.js';
import { defineHostComponent, loose, str, any, z } from '../openui/define.js';
import { CardFrame, Eyebrow, Btn } from '../openui/primitives.jsx';

function ExtCardView({ props: { sessionId, event } }) {
  const t = useT();
  const [busy, setBusy] = useState('');
  const title = typeof event.title === 'string' ? event.title.trim() : '';
  const body = typeof event.body === 'string' ? event.body : '';
  const buttons = (Array.isArray(event.buttons) ? event.buttons : [])
    .filter((b) => b && typeof b.label === 'string' && b.label.trim() && typeof b.prompt === 'string' && b.prompt.trim())
    .slice(0, 6);
  if (!title && !body && !buttons.length) return null;

  const press = async (b, i) => {
    if (busy) return;
    setBusy(String(i));
    try {
      await api.post(`/sessions/${sessionId}/message`, { text: b.prompt });
    } catch {
      /* the composer's own error path owns retries — a card stays quiet */
    } finally {
      setBusy('');
    }
  };

  return (
    <CardFrame tone="panel" dense data-ext-card={event.extension || true}>
      <Eyebrow>{event.extension ? `${t('ext.card.from')} · ${event.extension}` : t('ext.card.from')}</Eyebrow>
      {title && <div className="text-[12.5px] font-bold text-fg" dir={dirOf(title)}>{title}</div>}
      {body && (
        <div className="md mt-1 text-[12px]" dir={dirOf(body)}>
          <Markdown remarkPlugins={[remarkGfm]}>{body}</Markdown>
        </div>
      )}
      {buttons.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {buttons.map((b, i) => (
            <Btn key={i} variant="pill" disabled={!!busy} onClick={() => press(b, i)}>{b.label}</Btn>
          ))}
        </div>
      )}
    </CardFrame>
  );
}

export const ExtCardDef = defineHostComponent({
  name: 'ExtCard',
  description: 'Host: a card an extension appended (title, markdown, prompt buttons)',
  props: loose({
    sessionId: z.string(),
    event: loose({ extension: str, title: any, body: any, buttons: any }),
  }),
  component: ExtCardView,
});

export default function ExtCard({ sessionId, event }) {
  return <ExtCardView props={{ sessionId, event }} />;
}
