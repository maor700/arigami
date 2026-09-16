// Review-comment primitives (GitHub-PR style). Bodies render with the comment's
// own dir (the explain/review skill can send 'rtl'/'ltr'); default 'auto' detects.
// Supports: edit, reply (threaded), resolve, delete, and auto-review "suggestion"
// comments that can be accepted (→ a normal pending comment) or rejected (deleted).
import { useState } from 'react';
import { Icon } from '../lib/icons.js';
import { useT } from '../lib/i18n.js';
import { faCheck, faWandMagicSparkles, faXmark } from '@fortawesome/free-solid-svg-icons';

const ACTION_BTN = 'cursor-pointer font-mono text-[11px] md:text-[9.5px] text-fgdim hover:text-fg';

function Reply({ reply, onEdit, onDelete }) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  if (editing) {
    return (
      <CommentComposer
        initial={reply.body}
        submitLabel={t('chat.save')}
        placeholder={t('chat.editReply')}
        autoFocus
        onSubmit={(t) => { onEdit(reply.id, t); setEditing(false); }}
        onCancel={() => setEditing(false)}
      />
    );
  }
  return (
    <div className="rounded-md border border-hair/70 bg-bg/60 px-2.5 py-1.5">
      <div className="mb-0.5 flex items-center gap-1.5">
        <span className="font-mono text-[8.5px] font-bold tracking-wide text-fgdim uppercase">↳ {t('chat.reply')}</span>
        <div className="ml-auto flex items-center gap-2">
          {onEdit && <button type="button" onClick={() => setEditing(true)} className={ACTION_BTN}>{t('chat.edit')}</button>}
          {onDelete && <button type="button" onClick={() => onDelete(reply.id)} className="cursor-pointer text-[11.5px] md:text-[10px] text-fgdim hover:text-danger"><Icon icon={faXmark} /></button>}
        </div>
      </div>
      <div dir={reply.dir || 'auto'} className="whitespace-pre-wrap text-[11px] leading-snug text-fg">{reply.body}</div>
    </div>
  );
}

export function CommentItem({ comment, onDelete, onResolve, onEdit, onReply, onAccept, onReject, onEditReply, onDeleteReply }) {
  const t = useT();
  const resolved = !!comment.resolved;
  const suggested = !!comment.suggested;
  const [editing, setEditing] = useState(false);
  const [replying, setReplying] = useState(false);
  const replies = comment.replies || [];

  const border = suggested
    ? 'border-[#cdbb66] bg-[#fffdf2]'
    : resolved
      ? 'border-hair/60 bg-bg/40'
      : 'border-hair bg-bg';

  return (
    <div className={`rounded-md border px-2.5 py-1.5 ${border}`}>
      <div className="mb-0.5 flex items-center gap-1.5">
        <span className={`font-mono text-[11px] md:text-[9px] font-bold tracking-wide uppercase ${suggested ? 'text-[#8a6d1f]' : 'text-fgdim'}`}>
          {suggested ? <><Icon icon={faWandMagicSparkles} /> {t('chat.suggestion')}</> : t('chat.you')}
        </span>
        {resolved && (
          <span className="rounded-full bg-[#3C9A4E]/15 px-1.5 font-mono text-[8.5px] font-bold tracking-wide text-[#3C9A4E] uppercase">
            <Icon icon={faCheck} /> {t('chat.resolved')}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {/* edit + reply are available on every comment, suggestion or not */}
          {onEdit && !editing && <button type="button" onClick={() => setEditing(true)} className={ACTION_BTN}>{t('chat.edit')}</button>}
          {onReply && <button type="button" onClick={() => setReplying((v) => !v)} className={ACTION_BTN}>{t('chat.reply')}</button>}
          {suggested ? (
            // a suggestion additionally offers accept (→ real comment) / reject (discard)
            <>
              {onAccept && <button type="button" onClick={() => onAccept(comment.id)} title={t('chat.acceptTitle')} className="cursor-pointer font-mono text-[11px] md:text-[9.5px] font-bold text-[#3C9A4E] hover:underline">{t('chat.accept')}</button>}
              {onReject && <button type="button" onClick={() => onReject(comment.id)} title={t('chat.rejectTitle')} className="cursor-pointer font-mono text-[11px] md:text-[9.5px] text-fgdim hover:text-danger">{t('chat.reject')}</button>}
            </>
          ) : (
            <>
              {onResolve && (
                <button type="button" onClick={() => onResolve(comment.id, !resolved)} title={resolved ? t('chat.reopenTitle') : t('chat.resolveTitle')} className="cursor-pointer font-mono text-[11px] md:text-[9.5px] text-fgdim hover:text-[#3C9A4E]">
                  {resolved ? t('chat.reopen') : t('chat.resolve')}
                </button>
              )}
              {onDelete && <button type="button" onClick={() => onDelete(comment.id)} title={t('chat.deleteComment')} className="cursor-pointer text-[11.5px] md:text-[10px] text-fgdim hover:text-danger"><Icon icon={faXmark} /></button>}
            </>
          )}
        </div>
      </div>

      {editing ? (
        <CommentComposer
          initial={comment.body}
          submitLabel={t('chat.save')}
          placeholder={t('chat.editComment')}
          autoFocus
          onSubmit={(t) => { onEdit(comment.id, t); setEditing(false); }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <div
          dir={comment.dir || 'auto'}
          className={`whitespace-pre-wrap text-[11.5px] leading-snug ${
            resolved
              ? 'text-fgdim line-through decoration-fgdim/50'
              : // A suggestion card hardcodes a near-white background
                // (bg-[#fffdf2]) in BOTH themes, so its text has to be
                // hardcoded dark too. `text-fg` is a theme token — light in
                // dark mode — which put light text on a near-white card and
                // made every suggestion unreadable for anyone in the dark
                // theme. The header beside it was already hardcoded (#8a6d1f);
                // only the body was left following the theme.
                suggested
                ? 'text-[#3a3426]'
                : 'text-fg'
          }`}
        >
          {comment.body}
        </div>
      )}

      {(replies.length > 0 || replying) && (
        <div className="mt-1.5 flex flex-col gap-1.5 border-l-2 border-hair pl-2">
          {replies.map((r) => (
            <Reply
              key={r.id}
              reply={r}
              onEdit={onEditReply ? (rid, body) => onEditReply(comment.id, rid, body) : null}
              onDelete={onDeleteReply ? (rid) => onDeleteReply(comment.id, rid) : null}
            />
          ))}
          {replying && (
            <CommentComposer
              placeholder={t('chat.replyPlaceholder')}
              submitLabel={t('chat.replySubmit')}
              autoFocus
              onSubmit={(t) => { onReply(comment.id, t); setReplying(false); }}
              onCancel={() => setReplying(false)}
            />
          )}
        </div>
      )}
    </div>
  );
}

export function CommentComposer({ onSubmit, onCancel, placeholder, autoFocus, initial = '', submitLabel }) {
  const t = useT();
  const ph = placeholder ?? t('chat.leaveComment');
  const label = submitLabel ?? t('chat.comment');
  const [text, setText] = useState(initial);
  const submit = () => {
    const t = text.trim();
    if (!t) return;
    onSubmit(t);
    if (!initial) setText('');
  };
  return (
    <div className="rounded-md border-[1.5px] border-border bg-bg p-2">
      <textarea
        autoFocus={autoFocus}
        dir="auto"
        rows={2}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); }
          else if (e.key === 'Escape' && onCancel) { e.preventDefault(); onCancel(); }
        }}
        placeholder={ph}
        className="w-full resize-none bg-transparent text-[11.5px] leading-snug outline-none placeholder:text-fgdim"
      />
      <div className="mt-1 flex items-center gap-2">
        <button
          type="button"
          onClick={submit}
          disabled={!text.trim()}
          className="cursor-pointer rounded-md border-[1.5px] border-ink bg-brand px-2.5 py-0.5 text-[11.5px] md:text-[10.5px] font-bold text-[#1a1a1a] disabled:cursor-default disabled:opacity-40"
        >
          {label}
        </button>
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="cursor-pointer rounded-md border border-hair px-2 py-0.5 text-[11.5px] md:text-[10.5px] text-fgdim hover:text-fg"
          >
            {t('chat.cancel')}
          </button>
        )}
        {/* ⌘↵ — nothing to press on a phone, and `ml-auto` was physical in RTL */}
        <span className="ms-auto hidden font-mono text-[11px] md:text-[9px] text-fgdim [@media(pointer:fine)]:inline">
          {t('chat.saveHint')}
        </span>
      </div>
    </div>
  );
}

export function CommentThread({ comments, ...handlers }) {
  if (!comments?.length) return null;
  return (
    <div className="flex flex-col gap-1.5">
      {comments.map((c) => (
        <CommentItem key={c.id} comment={c} {...handlers} />
      ))}
    </div>
  );
}
