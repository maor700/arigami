// Review-comment primitives (GitHub-PR style). Bodies render with the comment's
// own dir (the explain/review skill can send 'rtl'/'ltr'); default 'auto' detects.
// Supports: edit, reply (threaded), resolve, delete, and auto-review "suggestion"
// comments that can be accepted (→ a normal pending comment) or rejected (deleted).
import { useState } from 'react';
import { CheckIcon, CornerDownRightIcon, SparklesIcon, XIcon } from 'lucide-react';
import { useT } from '../lib/i18n.js';
import { Button, Badge, Textarea, Tip } from './ui/index.js';

// quiet text actions — neutral until hovered; 44px on a finger
const ACTION_BTN = 'h-auto min-h-0 px-1.5 py-0.5 text-2xs coarse:min-h-11 coarse:px-2.5 coarse:text-xs';

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
    <div className="py-0.5">
      <div className="mb-0.5 flex items-center gap-1">
        <span className="flex items-center gap-1 text-2xs font-medium text-muted-foreground">
          <CornerDownRightIcon className="size-3 rtl:-scale-x-100" /> {t('chat.reply')}
        </span>
        <div className="ms-auto flex items-center">
          {onEdit && <Button variant="ghost" size="xs" className={ACTION_BTN} onClick={() => setEditing(true)}>{t('chat.edit')}</Button>}
          {onDelete && (
            <Tip label={t('chat.deleteComment')}>
              <Button variant="ghost" size="icon-xs" aria-label={t('chat.deleteComment')} className="hover:text-destructive" onClick={() => onDelete(reply.id)}>
                <XIcon className="size-3" />
              </Button>
            </Tip>
          )}
        </div>
      </div>
      <div dir={reply.dir || 'auto'} className="text-sm leading-snug whitespace-pre-wrap text-foreground">{reply.body}</div>
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

  return (
    <div
      className={`rounded-lg border px-3 py-2 ${resolved ? 'border-border/60 bg-card/50' : 'border-border bg-card'}`}
      data-comment={suggested ? 'suggestion' : resolved ? 'resolved' : 'open'}
    >
      <div className="mb-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
        {suggested ? (
          <Badge status="violet"><SparklesIcon /> {t('chat.suggestion')}</Badge>
        ) : (
          <span className="text-xs font-medium text-foreground">{t('chat.you')}</span>
        )}
        {resolved && <Badge status="ok"><CheckIcon /> {t('chat.resolved')}</Badge>}
        <div className="ms-auto flex flex-wrap items-center">
          {/* edit + reply are available on every comment, suggestion or not */}
          {onEdit && !editing && <Button variant="ghost" size="xs" className={ACTION_BTN} onClick={() => setEditing(true)}>{t('chat.edit')}</Button>}
          {onReply && <Button variant="ghost" size="xs" className={ACTION_BTN} onClick={() => setReplying((v) => !v)}>{t('chat.reply')}</Button>}
          {suggested ? (
            // a suggestion additionally offers accept (→ real comment) / reject (discard)
            <>
              {onAccept && <Button variant="ghost" size="xs" className={`${ACTION_BTN} text-foreground`} title={t('chat.acceptTitle')} onClick={() => onAccept(comment.id)}>{t('chat.accept')}</Button>}
              {onReject && <Button variant="ghost" size="xs" className={ACTION_BTN} title={t('chat.rejectTitle')} onClick={() => onReject(comment.id)}>{t('chat.reject')}</Button>}
            </>
          ) : (
            <>
              {onResolve && (
                <Button variant="ghost" size="xs" className={ACTION_BTN} title={resolved ? t('chat.reopenTitle') : t('chat.resolveTitle')} onClick={() => onResolve(comment.id, !resolved)}>
                  {resolved ? t('chat.reopen') : t('chat.resolve')}
                </Button>
              )}
              {onDelete && (
                <Tip label={t('chat.deleteComment')}>
                  <Button variant="ghost" size="icon-xs" aria-label={t('chat.deleteComment')} className="hover:text-destructive" onClick={() => onDelete(comment.id)}>
                    <XIcon className="size-3" />
                  </Button>
                </Tip>
              )}
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
          className={`text-sm leading-snug whitespace-pre-wrap ${resolved ? 'text-muted-foreground line-through decoration-muted-foreground/50' : 'text-foreground'}`}
        >
          {comment.body}
        </div>
      )}

      {(replies.length > 0 || replying) && (
        <div className="mt-2 flex flex-col gap-1.5 border-s border-border ps-3">
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
    <div className="rounded-lg border border-border bg-background p-2 focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/35">
      <Textarea
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
        className="min-h-0 resize-none border-0 bg-transparent p-1 text-sm leading-snug focus-visible:ring-0"
      />
      <div className="mt-1 flex items-center gap-1.5">
        {/* one primary per view lives in the review bar; submitting a comment is a neutral action */}
        <Button size="sm" onClick={submit} disabled={!text.trim()}>{label}</Button>
        {onCancel && <Button size="sm" variant="ghost" onClick={onCancel}>{t('chat.cancel')}</Button>}
        {/* ⌘↵ — nothing to press on a phone, and `ml-auto` was physical in RTL */}
        <span className="ms-auto hidden text-2xs text-muted-foreground [@media(pointer:fine)]:inline">
          {t('chat.saveHint')}
        </span>
      </div>
    </div>
  );
}

export function CommentThread({ comments, ...handlers }) {
  if (!comments?.length) return null;
  return (
    <div className="flex flex-col gap-2">
      {comments.map((c) => (
        <CommentItem key={c.id} comment={c} {...handlers} />
      ))}
    </div>
  );
}
