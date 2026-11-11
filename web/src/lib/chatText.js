// Chat text size: pure helpers shared by prefs, the settings control, the
// header menu and the keyboard shortcut. The pref is the PROSE size in px; the
// chat scales as one unit via --chat-scale (= size / default) — see index.css.
export const CHAT_TEXT = { min: 12, max: 20, def: 15, step: 1 };

export function clampChatText(n, fallback = CHAT_TEXT.def) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return fallback;
  return Math.min(CHAT_TEXT.max, Math.max(CHAT_TEXT.min, v));
}

// Unitless factor the chat's `zoom` uses; 1 at the default size.
export const chatScale = (px) => clampChatText(px) / CHAT_TEXT.def;

// dir: 'up' | 'down' | 'reset'
export function stepChatText(cur, dir) {
  if (dir === 'reset') return CHAT_TEXT.def;
  return clampChatText(clampChatText(cur) + (dir === 'up' ? CHAT_TEXT.step : -CHAT_TEXT.step));
}

// Pre-1.0 prefs stored `termFontSize` (px, default 16, where 16 rendered 15px
// prose): carry a customised value over, otherwise start at the default.
export function migrateChatText(p) {
  if (p && p.chatTextSize != null) return clampChatText(p.chatTextSize);
  if (p && p.termFontSize != null && Number(p.termFontSize) !== 16) return clampChatText(Number(p.termFontSize) - 1);
  return CHAT_TEXT.def;
}

// Pure keydown → action. ⌘/Ctrl with + (or =) / − / 0; null for everything
// else. `inChat` says whether focus is in the transcript or composer — outside
// it the browser's own zoom keeps working.
export function chatTextShortcut(e, inChat) {
  if (!inChat || !e || e.altKey || !(e.metaKey || e.ctrlKey)) return null;
  const k = e.key;
  if (k === '+' || k === '=') return 'up';
  if (k === '-') return 'down';
  if (k === '0' && !e.shiftKey) return 'reset';
  return null;
}

// Focus is "in the chat" when the active element / event target sits inside
// the transcript or the composer footer.
export const CHAT_FOCUS_SELECTOR = '[data-chat-mode], [data-composer-footer]';
export function focusInChat(doc = document) {
  const a = doc.activeElement;
  return !!(a && a.closest && a.closest(CHAT_FOCUS_SELECTOR));
}
