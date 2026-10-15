// "Find a setting" — a jump list for the common settings that live in different
// pages (theme, language, text size, accent, notifications, voice, memory…).
// Typing filters a small index by the translated name plus English keywords;
// picking one goes to #/settings/<page>/<section>, which scrolls to it (and
// opens the Advanced drawer when the section lives in one).
import { useId, useState } from 'react';
import { SearchIcon } from 'lucide-react';
import { useT } from '../../lib/i18n.js';

// [i18n key of the setting's own name, page, section, extra keywords]
export const SETTINGS_INDEX = [
  ['settings.theme', 'appearance', 'chrome', 'dark light mode system appearance'],
  ['rail.chatTheme', 'appearance', 'chrome', 'chat theme dark light terminal'],
  ['settings.language', 'appearance', 'chrome', 'hebrew english rtl direction'],
  ['settings.uiScale', 'appearance', 'chrome', 'interface size zoom large small'],
  ['settings.fontSize', 'appearance', 'chrome', 'chat text size font bigger smaller'],
  ['settings.accent', 'appearance', 'chrome', 'colour color brand'],
  ['settings.pushTitle', 'connections', 'notifications', 'notifications push alerts browser'],
  ['chrome.voice.section', 'appearance', 'voice', 'voice microphone dictation hotkey'],
  ['memory.title', 'appearance', 'memory', 'memory learning brain'],
  ['brain.heartbeatTitle', 'appearance', 'heartbeat', 'heartbeat schedule'],
  ['telemetry.title', 'appearance', 'telemetry', 'telemetry usage analytics privacy'],
  ['settings.connections.claude', 'connections', 'claude', 'claude codex account login engine'],
  ['settings.connections.channels', 'connections', 'channels', 'whatsapp slack channels'],
  ['host.backup', 'host', 'backup', 'backup restore export'],
  ['machine.title', 'host', 'resources', 'machine resources cpu memory disk'],
];

export function findSettings(query, t, index = SETTINGS_INDEX) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  return index
    .map(([key, cat, section, kw]) => ({ key, cat, section, label: t(key), hay: `${t(key)} ${kw}`.toLowerCase() }))
    .filter((e) => e.hay.includes(q))
    .slice(0, 6);
}

export default function SettingsFind() {
  const t = useT();
  const id = useId();
  const [q, setQ] = useState('');
  const results = findSettings(q, t);
  return (
    <div className="relative ms-auto min-w-0 max-w-56 flex-1" data-settings-find>
      <SearchIcon aria-hidden="true" className="pointer-events-none absolute start-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
      <input
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Escape' && q) { e.stopPropagation(); setQ(''); } }}
        aria-label={t('settings.find')}
        aria-controls={q ? `${id}-r` : undefined}
        placeholder={t('settings.find')}
        dir="auto"
        className="h-8 w-full min-w-0 rounded-md border border-input bg-background ps-7 pe-2 text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/35 coarse:h-11"
      />
      {q && (
        <ul id={`${id}-r`} className="absolute inset-x-0 top-full z-20 mt-1 overflow-hidden rounded-md border border-border bg-popover py-1 shadow-md">
          {results.length === 0 && <li className="px-3 py-2 text-xs text-muted-foreground">{t('settings.find.none')}</li>}
          {results.map((r) => (
            <li key={r.key}>
              <a
                href={`#/settings/${r.cat}/${r.section}`}
                onClick={() => setQ('')}
                className="flex min-h-8 items-center justify-between gap-2 px-3 py-1.5 text-sm text-foreground no-underline hover:bg-muted focus-visible:bg-muted coarse:min-h-11"
              >
                <span className="min-w-0 truncate">{r.label}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{t(`settings.cat.${r.cat}`)}</span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
