// `artifact` chat events (A1): the agent's publish_artifact calls. The host
// snapshotted a static file/folder and serves it at a HOST-RELATIVE path
// (`/__artifacts/<id>/`), so every link here is built from
// window.location.origin — the same card works on the laptop and on a phone
// over VPN. Buttons: open as a session tab (sandboxed iframe), open in a new
// window (feature-flagged until cookie auth, C1, lands), copy the absolute
// link. "Share link" (K2) mints an expiring cookie-less link via
// POST /sessions/:id/artifacts/:aid/share (the token never lives in chat
// history except when publish itself asked for share:true); Revoke = DELETE.
import { useState } from 'react';
import { useT } from '../lib/i18n.js';
import { Icon } from '../lib/icons.js';
import { api } from '../lib/api.js';
import { useStore } from '../lib/store.js';
import { HOST_ORIGIN } from '../lib/hostUrl.js';
import { faCube, faArrowUpRightFromSquare, faLink, faCheck, faTriangleExclamation, faWindowRestore, faShareNodes, faBan } from '@fortawesome/free-solid-svg-icons';

// A share_url is host-relative unless the server has ARIGAMI_PUBLIC_URL; the
// browser always knows its own origin, so show an absolute link either way.
function absolutize(u) {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(u) ? u : `${HOST_ORIGIN}${u}`;
}

function fmtExpiry(iso) {
  try {
    return new Date(iso).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
  } catch {
    return iso;
  }
}

function clock(ts) {
  try {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

export function fmtBytes(n) {
  if (!Number.isFinite(n)) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

export default function ArtifactCard({ sessionId, event }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const [opening, setOpening] = useState(false);
  // K2 share state — seeded from the event when publish had share:true, else
  // created on demand. `share` = { url, exp } | null.
  const [share, setShare] = useState(() => (event.shareUrl ? { url: event.shareUrl, exp: event.shareExp } : null));
  const [shareDays, setShareDays] = useState(7);
  const [shareBusy, setShareBusy] = useState(false);
  const [shareErr, setShareErr] = useState('');
  const [shareCopied, setShareCopied] = useState(false);
  const authMode = useStore((s) => s.config?.auth?.mode);
  // "Open in window" leaves the sandboxed iframe — only offered once the host
  // authenticates requests itself (C1). CSP sandbox headers still apply.
  const canWindow = !!authMode && authMode !== 'off';
  const path = event.path || '';
  const abs = `${HOST_ORIGIN}${path}`;
  const warnings = event.warnings || [];

  const openTab = async () => {
    setOpening(true);
    try {
      await api.post(`/sessions/${encodeURIComponent(sessionId)}/tabs`, { type: 'url', title: event.title, url: path });
    } catch {}
    setOpening(false);
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(abs);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };

  const aid = event.artifactId;
  const shareBase = `/sessions/${encodeURIComponent(sessionId)}/artifacts/${encodeURIComponent(aid || '')}/share`;
  const mintShare = async () => {
    if (!aid) return;
    setShareBusy(true);
    setShareErr('');
    try {
      const r = await api.post(shareBase, { days: shareDays });
      if (r?.error) throw new Error(r.error);
      setShare({ url: r.share_url, exp: r.exp });
    } catch (e) {
      setShareErr(e?.message || t('chat.artifactShareFailed'));
    }
    setShareBusy(false);
  };
  const revokeShare = async () => {
    if (!aid) return;
    setShareBusy(true);
    try {
      await api.del(shareBase);
      setShare(null);
    } catch {}
    setShareBusy(false);
  };
  const copyShare = async () => {
    if (!share) return;
    try {
      await navigator.clipboard.writeText(absolutize(share.url));
      setShareCopied(true);
      setTimeout(() => setShareCopied(false), 1500);
    } catch {}
  };

  const btn = 'inline-flex cursor-pointer items-center gap-1 rounded-[6px] border border-[var(--term-border)] px-2 py-0.5 font-mono text-[10.5px] text-[var(--term-fg)] hover:bg-[var(--term-hover,rgba(127,127,127,0.15))] disabled:opacity-50';

  return (
    <div className="my-2 rounded-[10px] border border-[var(--term-border)] bg-[var(--term-codebg)] p-2.5">
      <div className="flex items-center gap-2 font-mono text-[11px]">
        <span className="text-[var(--term-dim)]"><Icon icon={faCube} /></span>
        <span dir="auto" className="min-w-0 truncate font-bold text-[var(--term-fg)]">{event.title || t('chat.artifact')}</span>
        <span className="shrink-0 text-[10px] text-[var(--term-faint)]">
          v{event.version} · {fmtBytes(event.bytes)} · {t('chat.artifactFiles', { n: event.files })}
        </span>
        <span className="ms-auto shrink-0 text-[10px] text-[var(--term-faint)]">{clock(event.ts)}</span>
      </div>
      <div dir="ltr" className="mt-1 truncate font-mono text-[10px] text-[var(--term-dim)]" title={abs}>{path}</div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <button type="button" className={btn} onClick={openTab} disabled={opening} title={t('chat.artifactOpenTabHint')}>
          <Icon icon={faArrowUpRightFromSquare} /> {t('chat.artifactOpenTab')}
        </button>
        {canWindow && (
          <a href={path} target="_blank" rel="noopener noreferrer" className={btn} title={t('chat.artifactOpenWindowHint')}>
            <Icon icon={faWindowRestore} /> {t('chat.artifactOpenWindow')}
          </a>
        )}
        <button type="button" className={btn} onClick={copy} title={abs}>
          <Icon icon={copied ? faCheck : faLink} /> {copied ? t('chat.copied') : t('chat.artifactCopyLink')}
        </button>
        {canWindow && aid && !share && (
          <span className="inline-flex items-center gap-1">
            <button type="button" className={btn} onClick={mintShare} disabled={shareBusy} title={t('chat.artifactShareHint')}>
              <Icon icon={faShareNodes} /> {t('chat.artifactShare')}
            </button>
            <select
              value={shareDays}
              onChange={(e) => setShareDays(Number(e.target.value))}
              className="rounded-[6px] border border-[var(--term-border)] bg-transparent px-1 py-0.5 font-mono text-[10.5px] text-[var(--term-fg)]"
              aria-label={t('chat.artifactShareDays', { n: shareDays })}
            >
              {[1, 7, 30].map((n) => (
                <option key={n} value={n}>{t('chat.artifactShareDays', { n })}</option>
              ))}
            </select>
          </span>
        )}
      </div>
      {share && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5 rounded-[6px] border border-dashed border-[var(--term-border)] px-2 py-1">
          <span className="text-[var(--term-dim)]"><Icon icon={faShareNodes} /></span>
          <span dir="ltr" className="min-w-0 flex-1 truncate font-mono text-[10px] text-[var(--term-dim)]" title={absolutize(share.url)}>
            {absolutize(share.url)}
          </span>
          {share.exp && (
            <span className="shrink-0 text-[10px] text-[var(--term-faint)]">{t('chat.artifactShareExpires', { when: fmtExpiry(share.exp) })}</span>
          )}
          <button type="button" className={btn} onClick={copyShare} title={t('chat.artifactShareCopy')}>
            <Icon icon={shareCopied ? faCheck : faLink} /> {shareCopied ? t('chat.copied') : t('chat.artifactShareCopy')}
          </button>
          <button type="button" className={btn} onClick={revokeShare} disabled={shareBusy} title={t('chat.artifactShareRevoke')}>
            <Icon icon={faBan} /> {t('chat.artifactShareRevoke')}
          </button>
        </div>
      )}
      {shareErr && <div dir="auto" className="mt-1 text-[10.5px] text-red-500">{shareErr}</div>}
      {warnings.length > 0 && (
        <ul className="mt-1.5 space-y-0.5 text-[10.5px] text-[var(--term-dim)]">
          {warnings.map((w, i) => (
            <li key={i} dir="auto" className="flex gap-1">
              <span className="shrink-0 text-amber-500"><Icon icon={faTriangleExclamation} /></span>
              <span className="min-w-0">{w}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
