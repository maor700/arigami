// Settings › General: "Chat text size" — A−/A+ steps, a slider, reset, and a
// live preview in Hebrew and English at the chosen size. The same pref the
// header "…" menu and ⌘/Ctrl + / − / 0 drive (lib/chatText.js).
import { usePrefs, setPrefs } from '../../lib/prefs.js';
import { CHAT_TEXT, stepChatText } from '../../lib/chatText.js';
import { useT } from '../../lib/i18n.js';
import { Field, BTN_SM } from './shared.jsx';
import { Button } from '../ui/button.jsx';

export function ChatTextPreview({ px }) {
  const t = useT();
  return (
    <div
      data-chat-text-preview
      className="mt-2 w-full rounded-md border border-hair bg-muted/40 px-3 py-2 text-foreground"
      style={{ fontSize: px, lineHeight: 1.6 }}
    >
      <p dir="ltr" lang="en" className="m-0 text-start">{t('settings.fontSize.previewEn')}</p>
      <p dir="rtl" lang="he" className="m-0 text-start">{t('settings.fontSize.previewHe')}</p>
    </div>
  );
}

export default function ChatTextSize() {
  const prefs = usePrefs();
  const t = useT();
  const px = prefs.chatTextSize;
  const set = (v) => setPrefs({ chatTextSize: v });
  return (
    <div data-chat-text-size>
      <Field label={t('settings.fontSize')} hint={t('settings.fontSize.hint', { min: CHAT_TEXT.min, max: CHAT_TEXT.max })} wrap>
        <span className="flex flex-wrap items-center gap-2">
          <Button type="button" aria-label={t('settings.fontSize.smaller')} onClick={() => set(stepChatText(px, 'down'))} disabled={px <= CHAT_TEXT.min}><span dir="ltr">A−</span></Button>
          <input
            type="range"
            dir="ltr"
            min={CHAT_TEXT.min}
            max={CHAT_TEXT.max}
            step={CHAT_TEXT.step}
            value={px}
            onChange={(e) => set(Number(e.target.value))}
            aria-label={t('settings.fontSize.slider')}
            className="w-28 cursor-pointer accent-[var(--color-brand)]"
          />
          <Button type="button" aria-label={t('settings.fontSize.larger')} onClick={() => set(stepChatText(px, 'up'))} disabled={px >= CHAT_TEXT.max}><span dir="ltr">A+</span></Button>
          <span className="min-w-10 text-center text-sm tabular-nums text-fg" dir="ltr">{px}px</span>
          {px !== CHAT_TEXT.def && (
            <button type="button" onClick={() => set(CHAT_TEXT.def)} className={BTN_SM}>
              {t('settings.fontSize.reset', { px: CHAT_TEXT.def })}
            </button>
          )}
        </span>
      </Field>
      <ChatTextPreview px={px} />
    </div>
  );
}
