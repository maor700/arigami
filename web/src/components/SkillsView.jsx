// Skills view — a global, app-level surface (replaces `main`, like Settings) for
// browsing + editing the host's own skill pack and seeing how those skills
// relate to the host. Master–detail with a Detail/Edit ↔ Graph toggle on the
// right pane. The graph's surface→skill backbone is curated server-side (always
// correct); an opt-in AI pass adds per-skill summaries and inferred secondary
// edges, clearly marked as suggested.
import { useEffect, useMemo, useRef, useState } from 'react';
import Md from './Md.jsx';

// B24: SKILL.md starts with YAML frontmatter (name/description/triggers…) — metadata the
// page already shows in its header, not prose to render as a giant bold paragraph.
export const stripFrontmatter = (s) => String(s || '').replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, '');
import { api } from '../lib/api.js';
import { toastSuccess } from '../lib/toast.js';
import { confirmDialog } from '../lib/confirm.js';
import { useT } from '../lib/i18n.js';
import { useIsDesktop } from '../lib/useMedia.js';
import { Icon } from '../lib/icons.js';
import { faCaretDown, faCaretUp, faXmark } from '@fortawesome/free-solid-svg-icons';
import { DiffView } from './DiffView.jsx';
import { Button } from './ui/button.jsx';
import { Textarea } from './ui/input.jsx';
import { Badge } from './ui/badge.jsx';
import { Tip } from './ui/tooltip.jsx';
import { Tabs, TabsList, TabsTrigger } from './ui/tabs.jsx';

const nsOf = (name) => {
  const i = name.indexOf(':');
  return i >= 0 ? name.slice(0, i) : '(built-in)';
};

/* ---------- left column: host pack + session context ---------------------- */

// F2: where the effective copy lives. `shipped` = git-tracked host pack
// (read-only — saving creates an override copy in $ARIGAMI_DIR/skills);
// `user` = $ARIGAMI_DIR/skills (bundles, applied proposals, edits).
function SourceBadge({ skill, title = false }) {
  const t = useT();
  const user = skill.source === 'user';
  const label = user
    ? skill.overridesShipped ? t('dialogs.skillSourceOverride') : t('dialogs.skillSourceUser')
    : t('dialogs.skillSourceShipped');
  const hint = user ? t('dialogs.skillSourceUserHint') : t('dialogs.skillSourceShippedHint');
  return (
    <Tip label={hint}>
      <span className={title ? undefined : 'ms-auto'}>
        <Badge variant={user ? 'default' : 'outline'}>{label}</Badge>
      </span>
    </Tip>
  );
}

function SkillList({ skills, selected, onSelect, sessionSkills, sessionTitle, className }) {
  const t = useT();
  const grouped = useMemo(() => {
    const g = {};
    for (const n of [...(sessionSkills || [])].sort()) (g[nsOf(n)] ||= []).push(n);
    return g;
  }, [sessionSkills]);

  return (
    <div className={`thin-scroll flex shrink-0 flex-col overflow-y-auto bg-panel ${className}`}>
      <div className="px-3 pt-3 pb-1.5 text-xs font-medium text-fgdim">
        {t('dialogs.hostSkillPack')} · {skills.length}
      </div>
      {skills.map((s) => (
        <button
          key={s.name}
          type="button"
          onClick={() => onSelect(s.name)}
          className={`flex flex-col gap-0.5 border-b border-hair px-3 py-2 text-start ${
            selected === s.name ? 'bg-muted' : 'hover:bg-muted'
          }`}
        >
          <span className="flex items-center gap-1.5">
            <span className="font-mono text-xs font-medium text-fg" dir="ltr">{s.name}</span>
            {s.files.length > 0 && (
              <Badge variant="outline" dir="ltr">+{s.files.length}</Badge>
            )}
            <SourceBadge skill={s} />
          </span>
          {s.description && (
            <span className="line-clamp-2 text-xs leading-snug text-fgdim">{s.description}</span>
          )}
        </button>
      ))}

      {sessionSkills?.length > 0 && (
        <>
          <div className="px-3 pt-4 pb-1.5 text-xs font-medium text-fgdim">
            {t('dialogs.alsoInThisSession')}
            {sessionTitle && <span className="font-normal"> · {sessionTitle}</span>}
          </div>
          <div className="flex flex-col gap-2.5 px-3 pb-4">
            {Object.keys(grouped)
              .sort((a, b) => (a === '(built-in)' ? -1 : b === '(built-in)' ? 1 : a.localeCompare(b)))
              .map((ns) => (
                <div key={ns}>
                  <div className="mb-1 text-xs font-medium text-fgdim">
                    {ns} · {grouped[ns].length}
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {grouped[ns].map((n) => (
                      <span
                        key={n}
                        className="rounded-md border border-hair bg-bg px-1.5 py-0.5 font-mono text-xs text-fgdim"
                      >
                        {n}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
          </div>
        </>
      )}
    </div>
  );
}

/* ---------- right pane: detail + edit ------------------------------------- */

function DetailPane({ name, aiSummary }) {
  const t = useT();
  const [detail, setDetail] = useState(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const [showFile, setShowFile] = useState(null);

  const [loadErr, setLoadErr] = useState('');
  useEffect(() => {
    let dead = false;
    setDetail(null);
    setEditing(false);
    setErr('');
    setLoadErr('');
    setShowFile(null);
    api
      .get(`/skills/${name}`)
      .then((d) => {
        if (dead) return;
        setDetail(d);
        setDraft(d?.content || '');
      })
      .catch((e) => {
        if (!dead) setLoadErr(String(e?.message || e).replace(/^HTTP \d+ — /, ''));
      });
    return () => {
      dead = true;
    };
  }, [name]);

  // Warn before leaving an edit with unsaved changes (within this pane's life).
  const dirty = editing && detail && draft !== detail.content;
  useEffect(() => {
    if (!dirty) return;
    const h = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);

  if (loadErr)
    return (
      <div className="p-6 text-sm text-fgdim">
        <div className="mb-2 text-danger">{t('dialogs.couldntLoadSkill', { name, err: loadErr })}</div>
        <Button
          onClick={() => {
            setLoadErr('');
            api
              .get(`/skills/${name}`)
              .then((d) => {
                setDetail(d);
                setDraft(d?.content || '');
              })
              .catch((e) => setLoadErr(String(e?.message || e).replace(/^HTTP \d+ — /, '')));
          }}
        >
          {t('dialogs.retry')}
        </Button>
      </div>
    );
  if (!detail) return <div className="p-6 text-sm text-fgdim">{t('dialogs.loading')}</div>;

  const save = async () => {
    setSaving(true);
    setErr('');
    try {
      await api.put(`/skills/${name}`, { content: draft });
      setDetail({ ...detail, content: draft });
      setEditing(false);
      toastSuccess(t('dialogs.savedSkill', { name }));
    } catch (e) {
      // server returns 400 with the validation message in the body
      setErr(String(e.message || e).replace(/^HTTP \d+ — /, ''));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-bg">
      <div className="flex shrink-0 items-center gap-2 border-b border-hair bg-panel px-4 py-2.5">
        <span className="font-mono text-sm font-medium text-fg">{name}</span>
        <span className="font-mono text-xs text-fgdim">/SKILL.md</span>
        {detail && <SourceBadge skill={detail} title />}
        <div className="ms-auto flex items-center gap-2">
          {editing ? (
            <>
              <Button
                onClick={async () => {
                  if (dirty && !(await confirmDialog({ title: t('dialogs.discardUnsavedTitle'), confirmLabel: t('dialogs.discard'), danger: true }))) return;
                  setEditing(false);
                  setDraft(detail.content);
                  setErr('');
                }}
              >
                {t('dialogs.cancel')}
              </Button>
              <Button variant="primary" onClick={save} disabled={saving || !dirty}>
                {saving ? t('dialogs.saving') : t('dialogs.save')}
              </Button>
            </>
          ) : (
            <Button onClick={() => { setDraft(detail.content); setEditing(true); }}>
              {t('dialogs.edit')}
            </Button>
          )}
        </div>
      </div>

      {err && (
        <div className="shrink-0 border-b border-err-line bg-err-bg px-4 py-2 text-xs text-err">
          {err}
        </div>
      )}

      {editing ? (
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          spellCheck={false}
          dir="ltr"
          className="thin-scroll min-h-0 flex-1 resize-none rounded-none border-0 bg-bg px-5 py-4 font-mono text-xs leading-relaxed focus-visible:ring-0"
        />
      ) : (
        <div className="thin-scroll min-h-0 flex-1 overflow-y-auto">
          <div className="md-light mx-auto max-w-[820px] px-7 py-6">
            {aiSummary && (
              <div className="mb-4 rounded-lg border border-violet-line bg-violet-bg px-3 py-2 text-xs text-violet">
                <span className="font-medium">{t('dialogs.aiSummaryLabel')}</span>
                {aiSummary}
              </div>
            )}
            <Md>{stripFrontmatter(detail.content)}</Md>

            {detail.supporting?.length > 0 && (
              <div className="mt-8 border-t border-hair pt-4">
                <div className="mb-2 text-xs font-medium tracking-wide text-fgdim uppercase">
                  {t('dialogs.supportingFilesReadOnly')}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {detail.supporting.map((f) => (
                    <button
                      key={f.name}
                      type="button"
                      onClick={() => setShowFile(showFile?.name === f.name ? null : f)}
                      className={`cursor-pointer rounded-md border px-2 py-1 font-mono text-xs coarse:min-h-11 ${
                        showFile?.name === f.name ? 'border-input bg-muted text-fg' : 'border-hair text-fgdim hover:bg-muted'
                      }`}
                      dir="ltr"
                    >
                      {f.name}
                    </button>
                  ))}
                </div>
                {showFile && (
                  <pre className="thin-scroll mt-3 max-h-96 overflow-auto rounded-md border border-hair bg-bg px-3 py-2 font-mono text-xs leading-relaxed text-fg">
                    {showFile.content ?? t('dialogs.binaryFile', { size: showFile.size })}
                  </pre>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------- right pane: graph --------------------------------------------- */

const NW = 150;
const NH = 34;

function buildLayout(data) {
  const nodes = {};
  const COL_L = 96; // left-column center x
  const COL_R = 392; // right-column center x
  const surfaces = data.surfaces || [];
  const skills = data.skills || [];

  surfaces.forEach((s, i) => {
    nodes[s.id] = { id: s.id, x: COL_L, y: 56 + i * 70, w: NW, h: NH, label: s.label, kind: 'surface' };
  });
  skills.forEach((s, i) => {
    nodes[`skill:${s.name}`] = { id: `skill:${s.name}`, x: COL_R, y: 36 + i * 56, w: NW, h: NH, label: s.name, kind: 'skill' };
  });

  const sBottom = surfaces.length ? 56 + (surfaces.length - 1) * 70 : 0;
  const kBottom = skills.length ? 36 + (skills.length - 1) * 56 : 0;
  const bottom = Math.max(sBottom, kBottom);
  if (data.lib) nodes.lib = { id: 'lib', x: (COL_L + COL_R) / 2, y: bottom + 64, w: 96, h: NH, label: '_lib', kind: 'lib' };

  const width = COL_R + NW / 2 + 24;
  const height = bottom + (data.lib ? 64 : 0) + NH + 24;
  return { nodes, width, height };
}

// Anchor on a node's border, in the direction of (tx,ty).
function border(n, tx, ty) {
  const dx = tx - n.x;
  const dy = ty - n.y;
  if (Math.abs(dx) >= Math.abs(dy)) return { x: n.x + Math.sign(dx || 1) * (n.w / 2), y: n.y };
  return { x: n.x, y: n.y + Math.sign(dy || 1) * (n.h / 2) };
}

function edgePath(from, to) {
  // same column (e.g. skill→skill): bow out to the right to avoid the nodes
  if (Math.abs(from.x - to.x) < 6) {
    const ax = from.x + from.w / 2;
    const bx = to.x + to.w / 2;
    const k = Math.max(ax, bx) + 56;
    return `M ${ax} ${from.y} C ${k} ${from.y}, ${k} ${to.y}, ${bx} ${to.y}`;
  }
  const a = border(from, to.x, to.y);
  const b = border(to, from.x, from.y);
  const cx = (a.x + b.x) / 2;
  return `M ${a.x} ${a.y} C ${cx} ${a.y}, ${cx} ${b.y}, ${b.x} ${b.y}`;
}

function GraphPane({ data, analysis, selected, onSelectSkill, onAnalyze, analyzing, analysisMeta }) {
  const t = useT();
  const [hl, setHl] = useState(null); // highlighted node id (surface/lib click)
  const { nodes, width, height } = useMemo(() => buildLayout(data), [data]);

  const edges = useMemo(() => {
    const backbone = (data.backbone || []).map((e) => ({ from: e.from, to: `skill:${e.to}`, label: e.label, kind: 'backbone' }));
    const ai = (analysis?.edges || []).map((e) => ({ ...e, kind: 'ai' }));
    return [...backbone, ...ai].filter((e) => nodes[e.from] && nodes[e.to]);
  }, [data, analysis, nodes]);

  const focus = selected ? `skill:${selected}` : hl;
  const active = useMemo(() => {
    if (!focus) return null;
    const n = new Set([focus]);
    for (const e of edges) if (e.from === focus || e.to === focus) { n.add(e.from); n.add(e.to); }
    return n;
  }, [focus, edges]);

  const dim = (id) => active && !active.has(id);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-bg">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-hair bg-panel px-4 py-2.5">
        <span className="text-xs text-fgdim">
          <span className="me-1 inline-block h-2 w-4 rounded-sm bg-fg align-middle" /> {t('dialogs.hostInvokesSkill')}
          <span className="ms-3 me-1 inline-block h-0 w-4 border-t-2 border-dashed border-[#7a4fc4] align-middle" /> {t('dialogs.aiSuggested')}
        </span>
        <div className="ms-auto flex items-center gap-2">
          {analysisMeta?.generatedAt && (
            <span className={`text-xs ${analysisMeta.stale ? 'text-warn' : 'text-fgdim'}`}>
              {analysisMeta.stale ? t('dialogs.analysisStale') : t('dialogs.analyzed')} · {new Date(analysisMeta.generatedAt).toLocaleString()}
            </span>
          )}
          <Button onClick={onAnalyze} disabled={analyzing}>
            {analyzing ? t('dialogs.analyzing') : analysisMeta?.generatedAt ? t('dialogs.refreshAiAnalysis') : t('dialogs.runAiAnalysis')}
          </Button>
        </div>
      </div>

      <div className="thin-scroll min-h-0 flex-1 overflow-auto p-6">
        <svg width={width} height={height} className="overflow-visible" style={{ minWidth: width }}>
          {edges.map((e, i) => {
            const a = nodes[e.from];
            const b = nodes[e.to];
            const isAi = e.kind === 'ai';
            const lit = active ? active.has(e.from) && active.has(e.to) : true;
            const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
            return (
              <g key={i} opacity={lit ? 1 : 0.12}>
                <path
                  d={edgePath(a, b)}
                  fill="none"
                  stroke={isAi ? '#7a4fc4' : 'var(--color-fg)'}
                  strokeWidth={isAi ? 1.5 : 1.75}
                  strokeDasharray={isAi ? '4 3' : undefined}
                />
                {e.label && lit && focus && (
                  <text x={mid.x} y={mid.y - 3} textAnchor="middle" className="fill-fgdim" style={{ fontSize: 9 }}>
                    {e.label}
                  </text>
                )}
              </g>
            );
          })}

          {Object.values(nodes).map((n) => {
            const isSel = n.id === `skill:${selected}`;
            const palette =
              n.kind === 'surface' ? { bg: 'var(--color-warn-bg)', bd: '#caa94e' }
              : n.kind === 'lib' ? { bg: 'var(--color-panel)', bd: '#9aa3ad' }
              : { bg: 'var(--color-ok-bg)', bd: '#2f9c82' };
            return (
              <g
                key={n.id}
                transform={`translate(${n.x - n.w / 2}, ${n.y - n.h / 2})`}
                opacity={dim(n.id) ? 0.2 : 1}
                style={{ cursor: n.kind === 'skill' ? 'pointer' : 'default' }}
                onClick={() => (n.kind === 'skill' ? onSelectSkill(n.label) : setHl(hl === n.id ? null : n.id))}
              >
                <rect
                  width={n.w}
                  height={n.h}
                  rx={8}
                  style={{ fill: palette.bg, stroke: isSel ? 'var(--color-fg)' : palette.bd }}
                  strokeWidth={isSel ? 2.5 : 1.5}
                />
                <text
                  x={n.w / 2}
                  y={n.h / 2 + 4}
                  textAnchor="middle"
                  className="fill-fg"
                  style={{ fontSize: 11, fontFamily: 'ui-monospace, monospace', fontWeight: n.kind === 'skill' ? 700 : 500 }}
                >
                  {n.label.length > 18 ? n.label.slice(0, 17) + '…' : n.label}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}

/* ---------- right pane: skill proposals (M3) -------------------------------- */
// A staged AI-authored diff against skills/*/SKILL.md (or a brand-new skill),
// never written until a human applies it. Same "clearly AI-inferred" marking
// as the graph pane's AI-edges legend — this whole pane IS the AI-proposed
// content, so the badge is on the tab, not per-item.

const STATUS_CLS = {
  pending: 'text-warn',
  applied: 'text-ok',
  rejected: 'text-fgdim',
  quarantined: 'text-err',
};

function ProposalList({ proposals, selectedId, onSelect, className }) {
  const t = useT();
  return (
    <div className={`thin-scroll flex shrink-0 flex-col overflow-y-auto bg-panel ${className}`}>
      <div className="px-3 pt-3 pb-1.5 text-xs font-medium text-fgdim">
        {t('dialogs.skillProposals')} · {proposals.length}
      </div>
      {proposals.length === 0 && (
        <div className="px-3 py-4 text-xs text-fgdim">{t('dialogs.noProposals')}</div>
      )}
      {proposals.map((p) => (
        <button
          key={p.id}
          type="button"
          onClick={() => onSelect(p.id)}
          className={`flex flex-col gap-0.5 border-b border-hair px-3 py-2 text-start ${
            selectedId === p.id ? 'bg-muted' : 'hover:bg-muted'
          }`}
        >
          <span className="flex items-center gap-1.5">
            <span className="font-mono text-xs font-medium text-fg" dir="ltr">{p.name}</span>
            {p.isNew && (
              <Badge variant="outline">{t('dialogs.newSkillBadge')}</Badge>
            )}
            {p.flags.length > 0 && <Tip label={p.flags.join(', ')}><span className="text-xs text-err">⚠ {p.flags.length}</span></Tip>}
          </span>
          <span className={`text-xs font-medium tracking-normal ${STATUS_CLS[p.status] || 'text-fgdim'}`}>
            {t(`dialogs.proposalStatus.${p.status}`)}
          </span>
          <span className="line-clamp-1 text-xs leading-snug text-fgdim">{p.rationale}</span>
        </button>
      ))}
    </div>
  );
}

function ProposalDetailPane({ id, onDecided, desktop }) {
  const t = useT();
  const [detail, setDetail] = useState(null);
  const [loadErr, setLoadErr] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');

  useEffect(() => {
    let dead = false;
    setDetail(null);
    setLoadErr('');
    setReason('');
    setErr('');
    api
      .get(`/skill-proposals/${id}`)
      .then((d) => { if (!dead) setDetail(d); })
      .catch((e) => { if (!dead) setLoadErr(String(e?.message || e).replace(/^HTTP \d+ — /, '')); });
    return () => { dead = true; };
  }, [id]);

  if (loadErr) return <div className="p-6 text-sm text-err">{loadErr}</div>;
  if (!detail) return <div className="p-6 text-sm text-fgdim">{t('dialogs.loading')}</div>;

  const ACTION_KEYS = {
    apply: { title: 'dialogs.confirmApplyProposalTitle', label: 'dialogs.apply', done: 'dialogs.proposalApplied' },
    reject: { title: 'dialogs.confirmRejectProposalTitle', label: 'dialogs.reject', done: 'dialogs.proposalRejected' },
    quarantine: { title: 'dialogs.confirmQuarantineProposalTitle', label: 'dialogs.quarantine', done: 'dialogs.proposalQuarantined' },
  };

  const decide = async (action) => {
    const keys = ACTION_KEYS[action];
    const ok = await confirmDialog({
      title: t(keys.title, { name: detail.name }),
      confirmLabel: t(keys.label),
      danger: action !== 'apply',
    });
    if (!ok) return;
    setBusy(action);
    setErr('');
    try {
      const updated = await api.post(`/skill-proposals/${id}/${action}`, action === 'apply' ? {} : { reason: reason || undefined });
      toastSuccess(t(keys.done, { name: detail.name }));
      onDecided?.(updated);
    } catch (e) {
      setErr(String(e?.message || e).replace(/^HTTP \d+ — /, ''));
    } finally {
      setBusy('');
    }
  };

  const pending = detail.status === 'pending';

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-bg">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-hair bg-panel px-4 py-2.5">
        <span className="font-mono text-sm font-medium text-fg">{detail.name}</span>
        {detail.isNew && (
          <Badge variant="outline">{t('dialogs.newSkillBadge')}</Badge>
        )}
        <Badge variant="outline">
          {t('dialogs.aiProposed')}
        </Badge>
        <span className={`text-xs font-medium ${STATUS_CLS[detail.status] || 'text-fgdim'}`}>
          {t(`dialogs.proposalStatus.${detail.status}`)}
        </span>
        {pending && (
          <div className="ms-auto flex items-center gap-2">
            <Button variant="destructive" onClick={() => decide('quarantine')} disabled={!!busy}>
              {busy === 'quarantine' ? t('dialogs.quarantining') : t('dialogs.quarantine')}
            </Button>
            <Button onClick={() => decide('reject')} disabled={!!busy}>
              {busy === 'reject' ? t('dialogs.rejecting') : t('dialogs.reject')}
            </Button>
            <Button variant="primary" onClick={() => decide('apply')} disabled={!!busy}>
              {busy === 'apply' ? t('dialogs.applying') : t('dialogs.apply')}
            </Button>
          </div>
        )}
      </div>

      {err && (
        <div className="shrink-0 border-b border-err-line bg-err-bg px-4 py-2 text-xs text-err">{err}</div>
      )}
      {detail.stale && (
        <div className="shrink-0 border-b border-warn-line bg-warn-bg px-4 py-2 text-xs text-warn">
          {t('dialogs.staleProposalWarning')}
        </div>
      )}

      <div className="thin-scroll min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[900px] px-5 py-4">
          <div className="mb-3 text-xs leading-relaxed text-fg">
            <span className="font-medium">{t('dialogs.rationale')}: </span>{detail.rationale}
          </div>
          {detail.evidence && (
            <div className="mb-3 text-xs leading-relaxed text-fgdim">
              <span className="font-medium text-fg">{t('dialogs.evidence')}: </span>{detail.evidence}
            </div>
          )}
          {detail.flags.length > 0 && (
            <div className="mb-3 flex flex-wrap items-center gap-1.5 text-xs">
              <span className="font-medium text-err">{t('dialogs.flags')}:</span>
              {detail.flags.map((f) => (
                <span key={f} className="rounded-md border border-err-line bg-err-bg px-1.5 py-0.5 text-err">{f}</span>
              ))}
            </div>
          )}
          {pending && (
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={t('dialogs.reasonOptional')}
              rows={2}
              className="mb-3 min-h-0 resize-none"
            />
          )}
          {detail.reason && !pending && (
            <div className="mb-3 text-xs text-fgdim">
              <span className="font-medium text-fg">{t('dialogs.reason')}: </span>{detail.reason}
            </div>
          )}
        </div>
        {detail.diff ? (
          <DiffView diff={detail.diff} path={`skills/${detail.name}/SKILL.md`} compact={!desktop} />
        ) : (
          <div className="px-5 pb-4 text-xs text-fgdim">{t('dialogs.noDiff')}</div>
        )}
      </div>
    </div>
  );
}

// Exported so BrainView.jsx (M4) can embed the same pending-proposals queue
// under the Brain tab — spec says "link/wrap the existing tab, don't
// duplicate" (SPEC-ARIGAMI-BRAIN.md M4.1).
export function ProposalsPane({ desktop }) {
  const t = useT();
  const [proposals, setProposals] = useState(null);
  const [selected, setSelected] = useState(null);
  const [loadErr, setLoadErr] = useState('');
  const [listOpen, setListOpen] = useState(false);

  const load = () => {
    api
      .get('/skill-proposals')
      .then((list) => {
        setProposals(list);
        setSelected((cur) => (cur && list.some((p) => p.id === cur) ? cur : list[0]?.id || null));
      })
      .catch((e) => setLoadErr(String(e?.message || e).replace(/^HTTP \d+ — /, '')));
  };
  useEffect(() => { load(); }, []);

  if (loadErr) return <div className="flex-1 p-6 text-sm text-err">{loadErr}</div>;
  if (!proposals) return <div className="flex flex-1 items-center justify-center text-sm text-fgdim">{t('dialogs.loadingProposals')}</div>;

  return (
    <div className="flex min-h-0 flex-1 flex-col md:flex-row">
      {!desktop && (
        <button
          type="button"
          onClick={() => setListOpen((o) => !o)}
          className="flex shrink-0 items-center gap-2 border-b border-hair bg-panel px-3 py-1.5 text-start text-xs text-fgdim coarse:min-h-11"
        >
          <span className="font-medium text-fg">{t('dialogs.skillProposals')} · {proposals.length}</span>
          <span className="ms-auto truncate">{selected || ''}</span>
          <span className="shrink-0"><Icon icon={listOpen ? faCaretUp : faCaretDown} /></span>
        </button>
      )}
      <ProposalList
        proposals={proposals}
        selectedId={selected}
        onSelect={(id) => { setSelected(id); if (!desktop) setListOpen(false); }}
        className={desktop ? 'w-[248px] border-e border-hair' : listOpen ? 'max-h-[50vh] w-full border-b border-hair' : 'hidden'}
      />
      {selected ? (
        <ProposalDetailPane key={selected} id={selected} desktop={desktop} onDecided={load} />
      ) : (
        <div className="flex flex-1 items-center justify-center text-sm text-fgdim">{t('dialogs.selectAProposal')}</div>
      )}
    </div>
  );
}

/* ---------- the view ------------------------------------------------------- */

export default function SkillsView({ session, onClose }) {
  const t = useT();
  const [data, setData] = useState(null);
  const [selected, setSelected] = useState(null);
  const [mode, setMode] = useState('detail'); // 'detail' | 'graph' | 'proposals'
  const desktop = useIsDesktop();
  const [listOpen, setListOpen] = useState(false); // mobile: skill-list sheet
  const [analysisResp, setAnalysisResp] = useState(null); // { analysis, hash, stale }
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeErr, setAnalyzeErr] = useState('');
  const [loadErr, setLoadErr] = useState('');
  const [pendingProposals, setPendingProposals] = useState(0);

  useEffect(() => {
    api
      .get('/skills')
      .then((d) => {
        setData(d);
        setSelected((cur) => cur || d?.skills?.[0]?.name || null);
      })
      .catch((e) =>
        setLoadErr(
          /HTTP 404/.test(String(e.message || e))
            ? t('dialogs.skillsApiNotFound')
            : String(e.message || e)
        )
      );
    api.get('/skills/graph').then(setAnalysisResp).catch(() => {});
  }, []);

  // Refetched whenever the proposals tab is left (a decision there — apply/
  // reject/quarantine — should clear/shrink this badge without a full reload).
  useEffect(() => {
    api
      .get('/skill-proposals')
      .then((list) => setPendingProposals(list.filter((p) => p.status === 'pending').length))
      .catch(() => {});
  }, [mode]);

  const runAnalyze = async () => {
    setAnalyzing(true);
    setAnalyzeErr('');
    try {
      setAnalysisResp(await api.post('/skills/analyze'));
    } catch (e) {
      setAnalyzeErr(String(e.message || e));
    } finally {
      setAnalyzing(false);
    }
  };

  const sessionSkills = session?.claude?.capabilities?.skills || [];
  const analysis = analysisResp?.analysis || null;
  const aiSummary = selected ? analysis?.summaries?.[selected] : null;

  if (loadErr)
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
        <div className="max-w-md text-sm text-err">{loadErr}</div>
        <Button onClick={onClose}>{t('dialogs.close')}</Button>
      </div>
    );
  if (!data) return <div className="flex flex-1 items-center justify-center text-sm text-fgdim">{t('dialogs.loadingSkills')}</div>;

  const pick = (name) => {
    setSelected(name);
    setMode('detail');
    if (!desktop) setListOpen(false); // picking from the sheet closes it
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-3 border-b border-hair bg-panel px-4 py-2.5">
<span className="text-sm font-semibold text-fg">{t('dialogs.skills')}</span>
        <Tabs value={mode} onValueChange={setMode} className="ms-2">
          <TabsList variant="segmented">
            {['detail', 'graph', 'proposals'].map((mItem) => (
              <TabsTrigger key={mItem} value={mItem}>
                {mItem === 'detail' ? t('dialogs.detailEdit') : mItem === 'graph' ? t('dialogs.graph') : t('dialogs.skillProposals')}
                {mItem === 'proposals' && pendingProposals > 0 && (
                  <span className="ms-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-muted-foreground/20 px-1 text-2xs font-medium text-foreground tabular-nums">
                    {pendingProposals}
                  </span>
                )}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        {analyzeErr && <span className="text-xs text-err">{analyzeErr}</span>}
        <Tip label={t('dialogs.close')}>
          <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label={t('dialogs.close')} className="ms-auto">
            <Icon icon={faXmark} />
          </Button>
        </Tip>
      </div>

      {mode === 'proposals' ? (
        <ProposalsPane desktop={desktop} />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          {/* mobile: the skill list lives behind a toggle sheet (same pattern as
              the Changes tab file list) — a fixed 248px column doesn't fit */}
          {!desktop && (
            <button
              type="button"
              onClick={() => setListOpen((o) => !o)}
              className="flex shrink-0 items-center gap-2 border-b border-hair bg-panel px-3 py-1.5 text-start text-xs text-fgdim coarse:min-h-11"
            >
              <span className="font-medium text-fg">{t('dialogs.skills')} · {data.skills.length}</span>
              <span className="ms-auto truncate">{selected || ''}</span>
              <span className="shrink-0"><Icon icon={listOpen ? faCaretUp : faCaretDown} /></span>
            </button>
          )}
          <SkillList
            skills={data.skills}
            selected={selected}
            onSelect={pick}
            sessionSkills={sessionSkills}
            sessionTitle={session?.title}
            className={desktop ? 'w-[248px] border-e border-hair' : listOpen ? 'max-h-[50vh] w-full border-b border-hair' : 'hidden'}
          />
          {mode === 'detail' ? (
            selected ? (
              <DetailPane key={selected} name={selected} aiSummary={aiSummary} />
            ) : (
              <div className="flex flex-1 items-center justify-center text-sm text-fgdim">{t('dialogs.selectASkill')}</div>
            )
          ) : (
            <GraphPane
              data={data}
              analysis={analysis}
              selected={selected}
              onSelectSkill={pick}
              onAnalyze={runAnalyze}
              analyzing={analyzing}
              analysisMeta={analysis ? { generatedAt: analysis.generatedAt, stale: analysisResp?.stale } : null}
            />
          )}
        </div>
      )}
    </div>
  );
}
