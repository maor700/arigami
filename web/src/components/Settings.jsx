// Settings — one screen, five categories (SETTINGS-IA.md): a left rail on
// desktop, horizontal chips on phones, deep-linkable as
// #/settings/<category>[/<section>]. Each category is its own file under
// ./settings/; this shell only owns the nav, the Escape/hotkey-recording key
// handler and the scroll-to-section on open.
import { useEffect, useState } from 'react';
import { setPrefs } from '../lib/prefs.js';
import { Wave } from './ui.jsx';
import { Icon } from '../lib/icons.js';
import { useT } from '../lib/i18n.js';
import { useIsDesktop } from '../lib/useMedia.js';
import { faXmark, faPalette, faMicrophone, faLink, faRobot, faServer } from '@fortawesome/free-solid-svg-icons';
import Appearance from './settings/Appearance.jsx';
import Voice from './settings/Voice.jsx';
import Connections from './settings/Connections.jsx';
import Automation from './settings/Automation.jsx';
import Host from './settings/Host.jsx';
import Health from './settings/Health.jsx';
import Access from './settings/Access.jsx';

import { SETTINGS_CATEGORIES } from '../lib/route.js';
export { SETTINGS_CATEGORIES };
const ICONS = { appearance: faPalette, voice: faMicrophone, connections: faLink, automation: faRobot, host: faServer };

export default function Settings({ category = 'appearance', section = '', initialAdd = false, onCategory, onClose }) {
  const t = useT();
  const desktop = useIsDesktop();
  const [recordingHotkey, setRecordingHotkey] = useState(false);
  const cat = SETTINGS_CATEGORIES.includes(category) ? category : 'appearance';

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
  // the category has rendered.
  useEffect(() => {
    if (!section) return;
    const id = setTimeout(() => document.getElementById(`settings-${section}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 80);
    return () => clearTimeout(id);
  }, [cat, section]);

  const navItem = (id) => (
    <button
      key={id}
      type="button"
      onClick={() => onCategory?.(id)}
      aria-current={cat === id ? 'page' : undefined}
      className={desktop
        ? `flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-start text-[12.5px] ${cat === id ? 'bg-chip font-bold text-fg' : 'text-fgdim hover:bg-chip/60 hover:text-fg'}`
        : `flex shrink-0 cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1 text-[11.5px] ${cat === id ? 'border-ink bg-chip font-bold text-fg' : 'border-hair text-fgdim'}`}
    >
      <span className="w-4 text-center text-[12px]"><Icon icon={ICONS[id]} /></span>
      {t(`settings.cat.${id}`)}
    </button>
  );

  let body;
  if (cat === 'voice') body = <Voice recording={recordingHotkey} setRecording={setRecordingHotkey} />;
  else if (cat === 'connections') body = <Connections initialAdd={initialAdd} />;
  else if (cat === 'automation') body = <Automation />;
  else if (cat === 'host') body = <><Host /><Health /><Access /></>;
  else body = <Appearance />;

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-panel">
      <div className="flex h-11 shrink-0 items-center gap-[9px] border-b border-hair px-4">
        <Wave />
        <span className="text-sm font-bold text-fg">{t('settings.title')}</span>
        <span className="text-[12px] text-fgdim">/ {t(`settings.cat.${cat}`)}</span>
        <button type="button" onClick={onClose} title={t('chrome.settings.closeTitle')} className="ms-auto cursor-pointer px-1 text-[15px] text-fgdim hover:text-fg">
          <Icon icon={faXmark} />
        </button>
      </div>

      {!desktop && (
        <div className="thin-scroll flex shrink-0 gap-1.5 overflow-x-auto border-b border-hair px-3 py-2">
          {SETTINGS_CATEGORIES.map(navItem)}
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {desktop && (
          <nav className="flex w-[180px] shrink-0 flex-col gap-0.5 border-e border-hair px-2 py-3">
            {SETTINGS_CATEGORIES.map(navItem)}
          </nav>
        )}
        <div data-settings-pane className="thin-scroll min-h-0 flex-1 overflow-y-auto">
          <div key={cat} className="mx-auto w-full max-w-[640px] px-4 py-5 sm:px-7">{body}</div>
        </div>
      </div>
    </div>
  );
}
