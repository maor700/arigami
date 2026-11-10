// CONSOL1 — memory consolidation ("dreaming"): a reviewable diff over the
// EXISTING USER.md/MEMORY.md lines once the files are at their cap, hash-checked
// writes, per-line provenance, and the learning loop no longer re-asking the
// model every tick while nothing can move. Pure parts in-process; everything
// touching disk runs in a fresh child with its own ARIGAMI_DIR and a stub LLM.
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { runInChild } from './_child.js';
import { tmpDir } from './_tmp.js';
import {
  numberLines,
  parseConsolidation,
  planConsolidation,
  simulateConsolidation,
  learnSignature,
  isoWeek,
  episodeDate,
  planEpisodeDigest,
  planPendingCompaction,
  buildConsolidationPrompt,
} from '../server/lib/memory-consolidate.ts';

const tmp = () => tmpDir('arigami-consol-');
const est = (s) => Math.ceil((s || '').length / 4);

const USER = '- Replies in Hebrew, short.\n- - Never merge PRs; the owner merges.\n';
const MEM = [
  '- GitHub API rate limit is shared across all sessions; keep gh calls minimal.',
  '- The GitHub API rate limit is shared by all sessions, so keep gh calls minimal and use GraphQL when REST runs out.',
  '- Toast audit found 101 call sites across 35 files.',
  '- Login ladder: MCP first, then request_login, then shared Chrome.',
].join('\n') + '\n';

// ---- pure ---------------------------------------------------------------------------

test('numberLines numbers bullets per file and strips doubled "- - " bullets', () => {
  const ls = numberLines(USER, MEM);
  expect(ls.map((l) => l.id)).toEqual(['U1', 'U2', 'M1', 'M2', 'M3', 'M4']);
  expect(ls[1].text).toBe('Never merge PRs; the owner merges.');
  expect(ls[1].raw).toBe('- - Never merge PRs; the owner merges.');
});

test('parseConsolidation refuses unknown ids, cross-file merges, single-line merges, reused lines and empty rewrites', () => {
  const ls = numberLines(USER, MEM);
  const text = JSON.stringify({
    ops: [
      { kind: 'DROP', lines: ['M9'], reason: 'x' },
      { kind: 'MERGE', lines: ['U1', 'M1'], content: 'x', reason: 'x' },
      { kind: 'MERGE', lines: ['M1'], content: 'x', reason: 'x' },
      { kind: 'REWRITE', lines: ['M4'], reason: 'no content' },
      { kind: 'DROP', lines: ['M3'], reason: 'one-off task detail' },
      { kind: 'MOVE_TO_SKILL', lines: ['M3'], skill: 'x', reason: 'reused line' },
      { kind: 'KEEP', lines: ['U1'] },
    ],
    admit: ['c1', 'c99'],
  });
  const r = parseConsolidation(text, ls, ['c1', 'c2']);
  expect(r.ops.map((o) => `${o.kind}:${o.lines.join('+')}`)).toEqual(['DROP:M3']);
  expect(r.notes.length).toBe(5);
  expect(r.admit).toEqual(['c1']);
  expect(r.ops[0].originals).toEqual(['Toast audit found 101 call sites across 35 files.']);
});

test('verified = deterministic dedupe only: near-duplicate MERGE and a DROP whose twin survives; never REWRITE/MOVE or a low-value DROP', () => {
  const ls = numberLines(USER, MEM);
  const merged = 'GitHub API rate limit is shared across all sessions; keep gh calls minimal and use GraphQL when REST runs out.';
  const a = parseConsolidation(JSON.stringify({ ops: [{ kind: 'MERGE', lines: ['M1', 'M2'], content: merged, reason: 'same fact' }] }), ls);
  expect(a.ops[0].verified).toBe(true);
  // DROP of M1 while its twin M2 stays → verified.
  const b = parseConsolidation(JSON.stringify({ ops: [{ kind: 'DROP', lines: ['M1'], reason: 'dup' }] }), ls);
  expect(b.ops[0].verified).toBe(true);
  // Dropping BOTH twins is not a dedupe — neither survives.
  const c = parseConsolidation(JSON.stringify({ ops: [{ kind: 'DROP', lines: ['M1'] }, { kind: 'DROP', lines: ['M2'] }] }), ls);
  expect(c.ops.map((o) => o.verified)).toEqual([false, false]);
  // A merge of unrelated lines, a lossy merge, a rewrite, a move, a low-value drop: all need a human.
  const d = parseConsolidation(
    JSON.stringify({
      ops: [
        { kind: 'MERGE', lines: ['M3', 'M4'], content: 'Toast audit and login ladder.', reason: '' },
        { kind: 'REWRITE', lines: ['U1'], content: 'Replies in Hebrew.', reason: '' },
        { kind: 'MOVE_TO_SKILL', lines: ['U2'], skill: 'ship-it', reason: '' },
      ],
    }),
    ls
  );
  expect(d.ops.map((o) => o.verified)).toEqual([false, false, false]);
  const e = parseConsolidation(JSON.stringify({ ops: [{ kind: 'MERGE', lines: ['M1', 'M2'], content: 'gh is rate limited.' }] }), ls);
  expect(e.ops[0].verified).toBe(false); // loses most of both lines
});

test('planConsolidation simulates the diff, reports tokens before/after and autoApplicable only for verified MERGE/DROP', () => {
  const merged = 'GitHub API rate limit is shared across all sessions; keep gh calls minimal and use GraphQL when REST runs out.';
  const pure = planConsolidation({ text: JSON.stringify({ ops: [{ kind: 'MERGE', lines: ['M1', 'M2'], content: merged }] }), userMd: USER, memoryMd: MEM, estimateTokens: est });
  expect(pure.autoApplicable).toBe(true);
  expect(pure.tokens.after.memory).toBeLessThan(pure.tokens.before.memory);
  const mixed = planConsolidation({
    text: JSON.stringify({ ops: [{ kind: 'MERGE', lines: ['M1', 'M2'], content: merged }, { kind: 'DROP', lines: ['M3'] }] }),
    userMd: USER,
    memoryMd: MEM,
    estimateTokens: est,
  });
  expect(mixed.autoApplicable).toBe(false);
  const lines = numberLines(USER, MEM);
  const after = simulateConsolidation(mixed.ops, lines, { userMd: USER, memoryMd: MEM });
  expect(after.memoryMd).toBe(`- ${merged}\n- Login ladder: MCP first, then request_login, then shared Chrome.\n`);
  expect(after.userMd).toBe(USER);
  expect(planConsolidation({ text: '{"ops":[]}', userMd: USER, memoryMd: MEM, estimateTokens: est }).autoApplicable).toBe(false);
});

test('the consolidation prompt shows numbered existing lines, the cap pressure, the waiting facts and the skills', () => {
  const p = buildConsolidationPrompt({
    lines: numberLines(USER, MEM),
    deferred: [{ key: 'c1', target: 'memory', content: 'The demo tenant has real users', count: 3 }],
    caps: { user: 600, memory: 900 },
    tokens: { user: 599, memory: 894 },
    skills: ['ship-it', 'local-env'],
  });
  expect(p).toContain('M2: The GitHub API rate limit');
  expect(p).toContain('U2: Never merge PRs');
  expect(p).toContain('MEMORY.md 894/900');
  expect(p).toContain('c1 [target=memory, seen ×3]: The demo tenant has real users');
  expect(p).toContain('ship-it, local-env');
});

test('learnSignature ignores pending order and changes with either file', () => {
  const h = { user: 'a', memory: 'b' };
  expect(learnSignature(['p2', 'p1'], h)).toBe(learnSignature(['p1', 'p2'], h));
  expect(learnSignature(['p1'], h)).not.toBe(learnSignature(['p1'], { user: 'a', memory: 'c' }));
  expect(learnSignature(['p1'], h)).not.toBe(learnSignature(['p1', 'p3'], h));
});

test('housekeeping plans are dry-run counts: episodes per ISO week older than N days, decided pending entries to archive', () => {
  expect(isoWeek('2026-11-10')).toBe('2026-W46');
  expect(isoWeek('2026-01-01')).toBe('2026-W01');
  expect(episodeDate('sess_X-2026-11-10T09-00-14-591Z.md')).toBe('2026-11-10');
  expect(episodeDate('notes.md')).toBeNull();
  const now = Date.parse('2026-11-10T12:00:00Z');
  const plan = planEpisodeDigest(
    [
      { name: 'a', date: '2026-09-15', bytes: 10 },
      { name: 'b', date: '2026-09-16', bytes: 5 },
      { name: 'c', date: '2026-11-09', bytes: 7 },
    ],
    { now, olderThanDays: 30 }
  );
  expect(plan).toEqual({ weeks: [{ week: '2026-W38', files: 2, bytes: 15 }], keep: 1 });
  const pend = planPendingCompaction(
    [
      { status: 'pending', createdAt: '2026-09-01T00:00:00Z' },
      { status: 'rejected', createdAt: '2026-09-01T00:00:00Z', decidedAt: '2026-09-02T00:00:00Z' },
      { status: 'approved', createdAt: '2026-11-09T00:00:00Z', decidedAt: '2026-11-09T00:00:00Z' },
    ],
    { now, olderThanDays: 30 }
  );
  expect(pend).toEqual({ archive: 1, keep: 2 });
});

// ---- memory.ts: hash-checked writes, caps, provenance --------------------------------

test('writeMemory: expectedHash refuses a stale writer; hashes chain; provenance names the writer, session and time', () => {
  const dir = tmp();
  const r = runInChild(
    "const m=await import('./server/memory.ts');" +
      "const h0=m.fileHash('memory');" +
      "const a=m.writeMemory({target:'memory',action:'add',content:'Fact A about the staging cluster',source:'agent',sessionId:'sess_A',expectedHash:h0});" +
      "const stale=m.writeMemory({target:'memory',action:'add',content:'Fact B from a stale read',source:'agent',sessionId:'sess_B',expectedHash:h0});" +
      "const b=m.writeMemory({target:'memory',action:'add',content:'Fact B from a fresh read',source:'learning:lr_1',sessionId:'sess_B',expectedHash:a.hash});" +
      "const free=m.writeMemory({target:'memory',action:'add',content:'Fact C with no hash at all'});" +
      "fs.appendFileSync(m.MEMORY_MD,'- Hand-edited line\\n');" +
      "emit({a,stale,b,free,prov:m.lineProvenance('memory'),get:m.getMemoryFile('MEMORY.md').hash===m.fileHash('memory')});",
    { ARIGAMI_DIR: dir, ARIGAMI_PORT: '' }
  );
  if (!r.ok) throw new Error(r.error);
  const o = r.out[0];
  expect(o.a.ok).toBe(true);
  expect(o.stale).toMatchObject({ ok: false, conflict: true });
  expect(o.b.ok).toBe(true);
  expect(o.free.ok).toBe(true);
  expect(o.get).toBe(true);
  expect(o.prov.map((p) => [p.source, p.sessionId || null])).toEqual([
    ['agent', 'sess_A'],
    ['learning:lr_1', 'sess_B'],
    ['agent', null],
    ['unknown', null],
  ]);
  expect(o.prov[0].ts).toMatch(/^\d{4}-/);
  expect(fs.readFileSync(path.join(dir, 'memory', 'MEMORY.md'), 'utf8')).not.toContain('stale read');
}, 30000);

test('caps: per-agent cap from config raises only that namespace; a shrinking replace is allowed over cap; undo may exceed it', () => {
  const dir = tmp();
  const r = runInChild(
    "const m=await import('./server/memory.ts');" +
      "m.setCapsSource(()=>({agents:{sales:1400}}));" +
      "const caps={shared:m.capFor('memory'),rec:m.capFor('memory','sales'),other:m.capFor('memory','ops'),user:m.capFor('user','sales')};" +
      "const big='x'.repeat(3900);" +
      "const rec=m.writeMemory({target:'memory',action:'add',content:big+' sales',agent:'sales'});" +
      "const chief=m.writeMemory({target:'memory',action:'add',content:big+' chief',agent:'ops'});" +
      // Lower the shared cap under the current file: a shrinking replace still works, a growing add does not.
      "m.writeMemory({target:'memory',action:'add',content:'y'.repeat(800)});" +
      "m.writeMemory({target:'memory',action:'add',content:'short line'});" +
      "m.setCapsSource(()=>({memory:100}));" +
      "const shrink=m.writeMemory({target:'memory',action:'replace',old_text:'y'.repeat(800),content:'y'.repeat(700)});" +
      "const grow=m.writeMemory({target:'memory',action:'add',content:'another'});" +
      "const forced=m.writeMemory({target:'memory',action:'add',content:'restored by undo',allowOverCap:true});" +
      'emit({caps,rec:rec.ok,chief:chief.ok,shrink:shrink.ok,grow:grow.ok,forced:forced.ok});',
    { ARIGAMI_DIR: dir, ARIGAMI_PORT: '' }
  );
  if (!r.ok) throw new Error(r.error);
  expect(r.out[0]).toEqual({ caps: { shared: 900, rec: 1400, other: 900, user: 600 }, rec: true, chief: false, shrink: true, grow: false, forced: true });
}, 30000);

// ---- the learner: stuck guard, auto consolidation + brake, manual proposal, apply/undo ------

const filler = (n) =>
  Array.from({ length: n }, (_, i) => `- Standing note ${i} ${'abcdefghijklmnopqrstuvwxyz'.slice(i % 20, (i % 20) + 6)}${i * 7919} keeps zone ${i * 31} quiet for ${i} reasons.`).join('\n');

function seedFullMemory(dir) {
  const mem = path.join(dir, 'memory');
  fs.mkdirSync(mem, { recursive: true });
  const twinA = '- GitHub API rate limit is shared across all sessions; keep gh calls minimal.';
  const twinB = '- The GitHub API rate limit is shared by all sessions, so keep gh calls minimal and use GraphQL when REST runs out.';
  const stale = '- Login ladder: MCP first, then request_login, then shared Chrome.';
  let body = `${twinA}\n${twinB}\n${stale}\n`;
  let n = 1;
  while (est(body + filler(n + 1) + '\n') <= 890) n++;
  body += filler(n) + '\n';
  fs.writeFileSync(path.join(mem, 'MEMORY.md'), body);
  return { twinA: twinA.slice(2), twinB: twinB.slice(2), stale: stale.slice(2) };
}

const STUB = (consolidation) =>
  'let calls={learn:0,consol:0};const notes=[];' +
  'const llm=async(p)=>{if(p.includes(\'consolidating Arigami\')){calls.consol++;return JSON.stringify(' +
  JSON.stringify(consolidation) +
  ');}calls.learn++;const keys=[...p.matchAll(/^(c\\d+) \\[/gm)].map(x=>x[1]);' +
  "return JSON.stringify({decisions:keys.map(k=>({key:k,action:'ENTER',target:'memory',content:'The demo tenant has real users: never submit persisting changes there.',reason:'safety'}))});};";

const LEARNER = (mode) =>
  "const M=await import('./server/memory.ts');const L=await import('./server/memory-learning.ts');" +
  "M.proposeFacts(['The demo tenant has real users: never submit persisting changes there.'],{source:'test',sessionId:'s1'});" +
  "let now=Date.parse('2026-11-10T00:00:00Z');" +
  `const l=L.createLearner({llm,now:()=>now,memAvailableMb:()=>1500,config:()=>({mode:'${mode}',minBatch:1,maxAgeHours:48,minFreeMb:600}),log:()=>{},emit:()=>{},notify:(n)=>notes.push(n),skills:()=>['ship-it']});` +
  'const tickAndSettle=async()=>{const t=await l.tick();await new Promise(r=>setTimeout(r,50));return t.ran;};';

test('stuck guard: at cap with nothing to consolidate, the next tick does not re-ask the model', () => {
  const dir = tmp();
  seedFullMemory(dir);
  const r = runInChild(
    STUB({ ops: [] }) +
      LEARNER('auto') +
      'const t1=await tickAndSettle();now+=15*60*1000;const t2=await tickAndSettle();now+=15*60*1000;const t3=await tickAndSettle();' +
      'emit({t1,t2,t3,calls,notes:notes.length});',
    { ARIGAMI_DIR: dir, ARIGAMI_PORT: '' }
  );
  if (!r.ok) throw new Error(r.error);
  expect(r.out[0]).toEqual({ t1: true, t2: false, t3: false, calls: { learn: 1, consol: 1 }, notes: 0 });
}, 30000);

test('auto mode manages its own memory: at cap it consolidates (deletions included), archives removed lines, notifies, and the waiting fact enters', () => {
  const dir = tmp();
  const t = seedFullMemory(dir);
  const merged = 'GitHub API rate limit is shared across all sessions; keep gh calls minimal and use GraphQL when REST runs out.';
  const consolidation = {
    ops: [
      { kind: 'MERGE', lines: ['M1', 'M2'], content: merged, reason: 'same fact' },
      { kind: 'REWRITE', lines: ['M3'], content: 'Sign-ins go through the sign_in tool.', reason: 'stale' },
      { kind: 'DROP', lines: ['M4'], reason: 'one-off detail' },
      { kind: 'MOVE_TO_SKILL', lines: ['M5'], skill: 'ship-it', reason: 'procedure' },
    ],
    admit: ['c1'],
  };
  const r = runInChild(
    STUB(consolidation) +
      LEARNER('auto') +
      'const t1=await tickAndSettle();const props=l.readConsolidations();' +
      'now+=15*60*1000;const t2=await tickAndSettle();' +
      "const journal=fs.readdirSync(M.JOURNAL_DIR).map(f=>fs.readFileSync(M.JOURNAL_DIR+'/'+f,'utf8')).join('');" +
      "emit({t1,t2,calls,notes,p:props[0],mem:fs.readFileSync(M.MEMORY_MD,'utf8'),journal,pending:M.listPending().length});",
    { ARIGAMI_DIR: dir, ARIGAMI_PORT: '' }
  );
  if (!r.ok) throw new Error(r.error);
  const o = r.out[0];
  expect(o.p.applied).toBe(true);
  expect(o.p.auto).toBe(true);
  expect(o.p.ops.map((x) => [x.kind, x.applied])).toEqual([['MERGE', true], ['REWRITE', true], ['DROP', true], ['MOVE_TO_SKILL', true]]);
  expect(o.mem).toContain(merged);
  expect(o.mem).not.toContain(t.twinA);
  expect(o.mem).not.toContain(t.stale);
  expect(o.mem).toContain('Sign-ins go through the sign_in tool.');
  // Nothing is lost: every removed/rewritten line is in the journal, searchable.
  expect(o.journal).toContain(t.twinA);
  expect(o.journal).toContain(t.stale);
  expect(o.journal).toContain('belongs in skill ship-it');
  expect(o.notes.map((n) => n.title)).toEqual(['Memory consolidated']);
  // The files changed → the stuck guard lets the next tick run, and the waiting fact now fits.
  expect(o.t2).toBe(true);
  expect(o.calls).toEqual({ learn: 2, consol: 1 });
  expect(o.mem).toContain('The demo tenant has real users');
  expect(o.pending).toBe(0);
}, 30000);

test('auto mode brake: a diff that would remove more than half of a file is never applied unattended — it waits for review', () => {
  const dir = tmp();
  const t = seedFullMemory(dir);
  const total = fs.readFileSync(path.join(dir, 'memory', 'MEMORY.md'), 'utf8').split('\n').filter(Boolean).length;
  const ops = Array.from({ length: Math.floor(total / 2) + 1 }, (_, i) => ({ kind: 'DROP', lines: [`M${i + 1}`], reason: 'low value' }));
  const r = runInChild(
    STUB({ ops }) + LEARNER('auto') + "const p=await l.consolidate();emit({p,notes,mem:fs.readFileSync(M.MEMORY_MD,'utf8')});",
    { ARIGAMI_DIR: dir, ARIGAMI_PORT: '' }
  );
  if (!r.ok) throw new Error(r.error);
  const o = r.out[0];
  expect(o.p.applied).toBe(false);
  expect(o.p.notes.join(' ')).toContain('more than half');
  expect(o.notes.map((n) => n.title)).toEqual(['Memory consolidation ready for review']);
  expect(o.mem).toContain(t.twinA);
}, 30000);

test('manual mode: the diff is only proposed and notified, never applied', () => {
  const dir = tmp();
  const t = seedFullMemory(dir);
  const r = runInChild(
    STUB({ ops: [{ kind: 'DROP', lines: ['M1'], reason: 'restated by M2' }] }) +
      LEARNER('manual') +
      "const p=await l.consolidate();emit({p,notes,status:l.status({preview:false}).consolidation?.id,mem:fs.readFileSync(M.MEMORY_MD,'utf8')});",
    { ARIGAMI_DIR: dir, ARIGAMI_PORT: '' }
  );
  if (!r.ok) throw new Error(r.error);
  const o = r.out[0];
  expect(o.p.applied).toBe(false);
  expect(o.p.ops[0].verified).toBe(true);
  expect(o.status).toBe(o.p.id);
  expect(o.notes.length).toBe(1);
  expect(o.mem).toContain(t.twinA);
}, 30000);

test('apply is hash-checked (409 after a concurrent edit); approved ops apply, learning resumes, per-op undo restores the lines', () => {
  const dir = tmp();
  const t = seedFullMemory(dir);
  const merged = 'GitHub API rate limit is shared across all sessions; keep gh calls minimal and use GraphQL when REST runs out.';
  const consolidation = {
    ops: [
      { kind: 'MERGE', lines: ['M1', 'M2'], content: merged, reason: 'same fact' },
      { kind: 'REWRITE', lines: ['M3'], content: 'Sign-ins go through the sign_in tool.', reason: 'stale' },
    ],
  };
  const r = runInChild(
    STUB(consolidation) +
      "const M=await import('./server/memory.ts');const L=await import('./server/memory-learning.ts');" +
      "const l=L.createLearner({llm,memAvailableMb:()=>1500,config:()=>({mode:'manual',minBatch:1,maxAgeHours:48,minFreeMb:600}),log:()=>{},emit:()=>{},notify:()=>{},skills:()=>[]});" +
      // A proposal, then someone edits MEMORY.md → the proposal is stale.
      "const p1=await l.consolidate();" +
      "M.writeMemory({target:'memory',action:'replace',old_text:" + JSON.stringify(t.stale) + ",content:'Login ladder: MCP first, then sign_in.'});" +
      "let stale=null;try{l.applyConsolidation(p1.id)}catch(e){stale=e.status}" +
      "M.writeMemory({target:'memory',action:'replace',old_text:'Login ladder: MCP first, then sign_in.',content:" + JSON.stringify(t.stale) + "});" +
      // Fresh proposal against the current files; approve both ops.
      "const p2=await l.consolidate();const applied=l.applyConsolidation(p2.id);" +
      "const afterApply=fs.readFileSync(M.MEMORY_MD,'utf8');" +
      "const prov=M.lineProvenance('memory').find(x=>x.line.includes('GraphQL'));" +
      "const room=M.writeMemory({target:'memory',action:'add',content:'The demo tenant has real users: never submit persisting changes there.'});" +
      "const u1=l.undoConsolidation(p2.id,'k1');const u2=l.undoConsolidation(p2.id,'k1');" +
      "emit({stale,ops:applied.ops.map(o=>[o.key,o.applied,o.logSeqs.length]),afterApply,prov:prov.source,room:room.ok,u1,u2,afterUndo:fs.readFileSync(M.MEMORY_MD,'utf8')});",
    { ARIGAMI_DIR: dir, ARIGAMI_PORT: '' }
  );
  if (!r.ok) throw new Error(r.error);
  const o = r.out[0];
  expect(o.stale).toBe(409);
  expect(o.ops).toEqual([['k1', true, 2], ['k2', true, 1]]);
  expect(o.afterApply).toContain(merged);
  expect(o.afterApply).not.toContain(t.twinA);
  expect(o.afterApply).toContain('Sign-ins go through the sign_in tool.');
  expect(o.prov).toMatch(/^consolidation:cr_/);
  expect(o.room).toBe(true); // the freed tokens let a waiting fact in
  expect(o.u1).toEqual({ ok: true });
  expect(o.u2.ok).toBe(false);
  expect(o.afterUndo).toContain(t.twinA);
  expect(o.afterUndo).toContain(t.twinB);
  expect(o.afterUndo).not.toContain(merged);
  expect(o.afterUndo).toContain('Sign-ins go through the sign_in tool.'); // the other op is untouched
}, 30000);
