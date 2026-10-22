// PROMPT1 — Settings › Customization (expert): the blocks the host puts in front of every session's
// messages (server/prompt-blocks.ts). Deliberately out of the way: one more collapsed row inside the already collapsed
// Advanced drawer, closed by default. Nothing is fetched until it is opened. GET/PUT/DELETE /__api/prompts[/:id].
import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { useT } from '../../lib/i18n.js';
import { confirmDialog } from '../../lib/confirm.js';
import { toast, toastError } from '../../lib/toast.js';
import { Section, Toggle, BTN_SM, BTN_PRIMARY, BTN_DANGER, INPUT, Segmented } from './shared.jsx';

const TEXTAREA = 'thin-scroll w-full min-h-[160px] rounded-md border border-input bg-background p-2 font-mono text-xs leading-relaxed text-foreground outline-none focus:border-ring';
const errText = (e) => e?.body?.error || e?.message || String(e);

function BlockEditor({ block, onSaved }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(block.text);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setText(block.text); }, [block.text]);
  const dirty = text.replace(/\s+$/, '') !== block.text;

  const save = async (patch) => {
    setBusy(true);
    try {
      await api.put(`/prompts/${encodeURIComponent(block.id)}`, patch);
      toast(t('instructions.saved', { title: block.title }));
      onSaved();
    } catch (e) {
      toastError(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const toggle = async (on) => {
    if (!on && block.guardrail) {
      const ok = await confirmDialog({ title: t('instructions.offTitle', { title: block.title }), body: t('instructions.offBody'), confirmLabel: t('instructions.offOk'), danger: true });
      if (!ok) return;
    }
    save({ enabled: on });
  };
  const reset = async () => {
    const ok = await confirmDialog({
      title: block.builtin ? t('instructions.resetTitle', { title: block.title }) : t('instructions.deleteTitle', { title: block.title }),
      confirmLabel: block.builtin ? t('instructions.reset') : t('instructions.delete'),
      danger: !block.builtin,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api.del(`/prompts/${encodeURIComponent(block.id)}`);
      onSaved();
    } catch (e) {
      toastError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-instruction-block={block.id} className="border-b border-hair py-2 last:border-b-0">
      <div className="flex items-center gap-2 text-sm">
        <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-start coarse:min-h-11">
          <span className="truncate font-medium text-fg">{block.title}</span>
          {block.edited && <span className="rounded border border-hair px-1 text-[10px] text-fgdim">{block.builtin ? t('instructions.edited') : t('instructions.own')}</span>}
          <span className="text-[10px] text-fgdim">{block.when === 'every-turn' ? t('instructions.everyTurn') : t('instructions.firstTurn')}</span>
        </button>
        <Toggle on={block.enabled} disabled={busy} onChange={toggle} aria-label={t('instructions.enabled', { title: block.title })} />
      </div>
      {open && (
        <div className="mt-2 space-y-2">
          {block.description && <p className="text-xs text-fgdim">{block.description}</p>}
          {block.vars.length > 0 && <p className="text-xs text-fgdim" dir="ltr">{t('instructions.vars')} {block.vars.map((v) => `{{${v}}}`).join(' ')}</p>}
          <textarea value={text} onChange={(e) => setText(e.target.value)} dir="auto" spellCheck={false} className={TEXTAREA} aria-label={block.title} />
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" disabled={busy || !dirty} onClick={() => save({ text })} className={BTN_PRIMARY}>{t('instructions.save')}</button>
            {dirty && <button type="button" disabled={busy} onClick={() => setText(block.text)} className={BTN_SM}>{t('instructions.discard')}</button>}
            {block.builtin && block.defaultText !== null && text !== block.defaultText && (
              <button type="button" disabled={busy} onClick={() => setText(block.defaultText)} className={BTN_SM}>{t('instructions.showDefault')}</button>
            )}
            {block.edited && <button type="button" disabled={busy} onClick={reset} className={block.builtin ? BTN_SM : BTN_DANGER}>{block.builtin ? t('instructions.reset') : t('instructions.delete')}</button>}
          </div>
        </div>
      )}
    </div>
  );
}

function NewBlock({ onSaved }) {
  const t = useT();
  const [id, setId] = useState('');
  const [text, setText] = useState('');
  const [when, setWhen] = useState('first-turn');
  const [busy, setBusy] = useState(false);
  const valid = /^[a-z0-9][a-z0-9-]{0,39}$/.test(id) && text.trim();
  const create = async () => {
    setBusy(true);
    try {
      await api.put(`/prompts/${encodeURIComponent(id)}`, { text, when, title: id });
      setId(''); setText('');
      onSaved();
    } catch (e) {
      toastError(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-3 space-y-2 rounded-lg border border-dashed border-hair p-2">
      <div className="text-xs font-medium text-fgdim">{t('instructions.new')}</div>
      <div className="flex flex-wrap items-center gap-2">
        <input value={id} onChange={(e) => setId(e.target.value.toLowerCase())} placeholder={t('instructions.newId')} dir="ltr" className={`${INPUT} w-[200px]`} aria-label={t('instructions.newId')} />
        <Segmented value={when} onChange={setWhen} label={t('instructions.when')} options={[{ value: 'first-turn', label: t('instructions.firstTurn') }, { value: 'every-turn', label: t('instructions.everyTurn') }]} />
      </div>
      <textarea value={text} onChange={(e) => setText(e.target.value)} dir="auto" placeholder={t('instructions.newText')} className={`${TEXTAREA} min-h-[90px]`} aria-label={t('instructions.newText')} />
      <button type="button" disabled={busy || !valid} onClick={create} className={BTN_PRIMARY}>{t('instructions.add')}</button>
    </div>
  );
}

function Preview() {
  const t = useT();
  const [engine, setEngine] = useState('claude');
  const [out, setOut] = useState(null);
  const load = async (e = engine) => {
    try { setOut(await api.get(`/prompts/preview?engine=${e}`)); } catch (err) { toastError(errText(err)); }
  };
  return (
    <div className="mt-3 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => load()} className={BTN_SM}>{t('instructions.preview')}</button>
        <Segmented value={engine} onChange={(v) => { setEngine(v); if (out) load(v); }} label={t('instructions.engine')} options={[{ value: 'claude', label: 'Claude' }, { value: 'codex', label: 'Codex' }]} />
      </div>
      {out && (
        <pre dir="ltr" className="thin-scroll max-h-[360px] overflow-auto whitespace-pre-wrap rounded-lg border border-hair bg-bg p-2 font-mono text-[11px] leading-snug text-fg">
          {out.firstTurn}
          {out.everyTurn ? `\n— ${t('instructions.everyTurnSimple')} —\n${out.everyTurn}` : ''}
        </pre>
      )}
    </div>
  );
}

export default function Instructions() {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [blocks, setBlocks] = useState(null);
  const load = () => api.get('/prompts').then((r) => setBlocks(r.blocks)).catch((e) => toastError(errText(e)));
  useEffect(() => { if (open && !blocks) load(); }, [open]);
  return (
    <Section id="instructions" title={t('instructions.section')}>
      <details data-settings-instructions open={open} onToggle={(e) => setOpen(e.currentTarget.open)} className="rounded-lg border border-hair">
        <summary className="cursor-pointer list-none px-3 py-2 text-xs text-fgdim select-none hover:text-fg coarse:min-h-11 [&::-webkit-details-marker]:hidden">
          {t('instructions.summary')}
        </summary>
        <div className="border-t border-hair px-3 pb-3">
          <p className="mt-2 text-xs text-warn">{t('instructions.warning')}</p>
          {!blocks ? <p className="mt-2 text-xs text-fgdim">…</p> : blocks.map((b) => <BlockEditor key={b.id} block={b} onSaved={load} />)}
          {blocks && <NewBlock onSaved={load} />}
          {blocks && <Preview />}
        </div>
      </details>
    </Section>
  );
}
