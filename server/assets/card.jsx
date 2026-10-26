/** @jsxImportSource preact */
// Ticket card UI — ported from iframe-host-poc/card/index.jsx, mounted by the
// /__ticket/<id> shell (server/pages.js builds this file with Bun.build and
// serves it at /__card.js). Sub-tabs: Details / Comments / GitHub (PR inline).
// Removed vs the PoC: the 💬 Chat tab (the old /__chat relay is replaced by the
// host's session chat) and the /__prefs zoom persistence (zoom is local-only).
import { render } from 'preact';
import { useState, useEffect, useRef } from 'preact/hooks';

// The shell sets these on <html data-ticket data-zoom>; the server provides all
// rendered HTML chunks (markdown, diffs) via /__ticket-data so this stays UI-only.
const ID = document.documentElement.dataset.ticket || '';
const PR_REF = document.documentElement.dataset.pr || ''; // "<owner>/<repo>/<num>" → PR-only mode
const ZOOM0 = parseFloat(document.documentElement.dataset.zoom || '1') || 1;
// Best-effort title known before the live Linear fetch resolves (trigger
// snapshot) — shown if that fetch fails instead of a bare "isn't loaded".
const FALLBACK_TITLE = document.documentElement.dataset.fallbackTitle || '';

// The cockpit's theme (this page is same-origin: it reads the cockpit's own prefs) — and live, when it changes there.
function applyTheme() {
  let theme = '';
  try { theme = JSON.parse(localStorage.getItem('arigami-prefs') || '{}').theme || ''; } catch {}
  if (theme !== 'light' && theme !== 'dark') theme = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  document.documentElement.dataset.theme = theme;
}
applyTheme();
addEventListener('storage', (e) => { if (!e.key || e.key === 'arigami-prefs') applyTheme(); });
matchMedia('(prefers-color-scheme: light)').addEventListener?.('change', applyTheme);

// Click an image in a description or comment → it opens large, like Linear; Esc or a click outside closes it.
function Lightbox() {
  const [img, setImg] = useState(null);
  useEffect(() => {
    const onClick = (e) => {
      const t = e.target;
      if (t && t.tagName === 'IMG' && t.closest('.desc')) { e.preventDefault(); setImg({ src: t.currentSrc || t.src, alt: t.alt || '' }); }
    };
    const onKey = (e) => { if (e.key === 'Escape') setImg(null); };
    document.addEventListener('click', onClick);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('click', onClick); document.removeEventListener('keydown', onKey); };
  }, []);
  if (!img) return null;
  return (
    <div class="lbox" onClick={() => setImg(null)} role="dialog" aria-label={img.alt}>
      <div class="lbar" onClick={(e) => e.stopPropagation()}>
        <a href={img.src} target="_blank" rel="noopener">Open original ↗</a>
        <button onClick={() => setImg(null)}>✕</button>
      </div>
      <img src={img.src} alt={img.alt} onClick={(e) => e.stopPropagation()} />
      {img.alt && <div class="lcap">{img.alt}</div>}
    </div>
  );
}

const Pill = ({ children, color = '#79c0ff' }) => (
  <span class="pill" style={{ background: color + '22', color, borderColor: color + '55' }}>{children}</span>
);
// server-rendered HTML (markdown/diffs) — kept server-side to reuse proven renderers
const Html = ({ html, class: cls }) => <div class={cls} dangerouslySetInnerHTML={{ __html: html || '' }} />;

function useData(id, urlPrefix = '/__ticket-data/') {
  const [d, setD] = useState(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    if (attempt === 0) setD(null); // a reload after an action keeps the page (and its scroll) until the new data lands
    fetch(urlPrefix + id + (attempt ? `?r=${attempt}` : ''))
      .then((r) => r.json())
      .then((j) => live && setD(j))
      .catch(() => live && setD({ error: true }));
    return () => { live = false; };
  }, [id, attempt]);
  return [d, () => setAttempt((a) => a + 1)];
}

function FontControls() {
  const [z, setZ] = useState(ZOOM0);
  useEffect(() => { document.documentElement.style.zoom = z; }, [z]);
  const step = (d) => setZ(d === 0 ? 1 : Math.max(0.8, Math.min(2, Math.round((z + d * 0.1) * 10) / 10)));
  return (
    <div class="fontctl" title="card font size">
      <button onClick={() => step(-1)}>A−</button>
      <button onClick={() => step(0)}>A</button>
      <button onClick={() => step(1)}>A+</button>
    </div>
  );
}

// ---- the Linear ticket page look ------------------------------------------------------------------------------------
const Avatar = ({ initials, color, size = 22 }) => (
  <span class="av" style={{ background: color || '#5e6ad2', width: size + 'px', height: size + 'px', fontSize: Math.round(size * 0.45) + 'px' }}>{initials || '?'}</span>
);

// Linear's workflow-state glyphs: an empty ring, a half-filled one, a check, a cross.
function StatusIcon({ kind, color }) {
  const c = color || '#8a8f98';
  if (kind === 'completed') return <svg class="ico" viewBox="0 0 14 14"><circle cx="7" cy="7" r="6" fill={c} /><path d="M4.2 7.2l1.9 1.9 3.8-4" stroke="#1b1c1f" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round" /></svg>;
  if (kind === 'canceled') return <svg class="ico" viewBox="0 0 14 14"><circle cx="7" cy="7" r="6" fill={c} /><path d="M5 5l4 4M9 5l-4 4" stroke="#1b1c1f" stroke-width="1.6" stroke-linecap="round" /></svg>;
  if (kind === 'started') return <svg class="ico" viewBox="0 0 14 14"><circle cx="7" cy="7" r="5.5" fill="none" stroke={c} stroke-width="1.5" /><path d="M7 3.5a3.5 3.5 0 0 1 0 7z" fill={c} /></svg>;
  if (kind === 'backlog' || kind === 'triage') return <svg class="ico" viewBox="0 0 14 14"><circle cx="7" cy="7" r="5.5" fill="none" stroke={c} stroke-width="1.5" stroke-dasharray="2 1.6" /></svg>;
  return <svg class="ico" viewBox="0 0 14 14"><circle cx="7" cy="7" r="5.5" fill="none" stroke={c} stroke-width="1.5" /></svg>;
}

// Urgent = an orange square with "!"; high / medium / low = 3 / 2 / 1 lit bars; none = three dashes.
function PriorityIcon({ level }) {
  if (level === 1) return <svg class="ico" viewBox="0 0 14 14"><rect x="1" y="1" width="12" height="12" rx="3" fill="#fc7840" /><path d="M7 3.8v4M7 10v.2" stroke="#1b1c1f" stroke-width="1.8" stroke-linecap="round" /></svg>;
  const lit = level === 2 ? 3 : level === 3 ? 2 : level === 4 ? 1 : 0;
  if (!lit) return <svg class="ico" viewBox="0 0 14 14">{[2, 6, 10].map((x) => <rect x={x} y="6.3" width="2.4" height="1.4" rx=".7" fill="var(--dim)" />)}</svg>;
  return <svg class="ico" viewBox="0 0 14 14">{[0, 1, 2].map((i) => <rect x={1.5 + i * 4} y={9 - i * 3} width="3" height={3 + i * 3} rx="1" fill={i < lit ? 'var(--text)' : 'var(--chip-off)'} />)}</svg>;
}

function Prop({ p, edit }) {
  let v;
  if (p.key === 'status') v = <><StatusIcon kind={p.kind} color={p.color} /><span>{p.value}</span></>;
  else if (p.key === 'priority') v = <><PriorityIcon level={p.level} /><span>{p.value}</span></>;
  else if (p.key === 'assignee') v = p.initials ? <><Avatar initials={p.initials} color={p.avatar} size={18} /><span>{p.value}</span></> : <span class="dim">{p.value}</span>;
  else if (p.key === 'labels') v = <span class="chips">{p.labels.map((l) => <span class="chip"><span class="dot" style={{ background: l.color && l.color !== '#79c0ff' ? l.color : '#8a8f98' }} />{l.name}</span>)}</span>;
  else v = <span class={p.mono ? 'mono' : ''}>{p.value}</span>;
  return (
    <div class="prop">
      <div class="plbl">{p.label}</div>
      <div class={'pval' + (edit ? ' editable' : '')} onClick={edit || undefined} role={edit ? 'button' : undefined} tabIndex={edit ? 0 : undefined}>{v}</div>
    </div>
  );
}

// The sidebar with its pickers. Every change goes to Linear, then the page reloads what Linear now says.
function Props({ t, reload, say }) {
  const [open, setOpen] = useState(null);
  const [search, setSearch] = useState('');
  const [opts, loadOpts] = useOptions(t.team);
  const busy = useRef(false);
  const run = async (patch, label) => {
    if (busy.current) return;
    busy.current = true; setOpen(null); say(`Saving ${label}…`);
    try { await act('update', patch); say(''); reload(); } catch (e) { say(e.message, true); } finally { busy.current = false; }
  };
  const editable = { status: 1, priority: 1, assignee: 1, labels: 1 };
  const openMenu = (key) => () => { setSearch(''); loadOpts(); setOpen(open === key ? null : key); };
  const cur = Object.fromEntries(t.props.map((p) => [p.key, p]));
  const q = search.trim().toLowerCase();
  const list = (items) => (opts?.error ? <div class="mitem dim">{opts.error}</div> : !opts ? <div class="mitem dim">Loading…</div> : items);
  return (
    <>
      {t.props.map((p) => (
        <div class="propwrap">
          <Prop p={p} edit={editable[p.key] ? openMenu(p.key) : null} />
          {open === p.key && p.key === 'status' && (
            <Menu onClose={() => setOpen(null)}>
              {list(opts?.statuses.map((st) => <div class={'mitem' + (st.name === p.value ? ' on' : '')} onClick={() => st.name !== p.value && run({ state: st.name }, 'status')}><StatusIcon kind={st.type} color={st.color || TYPE_COLOR[st.type]} /><span>{st.name}</span></div>))}
            </Menu>
          )}
          {open === p.key && p.key === 'priority' && (
            <Menu onClose={() => setOpen(null)}>
              {PRIORITIES.map(([lv, name]) => <div class={'mitem' + (lv === p.level ? ' on' : '')} onClick={() => lv !== p.level && run({ priority: lv }, 'priority')}><PriorityIcon level={lv} /><span>{name}</span></div>)}
            </Menu>
          )}
          {open === p.key && p.key === 'assignee' && (
            <Menu onClose={() => setOpen(null)} search={search} setSearch={setSearch}>
              <div class="mitem" onClick={() => run({ assignee: null }, 'assignee')}><span class="dim">Unassigned</span></div>
              {list(opts?.users.filter((u) => !q || u.name.toLowerCase().includes(q) || (u.email || '').toLowerCase().includes(q)).slice(0, 60).map((u) => (
                <div class="mitem" onClick={() => run({ assignee: u.id }, 'assignee')}><span>{u.name}</span>{u.email && <span class="dim small">{u.email}</span>}</div>
              )))}
            </Menu>
          )}
          {open === p.key && p.key === 'labels' && (
            <Menu onClose={() => setOpen(null)} search={search} setSearch={setSearch}>
              {list(opts?.labels.filter((l) => !q || l.name.toLowerCase().includes(q)).slice(0, 80).map((l) => {
                const has = (cur.labels?.labels || []).some((x) => x.name === l.name);
                return <div class={'mitem' + (has ? ' on' : '')} onClick={() => run(has ? { removeLabels: [l.name] } : { addLabels: [l.name] }, 'labels')}><span class="dot" style={{ background: l.color || '#8a8f98' }} /><span>{l.name}</span>{has && <span class="check">✓</span>}</div>;
              }))}
            </Menu>
          )}
        </div>
      ))}
      {!cur.labels && (
        <div class="propwrap">
          <Prop p={{ key: 'labels', label: 'Labels', labels: [] }} edit={openMenu('labels-new')} />
          {open === 'labels-new' && (
            <Menu onClose={() => setOpen(null)} search={search} setSearch={setSearch}>
              {list(opts?.labels.filter((l) => !q || l.name.toLowerCase().includes(q)).slice(0, 80).map((l) => <div class="mitem" onClick={() => run({ addLabels: [l.name] }, 'labels')}><span class="dot" style={{ background: l.color || '#8a8f98' }} /><span>{l.name}</span></div>))}
            </Menu>
          )}
        </div>
      )}
    </>
  );
}

// Writing a comment or a reply, with @mention completion from the team's members. Ctrl/⌘+Enter sends.
function Composer({ t, parentId, reload, onDone, say }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [mention, setMention] = useState(null); // {q, start}
  const [opts, loadOpts] = useOptions(t.team);
  const ta = useRef(null);
  const onInput = (e) => {
    const v = e.currentTarget.value;
    setText(v);
    const caret = e.currentTarget.selectionStart;
    const m = /(^|\s)@([\w.-]*)$/.exec(v.slice(0, caret));
    if (m) { loadOpts(); setMention({ q: m[2].toLowerCase(), start: caret - m[2].length - 1 }); } else setMention(null);
  };
  const pick = (u) => {
    const el = ta.current;
    const caret = el.selectionStart;
    const v = text.slice(0, mention.start) + '@' + u.handle + ' ' + text.slice(caret);
    setText(v); setMention(null);
    requestAnimationFrame(() => { el.focus(); const pos = mention.start + u.handle.length + 2; el.setSelectionRange(pos, pos); });
  };
  const send = async () => {
    if (!text.trim() || busy) return;
    setBusy(true); say('Sending…');
    try { await act('comment', { body: text, ...(parentId ? { parentId } : {}) }); setText(''); say(''); onDone?.(); reload(); } catch (e) { say(e.message, true); } finally { setBusy(false); }
  };
  const matches = mention && opts?.users ? opts.users.filter((u) => u.handle.toLowerCase().startsWith(mention.q) || u.name.toLowerCase().includes(mention.q)).slice(0, 8) : [];
  return (
    <div class={'composer' + (parentId ? ' reply' : '')}>
      <textarea ref={ta} value={text} onInput={onInput} rows={parentId ? 2 : 3} placeholder={parentId ? 'Leave a reply…' : 'Leave a comment…'}
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); } if (e.key === 'Escape' && mention) setMention(null); }} />
      {mention && matches.length > 0 && (
        <div class="menu mentions">{matches.map((u) => <div class="mitem" onMouseDown={(e) => { e.preventDefault(); pick(u); }}><span>{u.name}</span><span class="dim small">@{u.handle}</span></div>)}</div>
      )}
      <div class="crow">
        {onDone && <button class="ghost" onClick={onDone}>Cancel</button>}
        <button class="send" disabled={busy || !text.trim()} onClick={send}>{parentId ? 'Reply' : 'Comment'}</button>
      </div>
    </div>
  );
}

function Comment({ c, reply }) {
  return (
    <div class={'lc' + (reply ? ' reply' : '')}>
      <div class="lc-head">
        <Avatar initials={c.initials} color={c.avatar} size={reply ? 20 : 22} />
        <span class="lc-author">{c.author}</span>
        <span class="lc-time" title={c.at}>{c.time}</span>
        {c.resolved && <span class="resolved">Resolved</span>}
      </div>
      {c.quotedText && <blockquote class="quote">{c.quotedText}</blockquote>}
      <Html class="lc-body desc" html={c.bodyHtml} />
    </div>
  );
}

function Thread({ c, t, reload, say }) {
  const [replying, setReplying] = useState(false);
  return (
    <div class="thread">
      <Comment c={c} />
      {(c.replies || []).map((r) => <Comment c={r} reply />)}
      {c.id && (replying
        ? <Composer t={t} parentId={c.id} reload={reload} say={say} onDone={() => setReplying(false)} />
        : <div class="replyrow"><button class="ghost" onClick={() => setReplying(true)}>Reply</button></div>)}
    </div>
  );
}

const LINK_ICON = { pr: '⑂', sentry: '◆', link: '↗' };

// ---- acting on the issue (owner only: /__api/linear/issues/:id/*, same-origin cookie) ---------------------------------
async function act(path, body) {
  const r = await fetch(`/__api/linear/issues/${encodeURIComponent(ID)}/${path}`, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}
let optionsCache = null;
function useOptions(team) {
  const [o, setO] = useState(optionsCache);
  // one fetch per page, shared by the sidebar and every composer
  const load = () => {
    if (!team) return;
    if (!optionsCache) {
      optionsCache = act(`options?team=${encodeURIComponent(team)}`).catch((e) => ({ error: e.message }));
      optionsCache.then((v) => { optionsCache = v; });
    }
    Promise.resolve(optionsCache).then(setO);
  };
  useEffect(() => { if (optionsCache && !(optionsCache instanceof Promise)) setO(optionsCache); }, []);
  return [o instanceof Promise ? null : o, load];
}

// A small menu anchored under a property; closes on a click outside or Esc.
function Menu({ onClose, children, search, setSearch }) {
  const ref = useRef(null);
  useEffect(() => {
    const out = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
    const esc = (e) => { if (e.key === 'Escape') onClose(); };
    setTimeout(() => document.addEventListener('mousedown', out), 0);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', out); document.removeEventListener('keydown', esc); };
  }, []);
  return (
    <div class="menu" ref={ref}>
      {setSearch && <input class="msearch" autoFocus placeholder="Search…" value={search} onInput={(e) => setSearch(e.currentTarget.value)} />}
      <div class="mlist">{children}</div>
    </div>
  );
}
const TYPE_COLOR = { triage: '#fc7840', backlog: '#bec2c8', unstarted: '#e2e2e2', started: '#f2c94c', completed: '#5e6ad2', canceled: '#95a2b3' };
const PRIORITIES = [[0, 'No priority'], [1, 'Urgent'], [2, 'High'], [3, 'Medium'], [4, 'Low']];

function GitHubTab({ pr, ghUrl }) {
  const [sub, setSub] = useState('ov');
  if (!pr) return ghUrl
    ? <p class="empty">Couldn't load the PR (is <code>gh</code> authed?). <a href={ghUrl} target="_blank">Open on GitHub ↗</a></p>
    : <p class="empty">No linked PR.</p>;
  const subs = [['ov', 'Overview'], ['files', `Files ${pr.files.length}`], ['conv', `Comments ${pr.comments.length}`]];
  return (
    <div>
      <div class="metarow">
        <Pill color={pr.stateColor}>{pr.stateLabel}</Pill>
        {pr.review && <Pill color={pr.reviewColor}>{pr.review}</Pill>}
        {pr.checks && <Pill color={pr.checks.color}>{pr.checks.label}</Pill>}
        <a href={pr.url} target="_blank">GitHub ↗</a>
      </div>
      <div class="metarow mono">
        {pr.baseRefName} ← {pr.headRefName} · <span style="color:#3fb950">+{pr.additions}</span> <span style="color:#f85149">−{pr.deletions}</span> · {pr.changedFiles} files
      </div>
      <div class="gtabs">
        {subs.map(([k, l]) => <div class={'gtab' + (sub === k ? ' active' : '')} onClick={() => setSub(k)}>{l}</div>)}
      </div>
      {sub === 'ov' && <Html class="desc" html={pr.bodyHtml} />}
      {sub === 'files' && (pr.files.length
        ? pr.files.map((f) => (
            <details class="file" open={f.comments && f.comments.length > 0}>
              <summary><span class="fp">{f.name}</span><span class="fd">{f.comments && f.comments.length > 0 && <span class="fcct">💬 {f.comments.length}</span>} <span style="color:#3fb950">+{f.additions}</span> <span style="color:#f85149">−{f.deletions}</span></span></summary>
              <Html html={f.diffHtml} />
              {f.comments && f.comments.length > 0 && (
                <div class="filecmts">
                  {f.comments.map((c) => (
                    <div class="filecmt">
                      <div class="chead"><span class="cauthor">@{c.author}</span>{c.line && <span class="cloc">line {c.line}</span>}<span class="ctime">{c.time}</span></div>
                      <Html class="cbody" html={c.bodyHtml} />
                    </div>
                  ))}
                </div>
              )}
            </details>
          ))
        : <p class="empty">No files.</p>)}
      {sub === 'conv' && (pr.comments.length
        ? pr.comments.map((c) => (
            <div class="cmt">
              <div class="chead"><span class="cauthor">@{c.author}</span>{c.state && <Pill color={c.stateColor}>{c.state}</Pill>}{c.loc && <span class="cloc">{c.loc}</span>}<span class="ctime">{c.time}</span></div>
              {c.codeHtml && <Html html={c.codeHtml} />}
              <Html class="cbody" html={c.bodyHtml} />
            </div>
          ))
        : <p class="empty">No PR comments.</p>)}
    </div>
  );
}

const TAB0 = document.documentElement.dataset.tab;
function App() {
  const [d, retry] = useData(ID);
  const [tab, setTab] = useState(TAB0 === 'github' ? 'github' : 'activity');
  const [note, setNote] = useState(null); // {text, err}
  const say = (text, err) => setNote(text ? { text, err } : null);
  if (!d) return <p class="empty" style="padding:24px">Loading {ID}…</p>;
  if (d.error || !d.ticket) return (
    <p class="empty" style="padding:24px">
      <b>{ID}</b>{FALLBACK_TITLE ? <> — {FALLBACK_TITLE}</> : ''} isn't loaded.
      {' '}Live Linear details couldn't be fetched (Linear not connected, or not cached yet).
      {' '}<a href="#" onClick={(e) => { e.preventDefault(); retry(); }}>Retry ↻</a>
    </p>
  );
  const t = d.ticket;
  const count = t.comments.reduce((n, c) => n + 1 + (c.replies || []).length, 0);
  const hasGh = !!(d.pr || t.ghUrl);
  return (
    <div class="lin">
      <div class="lin-top">
        <div class="crumb">{t.team && <><span>{t.team}</span><span class="sep">›</span></>}<span class="mono">{t.identifier}</span></div>
        <div class="topr">
          <a class="open" href={t.url} target="_blank">Open in Linear ↗</a>
          <FontControls />
        </div>
      </div>
      {note && <div class={'note' + (note.err ? ' err' : '')} onClick={() => setNote(null)}>{note.text}</div>}
      <div class="lin-body">
        <main class="lin-main">
          <h1 class="lin-title">{t.title}</h1>
          <Html class="desc lin-desc" html={t.descriptionHtml} />
          {t.relations.length > 0 && (
            <div class="lin-sec">
              <div class="sec-h">Relations</div>
              {t.relations.map((r) => (
                <a class="rel" href={r.url} target="_blank"><span class="rlbl">{r.kind}</span><span class="dot" style={{ background: r.color }} /><b class="mono">{r.identifier}</b><span class="rtitle">{r.title}</span></a>
              ))}
            </div>
          )}
          <div class="lin-tabs">
            <div class={'lt' + (tab === 'activity' ? ' on' : '')} onClick={() => setTab('activity')}>Activity{count ? <span class="cnt">{count}</span> : ''}</div>
            {hasGh && <div class={'lt' + (tab === 'github' ? ' on' : '')} onClick={() => setTab('github')}>GitHub{d.pr ? <span class="cnt">{d.pr.stateLabel}</span> : ''}</div>}
          </div>
          {tab === 'activity' && (
            <>
              {t.comments.length ? t.comments.map((c) => <Thread c={c} t={t} reload={retry} say={say} />) : <p class="empty">No comments yet.</p>}
              <Composer t={t} reload={retry} say={say} />
            </>
          )}
          {tab === 'github' && <GitHubTab pr={d.pr} ghUrl={t.ghUrl} />}
        </main>
        <aside class="lin-side">
          <Props t={t} reload={retry} say={say} />
          {t.links.length > 0 && (
            <div class="side-sec">
              <div class="plbl">Links</div>
              {t.links.map((l) => <a class="slink" href={l.url} target="_blank" title={l.url}><span class="li">{LINK_ICON[l.kind]}</span><span class="lt2">{l.title}</span></a>)}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

// PR-only mode for the standalone /__pr/<owner>/<repo>/<num> page.
function PrApp() {
  const [d, retry] = useData(PR_REF, '/__pr-data/');
  if (!d) return <p class="empty" style="padding:20px">Loading {PR_REF}…</p>;
  if (d.error || !d.pr) return (
    <p class="empty" style="padding:20px">
      <b>{PR_REF}</b> couldn't be loaded — is <code>gh</code> authenticated?
      {' '}<a href="#" onClick={(e) => { e.preventDefault(); retry(); }}>Retry ↻</a>
    </p>
  );
  const pr = d.pr;
  return (
    <div class="app">
      <div class="head">
        <div class="topbar">
          <div class="id">{PR_REF.split('/').slice(0, 2).join('/')}#{pr.number} · <a href={pr.url} target="_blank">Open on GitHub ↗</a></div>
          <FontControls />
        </div>
      </div>
      <div class="body"><section><GitHubTab pr={pr} ghUrl={pr.url} /></section></div>
    </div>
  );
}

render(<>{PR_REF ? <PrApp /> : <App />}<Lightbox /></>, document.getElementById('app'));
