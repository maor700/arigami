// The "reading" controls of a chat — chat view (Simple | Terminal) and text size —
// as menu parts. Shared by the session header's "…" menu and the terminal gear,
// so they are reachable from both (and from Settings → General).
import { ALargeSmall } from 'lucide-react';
import { setChatMode } from '../lib/store.js';
import { usePrefs, setPrefs } from '../lib/prefs.js';
import { CHAT_TEXT, stepChatText } from '../lib/chatText.js';
import { useT } from '../lib/i18n.js';
import { DropdownMenuItem, DropdownMenuShortcut, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger } from './ui/dropdown-menu.jsx';

// The radio items themselves; `M` carries the menu parts (a test renders them
// with plain stand-ins, the header passes the DropdownMenu ones).
export function ChatModeItems({ M, session, mode }) {
  const t = useT();
  return (
    <M.Group aria-label={t('rail.chatMode')} data-chat-mode-toggle={mode}>
      <M.Label>{t('rail.chatMode')}</M.Label>
      <M.RadioGroup value={mode} onValueChange={(v) => { if (v !== mode) setChatMode(session, v); }}>
        <M.RadioItem value="simple" data-chat-mode-btn="simple" aria-pressed={mode === 'simple'}>{t('rail.chatModeSimple')}</M.RadioItem>
        <M.RadioItem value="full" data-chat-mode-btn="full" aria-pressed={mode === 'full'}>{t('rail.chatModeTerminal')}</M.RadioItem>
      </M.RadioGroup>
    </M.Group>
  );
}

// "Text size ▸ smaller / default / larger", the current px beside the label.
// Smaller/larger keep the menu open so a few steps are one visit.
export function ChatTextSizeSub() {
  const t = useT();
  const px = usePrefs().chatTextSize;
  const step = (dir) => (e) => { e.preventDefault(); setPrefs({ chatTextSize: stepChatText(px, dir) }); };
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger data-chat-text-size-menu>
        <ALargeSmall /> {t('chat.textSize')}
        <span dir="ltr" className="ms-auto text-xs tabular-nums text-muted-foreground">{px}px</span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        <DropdownMenuItem disabled={px <= CHAT_TEXT.min} onSelect={step('down')}>{t('chat.textSizeSmaller')}<DropdownMenuShortcut dir="ltr">⌘−</DropdownMenuShortcut></DropdownMenuItem>
        <DropdownMenuItem disabled={px === CHAT_TEXT.def} onSelect={() => setPrefs({ chatTextSize: CHAT_TEXT.def })}>{t('chat.textSizeDefault', { px: CHAT_TEXT.def })}<DropdownMenuShortcut dir="ltr">⌘0</DropdownMenuShortcut></DropdownMenuItem>
        <DropdownMenuItem disabled={px >= CHAT_TEXT.max} onSelect={step('up')}>{t('chat.textSizeLarger')}<DropdownMenuShortcut dir="ltr">⌘+</DropdownMenuShortcut></DropdownMenuItem>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

