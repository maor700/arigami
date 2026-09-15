// OPENUI pilot — the heavy half of OpenUICard, loaded lazily so the parser,
// zod and the library stay out of the main bundle until a card appears.
import { Component, useMemo, useState } from 'react';
import { Renderer, createParser } from '@openuidev/react-lang';
import { useT } from '../lib/i18n.js';
import { library } from '../openui/library.jsx';
import { OPENUI_MAX_CHARS } from '../openui/message.js';

/** Sync pre-check so a bad block never reaches the Renderer: null = fine, else the reason. */
export function openuiProblem(ui) {
  if (typeof ui !== 'string' || !ui.trim()) return 'empty';
  if (ui.length > OPENUI_MAX_CHARS) return 'too-long';
  try {
    const r = createParser(library.toJSONSchema(), library.root).parse(ui);
    if (!r?.root) return 'no-root';
    const bad = (r.meta?.errors || []).find((e) => e.code === 'unknown-component');
    if (bad) return `unknown-component:${bad.component}`;
    return null;
  } catch (e) {
    return `parse:${(e && e.message) || e}`;
  }
}

class Boundary extends Component {
  constructor(p) { super(p); this.state = { err: null }; }
  static getDerivedStateFromError(err) { return { err }; }
  render() { return this.state.err ? this.props.fallback : this.props.children; }
}

export function Fallback({ ui, reason }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <div data-openui-fallback={reason} className="text-[11.5px] text-fgdim">
      <span>{t('openui.fallback')}</span>
      {ui && (
        <button type="button" className="ms-1.5 cursor-pointer underline" onClick={() => setOpen((v) => !v)}>
          {open ? t('openui.hideSource') : t('openui.source')}
        </button>
      )}
      {open && <pre className="mt-1 max-h-48 overflow-auto rounded-md bg-[var(--term-codebg)] p-2 text-[10.5px]" dir="ltr">{ui}</pre>}
    </div>
  );
}

export default function OpenUIBody({ ui, busy, onAction }) {
  const problem = useMemo(() => openuiProblem(ui), [ui]);
  const fallback = <Fallback ui={ui} reason={problem || 'render'} />;
  if (problem) return fallback;
  return (
    <Boundary fallback={fallback}>
      <div className={busy ? 'opacity-60' : ''}>
        <Renderer response={ui} library={library} isStreaming={false} onAction={onAction} publishObservability={false} onError={() => {}} />
      </div>
    </Boundary>
  );
}
