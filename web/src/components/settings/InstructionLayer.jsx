// PROMPT1 phase 2 — one agent's or one session's layer over the instruction blocks (server/prompt-blocks.ts
// applyLayers). Per block: inherit (the default — nothing stored), off, on (only offered when the block is off above),
// or this layer's own text; plus blocks of this layer's own. Collapsed until opened, like the global editor: an
// untouched agent or session needs no UI at all. Controlled: the edits go to onChange(layer | null) and are saved by
// the page's / dialog's own Save — one Save per form, never a second one inside it.
import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { useT } from '../../lib/i18n.js';
import { toastError } from '../../lib/toast.js';
import { Segmented, BTN_SM, INPUT } from './shared.jsx';

const TEXTAREA = 'thin-scroll w-full min-h-[120px] rounded-md border border-input bg-background p-2 font-mono text-xs leading-relaxed text-foreground outline-none focus:border-ring';
const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

const modeOf = (entry) => (entry === undefined ? 'inherit' : entry === 'off' ? 'off' : entry === 'on' ? 'on' : 'text');

export default function InstructionLayer({ value, onChange, scope, hint }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [blocks, setBlocks] = useState(null);
  const [newId, setNewId] = useState('');
  const [newText, setNewText] = useState('');
  const layer = value || {};
  const setLayer = (fn) => { const next = typeof fn === 'function' ? fn(layer) : fn; onChange(Object.keys(next).length ? next : null); };
  useEffect(() => {
    if (open && !blocks) api.get('/prompts').then((r) => setBlocks(r.blocks)).catch((e) => toastError(e?.body?.error || e?.message || String(e)));
  }, [open]);

  const changed = Object.keys(layer).length;
  const setEntry = (id, entry) => setLayer((cur) => {
    const next = { ...cur };
    if (entry === undefined) delete next[id];
    else next[id] = entry;
    return next;
  });
  const own = Object.entries(layer).filter(([id, e]) => typeof e === 'object' && !(blocks || []).some((b) => b.id === id));

  return (
    <details data-instruction-layer={scope} open={open} onToggle={(e) => setOpen(e.currentTarget.open)} className="rounded-lg border border-hair">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs text-fgdim select-none hover:text-fg coarse:min-h-11 [&::-webkit-details-marker]:hidden">
        {t('instructions.section')}
        {changed > 0 && <span className="rounded border border-hair px-1 text-[10px]">{t('instructions.layerChanged', { n: changed })}</span>}
      </summary>
      <div className="space-y-2 border-t border-hair px-3 pb-3 pt-2">
        <p className="text-xs text-fgdim">{hint || t(`instructions.layerHint.${scope}`)}</p>
        {!blocks ? <p className="text-xs text-fgdim">…</p> : blocks.map((b) => {
          const entry = layer[b.id];
          const mode = modeOf(entry);
          const options = [
            { value: 'inherit', label: t('instructions.inherit') },
            ...(b.enabled ? [] : [{ value: 'on', label: t('instructions.on') }]),
            { value: 'off', label: t('instructions.off') },
            { value: 'text', label: t('instructions.ownText') },
          ];
          return (
            <div key={b.id} data-layer-block={b.id} className="border-b border-hair pb-2 last:border-b-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-sm text-fg">
                  {b.title}
                  {!b.enabled && <span className="ms-1 text-[10px] text-fgdim">({t('instructions.offAbove')})</span>}
                </span>
                <Segmented
                  value={mode}
                  label={b.title}
                  options={options}
                  onChange={(m) => setEntry(b.id, m === 'inherit' ? undefined : m === 'text' ? { text: typeof entry === 'object' ? entry.text : b.text } : m)}
                />
              </div>
              {mode === 'text' && (
                <textarea value={entry.text} onChange={(e) => setEntry(b.id, { ...entry, text: e.target.value })} dir="auto" spellCheck={false} className={`${TEXTAREA} mt-2`} aria-label={b.title} />
              )}
            </div>
          );
        })}
        {own.map(([id, e]) => (
          <div key={id} className="border-b border-hair pb-2">
            <div className="flex items-center gap-2">
              <span className="flex-1 text-sm text-fg" dir="ltr">{id}</span>
              <button type="button" onClick={() => setEntry(id, undefined)} className={BTN_SM}>{t('instructions.delete')}</button>
            </div>
            <textarea value={e.text} onChange={(ev) => setEntry(id, { ...e, text: ev.target.value })} dir="auto" className={`${TEXTAREA} mt-2 min-h-[80px]`} aria-label={id} />
          </div>
        ))}
        {blocks && (
          <div className="flex flex-wrap items-end gap-2">
            <input value={newId} onChange={(e) => setNewId(e.target.value.toLowerCase())} placeholder={t('instructions.newId')} dir="ltr" className={`${INPUT} w-[170px]`} aria-label={t('instructions.newId')} />
            <input value={newText} onChange={(e) => setNewText(e.target.value)} placeholder={t('instructions.newText')} dir="auto" className={`${INPUT} min-w-[180px] flex-1`} aria-label={t('instructions.newText')} />
            <button
              type="button"
              disabled={!ID_RE.test(newId) || !newText.trim() || (blocks || []).some((b) => b.id === newId)}
              onClick={() => { setEntry(newId, { text: newText }); setNewId(''); setNewText(''); }}
              className={BTN_SM}
            >
              {t('instructions.add')}
            </button>
          </div>
        )}
        {changed > 0 && (
          <div className="pt-1">
            <button type="button" onClick={() => setLayer({})} className={BTN_SM}>{t('instructions.inheritAll')}</button>
          </div>
        )}
      </div>
    </details>
  );
}
