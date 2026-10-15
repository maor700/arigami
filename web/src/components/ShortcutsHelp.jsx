import { useT } from '../lib/i18n.js';
import { Kbd } from './ui/kbd.jsx';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from './ui/dialog.jsx';

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
      [[`${MOD}`, 'J'], t('rail.scNextNeedsYou')],
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
    <span dir="ltr" className="flex items-center gap-1">
      {keys.map((k, i) => (k === 'or' ? <span key={i} className="text-2xs text-muted-foreground">{k}</span> : <Kbd key={i}>{k}</Kbd>))}
    </span>
  );
}

// Esc closes (Radix); "?" toggles it from the app-level handler, which also
// closes it, so the key is handled here as well for when the dialog has focus.
export default function ShortcutsHelp({ onClose }) {
  const t = useT();
  const GROUPS = buildGroups(t);
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent
        showClose={false}
        className="w-[min(36rem,calc(100vw-1.5rem))] gap-0 p-0"
        onKeyDownCapture={(e) => { if (e.key === '?') { e.preventDefault(); e.stopPropagation(); onClose(); } }}
      >
        <DialogHeader className="flex-row items-center justify-between border-b border-border px-5 py-3.5 pe-5">
          <DialogTitle>{t('dialogs.keyboardShortcuts')}</DialogTitle>
          <Kbd>?</Kbd>
        </DialogHeader>
        <div className="grid grid-cols-1 gap-x-8 gap-y-5 px-5 py-4 sm:grid-cols-2">
          {GROUPS.map((g) => (
            <div key={g.title}>
              <div className="mb-2 text-xs font-medium text-muted-foreground">{g.title}</div>
              <div className="flex flex-col gap-2">
                {g.rows.map(([keys, label], i) => (
                  <div key={i} className="flex items-center justify-between gap-3">
                    <span className="text-sm text-foreground">{label}</span>
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
