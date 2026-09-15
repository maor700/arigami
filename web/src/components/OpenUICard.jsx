// OPENUI pilot — the chat card for `{kind:'openui', ui}` (the render_ui tool).
// This is the light shell (header, title, "sent" line); the parser + library
// (OpenUIBody.jsx) load lazily on the first card. Forgiving on purpose: the
// source is model output, so a block that does not parse, names an unknown
// component, throws while rendering — or whose chunk fails to load — shows a
// quiet fallback and never breaks the transcript. Button / Form actions go
// back into the session as an ordinary message, the same path ExtCard uses.
import { Component, Suspense, lazy, useState } from 'react';
import { api } from '../lib/api.js';
import { useT, dirOf } from '../lib/i18n.js';
import { actionToMessage } from '../openui/message.js';

const Body = lazy(() => import('./OpenUIBody.jsx'));
/** Tests + the demo page await this so the lazy chunk is ready before mounting. */
export const preloadOpenUI = () => import('./OpenUIBody.jsx');

class ChunkBoundary extends Component {
  constructor(p) { super(p); this.state = { err: null }; }
  static getDerivedStateFromError(err) { return { err }; }
  render() { return this.state.err ? this.props.fallback : this.props.children; }
}

export default function OpenUICard({ sessionId, event }) {
  const t = useT();
  const ui = typeof event?.ui === 'string' ? event.ui : '';
  const title = typeof event?.title === 'string' ? event.title.trim() : '';
  const [sent, setSent] = useState('');
  const [busy, setBusy] = useState(false);

  const onAction = async (ev) => {
    const text = actionToMessage(ev);
    if (!text || busy) return;
    setBusy(true);
    try {
      await api.post(`/sessions/${sessionId}/message`, { text });
      setSent(String(ev.humanFriendlyMessage || t('openui.sent')));
    } catch {
      /* the composer owns retries — a card stays quiet */
    } finally {
      setBusy(false);
    }
  };

  const quiet = <div data-openui-fallback="chunk" className="text-[11.5px] text-fgdim">{t('openui.fallback')}</div>;
  return (
    <div data-openui-card="" className="my-1.5 rounded-[10px] border border-hair bg-panel px-3 py-2.5">
      <div className="mb-1 font-mono text-[11px] md:text-[9px] tracking-[0.08em] text-fgdim uppercase">{t('openui.from')}</div>
      {title && <div className="mb-1.5 text-[12.5px] font-bold text-fg" dir={dirOf(title)}>{title}</div>}
      <ChunkBoundary fallback={quiet}>
        <Suspense fallback={<div data-openui-loading="" className="h-6 animate-pulse rounded-md bg-[var(--term-hover)] opacity-60" />}>
          <Body ui={ui} busy={busy} onAction={onAction} />
        </Suspense>
      </ChunkBoundary>
      {sent && <div data-openui-sent="" className="mt-1.5 text-[11px] text-fgdim" dir={dirOf(sent)}>✓ {sent}</div>}
    </div>
  );
}
