import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { useT } from '../lib/i18n.js';
import { sessionLabel, Dot } from './ui.jsx';
import { Icon } from '../lib/icons.js';
import { faFolder } from '@fortawesome/free-solid-svg-icons';
import { Button } from './ui/button.jsx';
import { Input, Textarea } from './ui/input.jsx';
import { Label } from './ui/label.jsx';
import { Checkbox } from './ui/checkbox.jsx';
import { Dialog, DialogContent, DialogHeader, DialogFooter, DialogTitle } from './ui/dialog.jsx';
import InstructionLayer from './settings/InstructionLayer.jsx';

// Modal shell on the ui Dialog (Radix: focus trap + restore, Esc, outside
// click, portaled to <body> so Rail's transformed box can't clip it). Same
// props as before; `size` picks the width.
const OVERLAY_W = {
  sm: 'w-[min(24rem,calc(100vw-1.5rem))]',
  md: 'w-[min(26.25rem,calc(100vw-1.5rem))]',
};
export function Overlay({ onClose, children, size = 'sm', className = '' }) {
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent showClose={false} aria-describedby={undefined} className={`${OVERLAY_W[size] || size} ${className}`}>
        {children}
      </DialogContent>
    </Dialog>
  );
}

const ERR = 'text-xs text-err';

// What a delete/archive will actually do, as the host computed it (GET
// /sessions/:id/cleanup → preview, server/reap.ts). This used to list the
// shell commands the AGENT had written into metadata.cleanup; those are no
// longer what runs, so showing them would be showing the wrong thing.
function useTeardown(session) {
  const [preview, setPreview] = useState(null);
  useEffect(() => {
    let dead = false;
    api
      .get(`/sessions/${session.id}/cleanup`)
      .then((r) => !dead && setPreview(r?.preview || null))
      .catch(() => !dead && setPreview(null));
    return () => {
      dead = true;
    };
  }, [session.id]);
  return preview;
}

const hasWorktree = (p) => p?.worktree && (p.worktree.action === 'remove' || p.worktree.action === 'keep');

function TeardownLines({ preview, worktree = true, scratch = true, tone = 'text-fgdim' }) {
  const t = useT();
  if (!preview) return null;
  const lines = [];
  const n = preview.processes?.length || 0;
  if (n) lines.push({ k: 'p', text: t('dialogs.teardown.procs', { n }) });
  if (worktree && hasWorktree(preview)) {
    const w = preview.worktree;
    lines.push(
      w.action === 'remove'
        ? { k: 'w', text: t('dialogs.teardown.wtRemove'), dir: w.dir }
        : { k: 'w', text: t('dialogs.teardown.wtKeep', { why: (w.reasons || []).join(', ') }), dir: w.dir, warn: true }
    );
  }
  if (scratch && preview.scratch) lines.push({ k: 's', text: t('dialogs.teardown.scratch') });
  if (!lines.length) return null;
  return (
    <ul className={`flex flex-col gap-1 text-xs leading-snug ${tone}`}>
      {lines.map((l) => (
        <li key={l.k} className={l.warn ? 'text-warn' : undefined}>
          {l.text}
          {l.dir && (
            <span className="block break-all font-mono text-2xs opacity-80" dir="ltr">
              {l.dir}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

export function ArchiveDialog({ session, onClose }) {
  const t = useT();
  const preview = useTeardown(session);
  const hasCleanup = hasWorktree(preview);
  const [removeWorktree, setRemoveWorktree] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const archive = async () => {
    setBusy(true);
    setError(null);
    try {
      // runCleanup only applies when the cleanup checkbox is shown + checked.
      const qs = hasCleanup && removeWorktree ? '?runCleanup=true' : '';
      await api.patch(`/sessions/${session.id}${qs}`, { archived: true });
      onClose();
    } catch (e) {
      setError(String(e.message || e));
      setBusy(false);
    }
  };

  return (
    <Overlay onClose={onClose}>
      <DialogHeader>
        <DialogTitle>{t('dialogs.archiveTitle')}</DialogTitle>
        <p className="text-sm text-fgdim">
          <span className="font-medium text-fg" dir="auto">{sessionLabel(session)}</span>{' '}
          {t('dialogs.archiveBody')}
        </p>
      </DialogHeader>
      {hasCleanup && (
        <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-hair p-3">
          <Checkbox checked={removeWorktree} onCheckedChange={(v) => setRemoveWorktree(v === true)} className="mt-0.5" />
          <span className="min-w-0">
            <span className="block text-sm font-medium text-fg">{t('dialogs.alsoRemoveWorktree')}</span>
            <span className="mt-1 block">
              <TeardownLines preview={preview} scratch={false} />
            </span>
          </span>
        </label>
      )}
      {error && <div className={ERR}>{error}</div>}
      <DialogFooter>
        <Button onClick={onClose}>{t('dialogs.cancel')}</Button>
        <Button variant="primary" onClick={archive} disabled={busy}>
          {busy ? t('dialogs.archiving') : t('dialogs.archive')}
        </Button>
      </DialogFooter>
    </Overlay>
  );
}

// Common statuses the MCP tools / rail grouping already use — offered as
// datalist suggestions; the field stays free-form (status is a free string).
const STATUS_SUGGESTIONS = ['In Progress', 'In Review', 'Blocked', 'Verified', 'Done'];

export function EditSessionDialog({ session, onClose }) {
  const t = useT();
  const [title, setTitle] = useState(session.title || '');
  const [status, setStatus] = useState(session.status || '');
  const [description, setDescription] = useState(session.metadata?.description || '');
  const [prompts, setPrompts] = useState(session.metadata?.prompts || null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.patch(`/sessions/${session.id}`, {
        title: title.trim() || session.title,
        status: status.trim(),
        metadata: { description: description.trim(), prompts },
      });
      onClose();
    } catch (e) {
      setError(String(e.message || e));
      setBusy(false);
    }
  };

  const field =
    'w-full rounded-lg border-[1.5px] border-border px-2.5 py-2 text-[12.5px] outline-none placeholder:text-fgdim focus:border-fgdim';

  return (
    <Overlay onClose={onClose} size="md">
      <DialogHeader>
        <DialogTitle>{t('dialogs.editSession')}</DialogTitle>
      </DialogHeader>
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="edit-session-title">{t('dialogs.title')}</Label>
          <Input
            id="edit-session-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && save()}
            autoFocus
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="edit-session-status">{t('dialogs.status')}</Label>
          <Input
            id="edit-session-status"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && save()}
            list="session-status-suggestions"
            placeholder="In Progress"
          />
          <datalist id="session-status-suggestions">
            {STATUS_SUGGESTIONS.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="edit-session-desc">{t('dialogs.description')}</Label>
          <Textarea
            id="edit-session-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            placeholder={t('dialogs.descriptionPlaceholder')}
            className="resize-none"
          />
        </div>
        <InstructionLayer scope="session" value={prompts} onChange={setPrompts} />
      </div>
      {error && <div className={ERR}>{error}</div>}
      <DialogFooter>
        <Button onClick={onClose}>{t('dialogs.cancel')}</Button>
        <Button variant="primary" onClick={save} disabled={busy}>
          {busy ? t('dialogs.saving') : t('dialogs.save')}
        </Button>
      </DialogFooter>
    </Overlay>
  );
}

/* ---------------- rail folders ------------------------------------------- */

// Shared ticket-prefix heuristic for the default folder name: two ENG-xxx
// sessions suggest "DEM"; otherwise "New folder".
function suggestFolderName(a, b) {
  const pre = (s) => /^([A-Za-z]+)-\d+/.exec(String(s?.metadata?.ticket || ''))?.[1] || null;
  const pa = pre(a);
  return (pa && pa === pre(b) && pa.toUpperCase()) || 'New folder';
}

function FolderNameShell({ title, children, name, setName, busy, error, submitLabel, onSubmit, onClose }) {
  const t = useT();
  return (
    <Overlay onClose={onClose}>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        {children}
      </DialogHeader>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="folder-name">{t('dialogs.folderName')}</Label>
        <Input
          id="folder-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && onSubmit()}
          onFocus={(e) => e.currentTarget.select()}
          autoFocus
        />
      </div>
      {error && <div className={ERR}>{error}</div>}
      <DialogFooter>
        <Button onClick={onClose}>{t('dialogs.cancel')}</Button>
        <Button variant="primary" onClick={onSubmit} disabled={busy}>
          {busy ? '…' : submitLabel}
        </Button>
      </DialogFooter>
    </Overlay>
  );
}

// Drop-session-on-session → group them. Cancel is a total no-op (no reorder
// happened yet — the drop only opened this dialog).
export function CreateFolderDialog({ target, dragged, onClose }) {
  const t = useT();
  const [name, setName] = useState(suggestFolderName(target, dragged));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const folder = await api.post('/folders', {
        name: name.trim() || 'New folder',
        // Inherit the target's root position; its old sortOrder becomes free.
        ...(target.sortOrder != null ? { sortOrder: target.sortOrder } : {}),
      });
      await api.post('/rail/reorder', {
        moves: [
          { sessionId: target.id, folderId: folder.id },
          { sessionId: dragged.id, folderId: folder.id },
        ],
        folders: { [folder.id]: [target.id, dragged.id] }, // target first — it was here first
      });
      onClose();
    } catch (e) {
      setError(String(e.message || e));
      setBusy(false);
    }
  };

  return (
    <FolderNameShell
      title={t('dialogs.createFolderTitle')}
      name={name}
      setName={setName}
      busy={busy}
      error={error}
      submitLabel={t('dialogs.createFolder')}
      onSubmit={create}
      onClose={onClose}
    >
      <div className="flex flex-col gap-1 text-sm text-fgdim">
        {[target, dragged].map((s) => (
          <span key={s.id} className="flex min-w-0 items-center gap-2">
            <Dot color={s.color || '#c4c4c4'} />
            <span className="truncate text-fg" dir="auto">{sessionLabel(s)}</span>
          </span>
        ))}
      </div>
    </FolderNameShell>
  );
}

// Manual creation (the + folder button) and rename share the name shell.
export function FolderNameDialog({ folder, onClose }) {
  const t = useT();
  const renaming = !!folder;
  const [name, setName] = useState(folder?.name || 'New folder');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      if (renaming) await api.patch(`/folders/${folder.id}`, { name: name.trim() || folder.name });
      else await api.post('/folders', { name: name.trim() || 'New folder', sortOrder: -1 }); // top of the rail
      onClose();
    } catch (e) {
      setError(String(e.message || e));
      setBusy(false);
    }
  };

  return (
    <FolderNameShell
      title={renaming ? t('dialogs.renameFolder') : t('dialogs.newFolder')}
      name={name}
      setName={setName}
      busy={busy}
      error={error}
      submitLabel={renaming ? t('dialogs.rename') : t('dialogs.create')}
      onSubmit={submit}
      onClose={onClose}
    />
  );
}

// Upgrade a folder to a project folder: a NEW dedicated controller session is
// spawned (seeded with the project-manager skill + the member roster). The
// human keeps working with every child directly — the controller is an
// additional bird's-eye authority, never a replacement.
export function MakeProjectDialog({ folder, defaultCwd, onClose }) {
  const t = useT();
  const [cwd, setCwd] = useState(defaultCwd || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const make = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/folders/${folder.id}/make-project`, {
        ...(cwd.trim() ? { cwd: cwd.trim() } : {}),
      });
      onClose();
    } catch (e) {
      setError(String(e.message || e));
      setBusy(false);
    }
  };

  return (
    <Overlay onClose={onClose} size="md">
      <DialogHeader>
        <DialogTitle>{t('dialogs.makeProjectTitle', { name: folder.name })}</DialogTitle>
        <p className="text-sm text-fgdim">{t('dialogs.makeProjectBody')}</p>
      </DialogHeader>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="make-project-cwd">{t('dialogs.controllerWorkingDir')}</Label>
        <Input
          id="make-project-cwd"
          value={cwd}
          onChange={(e) => setCwd(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && make()}
          autoFocus
          dir="ltr"
          placeholder={t('dialogs.controllerCwdPlaceholder')}
          className="font-mono text-xs"
        />
      </div>
      {error && <div className={ERR}>{error}</div>}
      <DialogFooter>
        <Button onClick={onClose}>{t('dialogs.cancel')}</Button>
        <Button variant="primary" onClick={make} disabled={busy}>
          {busy ? t('dialogs.creating') : t('dialogs.createController')}
        </Button>
      </DialogFooter>
    </Overlay>
  );
}

// The rail's "New project" button: one step instead of "new folder" → "make project folder". Creates the folder,
// makes it a project (its controller session, seeded with the goal when one is given) and opens that session.
export function NewProjectDialog({ defaultCwd, onClose }) {
  const t = useT();
  const [name, setName] = useState('');
  const [goal, setGoal] = useState('');
  const [cwd, setCwd] = useState(defaultCwd || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const create = async () => {
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const folder = await api.post('/folders', { name: name.trim(), sortOrder: -1 });
      const ctl = await api.post(`/folders/${folder.id}/make-project`, {
        ...(cwd.trim() ? { cwd: cwd.trim() } : {}),
        ...(goal.trim() ? { goal: goal.trim() } : {}),
      });
      onClose();
      if (ctl?.id) window.dispatchEvent(new CustomEvent('host:select-session', { detail: { id: ctl.id } }));
    } catch (e) {
      setError(String(e.message || e));
      setBusy(false);
    }
  };

  return (
    <Overlay onClose={onClose} size="md">
      <DialogHeader>
        <DialogTitle>{t('dialogs.newProjectTitle')}</DialogTitle>
        <p className="text-sm text-fgdim">{t('dialogs.newProjectBody')}</p>
      </DialogHeader>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="new-project-name">{t('dialogs.newProjectName')}</Label>
        <Input id="new-project-name" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && create()} autoFocus dir="auto" data-new-project-name />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="new-project-goal">{t('dialogs.newProjectGoal')}</Label>
        <Textarea id="new-project-goal" value={goal} onChange={(e) => setGoal(e.target.value)} dir="auto" rows={3} placeholder={t('dialogs.newProjectGoalPlaceholder')} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="new-project-cwd">{t('dialogs.controllerWorkingDir')}</Label>
        <Input id="new-project-cwd" value={cwd} onChange={(e) => setCwd(e.target.value)} dir="ltr" placeholder={t('dialogs.controllerCwdPlaceholder')} className="font-mono text-xs" />
      </div>
      {error && <div className={ERR}>{error}</div>}
      <DialogFooter>
        <Button onClick={onClose}>{t('dialogs.cancel')}</Button>
        <Button variant="primary" onClick={create} disabled={busy || !name.trim()} data-new-project-create>
          {busy ? t('dialogs.creating') : t('dialogs.newProjectCreate')}
        </Button>
      </DialogFooter>
    </Overlay>
  );
}

// Two exits: ungroup (children return to the rail) or purge (kill them all).
// Purge is the only place a folder action can destroy sessions — the server
// runs cleanup only for sessions that own their worktree.
export function DeleteFolderDialog({ folder, children: kids, onClose }) {
  const t = useT();
  const [busy, setBusy] = useState(null); // 'ungroup' | 'purge'
  const [error, setError] = useState(null);

  const run = async (mode) => {
    setBusy(mode);
    setError(null);
    try {
      await api.del(`/folders/${folder.id}?mode=${mode}`);
      onClose();
    } catch (e) {
      setError(String(e.message || e));
      setBusy(null);
    }
  };

  return (
    <Overlay onClose={onClose}>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <Icon icon={faFolder} className="text-fgdim" /> {t('dialogs.deleteFolderTitle', { name: folder.name })}
        </DialogTitle>
        <p className="text-sm text-fgdim">
          {kids.length === 1
            ? t('dialogs.folderSessionCountOne', { count: kids.length })
            : t('dialogs.folderSessionCountOther', { count: kids.length })}
        </p>
        <div className="mt-1 flex max-h-32 flex-col gap-1 overflow-y-auto text-xs text-fgdim">
          {kids.map((s) => (
            <span key={s.id} className="flex min-w-0 items-center gap-2">
              <Dot color={s.color || '#c4c4c4'} />
              <span className="truncate text-fg" dir="auto">{sessionLabel(s)}</span>
            </span>
          ))}
        </div>
      </DialogHeader>
      {error && <div className={ERR}>{error}</div>}
      <div className="flex flex-col gap-2">
        <Button variant="primary" onClick={() => run('ungroup')} disabled={!!busy} className="w-full">
          {busy === 'ungroup' ? t('dialogs.deleting') : t('dialogs.deleteFolderOnly')}
        </Button>
        <Button variant="destructive" onClick={() => run('purge')} disabled={!!busy} className="w-full whitespace-normal">
          {busy === 'purge'
            ? t('dialogs.deleting')
            : kids.length === 1
              ? t('dialogs.deleteFolderAndSessionsOne', { count: kids.length })
              : t('dialogs.deleteFolderAndSessionsOther', { count: kids.length })}
        </Button>
        <Button onClick={onClose} className="w-full">{t('dialogs.cancel')}</Button>
      </div>
    </Overlay>
  );
}

export function DeleteDialog({ session, onClose, onDeleted }) {
  const t = useT();
  const preview = useTeardown(session);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const del = async () => {
    setBusy(true);
    setError(null);
    try {
      // The host always does the full teardown (server/reap.ts); nothing to opt into.
      await api.del(`/sessions/${session.id}`);
      onDeleted?.(session.id);
      onClose();
    } catch (e) {
      setError(String(e.message || e));
      setBusy(false);
    }
  };

  return (
    <Overlay onClose={onClose}>
      <DialogHeader>
        <DialogTitle className="text-destructive">{t('dialogs.deletePermanentlyTitle')}</DialogTitle>
        <p className="text-sm text-fgdim">
          {t('dialogs.deleteBodyBefore')}{' '}
          <span className="font-medium text-fg" dir="auto">{sessionLabel(session)}</span>{' '}
          {t('dialogs.deleteBodyAfter')}
        </p>
      </DialogHeader>
      {preview && (preview.processes?.length || hasWorktree(preview) || preview.scratch) ? (
        <div className="rounded-lg border border-[var(--hb-err-line)] bg-[var(--hb-err-bg)] p-3">
          <TeardownLines preview={preview} tone="text-danger" />
        </div>
      ) : null}
      {error && <div className={ERR}>{error}</div>}
      <DialogFooter>
        <Button onClick={onClose}>{t('dialogs.cancel')}</Button>
        <Button variant="destructive" onClick={del} disabled={busy}>
          {busy ? t('dialogs.deleting') : t('dialogs.delete')}
        </Button>
      </DialogFooter>
    </Overlay>
  );
}
