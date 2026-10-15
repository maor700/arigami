// ⌘/Ctrl + / − / 0 while the chat has focus: step the chat text size (prefs,
// applied at once) and say the new size in a small toast. Installed once from
// main.jsx; capture phase so the browser zoom never sees the chat's keys.
import { chatTextShortcut, focusInChat, stepChatText } from './chatText.js';
import { getPrefs, setPrefs } from './prefs.js';
import { toast, dismissToast } from './toast.js';
import { t } from './i18n.js';

let toastId = 0;
export function applyChatTextAction(action) {
  const next = stepChatText(getPrefs().chatTextSize, action);
  setPrefs({ chatTextSize: next });
  return next;
}

export function installChatTextShortcuts(win = window) {
  const onKey = (e) => {
    const action = chatTextShortcut(e, focusInChat(win.document));
    if (!action) return;
    e.preventDefault();
    const px = applyChatTextAction(action);
    if (toastId) dismissToast(toastId); // repeated presses update one toast
    toastId = toast(t('chat.textSizeToast', { px }), { ttl: 1200 });
  };
  win.addEventListener('keydown', onKey, true);
  return () => win.removeEventListener('keydown', onKey, true);
}
