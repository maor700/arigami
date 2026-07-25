// Skills view — a global, app-level surface (replaces `main`, like Settings) for
// browsing + editing the host's own skill pack and seeing how those skills
// relate to the host. Master–detail with a Detail/Edit ↔ Graph toggle on the
// right pane. The graph's surface→skill backbone is curated server-side (always
// correct); an opt-in AI pass adds per-skill summaries and inferred secondary
// edges, clearly marked as suggested.
import { useEffect, useMemo, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import { api } from '../lib/api.js';
import { toastSuccess } from '../lib/toast.js';
import { confirmDialog } from '../lib/confirm.js';
import { useIsDesktop } from '../lib/useMedia.js';
import { Icon } from '../lib/icons.js';
import { faCaretDown, faCaretUp, faXmark } from '@fortawesome/free-solid-svg-icons';

const nsOf = (name) => {
  const i = name.indexOf(':');
  return i >= 0 ? name.slice(0, i) : '(built-in)';
};

/* ---------- left column: host pack + session context ---------------------- */

function SkillList({ skills, selected, onSelect, sessionSkills, sessionTitle, className }) {
  const grouped = useMemo(() => {
    const g = {};
    for (const n of [...(sessionSkills || [])].sort()) (g[nsOf(n)] ||= []).push(n);
    return g;
  }, [sessionSkills]);

  return (
    <div className={`thin-scroll flex shrink-0 flex-col overflow-y-auto bg-panel ${className}`}>
      <div className="px-3 pt-3 pb-1.5 text-[9.5px] font-bold tracking-wide text-fgdim uppercase">
        Host skill pack · {skills.length}
      </div>
      {skills.map((s) => (
        <button
          key={s.name}
          type="button"
          onClick={() => onSelect(s.name)}
          className={`flex flex-col gap-0.5 border-b border-hair px-3 py-2 text-left ${
            selected === s.name ? 'bg-chip' : 'hover:bg-chip/60'
          }`}
        >
          <span className="flex items-center gap-1.5">
            <span className="font-mono text-[11.5px] font-bold text-fg">{s.name}</span>
            {s.files.length > 0 && (
              <span className="rounded-full border border-hair px-1.5 text-[8.5px] text-fgdim">
                +{s.files.length}
              </span>
            )}
          </span>
          {s.description && (
            <span className="line-clamp-2 text-[10.5px] leading-snug text-fgdim">{s.description}</span>
          )}
        </button>
      ))}

      {sessionSkills?.length > 0 && (
        <>
          <div className="px-3 pt-4 pb-1.5 text-[9.5px] font-bold tracking-wide text-fgdim uppercase">
            Also in this session
            {sessionTitle && <span className="font-normal normal-case"> · {sessionTitle}</span>}
          </div>
          <div className="flex flex-col gap-2.5 px-3 pb-4">
            {Object.keys(grouped)
              .sort((a, b) => (a === '(built-in)' ? -1 : b === '(built-in)' ? 1 : a.localeCompare(b)))
              .map((ns) => (
                <div key={ns}>
                  <div className="mb-1 text-[9px] font-bold tracking-wide text-fgdim/80 uppercase">
                    {ns} · {grouped[ns].length}
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {grouped[ns].map((n) => (
                      <span
                        key={n}
                        className="rounded-md border border-hair bg-bg px-1.5 py-0.5 font-mono text-[9.5px] text-fgdim"
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
      <div className="p-6 text-[12px] text-fgdim">
        <div className="mb-2 text-danger">Couldn’t load “{name}”: {loadErr}</div>
        <button
          className="rounded border border-hair px-2 py-1 text-[11px] hover:bg-chip"
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
          Retry
        </button>
      </div>
    );
  if (!detail) return <div className="p-6 text-[12px] text-fgdim">Loading…</div>;

  const save = async () => {
    setSaving(true);
    setErr('');
    try {
      await api.put(`/skills/${name}`, { content: draft });
      setDetail({ ...detail, content: draft });
      setEditing(false);
      toastSuccess(`Saved ${name}/SKILL.md`);
    } catch (e) {
      // server returns 400 with the validation message in the body
      setErr(String(e.message || e).replace(/^HTTP \d+ — /, ''));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-white">
      <div className="flex shrink-0 items-center gap-2 border-b border-hair bg-panel px-4 py-2.5">
        <span className="font-mono text-[13px] font-bold text-fg">{name}</span>
        <span className="font-mono text-[10px] text-fgdim">/SKILL.md</span>
        <div className="ml-auto flex items-center gap-2">
          {editing ? (
            <>
              <button
                type="button"
                onClick={async () => {
                  if (dirty && !(await confirmDialog({ title: 'Discard unsaved changes?', confirmLabel: 'Discard', danger: true }))) return;
                  setEditing(false);
                  setDraft(detail.content);
                  setErr('');
                }}
                className="cursor-pointer rounded-lg border-[1.5px] border-ink bg-panel px-3 py-1 text-[11px] font-bold text-fg hover:bg-chip"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={save}
                disabled={saving || !dirty}
                className="cursor-pointer rounded-lg border-[1.5px] border-ink bg-brand px-3 py-1 text-[11px] font-bold text-fg disabled:cursor-default disabled:opacity-40"
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => { setDraft(detail.content); setEditing(true); }}
              className="cursor-pointer rounded-lg border-[1.5px] border-ink bg-panel px-3 py-1 text-[11px] font-bold text-fg hover:bg-brand"
            >
              Edit
            </button>
          )}
        </div>
      </div>

      {err && (
        <div className="shrink-0 border-b border-[#e2c4c0] bg-[#FBECEA] px-4 py-2 text-[11px] text-[#9c3b33]">
          {err}
        </div>
      )}

      {editing ? (
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          spellCheck={false}
          dir="ltr"
          className="thin-scroll min-h-0 flex-1 resize-none bg-white px-5 py-4 font-mono text-[12px] leading-relaxed text-fg outline-none"
        />
      ) : (
        <div className="thin-scroll min-h-0 flex-1 overflow-y-auto">
          <div className="md-light mx-auto max-w-[820px] px-7 py-6">
            {aiSummary && (
              <div className="mb-4 rounded-lg border border-[#cdb9ea] bg-[#f3eefc] px-3 py-2 text-[11.5px] text-[#5a3aa6]">
                <span className="font-bold">AI summary · </span>
                {aiSummary}
              </div>
            )}
            <Markdown>{detail.content || ''}</Markdown>

            {detail.supporting?.length > 0 && (
              <div className="mt-8 border-t border-hair pt-4">
                <div className="mb-2 text-[9.5px] font-bold tracking-wide text-fgdim uppercase">
                  Supporting files · read-only
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {detail.supporting.map((f) => (
                    <button
                      key={f.name}
                      type="button"
                      onClick={() => setShowFile(showFile?.name === f.name ? null : f)}
                      className={`cursor-pointer rounded-md border px-2 py-1 font-mono text-[10.5px] ${
                        showFile?.name === f.name ? 'border-ink bg-chip text-fg' : 'border-hair text-fgdim hover:border-ink'
                      }`}
                    >
                      {f.name}
                    </button>
                  ))}
                </div>
                {showFile && (
                  <pre className="thin-scroll mt-3 max-h-96 overflow-auto rounded-md border border-hair bg-bg px-3 py-2 font-mono text-[10.5px] leading-relaxed text-fg">
                    {showFile.content ?? `(binary file · ${showFile.size} bytes)`}
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
    <div className="flex min-h-0 flex-1 flex-col bg-white">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-hair bg-panel px-4 py-2.5">
        <span className="text-[11px] text-fgdim">
          <span className="mr-1 inline-block h-2 w-4 rounded-sm bg-[#2a2a2a] align-middle" /> host invokes skill
          <span className="ml-3 mr-1 inline-block h-0 w-4 border-t-2 border-dashed border-[#7a4fc4] align-middle" /> AI-suggested
        </span>
        <div className="ml-auto flex items-center gap-2">
          {analysisMeta?.generatedAt && (
            <span className={`text-[10px] ${analysisMeta.stale ? 'text-[#b8791f]' : 'text-fgdim'}`}>
              {analysisMeta.stale ? 'analysis stale' : 'analyzed'} · {new Date(analysisMeta.generatedAt).toLocaleString()}
            </span>
          )}
          <button
            type="button"
            onClick={onAnalyze}
            disabled={analyzing}
            className="cursor-pointer rounded-lg border-[1.5px] border-ink bg-panel px-3 py-1 text-[11px] font-bold text-fg hover:bg-brand disabled:cursor-default disabled:opacity-50"
          >
            {analyzing ? 'Analyzing…' : analysisMeta?.generatedAt ? 'Refresh AI analysis' : 'Run AI analysis'}
          </button>
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
                  stroke={isAi ? '#7a4fc4' : '#2a2a2a'}
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
              n.kind === 'surface' ? { bg: '#fdf3df', bd: '#caa94e' }
              : n.kind === 'lib' ? { bg: '#eef0f3', bd: '#9aa3ad' }
              : { bg: '#eaf4ef', bd: '#2f9c82' };
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
                  fill={palette.bg}
                  stroke={isSel ? '#2a2a2a' : palette.bd}
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

/* ---------- the view ------------------------------------------------------- */

export default function SkillsView({ session, onClose }) {
  const [data, setData] = useState(null);
  const [selected, setSelected] = useState(null);
  const [mode, setMode] = useState('detail'); // 'detail' | 'graph'
  const desktop = useIsDesktop();
  const [listOpen, setListOpen] = useState(false); // mobile: skill-list sheet
  const [analysisResp, setAnalysisResp] = useState(null); // { analysis, hash, stale }
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeErr, setAnalyzeErr] = useState('');
  const [loadErr, setLoadErr] = useState('');

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
            ? 'Skills API not found — the host server is running older code. Restart it (the routes were just added).'
            : String(e.message || e)
        )
      );
    api.get('/skills/graph').then(setAnalysisResp).catch(() => {});
  }, []);

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
        <div className="max-w-md text-[12.5px] text-[#9c3b33]">{loadErr}</div>
        <button
          type="button"
          onClick={onClose}
          className="cursor-pointer rounded-lg border-[1.5px] border-ink bg-panel px-3 py-1.5 text-[11.5px] font-bold text-fg hover:bg-chip"
        >
          Close
        </button>
      </div>
    );
  if (!data) return <div className="flex flex-1 items-center justify-center text-[12px] text-fgdim">Loading skills…</div>;

  const pick = (name) => {
    setSelected(name);
    setMode('detail');
    if (!desktop) setListOpen(false); // picking from the sheet closes it
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-3 border-b border-hair bg-panel px-4 py-2.5">
        <span className="text-[14px] font-bold text-fg">Skills</span>
        <div className="ml-2 flex overflow-hidden rounded-lg border-[1.5px] border-ink">
          {['detail', 'graph'].map((mItem) => (
            <button
              key={mItem}
              type="button"
              onClick={() => setMode(mItem)}
              className={`cursor-pointer px-3 py-1 text-[11px] font-bold ${
                mode === mItem ? 'bg-brand text-fg' : 'bg-panel text-fgdim hover:bg-chip'
              }`}
            >
              {mItem === 'detail' ? 'Detail / Edit' : 'Graph'}
            </button>
          ))}
        </div>
        {analyzeErr && <span className="text-[10.5px] text-[#9c3b33]">{analyzeErr}</span>}
        <button
          type="button"
          onClick={onClose}
          className="ml-auto flex h-7 w-7 cursor-pointer items-center justify-center rounded-md border border-hair text-fgdim hover:border-ink hover:text-fg"
          title="Close"
        >
          <Icon icon={faXmark} />
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        {/* mobile: the skill list lives behind a toggle sheet (same pattern as
            the Changes tab file list) — a fixed 248px column doesn't fit */}
        {!desktop && (
          <button
            type="button"
            onClick={() => setListOpen((o) => !o)}
            className="flex shrink-0 items-center gap-2 border-b border-hair bg-panel px-3 py-1.5 text-left font-mono text-[11px] text-fgdim"
          >
            <span className="font-bold text-fg">Skills · {data.skills.length}</span>
            <span className="ml-auto truncate">{selected || ''}</span>
            <span className="shrink-0"><Icon icon={listOpen ? faCaretUp : faCaretDown} /></span>
          </button>
        )}
        <SkillList
          skills={data.skills}
          selected={selected}
          onSelect={pick}
          sessionSkills={sessionSkills}
          sessionTitle={session?.title}
          className={desktop ? 'w-[248px] border-r border-hair' : listOpen ? 'max-h-[50vh] w-full border-b border-hair' : 'hidden'}
        />
        {mode === 'detail' ? (
          selected ? (
            <DetailPane key={selected} name={selected} aiSummary={aiSummary} />
          ) : (
            <div className="flex flex-1 items-center justify-center text-[12px] text-fgdim">Select a skill</div>
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
    </div>
  );
}
