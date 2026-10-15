import { useState } from 'react';
import { Command as CommandIcon } from 'lucide-react';
import { Dot, sessionLabel } from './ui.jsx';
import { needsAttention } from '../lib/store.js';
import { useT } from '../lib/i18n.js';
import { Icon } from '../lib/icons.js';
import { StatusDot } from './ui/badge.jsx';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog.jsx';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandShortcut } from './ui/command.jsx';

// ⌘K command palette (cmdk): fuzzy-filter sessions AND commands, then run/jump.
// Arrow keys move, Enter runs, Esc closes. Sessions are the fast jump-to path;
// the commands (open Settings, new session, theme, language, archive current,
// …) are listed under them, and when a query is typed the matching commands
// come first — everything is reachable keyboard-only. Filtering stays ours
// (id / title / ticket for sessions, label + keywords for commands), so what a
// query matches is exactly what it matched before the cmdk skin.
export default function QuickSwitcher({ sessions, selectedId, onSelect, onClose, actions = [] }) {
  const t = useT();
  const [q, setQ] = useState('');

  const live = sessions.filter((s) => !s.archived);
  const needle = q.trim().toLowerCase();
  const sessionMatches = needle
    ? live.filter((s) =>
        `${sessionLabel(s)} ${s.metadata?.ticket || ''} ${s.title || ''}`.toLowerCase().includes(needle),
      )
    : live;
  const actionMatches = needle
    ? actions.filter((a) => `${a.label} ${a.keywords || ''}`.toLowerCase().includes(needle))
    : actions;

  const run = (fn) => () => {
    onClose();
    fn();
  };

  const actionsGroup = actionMatches.length > 0 && (
    <CommandGroup heading={t('rail.commandsGroup')} key="actions">
      {actionMatches.map((a) => (
        <CommandItem key={`a:${a.id}`} value={`a:${a.id}`} onSelect={run(a.run)} data-palette-action={a.id}>
          <span className="flex size-4 shrink-0 items-center justify-center text-xs text-muted-foreground [&_svg]:size-3.5">
            {a.icon ? typeof a.icon === 'string' ? a.icon : a.icon.iconName ? <Icon icon={a.icon} /> : <a.icon /> : <CommandIcon className="size-3.5" />}
          </span>
          <span className="min-w-0 flex-1 truncate">{a.label}</span>
          {a.shortcut && <CommandShortcut>{a.shortcut}</CommandShortcut>}
        </CommandItem>
      ))}
    </CommandGroup>
  );
  const sessionsGroup = sessionMatches.length > 0 && (
    <CommandGroup heading={t('rail.sessionsGroup')} key="sessions">
      {sessionMatches.map((s) => {
        const attn = needsAttention(s);
        const working = s.claude?.state === 'working';
        return (
          <CommandItem key={`s:${s.id}`} value={`s:${s.id}`} onSelect={run(() => onSelect(s.id))} data-palette-session={s.id}>
            <span className="flex size-4 shrink-0 items-center justify-center"><Dot color={s.color} size={9} /></span>
            <span className="min-w-0 flex-1 truncate">{sessionLabel(s)}</span>
            {s.id === selectedId && <span className="text-2xs text-muted-foreground">{t('rail.current')}</span>}
            {working && <StatusDot status="info" pulse />}
            {attn && !working && <StatusDot status="warn" pulse />}
          </CommandItem>
        );
      })}
    </CommandGroup>
  );

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogHeader className="sr-only">
        <DialogTitle>{t('rail.searchSessionsCommands')}</DialogTitle>
        <DialogDescription>{t('rail.searchSessionsCommands')}</DialogDescription>
      </DialogHeader>
      <DialogContent showClose={false} className="top-[14%] w-[min(32rem,calc(100vw-1.5rem))] translate-y-0 gap-0 overflow-hidden p-0" data-quick-switcher>
        {/* shouldFilter off: the lists above are already filtered */}
        <Command shouldFilter={false} loop className="[&_[cmdk-input-wrapper]_svg]:size-4">
          <CommandInput value={q} onValueChange={setQ} placeholder={t('rail.searchSessionsCommands')} />
          <CommandList className="max-h-[50vh]">
            {sessionMatches.length === 0 && actionMatches.length === 0 && (
              <CommandEmpty>{t('rail.noMatchQuery', { q })}</CommandEmpty>
            )}
            {/* a typed query puts the commands first (they are the intent), an empty one the sessions */}
            {needle ? [actionsGroup, sessionsGroup] : [sessionsGroup, actionsGroup]}
          </CommandList>
        </Command>
        <div className="hidden items-center gap-4 border-t border-border px-3 py-2 text-2xs text-muted-foreground sm:flex">
          <span>{t('rail.qsMove')}</span>
          <span>{t('rail.qsRun')}</span>
          <span>{t('rail.qsClose')}</span>
        </div>
      </DialogContent>
    </Dialog>
  );
}
