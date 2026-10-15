// The chat composer: textarea + attachments + slash / @ palettes + queue +
// voice + the model/effort/mode pill. Moved out of SessionView.jsx (behaviour
// unchanged) so the chat redesign owns one file; SessionView mounts <ChatFooter/>.
import { useState, useRef, useMemo, useEffect } from 'react';
import {
  ArrowUpIcon,
  ArchiveIcon,
  AtSignIcon,
  CornerUpLeftIcon,
  FileIcon,
  GripVerticalIcon,
  HourglassIcon,
  ImageIcon,
  ListIcon,
  PaperclipIcon,
  PlayIcon,
  SquareIcon,
  ChevronDownIcon,
  XIcon,
} from 'lucide-react';
import { api } from '../lib/api.js';
import { toastError } from '../lib/toast.js';
import { errText } from '../lib/errors.js';
import { useStore, fullCapabilities, ensureFullCapabilities, getDraft, setDraft, setLastSent, interruptSession } from '../lib/store.js';
import { useIsDesktop } from '../lib/useMedia.js';
import { engineLabel } from '../lib/engines.js';
import { setDictationSink, appendDictation } from '../lib/voice.js';
import { HARD_CAP, shouldStream, fileToBase64, uploadAttachment, pendingAttachment, applyUploadEvent, isAlreadyAttached } from '../lib/attachments.js';
import { useT, fieldDir } from '../lib/i18n.js';
import { SlashPalette, CapabilitiesPanel, buildSlashItems, MentionPalette, TeamPanel } from './SlashCommands.jsx';
import { useSkills, skillSlashItems, agentCommandItems, resolveSubmission, mentionQuery, completeMention, buildMentionItems } from '../lib/composer.js';
import { extSlashItems } from '../lib/ext.js';
import { openAgent } from './DelegatedLine.jsx';
import { contextColor } from './ui.jsx';
import ContextModal from './ContextModal.jsx';
import MicButton from './MicButton.jsx';
import ComposerPill from './ComposerPill.jsx';
import { Button, Switch, Tip, TooltipProvider } from './ui/index.js';

/* ---------- pending prompts (queued while busy) ---------------------------- */

export function PendingPromptsPanel({ session }) {
  const t = useT();
  const isDesktop = useIsDesktop();
  const prompts = session.pendingPrompts || [];
  const autoPlay = !!session.promptAutoPlay;
  const [open, setOpen] = useState(false);
  // Optimistic order mirror for drag-sort (same HTML5 pattern as the rail's
  // Pending tasks list — no library, plain draggable + dataTransfer).
  const [order, setOrder] = useState(prompts.map((p) => p.id));
  const dragId = useRef(null);
  const [overId, setOverId] = useState(null);
  useEffect(() => {
    setOrder(prompts.map((p) => p.id));
  }, [prompts.map((p) => p.id).join('|')]);
  if (!prompts.length) return null;
  const byId = new Map(prompts.map((p) => [p.id, p]));
  const rows = order.map((pid) => byId.get(pid)).filter(Boolean);

  const play = (pid) => api.post(`/sessions/${session.id}/prompts/${pid}/play`).catch(toastError);
  const del = (pid) => api.del(`/sessions/${session.id}/prompts/${pid}`).catch(toastError);
  const toggleAuto = () =>
    api.post(`/sessions/${session.id}/prompts/autoplay`, { on: !autoPlay }).catch(toastError);

  const onDragStart = (e, pid) => {
    dragId.current = pid;
    e.dataTransfer.effectAllowed = 'move';
    // Tag the drag so ancestors (the composer's attachment drop zone) can tell
    // it apart from a file/session drag and ignore it.
    e.dataTransfer.setData('application/x-arigami-prompt', pid);
  };
  const onDragOver = (e, pid) => {
    e.preventDefault();
    e.stopPropagation();
    if (pid !== overId) setOverId(pid);
  };
  const onDropRow = (e, pid) => {
    e.preventDefault();
    e.stopPropagation();
    setOverId(null);
    const from = order.indexOf(dragId.current);
    const to = order.indexOf(pid);
    dragId.current = null;
    if (from === -1 || to === -1 || from === to) return;
    const ids = [...order];
    ids.splice(to, 0, ...ids.splice(from, 1));
    setOrder(ids);
    api.post(`/sessions/${session.id}/prompts/reorder`, { order: ids }).catch(toastError);
  };

  return (
    <div className="relative">
      {/* collapsed pill row */}
      <div className="mb-1.5 flex items-center gap-3">
        <Tip label={open ? t('rail.hideQueuedPrompts') : t('rail.showQueuedPrompts')}>
          <Button variant="outline" size="sm" data-queue-pill aria-expanded={open} onClick={() => setOpen((v) => !v)} className="gap-1.5">
            <HourglassIcon className="size-3.5" />
            <span className="font-medium tabular-nums">{prompts.length}</span>
            <span className="text-muted-foreground">{t('rail.queued')}</span>
            <ChevronDownIcon className={`size-3 text-muted-foreground transition-transform ${open ? '' : 'rotate-180'}`} />
          </Button>
        </Tip>
        <Tip label={t('rail.autoPlayPromptHint', { engine: engineLabel(session.engine) })}>
          <label className="flex min-h-7 cursor-pointer items-center gap-2 text-xs text-muted-foreground coarse:min-h-11">
            <Switch checked={autoPlay} onCheckedChange={toggleAuto} aria-label={t('rail.autoPlay')} />
            {t('rail.autoPlay')}
          </label>
        </Tip>
        {/* Auto-play is on and prompts wait, but the host is holding the queue
            back until the human answers the action bar above — say so, instead
            of leaving a queue that looks stuck on an idle session. */}
        {autoPlay && session.autoPlayHold === 'action' && (
          <span className="text-xs text-muted-foreground" title={t('rail.autoPlayHoldActionHint')}>
            {t('rail.autoPlayHoldAction')}
          </span>
        )}
      </div>
      {/* floating list */}
      {open && (
        <div className="absolute bottom-full start-0 z-30 mb-1 w-full max-w-[560px] rounded-lg border border-border bg-popover p-2 shadow-pop">
          <div className="mb-1.5 px-1 text-2xs font-medium tracking-wide text-muted-foreground uppercase">
            {t(isDesktop ? 'rail.queuedPromptsHint' : 'rail.queuedPromptsHintTouch')}
          </div>
          <div className="thin-scroll flex max-h-[38vh] flex-col gap-1 overflow-y-auto">
            {rows.map((p) => (
              <div
                key={p.id}
                draggable
                onDragStart={(e) => onDragStart(e, p.id)}
                onDragOver={(e) => onDragOver(e, p.id)}
                onDrop={(e) => onDropRow(e, p.id)}
                onDragEnd={() => setOverId(null)}
                className={`flex items-start gap-2 rounded-md px-2 py-1.5 ${overId === p.id ? 'bg-muted ring-1 ring-ring' : 'bg-muted/50'}`}
              >
                <span className="cursor-grab pt-0.5 text-muted-foreground select-none" title={t('rail.dragToReorder')}>
                  <GripVerticalIcon className="size-3.5" />
                </span>
                <span dir="auto" className="min-w-0 flex-1 text-sm leading-snug break-words text-foreground">
                  {p.text.length > 220 ? `${p.text.slice(0, 220)}…` : p.text}
                </span>
                <Tip label={session.claude?.state === 'working' ? t('rail.interruptSendNow') : t('rail.sendPromptNow')}>
                  <Button variant="ghost" size="icon-xs" onClick={() => play(p.id)} aria-label={t('rail.sendPromptNow')}>
                    <PlayIcon className="rtl:-scale-x-100" />
                  </Button>
                </Tip>
                <Tip label={t('rail.removeFromQueue')}>
                  <Button variant="ghost" size="icon-xs" onClick={() => del(p.id)} aria-label={t('rail.removeFromQueue')} className="hover:text-destructive">
                    <XIcon />
                  </Button>
                </Tip>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function ChatFooter({ session }) {
  const t = useT();
  // Draft text/attachments are mirrored into the global store keyed by session
  // id, so they survive switching to another session and back — local state
  // alone doesn't, since ChatFooter unmounts when the active session changes.
  const [text, setTextLocal] = useState(() => getDraft(session.id).text);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [panelTab, setPanelTab] = useState(null); // null = closed; else a tab id
  const [attachments, setAttachmentsLocal] = useState(() => getDraft(session.id).attachments);
  const [dragging, setDragging] = useState(false);
  const [ctxOpen, setCtxOpen] = useState(false);
  const [quoted, setQuoted] = useState(null); // { kind, text, ts }
  const isDesktop = useIsDesktop();
  const taRef = useRef(null);
  const fileRef = useRef(null);
  const setText = (updater) =>
    setTextLocal((prev) => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      setDraft(session.id, { text: next });
      return next;
    });
  const setAttachments = (updater) =>
    setAttachmentsLocal((prev) => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      setDraft(session.id, { attachments: next });
      return next;
    });
  // VOICE1: the composer mic dictates — the transcript is appended to the draft
  // (with a space) and the textarea gets focus; nothing is sent.
  useEffect(() => setDictationSink((spoken) => {
    setText((prev) => appendDictation(prev, spoken));
    taRef.current?.focus();
  }), [session.id]);
  // Covers the case where ChatFooter stays mounted and only `session` changes.
  const prevSessionId = useRef(session.id);
  useEffect(() => {
    if (prevSessionId.current === session.id) return;
    prevSessionId.current = session.id;
    const d = getDraft(session.id);
    setTextLocal(d.text);
    setAttachmentsLocal(d.attachments);
  }, [session.id]);
  const working = session.claude?.state === 'working';
  // List payloads carry slim capabilities; the slash palette + Capabilities
  // panel need the full command/tool lists — fetched lazily, cached in the store.
  useStore(); // re-render when capsFull lands
  const caps = fullCapabilities(session);
  const capsSlim = !!session.claude?.capabilities?.slim;
  const capsSessionId = session.claude?.sessionId;
  useEffect(() => {
    if (capsSlim) ensureFullCapabilities(session);
  }, [session.id, capsSlim, capsSessionId]); // eslint-disable-line react-hooks/exhaustive-deps
  // Rich command objects from the initialize handshake; fall back to legacy
  // bare-string slashCommands captured before this shape existed.
  const commands = caps?.commands || (caps?.slashCommands || []).map((name) => ({ name }));

  // A4: host agent commands (/team, /as, /agent new) + skills with a `slash:`
  // field (/plan, /review, user skills) join the palette; "@" suggests agents.
  const { agents, sessions: sessionsAll, extensions } = useStore();
  const skills = useSkills();
  const [teamOpen, setTeamOpen] = useState(false);
  // EXT: a manifest tab with openFrom:["slash:/pick"] joins the palette last —
  // after the agent commands and the skills, which own their names first.
  const extraItems = useMemo(
    () => [...agentCommandItems(), ...skillSlashItems(skills), ...extSlashItems(extensions)],
    [skills, extensions]
  );

  // The palette shows while the input is a single "/token" (no space yet) —
  // "/agent new" is two words, so the second word is allowed for that one.
  const slashMatch = /^\/([\w:-]*)$/.exec(text) || /^\/(agent(?: [a-z]*)?)$/.exec(text);
  const query = slashMatch ? slashMatch[1] : '';
  const items = useMemo(
    () => (slashMatch ? buildSlashItems(query, commands, extraItems) : []),
    [slashMatch, query, commands, extraItems]
  );
  const mq = mentionQuery(text);
  const mentionItems = useMemo(() => (mq !== null ? buildMentionItems(mq, agents) : []), [mq, agents]);
  const mentionOpen = mq !== null && !dismissed && mentionItems.length > 0;
  const paletteOpen = !!slashMatch && !dismissed && items.length > 0;
  useEffect(() => setActive(0), [query, mq]);
  useEffect(() => { if (!slashMatch && mq === null) setDismissed(false); }, [slashMatch, mq]);

  const focusInput = () => requestAnimationFrame(() => taRef.current?.focus());

  // Command bus → focus the composer (voice: "let me type", "focus the input").
  useEffect(() => {
    const onFocus = () => focusInput();
    window.addEventListener('host:focus-input', onFocus);
    return () => window.removeEventListener('host:focus-input', onFocus);
  }, []);

  // Quote: ChatPane fires 'host:quote' when the user clicks ↩ on a message.
  useEffect(() => {
    const onQuote = (e) => {
      const ev = e.detail?.event;
      if (!ev) return;
      const txt = ev.text ?? ev.content ?? ev.message ?? ev.output ?? '';
      const text = typeof txt === 'string' ? txt : Array.isArray(txt) ? txt.map(p => typeof p === 'string' ? p : p?.text ?? '').join('\n') : String(txt);
      setQuoted({ kind: ev.kind, text, ts: ev.ts });
      focusInput();
    };
    window.addEventListener('host:quote', onQuote);
    return () => window.removeEventListener('host:quote', onQuote);
  }, []);


  // Accept a palette item: host "inspect" commands open the panel; real
  // commands are inserted as "/name " so the user can add args, then ↵ sends.
  const accept = (item) => {
    if (!item) return;
    // EXT: an extension slash takes no arguments — picking it opens the tab.
    if (item.extTab) { runHostCommand({ type: 'ext-tab', ...item.extTab }); setText(''); return; }
    if (item.agentCmd) {
      // A4: /team runs at once; /as and /agent new want arguments.
      if (item.run) { runHostCommand({ type: item.agentCmd }); setText(''); return; }
      setText('/' + item.name + ' ');
      setDismissed(true);
      focusInput();
    } else if (item.host) {
      setPanelTab(item.tab);
      setText('');
    } else {
      setText('/' + item.name + ' ');
      setDismissed(true);
      focusInput();
    }
  };

  const acceptMention = (a) => {
    if (!a) return;
    setText((t) => completeMention(t, a.slug));
    setDismissed(true);
    focusInput();
  };

  // A4: the host-side outcomes of a submission (never sent to claude).
  const runHostCommand = async (r) => {
    if (r.type === 'team') { setTeamOpen(true); return; }
    if (r.type === 'as-usage') { toastError(t('dialogs.asUsage')); return; }
    if (r.type === 'unknown-agent') { toastError(t('dialogs.unknownAgent', { name: r.name })); return; }
    if (r.type === 'agent-new') {
      // UX2: no session-spawning "interview" — opens the same agent surface an
      // existing agent uses, just in create mode (AgentView, slug '__new__').
      openAgent('__new__', 'persona', r.name || '');
      return;
    }
    if (r.type === 'adopt-usage') { toastError(t('dialogs.adoptUsage')); return; }
    if (r.type === 'adopt') {
      await api.post(`/sessions/${session.id}/adopt-agent`, { agent: r.agent.slug });
      return;
    }
    if (r.type === 'as') {
      await api.post(`/sessions/${session.id}/delegate`, { agent: r.agent.slug, text: r.text, mode: 'as' });
      return;
    }
    if (r.type === 'ext-tab') {
      const tab = await api.post(`/sessions/${session.id}/tabs`, { type: 'ext', ext: r.ext, tab: r.tab });
      if (tab?.id) await api.post(`/sessions/${session.id}/activate-tab`, { tabId: tab.id });
      return;
    }
    if (r.type === 'mention') {
      for (const a of r.agents) await api.post(`/sessions/${session.id}/delegate`, { agent: a.slug, text: r.text, mode: 'mention' });
    }
  };

  // Insert a command from the Capabilities panel into the input.
  const insertCommand = (name) => {
    setPanelTab(null);
    setText('/' + name + ' ');
    focusInput();
  };

  const isArchiveName = (name) => /\.(zip|tar|tar\.gz|tgz)$/i.test(name || '');

  // ---- attachments (file picker / drag-drop / paste) ----
  // ZIP: anything under STREAM_THRESHOLD still rides inline as base64 in the
  // message body; at/past it, it streams to .../attachments first (needed for
  // archives — the 32MB JSON body cap made anything but a small screenshot
  // fail outright) and the chip tracks upload progress until the server's
  // descriptor comes back (with the extracted tree, for a zip/tar).
  const addFiles = async (fileList) => {
    const arr = Array.from(fileList || []);
    // ZIP2: a re-drag of a file already in the draft (same name+size) is
    // dropped here instead of spooling another full copy server-side.
    const fresh = arr.filter((f) => !isAlreadyAttached(attachments, f));
    const oversized = fresh.filter((f) => f.size > HARD_CAP);
    for (const f of oversized) toastError(new Error(t('rail.attachTooLarge', { name: f.name })));
    const accepted = fresh.filter((f) => f.size <= HARD_CAP);
    const small = accepted.filter((f) => !shouldStream(f));
    const big = accepted.filter(shouldStream);

    if (small.length) {
      const read = await Promise.all(
        small.map(async (f) => ({ name: f.name, type: f.type || 'application/octet-stream', size: f.size, dataBase64: await fileToBase64(f) }))
      );
      setAttachments((a) => [...a, ...read.filter((x) => x.dataBase64)].slice(0, 10));
    }
    for (const f of big) {
      const placeholder = pendingAttachment(f);
      setAttachments((a) => [...a, placeholder].slice(0, 10));
      try {
        const descriptor = await uploadAttachment(session.id, f, {
          onProgress: (p) => setAttachments((a) => applyUploadEvent(a, placeholder.uid, { type: 'progress', progress: p })),
        });
        setAttachments((a) => applyUploadEvent(a, placeholder.uid, { type: 'done', descriptor }));
      } catch (e) {
        setAttachments((a) => applyUploadEvent(a, placeholder.uid, { type: 'fail', error: errText(e) }));
      }
    }
  };
  const removeAttachment = (i) => {
    // ZIP2: a streamed upload already landed on disk (has `.path`) — reclaim
    // the spooled copy + extraction dir now that the chip is gone, instead of
    // leaving it in ~/.arigami/uploads until someone cleans it up by hand.
    const item = attachments[i];
    if (item?.path && !item.uploading) {
      api.del(`/sessions/${session.id}/attachments?path=${encodeURIComponent(item.path)}`).catch(() => {});
    }
    setAttachments((a) => a.filter((_, k) => k !== i));
  };

  // Guards against a double-fire from the Enter-keydown handler and the Send
  // button's onClick landing in the same tick, before React re-renders to
  // reflect the cleared `text` — without this, one submission could POST twice.
  const sendingRef = useRef(false);
  const send = async () => {
    if (sendingRef.current) return;
    // NOTE: `t` is the i18n function in this component — the composer text is
    // `draft` (it used to shadow `t`, so nothing here could be translated).
    const draft = text.trim();
    if (!draft && !attachments.length) return;
    if (attachments.some((a) => a.uploading || a.failed)) {
      toastError(new Error(t('rail.attachStillUploading')));
      return;
    }
    sendingRef.current = true;
    const sentAttachments = attachments;
    // Prepend the quoted message as a blockquote so the model sees context.
    const quotedPrefix = quoted
      ? `> ${quoted.text.split('\n').join('\n> ')}\n\n`
      : '';
    // A4: slash-commands / @mentions the host answers itself (see lib/composer.js).
    const resolved = resolveSubmission(draft, { skills, agents, extensions });
    if (resolved.type !== 'plain' && resolved.type !== 'skill') {
      setText('');
      try {
        await runHostCommand(resolved.type === 'mention' ? { ...resolved, text: quotedPrefix + resolved.text } : resolved);
      } catch (e) {
        // A5 (#10): a FAILED command must never go back into the box. It used to
        // be restored there, so the next thing the human typed was appended to it
        // and Enter silently re-ran the same failing slash line instead of sending
        // a message. Say what happened; put the text back only if they ask.
        toastError(t('chat.commandFailed', { msg: errText(e) }), {
          action: { label: t('chat.commandRestore'), onClick: () => { setText(draft); focusInput(); } },
        });
      } finally {
        sendingRef.current = false;
      }
      return;
    }
    // A skill slash (/plan …) is rewritten to its plugin command (/arigami:dispatch …).
    const fullText = quotedPrefix + (resolved.type === 'skill' ? resolved.text : draft);
    const payload = {
      text: fullText,
      attachments: sentAttachments.map(({ name, type, dataBase64, path }) => (path ? { name, type, path } : { name, type, dataBase64 })),
    };
    setLastSent(session.id, { text: fullText, attachments: sentAttachments });
    setText('');
    setAttachments([]);
    setQuoted(null);
    try {
      await api.post(`/sessions/${session.id}/message`, payload);
    } catch (e) {
      // Restore the draft — but SAY why it came back (a refused turn used to look
      // like Enter did nothing at all): a budget 429 renders localized (A5 #11).
      setText(draft);
      setAttachments(sentAttachments);
      toastError(e);
    } finally {
      sendingRef.current = false;
    }
  };

  const interrupt = () => interruptSession(session.id);

  // Queue the composer text as a pending prompt instead of interjecting into
  // the running turn (attachments stay in the draft — the queue is text-only).
  const queue = async () => {
    const t = text.trim();
    if (!t) return;
    setText('');
    try {
      await api.post(`/sessions/${session.id}/prompts`, { text: t });
    } catch (e) {
      setText(t); // restore on failure
      toastError(e);
    }
  };

  // Stopping a running turn (Esc, ■, or a voice "stop") hands the in-flight
  // prompt back to this session's draft — sync it in if we're still mounted.
  useEffect(() => {
    const onRestored = (e) => {
      if (e.detail?.sessionId !== session.id) return;
      const d = getDraft(session.id);
      setTextLocal(d.text);
      setAttachmentsLocal(d.attachments);
    };
    window.addEventListener('host:draft-restored', onRestored);
    return () => window.removeEventListener('host:draft-restored', onRestored);
  }, [session.id]);

  const onDrop = (e) => {
    e.preventDefault();
    setDragging(false);
    // A rail session row dropped here becomes an inline reference the agent can
    // act on (it can read that session via the host MCP's list_sessions).
    const sessRef = e.dataTransfer?.getData('application/x-arigami-session');
    if (sessRef) {
      try {
        const { id: sid, title } = JSON.parse(sessRef);
        if (sid && sid !== session.id) {
          const ref = `[host session: "${title || sid}" — id ${sid}] `;
          setText((t) => (t ? `${t} ${ref}` : ref));
          focusInput();
        }
      } catch { /* malformed payload — ignore */ }
      return;
    }
    if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
  };
  const onPaste = (e) => {
    const files = [...(e.clipboardData?.items || [])]
      .filter((it) => it.kind === 'file')
      .map((it) => it.getAsFile())
      .filter(Boolean);
    if (files.length) { e.preventDefault(); addFiles(files); }
  };

  const onKeyDown = (e) => {
    if (mentionOpen) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(mentionItems.length - 1, i + 1)); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(0, i - 1)); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); acceptMention(mentionItems[active]); return; }
      if (e.key === 'Escape') { e.preventDefault(); setDismissed(true); return; }
    }
    if (paletteOpen) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(items.length - 1, i + 1)); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(0, i - 1)); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); accept(items[active]); return; }
      if (e.key === 'Escape') { e.preventDefault(); setDismissed(true); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const canSend = (!!text.trim() || attachments.length > 0) && !attachments.some((a) => a.uploading);
  const ctx = session.claude?.usage;

  return (
    <TooltipProvider>
    <div
      // bottom padding grows by the home-indicator inset on phones (0 elsewhere)
      className="relative shrink-0 bg-[var(--hb-bg)] px-2.5 pt-1.5 pb-[calc(0.5rem+env(safe-area-inset-bottom,0px))] sm:px-4 sm:pb-[calc(0.75rem+env(safe-area-inset-bottom,0px))]"
      data-composer-footer
      onDragOver={(e) => {
        // Only react to drags this zone can accept — real files or a rail
        // session row. Internal drags (queued-prompt reorder) fall through.
        const types = e.dataTransfer?.types || [];
        const kind = types.includes('application/x-arigami-session')
          ? 'session'
          : types.includes('Files')
            ? 'file'
            : null;
        if (!kind) return;
        e.preventDefault();
        if (!dragging) setDragging(kind);
      }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDragging(false); }}
      onDrop={onDrop}
    >
      <div className="relative mx-auto w-full max-w-3xl">
      {paletteOpen && <SlashPalette items={items} active={active} onPick={accept} onHover={setActive} />}
      {mentionOpen && !paletteOpen && <MentionPalette items={mentionItems} active={active} onPick={acceptMention} onHover={setActive} />}
      {teamOpen && (
        <TeamPanel agents={agents} sessions={sessionsAll} onClose={() => setTeamOpen(false)} onMention={(a) => { setText((t) => (t ? `${t} @${a.slug} ` : `@${a.slug} `)); focusInput(); }} />
      )}
      {panelTab && (
        <CapabilitiesPanel capabilities={caps} session={session} initialTab={panelTab} onClose={() => setPanelTab(null)} onPickCommand={insertCommand} />
      )}
      {dragging && (
        <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-xl border border-dashed border-ring bg-background/85 text-sm font-medium text-foreground">
          {dragging === 'session' ? t('rail.dropReferenceSession') : t('rail.dropFilesToAttach')}
        </div>
      )}

      <PendingPromptsPanel session={session} />

      <div className="flex flex-col rounded-xl border border-input bg-card shadow-card transition-[border-color,box-shadow] focus-within:border-ring focus-within:shadow-[0_0_0_3px_color-mix(in_oklab,var(--ring)_18%,transparent)]">
        {quoted && (
          <div className="flex items-start gap-2 border-b border-border px-3 py-1.5" data-quote-preview>
            <CornerUpLeftIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground rtl:-scale-x-100" />
            <span dir="auto" className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
              {quoted.text.length > 120 ? quoted.text.slice(0, 120) + '…' : quoted.text}
            </span>
            <Button variant="ghost" size="icon-xs" onClick={() => setQuoted(null)} aria-label={t('rail.remove')}>
              <XIcon />
            </Button>
          </div>
        )}

        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-2 px-3 pt-2.5">
            {attachments.map((a, i) => {
              const archiveLike = a.archive || isArchiveName(a.name);
              // ZIP3: a partial extraction (entriesTotal > entryCount, no hard
              // error) must look like a problem, not a quiet success — the bug
              // this fixes was a chip that reported 57/1335 as if nothing had
              // gone wrong.
              const archivePartial = !!(a.archive && !a.archive.error && a.archive.entriesTotal > 0 && a.archive.entriesTotal !== a.archive.entryCount);
              const archiveProblem = !a.uploading && !!(a.failed || (a.archive && (a.archive.error || archivePartial)));
              const AttIcon = archiveLike ? ArchiveIcon : a.type?.startsWith('image/') ? ImageIcon : FileIcon;
              return (
                <div
                  key={i}
                  title={a.archive?.dir || undefined}
                  className={`flex items-center gap-1.5 rounded-md border py-1 pe-1 ps-1.5 ${archiveProblem ? 'border-destructive bg-[var(--hb-err-bg)]' : 'border-border bg-muted/50'}`}
                >
                  {a.type?.startsWith('image/') && a.dataBase64 ? (
                    <img src={`data:${a.type};base64,${a.dataBase64}`} alt="" className="size-6 shrink-0 rounded object-cover" />
                  ) : (
                    <AttIcon className={`size-4 shrink-0 ${archiveProblem ? 'text-destructive' : 'text-muted-foreground'}`} />
                  )}
                  <span className="flex min-w-0 flex-col leading-tight">
                    <bdi dir="ltr" className="max-w-[160px] truncate text-xs text-foreground">{a.name}</bdi>
                    {a.uploading && (
                      <span className="text-2xs text-muted-foreground tabular-nums">{t('rail.attachUploading', { pct: Math.round((a.progress || 0) * 100) })}</span>
                    )}
                    {a.failed && (
                      <span className="max-w-[160px] truncate text-2xs text-destructive">{t('rail.attachUploadFailed', { msg: a.error || '' })}</span>
                    )}
                    {!a.uploading && !a.failed && a.archive && (
                      <span className={`text-2xs ${archiveProblem ? 'text-destructive' : 'text-muted-foreground'}`}>
                        {a.archive.error
                          ? t('rail.archiveExtractFailed')
                          : archivePartial
                            ? t('rail.archivePartial', { n: a.archive.entryCount, total: a.archive.entriesTotal })
                            : a.archive.entryCount === 1
                              ? t('rail.archiveOneEntry')
                              : t('rail.archiveNEntries', { n: a.archive.entryCount })}
                        {a.archive.rejectedCount > 0 && ` · ${t('rail.archiveRejected', { n: a.archive.rejectedCount })}`}
                      </span>
                    )}
                  </span>
                  <Button variant="ghost" size="icon-xs" onClick={() => removeAttachment(i)} aria-label={t('rail.remove')} title={t('rail.remove')} className="hover:text-destructive">
                    <XIcon />
                  </Button>
                </div>
              );
            })}
          </div>
        )}

        <textarea
          ref={taRef}
          data-composer
          rows={1}
          dir={fieldDir(text)}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          placeholder={
            isDesktop
              ? t('rail.replyPlaceholder', { engine: engineLabel(session.engine) })
              : t('rail.replyPlaceholderShort', { engine: engineLabel(session.engine) })
          }
          className="max-h-40 min-h-[2.5rem] w-full min-w-0 resize-none bg-transparent [unicode-bidi:plaintext] px-3.5 pt-3 pb-1 text-[16px] leading-relaxed outline-none placeholder:text-muted-foreground sm:text-[14px] chat-scaled"
          style={{ fieldSizing: 'content' }}
        />

        <div className="flex items-center gap-0.5 px-1.5 pb-1.5">
          <input
            ref={fileRef}
            type="file"
            multiple
            hidden
            onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }}
          />
          <Tip label={t('rail.attachFiles')}>
            <Button variant="ghost" size="icon-sm" data-composer-attach aria-label={t('rail.attachFiles')} onClick={() => fileRef.current?.click()}>
              <PaperclipIcon />
            </Button>
          </Tip>
          <Tip label="@">
            <Button
              variant="ghost"
              size="icon-sm"
              data-composer-mention
              aria-label="@"
              onClick={() => { setText((v) => (v && !/\s$/.test(v) ? `${v} @` : `${v}@`)); focusInput(); }}
            >
              <AtSignIcon />
            </Button>
          </Tip>
          {/* phones: typing "/" opens the same palette — the button isn't worth
              the composer width it costs */}
          <Tip label={t('rail.slashCommandsCapabilities')}>
            <Button variant="ghost" size="icon-sm" data-composer-slash aria-label={t('rail.slashCommandsCapabilities')} onClick={() => setPanelTab('commands')} className="hidden font-mono text-sm sm:inline-flex">
              /
            </Button>
          </Tip>
          <ComposerPill session={session} />
          {ctx?.ctxPct != null && (
            <Tip label={t('rail.context')}>
              <Button variant="ghost" size="xs" data-composer-context onClick={() => setCtxOpen(true)} aria-label={`${t('rail.context')} ${ctx.ctxPct}%`} className="gap-1.5 px-1.5 text-muted-foreground tabular-nums">
                <span aria-hidden="true" className="size-2 rounded-full" style={{ background: contextColor(ctx.ctxPct) }} />
                {ctx.ctxPct}%
              </Button>
            </Tip>
          )}
          <span className="ms-auto flex items-center gap-0.5">
            {working && (
              <Tip label={t('rail.interruptClaude', { engine: engineLabel(session.engine) })} shortcut="Esc">
                <Button variant="outline" size="icon-sm" data-composer-stop aria-label={t('rail.interruptClaude', { engine: engineLabel(session.engine) })} onClick={interrupt} className="text-destructive">
                  <SquareIcon className="size-3.5 fill-current" />
                </Button>
              </Tip>
            )}
            {working && (
              <Tip label={t('rail.queuePendingHint')}>
                <Button variant="ghost" size="icon-sm" data-composer-queue aria-label={t('rail.queuePendingHint')} onClick={queue} disabled={!text.trim()}>
                  <HourglassIcon />
                </Button>
              </Tip>
            )}
            <MicButton mode="dictate" />
            <Tip label={t('rail.send')} shortcut="↵">
              <Button
                variant={canSend ? 'primary' : 'default'}
                size="icon-sm"
                data-composer-send
                aria-label={t('rail.send')}
                onClick={send}
                disabled={!canSend}
                className="ms-1 rounded-lg"
              >
                <ArrowUpIcon />
              </Button>
            </Tip>
          </span>
        </div>
      </div>
      </div>
      {ctxOpen && <ContextModal session={session} usage={ctx} onClose={() => setCtxOpen(false)} />}
    </div>
    </TooltipProvider>
  );
}
