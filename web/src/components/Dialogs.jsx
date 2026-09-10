import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../lib/api.js';
import { useT } from '../lib/i18n.js';
import { sessionLabel, Dot, YellowButton, GhostButton } from './ui.jsx';
import { Icon } from '../lib/icons.js';
import { faCheck, faFolder } from '@fortawesome/free-solid-svg-icons';

export function Overlay({ onClose, children }) {
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  // Portaled to <body>: mounted from Rail.jsx, whose transform/overflow makes
  // a containing block for position:fixed descendants — without this, the
  // overlay is clipped to the rail's own box instead of covering the viewport
  // (same issue Rail.jsx's useHoverTip already works around the same way).
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(20,20,22,0.45)] p-5"
      onClick={onClose}
    >
      <div onClick={(e) => e.stopPropagation()}>{children}</div>
    </div>,
    document.body
  );
}

export function ArchiveDialog({ session, onClose }) {
  const t = useT();
  const cleanup = session.metadata?.cleanup;
  const hasCleanup = Array.isArray(cleanup) && cleanup.length > 0;
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
      <div className="w-[384px] max-w-full overflow-hidden rounded-xl border-2 border-ink bg-panel text-fg shadow-[5px_6px_0_rgba(42,42,42,0.25)]">
        <div className="px-[18px] pt-4">
          <div className="text-[17px] leading-tight font-bold">{t('dialogs.archiveTitle')}</div>
          <p className="mt-2 text-[12.5px] leading-normal text-fgdim">
            <span className="font-mono font-bold text-fg">{sessionLabel(session)}</span>{' '}
            {t('dialogs.archiveBody')}
          </p>
        </div>
        {hasCleanup && (
          <div
            onClick={() => setRemoveWorktree((v) => !v)}
            className="mx-[18px] mt-3.5 flex cursor-pointer items-start gap-[11px] rounded-[9px] border-[1.5px] border-border p-[11px_12px]"
          >
            <span
              className="mt-px flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[5px] border-[1.5px] border-ink text-[11px] text-[#1a1a1a]"
              style={{ background: removeWorktree ? '#F9D312' : 'var(--color-panel)' }}
            >
              {removeWorktree ? <Icon icon={faCheck} /> : ''}
            </span>
            <span className="min-w-0">
              <span className="block text-[12.5px] font-bold text-fg">
                {t('dialogs.alsoRemoveWorktree')}
              </span>
              {session.metadata?.worktree && (
                <span className="mt-0.5 block font-mono text-[11.5px] md:text-[10.5px] text-fgdim">
                  {session.metadata.worktree}
                </span>
              )}
              <span className="mt-1 block font-mono text-[11.5px] md:text-[10px] leading-relaxed text-fgdim">
                {cleanup.map((c, i) => (
                  <span key={i} className="block truncate">
                    {c}
                  </span>
                ))}
              </span>
              <span className="mt-1 block text-[11px] leading-snug text-fgdim">
                {t('dialogs.worktreeFreesDisk')}
              </span>
            </span>
          </div>
        )}
        {error && <div className="px-[18px] pt-2 text-[11px] text-danger">{error}</div>}
        <div className="flex justify-end gap-[9px] p-[16px_18px]">
          <GhostButton onClick={onClose}>{t('dialogs.cancel')}</GhostButton>
          <YellowButton onClick={archive} disabled={busy} className="px-4 py-2 text-[12.5px]">
            {busy ? t('dialogs.archiving') : t('dialogs.archive')}
          </YellowButton>
        </div>
      </div>
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.patch(`/sessions/${session.id}`, {
        title: title.trim() || session.title,
        status: status.trim(),
        metadata: { description: description.trim() },
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
    <Overlay onClose={onClose}>
      <div className="w-[420px] max-w-full overflow-hidden rounded-xl border-2 border-ink bg-panel text-fg shadow-[5px_6px_0_rgba(42,42,42,0.25)]">
        <div className="px-[18px] pt-4">
          <div className="text-[17px] leading-tight font-bold">{t('dialogs.editSession')}</div>
        </div>
        <div className="flex flex-col gap-3 px-[18px] pt-3.5">
          <label className="block">
            <span className="mb-1 block font-mono text-[11.5px] md:text-[10px] tracking-[0.08em] text-fgdim uppercase">{t('dialogs.title')}</span>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && save()}
              autoFocus
              className={field}
            />
          </label>
          <label className="block">
            <span className="mb-1 block font-mono text-[11.5px] md:text-[10px] tracking-[0.08em] text-fgdim uppercase">{t('dialogs.status')}</span>
            <input
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && save()}
              list="session-status-suggestions"
              placeholder="In Progress"
              className={field}
            />
            <datalist id="session-status-suggestions">
              {STATUS_SUGGESTIONS.map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
          </label>
          <label className="block">
            <span className="mb-1 block font-mono text-[11.5px] md:text-[10px] tracking-[0.08em] text-fgdim uppercase">{t('dialogs.description')}</span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              placeholder={t('dialogs.descriptionPlaceholder')}
              className={`${field} resize-none`}
            />
          </label>
        </div>
        {error && <div className="px-[18px] pt-2 text-[11px] text-danger">{error}</div>}
        <div className="flex justify-end gap-[9px] p-[16px_18px]">
          <GhostButton onClick={onClose}>{t('dialogs.cancel')}</GhostButton>
          <YellowButton onClick={save} disabled={busy} className="px-4 py-2 text-[12.5px]">
            {busy ? t('dialogs.saving') : t('dialogs.save')}
          </YellowButton>
        </div>
      </div>
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
      <div className="w-[384px] max-w-full overflow-hidden rounded-xl border-2 border-ink bg-panel text-fg shadow-[5px_6px_0_rgba(42,42,42,0.25)]">
        <div className="px-[18px] pt-4">
          <div className="text-[17px] leading-tight font-bold">{title}</div>
          {children}
        </div>
        <div className="px-[18px] pt-3.5">
          <label className="block">
            <span className="mb-1 block font-mono text-[11.5px] md:text-[10px] tracking-[0.08em] text-fgdim uppercase">
              {t('dialogs.folderName')}
            </span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && onSubmit()}
              onFocus={(e) => e.currentTarget.select()}
              autoFocus
              className="w-full rounded-lg border-[1.5px] border-border px-2.5 py-2 text-[12.5px] outline-none placeholder:text-fgdim focus:border-fgdim"
            />
          </label>
        </div>
        {error && <div className="px-[18px] pt-2 text-[11px] text-danger">{error}</div>}
        <div className="flex justify-end gap-[9px] p-[16px_18px]">
          <GhostButton onClick={onClose}>{t('dialogs.cancel')}</GhostButton>
          <YellowButton onClick={onSubmit} disabled={busy} className="px-4 py-2 text-[12.5px]">
            {busy ? '…' : submitLabel}
          </YellowButton>
        </div>
      </div>
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
      <div className="mt-2 flex flex-col gap-1 text-[12.5px] text-fgdim">
        {[target, dragged].map((s) => (
          <span key={s.id} className="flex min-w-0 items-center gap-2">
            <Dot color={s.color || '#c4c4c4'} />
            <span className="truncate font-mono text-fg">{sessionLabel(s)}</span>
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
    <Overlay onClose={onClose}>
      <div className="w-[420px] max-w-full overflow-hidden rounded-xl border-2 border-ink bg-panel text-fg shadow-[5px_6px_0_rgba(42,42,42,0.25)]">
        <div className="px-[18px] pt-4">
          <div className="text-[17px] leading-tight font-bold">
            {t('dialogs.makeProjectTitle', { name: folder.name })}
          </div>
          <p className="mt-2 text-[12.5px] leading-normal text-fgdim">
            {t('dialogs.makeProjectBody')}
          </p>
        </div>
        <div className="px-[18px] pt-3.5">
          <label className="block">
            <span className="mb-1 block font-mono text-[11.5px] md:text-[10px] tracking-[0.08em] text-fgdim uppercase">
              {t('dialogs.controllerWorkingDir')}
            </span>
            <input
              value={cwd}
              onChange={(e) => setCwd(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && make()}
              autoFocus
              placeholder={t('dialogs.controllerCwdPlaceholder')}
              className="w-full rounded-lg border-[1.5px] border-border px-2.5 py-2 font-mono text-[11.5px] outline-none placeholder:text-fgdim focus:border-fgdim"
            />
          </label>
        </div>
        {error && <div className="px-[18px] pt-2 text-[11px] text-danger">{error}</div>}
        <div className="flex justify-end gap-[9px] p-[16px_18px]">
          <GhostButton onClick={onClose}>{t('dialogs.cancel')}</GhostButton>
          <YellowButton onClick={make} disabled={busy} className="px-4 py-2 text-[12.5px]">
            {busy ? t('dialogs.creating') : t('dialogs.createController')}
          </YellowButton>
        </div>
      </div>
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
      <div className="w-[400px] max-w-full overflow-hidden rounded-xl border-2 border-ink bg-panel text-fg shadow-[5px_6px_0_rgba(42,42,42,0.25)]">
        <div className="px-[18px] pt-4">
          <div className="flex items-center gap-2 text-[17px] leading-tight font-bold">
            <Icon icon={faFolder} className="text-fgdim" /> {t('dialogs.deleteFolderTitle', { name: folder.name })}
          </div>
          <p className="mt-2 text-[12.5px] leading-normal text-fgdim">
            {kids.length === 1
              ? t('dialogs.folderSessionCountOne', { count: kids.length })
              : t('dialogs.folderSessionCountOther', { count: kids.length })}
          </p>
          <div className="mt-1.5 flex max-h-32 flex-col gap-1 overflow-y-auto text-[12px] text-fgdim">
            {kids.map((s) => (
              <span key={s.id} className="flex min-w-0 items-center gap-2">
                <Dot color={s.color || '#c4c4c4'} />
                <span className="truncate font-mono text-fg">{sessionLabel(s)}</span>
              </span>
            ))}
          </div>
        </div>
        {error && <div className="px-[18px] pt-2 text-[11px] text-danger">{error}</div>}
        <div className="flex flex-col gap-2 p-[16px_18px]">
          <YellowButton onClick={() => run('ungroup')} disabled={!!busy} className="w-full px-4 py-2 text-[12.5px]">
            {busy === 'ungroup' ? t('dialogs.deleting') : t('dialogs.deleteFolderOnly')}
          </YellowButton>
          <button
            type="button"
            onClick={() => run('purge')}
            disabled={!!busy}
            className="w-full cursor-pointer rounded-lg border-2 border-danger bg-danger px-4 py-2 text-[12.5px] font-bold text-white shadow-[2px_2px_0_#7d2a23] disabled:opacity-50"
          >
            {busy === 'purge'
              ? t('dialogs.deleting')
              : kids.length === 1
                ? t('dialogs.deleteFolderAndSessionsOne', { count: kids.length })
                : t('dialogs.deleteFolderAndSessionsOther', { count: kids.length })}
          </button>
          <GhostButton onClick={onClose} className="w-full">{t('dialogs.cancel')}</GhostButton>
        </div>
      </div>
    </Overlay>
  );
}

export function DeleteDialog({ session, onClose, onDeleted }) {
  const t = useT();
  const cleanup = session.metadata?.cleanup;
  const hasCleanup = Array.isArray(cleanup) && cleanup.length > 0;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const del = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.del(`/sessions/${session.id}${hasCleanup ? '?runCleanup=true' : ''}`);
      onDeleted?.(session.id);
      onClose();
    } catch (e) {
      setError(String(e.message || e));
      setBusy(false);
    }
  };

  return (
    <Overlay onClose={onClose}>
      <div className="w-[384px] max-w-full overflow-hidden rounded-xl border-2 border-danger bg-panel text-fg shadow-[5px_6px_0_rgba(178,59,48,0.25)]">
        <div className="px-[18px] pt-4">
          <div className="text-[17px] leading-tight font-bold text-danger">
            {t('dialogs.deletePermanentlyTitle')}
          </div>
          <p className="mt-2 text-[12.5px] leading-normal text-fgdim">
            {t('dialogs.deleteBodyBefore')}{' '}
            <span className="font-mono font-bold text-fg">{sessionLabel(session)}</span>{' '}
            {t('dialogs.deleteBodyAfter')}
          </p>
        </div>
        {hasCleanup && (
          <div className="mx-[18px] mt-3.5 rounded-[9px] border-[1.5px] border-danger/30 bg-danger/10 p-[10px_12px] font-mono text-[11.5px] md:text-[10.5px] leading-[1.8] text-danger">
            {cleanup.map((c, i) => (
              <div key={i} className="truncate">
                {c}
              </div>
            ))}
          </div>
        )}
        {error && <div className="px-[18px] pt-2 text-[11px] text-danger">{error}</div>}
        <div className="flex justify-end gap-[9px] p-[16px_18px]">
          <GhostButton onClick={onClose}>{t('dialogs.cancel')}</GhostButton>
          <button
            type="button"
            onClick={del}
            disabled={busy}
            className="cursor-pointer rounded-lg border-2 border-danger bg-danger px-4 py-2 text-[12.5px] font-bold text-white shadow-[2px_2px_0_#7d2a23] disabled:opacity-50"
          >
            {busy ? t('dialogs.deleting') : t('dialogs.delete')}
          </button>
        </div>
      </div>
    </Overlay>
  );
}
