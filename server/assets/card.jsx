/** @jsxImportSource preact */
// Ticket card UI — ported from iframe-host-poc/card/index.jsx, mounted by the
// /__ticket/<id> shell (server/pages.js builds this file with Bun.build and
// serves it at /__card.js). Sub-tabs: Details / Comments / GitHub (PR inline).
// Removed vs the PoC: the 💬 Chat tab (the old /__chat relay is replaced by the
// host's session chat) and the /__prefs zoom persistence (zoom is local-only).
import { render } from 'preact';
import { useState, useEffect } from 'preact/hooks';

// The shell sets these on <html data-ticket data-zoom>; the server provides all
// rendered HTML chunks (markdown, diffs) via /__ticket-data so this stays UI-only.
const ID = document.documentElement.dataset.ticket || '';
const PR_REF = document.documentElement.dataset.pr || ''; // "<owner>/<repo>/<num>" → PR-only mode
const ZOOM0 = parseFloat(document.documentElement.dataset.zoom || '1') || 1;
// Best-effort title known before the live Linear fetch resolves (trigger
// snapshot) — shown if that fetch fails instead of a bare "isn't loaded".
const FALLBACK_TITLE = document.documentElement.dataset.fallbackTitle || '';

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
    setD(null);
    fetch(urlPrefix + id)
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

const LinearComment = ({ c }) => (
  <div class={'cmt' + (c.reply ? ' reply' : '')}>
    <div class="chead">
      <span class="cauthor">{c.author}</span>
      <span class="ctime">{c.time}</span>
      {c.resolved && <span class="resolved">resolved</span>}
    </div>
    {c.quotedText && <blockquote class="quote">{c.quotedText}</blockquote>}
    <Html class="cbody" html={c.bodyHtml} />
    {(c.replies || []).map((r) => <LinearComment c={{ ...r, reply: true }} />)}
  </div>
);

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
  const [tab, setTab] = useState(['details', 'comments', 'github'].includes(TAB0) ? TAB0 : 'details');
  if (!d) return <p class="empty" style="padding:20px">Loading {ID}…</p>;
  if (d.error || !d.ticket) return (
    <p class="empty" style="padding:20px">
      <b>{ID}</b>{FALLBACK_TITLE ? <> — {FALLBACK_TITLE}</> : ''} isn't loaded.
      {' '}Live Linear details couldn't be fetched (Linear not connected, or not cached yet).
      {' '}<a href="#" onClick={(e) => { e.preventDefault(); retry(); }}>Retry ↻</a>
    </p>
  );
  const t = d.ticket;
  const tabs = [['details', 'Details'], ['comments', `Comments ${t.comments.length}`], ['github', `GitHub${d.pr ? ' ' + d.pr.stateLabel : ''}`]];
  return (
    <div class="app">
      <div class="head">
        <div class="topbar">
          <div class="id">{t.identifier} · <a href={t.url} target="_blank">Open in Linear ↗</a></div>
          <FontControls />
        </div>
        <h1>{t.title}</h1>
        <div class="metarow"><Pill color={t.statusColor}>{t.status}</Pill>{t.labels.map((l) => <Pill color={l.color}>{l.name}</Pill>)}</div>
        <div class="metarow">{t.meta.map((m) => <span class={m.mono ? 'mono' : ''}>{m.text}</span>)}</div>
        <div class="tabs">{tabs.map(([k, l]) => <div class={'tab' + (tab === k ? ' active' : '')} onClick={() => setTab(k)}>{l}</div>)}</div>
      </div>
      <div class="body">
        {tab === 'details' && (
          <section>
            <Html class="desc" html={t.descriptionHtml} />
            {t.relations.length > 0 && <h4>Relations</h4>}
            {t.relations.map((r) => (
              <div class="rrow"><span class="rlbl">{r.kind}</span><a class="ref" href={r.url} target="_blank"><span class="dot" style={{ background: r.color }} /><b>{r.identifier}</b> {r.title}</a></div>
            ))}
            {t.otherLinksHtml && <Html html={t.otherLinksHtml} />}
          </section>
        )}
        {tab === 'comments' && <section>{t.comments.length ? t.comments.map((c) => <LinearComment c={c} />) : <p class="empty">No comments.</p>}</section>}
        {tab === 'github' && <section><GitHubTab pr={d.pr} ghUrl={t.ghUrl} /></section>}
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

render(PR_REF ? <PrApp /> : <App />, document.getElementById('app'));
