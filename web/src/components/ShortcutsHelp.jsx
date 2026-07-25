import { useEffect } from 'react';

// macOS uses ⌘; everything else shows Ctrl.
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '');
const MOD = isMac ? '⌘' : 'Ctrl';

const GROUPS = [
  {
    title: 'Navigate',
    rows: [
      [[`${MOD}`, '1–9'], 'Jump to session 1–9'],
      [[`${MOD}`, '⇧', '↑'], 'Previous session'],
      [[`${MOD}`, '⇧', '↓'], 'Next session'],
      [[`${MOD}`, 'K'], 'Command palette (search sessions + commands)'],
      [['/'], 'Focus search'],
    ],
  },
  {
    title: 'Act',
    rows: [
      [[`${MOD}`, '⇧', 'N'], 'New empty session (default settings)'],
      [[`${MOD}`, '⇧', '↵'], 'Focus the message composer'],
      [[`${MOD}`, 'T'], 'Add a tab to the session'],
      [[`${MOD}`, '⇧', 'V'], 'Voice control (push-to-talk)'],
      [['Esc'], 'Close overlay · else interrupt Claude'],
      [['?'], 'Toggle this cheat-sheet'],
    ],
  },
  {
    title: 'When Claude asks',
    rows: [
      [['↵', 'or', 'y'], 'Allow a permission request'],
      [['Esc', 'or', 'n'], 'Deny a permission request'],
      [['↑', '↓'], 'Move between question options'],
      [['↵', 'or', '1–9'], 'Pick a question option'],
      [['Esc', 'or', 's'], 'Skip a question'],
    ],
  },
];

function Keys({ keys }) {
  return (
    <span className="flex items-center gap-1">
      {keys.map((k, i) => (
        <kbd
          key={i}
          className="inline-flex min-w-[20px] items-center justify-center rounded-[5px] border border-border bg-bg px-1.5 py-0.5 font-mono text-[10.5px] text-fg shadow-[0_1px_0_var(--color-border)]"
        >
          {k}
        </kbd>
      ))}
    </span>
  );
}

export default function ShortcutsHelp({ onClose }) {
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape' || e.key === '?') { e.preventDefault(); e.stopPropagation(); onClose(); }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-[rgba(20,20,22,0.5)] p-5"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-[460px] max-w-full overflow-hidden rounded-xl border-2 border-ink bg-panel text-fg shadow-[5px_6px_0_rgba(42,42,42,0.25)]"
      >
        <div className="flex items-center justify-between border-b border-hair px-[18px] py-3">
          <div className="text-[15px] font-bold">Keyboard shortcuts</div>
          <kbd className="font-mono text-[11px] text-fgdim">?</kbd>
        </div>
        <div className="grid grid-cols-1 gap-x-6 gap-y-4 px-[18px] py-4 sm:grid-cols-2">
          {GROUPS.map((g) => (
            <div key={g.title}>
              <div className="mb-2 font-mono text-[10px] tracking-[0.08em] text-fgdim uppercase">{g.title}</div>
              <div className="flex flex-col gap-2">
                {g.rows.map(([keys, label], i) => (
                  <div key={i} className="flex items-center justify-between gap-3">
                    <span className="text-[12px] text-fg">{label}</span>
                    <Keys keys={keys} />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
