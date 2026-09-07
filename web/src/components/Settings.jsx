// Settings — one screen, FOUR categories + a collapsed "Advanced" drawer per
// page (AUDIT2, docs/SETTINGS-IA.md §6): כללי · חיבורים · מארח · הרחבות. A left rail on
// desktop, horizontal chips on phones, deep-linkable as
// #/settings/<category>[/<section>]. Each category is its own file under
// ./settings/; this shell only owns the nav, the Escape/hotkey-recording key
// handler and the scroll-to-section on open.
//
// The old `voice` and `automation` categories are still accepted as route ids
// (BrainView links to #/settings/automation/heartbeat, older bookmarks to
// #/settings/voice): they land on the General page with the drawer open at
// the matching section. Nothing was deleted — the ADV/MOVE items of the audit
// sit inside each page's <Advanced> drawer.
import { useEffect, useState } from 'react';
import { setPrefs } from '../lib/prefs.js';
import { Wave } from './ui.jsx';
import { Icon } from '../lib/icons.js';
import { useT } from '../lib/i18n.js';
import { useStore } from '../lib/store.js';
import { useIsDesktop } from '../lib/useMedia.js';
import { faXmark, faSliders, faLink, faServer, faPuzzlePiece } from '@fortawesome/free-solid-svg-icons';
import General from './settings/Appearance.jsx';
import Connections from './settings/Connections.jsx';
import HostPage from './settings/Host.jsx';
import ExtensionsPage from './settings/Extensions.jsx';

// Route ids App.jsx accepts. The first four are the nav; `voice` and
// `automation` are legacy aliases that resolve onto `appearance` (General).
// EXT added `extensions` as a category of its own rather than a block inside
// Host: installing one is a decision about running foreign code, and it needs
// room for a permission list and a settings form per extension.
export const SETTINGS_CATEGORIES = ['appearance', 'connections', 'host', 'extensions', 'voice', 'automation'];
export const SETTINGS_NAV = ['appearance', 'connections', 'host', 'extensions'];
const ICONS = { appearance: faSliders, connections: faLink, host: faServer, extensions: faPuzzlePiece };

// Legacy category → {cat, section}. `automation` without a section opens the
// heartbeat (its only user-facing control); `voice` opens the voice block.
export function resolveCategory(category, section = '') {
  if (category === 'voice') return { cat: 'appearance', section: section || 'voice' };
  if (category === 'automation') return { cat: 'appearance', section: section || 'heartbeat' };
  return { cat: SETTINGS_NAV.includes(category) ? category : 'appearance', section };
}

export default function Settings({ category = 'appearance', section = '', initialAdd = false, onCategory, onClose }) {
  const t = useT();
  const desktop = useIsDesktop();
  const { config } = useStore();
  const [recordingHotkey, setRecordingHotkey] = useState(false);
  const { cat, section: sec } = resolveCategory(category, section);
  const voiceEnabled = !!config?.voiceEnabled;

  // Escape closes; while a voice hotkey is being recorded the next chord is
  // captured instead (Voice.jsx owns the button, we own the listener so the
  // capture phase beats every other global key handler).
  useEffect(() => {
    const onKey = (e) => {
      if (recordingHotkey) {
        e.preventDefault();
        e.stopPropagation();
        const parts = [];
        if (e.metaKey) parts.push('Cmd');
        if (e.ctrlKey) parts.push('Ctrl');
        if (e.altKey) parts.push('Alt');
        if (e.shiftKey) parts.push('Shift');
        const key = e.key === ' ' ? 'Space' : e.key.length === 1 ? e.key.toUpperCase() : e.key;
        if (!['Meta', 'Control', 'Alt', 'Shift'].includes(e.key)) parts.push(key);
        if (parts.length > 1 || (parts.length === 1 && !['Cmd', 'Ctrl', 'Alt', 'Shift'].includes(parts[0]))) {
          setPrefs({ voiceHotkey: parts.join('+') });
          setRecordingHotkey(false);
        }
        return;
      }
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose, recordingHotkey]);

  // Deep link to a section (#/settings/connections/claude) → scroll to it once
  // the category has rendered (sections inside the drawer open it first).
  useEffect(() => {
    if (!sec) return;
    const id = setTimeout(() => document.getElementById(`settings-${sec}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 120);
    return () => clearTimeout(id);
  }, [cat, sec]);

  const navItem = (id) => (
    <button
      key={id}
      type="button"
      onClick={() => onCategory?.(id)}
      aria-current={cat === id ? 'page' : undefined}
      className={desktop
        ? `flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-start text-[0.78125rem] ${cat === id ? 'bg-chip font-bold text-fg' : 'text-fgdim hover:bg-chip/60 hover:text-fg'}`
        : `flex shrink-0 cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1 text-[0.71875rem] ${cat === id ? 'border-ink bg-chip font-bold text-fg' : 'border-hair text-fgdim'}`}
    >
      <span className="w-4 text-center text-[0.75rem]"><Icon icon={ICONS[id]} /></span>
      {t(`settings.cat.${id}`)}
    </button>
  );

  let body;
  if (cat === 'connections') body = <Connections initialAdd={initialAdd} section={sec} />;
  else if (cat === 'host') body = <HostPage section={sec} />;
  else if (cat === 'extensions') body = <ExtensionsPage />;
  else body = <General section={sec} voiceEnabled={voiceEnabled} recording={recordingHotkey} setRecording={setRecordingHotkey} />;

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-panel">
      <div className="flex h-11 shrink-0 items-center gap-[0.5625rem] border-b border-hair px-4">
        <Wave />
        <span className="text-sm font-bold text-fg">{t('settings.title')}</span>
        <span className="text-[0.75rem] text-fgdim">/ {t(`settings.cat.${cat}`)}</span>
        <button type="button" onClick={onClose} title={t('chrome.settings.closeTitle')} className="ms-auto cursor-pointer px-1 text-[0.9375rem] text-fgdim hover:text-fg">
          <Icon icon={faXmark} />
        </button>
      </div>

      {!desktop && (
        <div className="thin-scroll flex shrink-0 gap-1.5 overflow-x-auto border-b border-hair px-3 py-2">
          {SETTINGS_NAV.map(navItem)}
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {desktop && (
          <nav className="flex w-[11.25rem] shrink-0 flex-col gap-0.5 border-e border-hair px-2 py-3">
            {SETTINGS_NAV.map(navItem)}
          </nav>
        )}
        <div data-settings-pane className="thin-scroll min-h-0 flex-1 overflow-y-auto">
          <div key={cat} className="mx-auto w-full max-w-[40rem] px-4 py-5 sm:px-7">{body}</div>
        </div>
      </div>
    </div>
  );
}
