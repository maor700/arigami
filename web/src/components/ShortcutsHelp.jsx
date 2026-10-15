import { useEffect } from 'react';
import { useT } from '../lib/i18n.js';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from './ui/dialog.jsx';
import { Kbd } from './ui/kbd.jsx';

// macOS uses ⌘; everything else shows Ctrl.
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '');
const MOD = isMac ? '⌘' : 'Ctrl';

const buildGroups = (t) => [
  {
    title: t('dialogs.scNavigate'),
    rows: [
      [[`${MOD}`, '1–9'], t('dialogs.scJumpToSession')],
      [[`${MOD}`, '⇧', '↑'], t('dialogs.scPrevSession')],
      [[`${MOD}`, '⇧', '↓'], t('dialogs.scNextSession')],
      [[`${MOD}`, 'K'], t('dialogs.scCommandPalette')],
      [['/'], t('dialogs.scFocusSearch')],
    ],
  },
  {
    title: t('dialogs.scAct'),
    rows: [
      [[`${MOD}`, '⇧', 'N'], t('dialogs.scNewEmptySession')],
      [[`${MOD}`, '⇧', '↵'], t('dialogs.scFocusComposer')],
      [[`${MOD}`, 'T'], t('dialogs.scAddTab')],
      [[`${MOD}`, '⇧', 'V'], t('dialogs.scVoiceControl')],
      [['Esc'], t('dialogs.scCloseOverlay')],
      [['?'], t('dialogs.scToggleCheatSheet')],
    ],
  },
  {
    title: t('dialogs.scWhenClaudeAsks'),
    rows: [
      [['↵', 'or', 'y'], t('dialogs.scAllowPermission')],
      [['Esc', 'or', 'n'], t('dialogs.scDenyPermission')],
      [['↑', '↓'], t('dialogs.scMoveOptions')],
      [['↵', 'or', '1–9'], t('dialogs.scPickOption')],
      [['Esc', 'or', 's'], t('dialogs.scSkipQuestion')],
    ],
  },
];

function Keys({ keys }) {
  return (
    <span className="flex items-center gap-1">
      {keys.map((k, i) => <Kbd key={i}>{k}</Kbd>)}
    </span>
  );
}

export default function ShortcutsHelp({ onClose }) {
  const t = useT();
  const GROUPS = buildGroups(t);
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape' || e.key === '?') { e.preventDefault(); e.stopPropagation(); onClose(); }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent aria-describedby={undefined} className="w-[min(460px,calc(100vw-1.5rem))]">
        <DialogHeader>
          <DialogTitle className="text-sm">{t('dialogs.keyboardShortcuts')}</DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
          {GROUPS.map((g) => (
            <div key={g.title}>
              <div className="mb-2 text-xs font-medium text-fgdim">{g.title}</div>
              <div className="flex flex-col gap-2">
                {g.rows.map(([keys, label], i) => (
                  <div key={i} className="flex items-center justify-between gap-3">
                    <span className="text-xs text-fg">{label}</span>
                    <Keys keys={keys} />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
