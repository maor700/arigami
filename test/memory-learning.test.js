// LEARN1 — autonomous memory learning. The pure half (lib/memory-triage.ts) is
// tested in-process; everything that touches the pending queue / MEMORY.md /
// the run log runs in a fresh child (test/_child.js) with its own ARIGAMI_DIR
// and a STUB llm (createLearner({ llm })) — no `claude` process is ever spawned.
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runInChild } from './_child.js';
import {
  detectSensitive,
  isRepoDoc,
  isNearDuplicate,
  isAlreadyKnown,
  clusterItems,
  prepass,
  parseDecisions,
  planWithCap,
  tokenLoss,
  shouldRun,
  nextRun,
  buildPrompt,
} from '../server/lib/memory-triage.ts';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-learn-'));
const H = 3600_000;

// ---- deterministic pre-pass ---------------------------------------------------------

test('sensitive: ID numbers (checksum), payment cards and home addresses are detected; phones/JIDs/emails are not', () => {
  expect(detectSensitive('User ID 123456782, address Main St 12')?.kind).toBe('id-number');
  expect(detectSensitive('ת.ז. 123456782')?.kind).toBe('id-number');
  expect(detectSensitive('card 4111111111111111')?.kind).toBe('payment-card');
  expect(detectSensitive('גר בהדקל 51, כפר אביב')?.kind).toBe('address');
  expect(detectSensitive('רחוב ראשי 12 תל אביב')?.kind).toBe('address');
  expect(detectSensitive('Lives at 12 Main Street')?.kind).toBe('address');
  // Not sensitive — the useful kind of identifier a memory is for.
  expect(detectSensitive('וואטסאפ JID עצמי של דנה: 1234567890@lid')).toBeNull();
  expect(detectSensitive('Riverside WhatsApp 050-0000000, office 073-0000000')).toBeNull();
  expect(detectSensitive('phone +972500000000, mail dana@example.com')).toBeNull();
  expect(detectSensitive('deposited 88,000₪ in TradeStation on 5/2026')).toBeNull();
  expect(detectSensitive('address book has 300 contacts')).toBeNull();
  // A random 9-digit run with a bad check digit is not an ID.
  expect(detectSensitive('order 123456789 shipped')).toBeNull();
});

test('repo documentation is recognised: source paths, repo roots, branches, API routes, "Arigami project:" prefixes', () => {
  expect(isRepoDoc('Arigami project repo lives at /opt/arigami; feature work in worktrees')).toBe(true);
  expect(isRepoDoc("server/claude.js injects OAuth token via baseEnv(); one-shot 'claude -p' calls must mirror this")).toBe(true);
  expect(isRepoDoc('branch feat/K2-share-token awaiting review')).toBe(true);
  expect(isRepoDoc('Arigami gotcha: claude -p --output-format json puts errors in .result')).toBe(true);
  expect(isRepoDoc('the queue is at /__api/waiting because pending was taken')).toBe(true);
  expect(isRepoDoc('User prefers Hebrew replies, about two sentences')).toBe(false);
  expect(isRepoDoc('Dana coaches a youth futsal team at City United')).toBe(false);
  expect(isRepoDoc('Riverside WhatsApp 050-0000000')).toBe(false);
});

test('near-duplicate restatements cluster together; unrelated facts stay apart; the longest phrasing represents', () => {
  const items = [
    { id: 'a', content: 'User is Dana Levi (dana@example.com); maintains a second-brain repo', target: 'user', sessionId: 's1' },
    { id: 'b', content: 'The user is Dana Levi, dana@example.com, and keeps a second brain vault', target: 'user', sessionId: 's2' },
    { id: 'c', content: 'Dana Levi (dana@example.com) is the user', target: 'user', sessionId: 's3' },
    { id: 'd', content: 'Riverside sports registrar Robin: 073-0000001', target: 'memory', sessionId: 's1' },
    { id: 'e', content: 'Riverside registrar Robin can be reached at 073-0000001', target: 'memory', sessionId: 's4' },
    { id: 'f', content: 'Dana leads Shacharit at the Oak Street hall on Shabbat 8:00', target: 'memory', sessionId: 's1' },
  ];
  expect(isNearDuplicate(items[0].content, items[1].content)).toBe(true);
  expect(isNearDuplicate(items[0].content, items[5].content)).toBe(false);
  const clusters = clusterItems(items);
  expect(clusters.length).toBe(3);
  const dana = clusters.find((c) => c.ids.includes('a'));
  expect(dana.count).toBe(3);
  expect(dana.sessions).toBe(3);
  expect(dana.target).toBe('user');
  expect(dana.representative).toBe(items[1].content); // longest
  expect(dana.ids[0]).toBe('b'); // representative first
  const anat = clusters.find((c) => c.ids.includes('d'));
  expect(anat.count).toBe(2);
  expect(clusters.find((c) => c.ids.includes('f')).count).toBe(1);
});

test('prepass: sensitive → dropped, already in USER.md/MEMORY.md → dropped (folded ×N), repo docs → dropped, the rest clustered with a related-line hint', () => {
  const userMd = '- User is Dana Levi (dana@example.com), parent of two\n';
  const memoryMd = '- Riverside (Springfield leisure company) WhatsApp contact: 050-0000000; office 073-0000000\n- Standing policy: agents never type passwords/2FA themselves\n';
  const items = [
    ...Array.from({ length: 5 }, (_, i) => ({ id: `k${i}`, content: 'User is Dana Levi (dana@example.com), parent of two', target: 'user', sessionId: `s${i}` })),
    { id: 'sens', content: 'User ID 123456782, address Main St 12', target: 'user' },
    { id: 'doc1', content: 'Arigami project repo lives at /opt/arigami; feature work is done in worktrees', target: 'memory' },
    { id: 'doc2', content: 'Arigami repo: feature work in worktrees under /home/arigami/repos/arigami-wt-<task>', target: 'memory' },
    { id: 'new1', content: 'Riverside sports registrar Robin: 073-0000001 (extension of the office line)', target: 'memory', sessionId: 's1' },
    { id: 'new2', content: 'Riverside registrar Robin is at 073-0000001', target: 'memory', sessionId: 's2' },
    { id: 'new3', content: 'Dana coaches a youth futsal team at City United that won the national championship', target: 'user', sessionId: 's3' },
    { id: 'cred', content: 'password: hunter2hunter2hunter2', target: 'memory' },
  ];
  const r = prepass({ items, userMd, memoryMd, sanitize: (s) => (/password/.test(s) ? { ok: false, reason: 'credential' } : { ok: true }) });
  const by = (key) => r.dropped.find((d) => d.reasonKey === key);
  expect(by('sensitive').ids).toEqual(['sens']);
  expect(by('unsafe').ids).toEqual(['cred']);
  expect(by('already-known').ids.length).toBe(5); // the ×5 restatement folded into ONE dropped row
  expect(by('already-known').count).toBe(5);
  expect(by('already-known').detail).toMatch(/dana@example.com/);
  expect(r.dropped.filter((d) => d.reasonKey === 'repo-doc').flatMap((d) => d.ids).sort()).toEqual(['doc1', 'doc2']);
  expect(r.clusters.length).toBe(2);
  const anat = r.clusters.find((c) => c.ids.includes('new1'));
  expect(anat.count).toBe(2);
  expect(anat.related?.line).toMatch(/Riverside/); // the model gets the MERGE candidate
  expect(r.clusters.find((c) => c.ids.includes('new3')).count).toBe(1);
  // Every pending id lands exactly once — in a cluster or a dropped row.
  const all = [...r.clusters.flatMap((c) => c.ids), ...r.dropped.flatMap((d) => d.ids)].sort();
  expect(all).toEqual(items.map((i) => i.id).sort());
  const prompt = buildPrompt(r.clusters, userMd, memoryMd);
  expect(prompt).toContain('c1 [target=');
  expect(prompt).toContain('"decisions"');
  expect(prompt).toContain('ONE short line in English'); // reasons follow the memory's language…
  expect(buildPrompt(r.clusters, '- דנה לוי, הורה לשניים', memoryMd)).toContain('ONE short line in Hebrew'); // …Hebrew memory → Hebrew reasons
  expect(prompt).toContain('related existing line (memory): Riverside'); // bullet stripped — the model copies it verbatim into merge_into
});

test('isAlreadyKnown is strict: one shared word does not make a new fact "known"', () => {
  const lines = ['- דנה מאמן קבוצת נוער בכדורגל אולמות בהפועל העיר'];
  expect(isAlreadyKnown('Dana lives in Riverton', lines)).toBeNull();
  expect(isAlreadyKnown('דנה מאמן קבוצת נוער בכדורגל אולמות בהפועל העיר — זכו באליפות', lines)?.line).toBe(lines[0]);
});

// ---- model contract + cap-aware plan -------------------------------------------------

test('parseDecisions validates the model output: unknown keys ignored, missing clusters DEFER, MERGE without a real target stays pending, fuzzy merge targets resolve, SAME_AS folds, ENTER restating a line becomes MERGE/DROP', () => {
  const clusters = clusterItems([
    { id: 'a', content: 'fact A about something', target: 'memory' },
    { id: 'b', content: 'fact B about another thing entirely', target: 'memory' },
    { id: 'c', content: 'fact C third topic here', target: 'user' },
    { id: 'd', content: 'the garden gate squeaks when it rains', target: 'memory' },
    { id: 'e', content: 'Dana asked for short Hebrew answers without tables', target: 'user' },
    { id: 'f', content: 'Coaching: City United futsal, youth squad', target: 'user' },
  ]);
  const K = Object.fromEntries(['a', 'b', 'c', 'd', 'e', 'f'].map((id) => [id, clusters.find((c) => c.ids.includes(id)).key]));
  const memoryMd = '- existing line about A\n';
  const userMd = '- **איך לדבר עם דנה**: כמו בן אדם, ~2 משפטים להודעה, בלי טבלאות ובלי כותרות\n- Dana coaches futsal at City United\n';
  const text = `Sure! {"decisions":[
    {"key":"${K.a}","action":"MERGE","target":"memory","content":"existing line about A, now with the merged detail","merge_into":"- existing line about A","reason":"refines"},
    {"key":"${K.b}","action":"MERGE","target":"memory","content":"B","merge_into":"no such line","reason":"x"},
    {"key":"${K.d}","action":"SAME_AS","as":"${K.a}"},
    {"key":"${K.e}","action":"MERGE","target":"user","content":"איך לדבר עם דנה: כמו בן אדם, ~2 משפטים, בלי טבלאות, בלי כותרות, בלי נרטיב שלב-אחר-שלב","merge_into":"איך לדבר עם דנה: כמו בן אדם, ~2 משפטים להודעה, בלי טבלאות ובלי כותרות","reason":"markdown dropped by the model"},
    {"key":"${K.f}","action":"ENTER","target":"user","content":"Dana coaches futsal at City United","reason":"restates a line"},
    {"key":"zzz","action":"ENTER","content":"ignored"}
  ]}`;
  const { decisions, notes } = parseDecisions(text, clusters, { userMd, memoryMd });
  const d = Object.fromEntries(decisions.map((x) => [x.key, x]));
  expect(d[K.a].action).toBe('MERGE');
  expect(d[K.a].mergeInto).toBe('existing line about A'); // bullet stripped, verbatim match
  expect(d[K.b].action).toBe('DEFER'); // never entered as a near-duplicate
  expect(d[K.b].reasonKey).toBe('merge-target-missing');
  expect(d[K.c].action).toBe('DEFER');
  expect(d[K.c].reasonKey).toBe('no-decision');
  expect(d[K.d].action).toBe('DROP'); // SAME_AS → member of A's cluster
  expect(d[K.d].reasonKey).toBe('cluster-member');
  expect(d[K.d].reason).toBe(K.a);
  expect(d[K.e].action).toBe('MERGE'); // fuzzy: the model dropped the **bold**
  expect(d[K.e].mergeInto).toBe('**איך לדבר עם דנה**: כמו בן אדם, ~2 משפטים להודעה, בלי טבלאות ובלי כותרות');
  expect(d[K.f].action).toBe('DROP'); // ENTER that restates an existing line
  expect(d[K.f].reasonKey).toBe('already-known');
  expect(notes.some((n) => /merge target not found/.test(n))).toBe(true);
  expect(() => parseDecisions('no json here', clusters, { userMd: '', memoryMd })).toThrow();
});

test('planWithCap: near the cap an ENTER with a fallback line becomes MERGE, one without stays pending — and the log says so', () => {
  const est = (s) => Math.ceil(s.length / 4);
  const memoryMd = '- ' + 'x'.repeat(3560) + '\n'; // ≈ 890 tokens of a 900 cap
  const decisions = [
    { key: 'c2', action: 'ENTER', target: 'memory', content: 'another new fact with no related line to merge into at all here', reason: 'r' },
    { key: 'c1', action: 'ENTER', target: 'memory', content: 'a brand new fact that is fairly long and will not fit under the cap', reason: 'r', mergeInto: 'x'.repeat(3560) },
    { key: 'c3', action: 'DROP', target: 'memory', content: 'whatever', reason: 'r' },
    { key: 'c4', action: 'ENTER', target: 'user', content: 'fits in USER.md', reason: 'r' },
  ];
  const { decisions: out, notes } = planWithCap({ decisions, userMd: '', memoryMd, caps: { user: 600, memory: 900 }, estimateTokens: est });
  expect(out[0].action).toBe('DEFER');
  expect(out[0].reasonKey).toBe('cap');
  expect(out[1].action).toBe('MERGE');
  expect(out[1].reasonKey).toBe('cap');
  expect(out[2].action).toBe('DROP');
  expect(out[3].action).toBe('ENTER');
  expect(notes.join('\n')).toMatch(/1 ENTER → MERGE/);
  expect(notes.join('\n')).toMatch(/1 left pending/);
});

// ---- scheduler ----------------------------------------------------------------------

test('shouldRun: ≥minBatch OR maxAgeHours since the last run (whichever first); never in manual, when empty, while running, or under memory pressure', () => {
  const base = { mode: 'auto', pending: 5, lastRunAt: null, firstSeenAt: 0, now: H, minBatch: 40, maxAgeHours: 48, memAvailableMb: 2000, minFreeMb: 600, running: false };
  expect(shouldRun(base)).toEqual({ run: false, deferred: 'not-yet' });
  expect(shouldRun({ ...base, pending: 40 })).toEqual({ run: true, reason: 'batch' });
  expect(shouldRun({ ...base, now: 48 * H })).toEqual({ run: true, reason: 'age' }); // anchored on first-seen when no run yet
  expect(shouldRun({ ...base, lastRunAt: 10 * H, now: 57 * H })).toEqual({ run: false, deferred: 'not-yet' }); // 47h since the last run
  expect(shouldRun({ ...base, lastRunAt: 10 * H, now: 58 * H })).toEqual({ run: true, reason: 'age' });
  expect(shouldRun({ ...base, pending: 40, mode: 'manual' })).toEqual({ run: false, deferred: 'manual' });
  expect(shouldRun({ ...base, pending: 0, now: 100 * H })).toEqual({ run: false, deferred: 'empty' });
  expect(shouldRun({ ...base, pending: 40, running: true })).toEqual({ run: false, deferred: 'running' });
  expect(shouldRun({ ...base, pending: 40, memAvailableMb: 400 })).toEqual({ run: false, deferred: 'memory', reason: 'batch' });
  expect(nextRun({ pending: 17, lastRunAt: 10 * H, firstSeenAt: 0, minBatch: 40, maxAgeHours: 48 })).toEqual({ byCount: 23, at: new Date(58 * H).toISOString() });
  expect(nextRun({ pending: 0, lastRunAt: null, firstSeenAt: null, minBatch: 40, maxAgeHours: 48 })).toEqual({ byCount: 40, at: null });
});

// ---- end to end against the real store (child process, stub LLM) ------------------------

const SEED =
  "const m=await import('./server/memory.ts');" +
  "m.writeMemory({target:'memory',action:'add',content:'Riverside (Springfield leisure company) WhatsApp contact: 050-0000000; office 073-0000000',source:'seed'});" +
  "m.writeMemory({target:'user',action:'add',content:'Dana Levi (dana@example.com) is the user; parent of two',source:'seed'});" +
  "const P=(facts,sid)=>m.proposeFacts(facts,{source:'learn1-test',sessionId:sid});" +
  "P(['User is Dana Levi (dana@example.com)'],'s1');P(['The user is Dana Levi, dana@example.com'],'s2');P(['Dana Levi (dana@example.com) is the user'],'s3');" +
  "P(['Riverside sports registrar Robin: 073-0000001'],'s1');P(['Riverside registrar Robin can be reached at 073-0000001'],'s4');" +
  "P(['Dana coaches a youth futsal team at City United'],'s2');P(['Dana coaches the City United youth futsal team'],'s5');" +
  "P(['Arigami project repo lives at /opt/arigami; feature work is done in worktrees'],'s1');" +
  "P(['Standing policy: agents never type passwords or 2FA codes themselves — request_screen instead'],'s3');";

// A stub model: MERGE Robin into the Riverside line, ENTER futsal, DROP the policy as trivial.
const STUB_LLM =
  'const llm=async(prompt)=>{' +
  "const blocks={};let cur=null;for(const line of prompt.split('\\n')){const h=/^(c\\d+) \\[/.exec(line);if(h){cur=h[1];blocks[cur]='';}else if(cur&&line.startsWith('  '))blocks[cur]+=line+'\\n';else cur=null;}" +
  'const key=(re)=>Object.keys(blocks).find(k=>re.test(blocks[k]));' +
  'const anat=key(/Robin/),futsal=key(/futsal/),policy=key(/passwords/);' +
  'return JSON.stringify({decisions:[' +
  "{key:anat,action:'MERGE',target:'memory',content:'Riverside (Springfield leisure company) WhatsApp contact: 050-0000000; office 073-0000000; sports registrar Robin 073-0000001',merge_into:'Riverside (Springfield leisure company) WhatsApp contact: 050-0000000; office 073-0000000',reason:'מדייק שורה קיימת'}," +
  "{key:futsal,action:'ENTER',target:'user',content:'Dana coaches the City United youth futsal team',reason:'עובדה חדשה, 2 סשנים'}," +
  "{key:policy,action:'DROP',target:'memory',content:'',reason:'כלל כללי מדי'}" +
  ']});};';

test('auto mode: one stub-LLM run applies through the approve gate — entered, merged, dropped, run log + pending statuses + undo per line', () => {
  const dir = tmp();
  const r = runInChild(
    SEED +
      STUB_LLM +
      "const L=await import('./server/memory-learning.ts');" +
      "let mem=1500;const l=L.createLearner({llm,memAvailableMb:()=>mem,config:()=>({mode:'auto',minBatch:40,maxAgeHours:48,minFreeMb:600}),log:()=>{},emit:()=>{}});" +
      'const before=l.status({preview:false});' +
      "const run=await l.run({trigger:'manual'});" +
      'const after=l.status({preview:false});' +
      'const boot=m.getMemoryBootstrap();' +
      "const pend=JSON.parse(require('fs').readFileSync(m.PENDING_FILE,'utf8'));" +
      "const entered=run.items.find(i=>i.action==='ENTER');" +
      'const undo=l.undo(entered.logSeq);' +
      'const boot2=m.getMemoryBootstrap();' +
      'const runs2=l.readRuns(10);' +
      'emit({before:{pending:before.pending,mode:before.mode,next:before.nextRun,runs:before.runs.length},run,after:{pending:after.pending,last:after.lastRunAt,runs:after.runs.length,keys:Object.keys(after)},userMd:boot.userMd,memoryMd:boot.memoryMd,pend:pend.map(p=>({c:p.content.slice(0,30),s:p.status,by:p.decidedBy})),undo,userMd2:boot2.userMd,undone:runs2[0].items.find(i=>i.key===entered.key).undone});',
    { ARIGAMI_DIR: dir, ARIGAMI_PORT: '' }
  );
  if (!r.ok) throw new Error(r.error);
  const o = r.out[0];
  expect(o.before.pending).toBe(9);
  expect(o.before.runs).toBe(0);
  expect(o.before.next).toEqual({ byCount: 31, at: null });
  // API shape (GET /__api/memory/learning)
  for (const k of ['mode', 'config', 'pending', 'running', 'lastRunAt', 'nextRun', 'lastDeferred', 'memAvailableMb', 'runs', 'proposedRun']) expect(o.after.keys).toContain(k);
  expect(o.run.applied).toBe(true);
  expect(o.run.llm).toBe(true);
  expect(o.run.counts.proposed).toBe(9);
  expect(o.run.counts.entered).toBe(1);
  expect(o.run.counts.merged).toBe(1);
  // dropped = 3 restatements already in USER.md + 1 repo doc + the policy the model dropped
  expect(o.run.counts.dropped).toBe(5);
  expect(o.run.counts.deferred).toBe(0);
  const byAction = (a) => o.run.items.filter((i) => i.action === a);
  expect(byAction('ENTER')[0].content).toBe('Dana coaches the City United youth futsal team');
  expect(byAction('ENTER')[0].count).toBe(2);
  expect(byAction('ENTER')[0].logSeq).toBeGreaterThan(0);
  expect(byAction('MERGE')[0].logSeq).toBeGreaterThan(0);
  expect(byAction('MERGE')[0].reason).toBe('מדייק שורה קיימת');
  expect(byAction('DROP').map((i) => i.reasonKey).filter(Boolean).sort()).toEqual(['already-known', 'repo-doc']);
  expect(byAction('DROP').find((i) => i.reasonKey === 'already-known').count).toBe(3);
  // The files: futsal entered in USER.md, Robin merged into the Riverside line (one line, not two).
  expect(o.userMd).toContain('City United youth futsal team');
  expect(o.memoryMd).toContain('sports registrar Robin 073-0000001');
  expect(o.memoryMd.match(/Riverside/g).length).toBe(1);
  // Nothing left pending; every row has a decision with the run as decider.
  expect(o.after.pending).toBe(0);
  expect(o.pend.every((p) => p.s !== 'pending')).toBe(true);
  expect(o.pend.filter((p) => p.s === 'approved').length).toBe(2);
  expect(o.pend.every((p) => /^learning:lr_/.test(p.by))).toBe(true);
  expect(o.after.last).toBeTruthy();
  expect(o.after.runs).toBe(1);
  // Undo removes exactly that line and marks the item.
  expect(o.undo.ok).toBe(true);
  expect(o.userMd2).not.toContain('futsal');
  expect(o.userMd2).toContain('dana@example.com');
  expect(o.undone).toBe(true);
});

test('manual mode: the run is stored pre-checked and applies nothing until /apply; unticked rows stay pending', () => {
  const dir = tmp();
  const r = runInChild(
    SEED +
      STUB_LLM +
      "const L=await import('./server/memory-learning.ts');" +
      "const l=L.createLearner({llm,memAvailableMb:()=>1500,config:()=>({mode:'manual',minBatch:40,maxAgeHours:48,minFreeMb:600}),log:()=>{},emit:()=>{}});" +
      'const run=await l.run({});' +
      'const st=l.status({preview:false});' +
      'const boot=m.getMemoryBootstrap();' +
      "const enter=run.items.find(i=>i.action==='ENTER');" +
      'const applied=l.applyRun(run.id,[enter.key]);' +
      'const boot2=m.getMemoryBootstrap();' +
      'const st2=l.status({preview:false});' +
      "let dup=null;try{l.applyRun(run.id)}catch(e){dup=e.status}" +
      "emit({applied:run.applied,checked:run.items.filter(i=>i.checked).map(i=>i.action).sort(),proposed:st.proposedRun&&st.proposedRun.id,pending:st.pending,memBefore:boot.memoryMd,userBefore:boot.userMd,after:{applied:applied.applied,counts:applied.counts,merge:applied.items.find(i=>i.mergeInto).action},memAfter:boot2.memoryMd,userAfter:boot2.userMd,pending2:st2.pending,proposed2:st2.proposedRun,dup});",
    { ARIGAMI_DIR: dir, ARIGAMI_PORT: '' }
  );
  if (!r.ok) throw new Error(r.error);
  const o = r.out[0];
  expect(o.applied).toBe(false);
  expect(o.checked).toEqual(['ENTER', 'MERGE']);
  expect(o.proposed).toMatch(/^lr_/);
  expect(o.pending).toBe(9); // nothing touched yet
  expect(o.userBefore).not.toContain('futsal');
  expect(o.memBefore).not.toContain('Robin');
  // Apply only the ENTER: futsal lands, the MERGE stays pending (not dropped), drops are recorded.
  expect(o.after.applied).toBe(true);
  expect(o.after.counts.entered).toBe(1);
  expect(o.after.counts.merged).toBe(0);
  expect(o.after.merge).toBe('DEFER');
  expect(o.userAfter).toContain('futsal');
  expect(o.memAfter).not.toContain('Robin');
  expect(o.pending2).toBe(2); // the two Robin restatements
  expect(o.proposed2).toBeNull();
  expect(o.dup).toBe(409);
});

test('manual approve without the model: pre-pass clusters approved as-is, drops rejected, recorded as a run', () => {
  const dir = tmp();
  const r = runInChild(
    SEED +
      "const L=await import('./server/memory-learning.ts');" +
      "const l=L.createLearner({llm:async()=>{throw new Error('must not be called')},memAvailableMb:()=>1500,config:()=>({mode:'manual',minBatch:40,maxAgeHours:48,minFreeMb:600}),log:()=>{},emit:()=>{}});" +
      'const pv=l.preview();' +
      "const futsal=pv.clusters.find(c=>/futsal/.test(c.content));" +
      'const run=l.approveClusters([futsal.key]);' +
      'const boot=m.getMemoryBootstrap();' +
      "emit({clusters:pv.clusters.map(c=>({n:c.count,c:c.content.slice(0,20)})),dropped:pv.dropped.map(d=>d.reasonKey).sort(),run:{trigger:run.trigger,llm:run.llm,counts:run.counts},userMd:boot.userMd,memoryMd:boot.memoryMd,pending:l.status({preview:false}).pending});",
    { ARIGAMI_DIR: dir, ARIGAMI_PORT: '' }
  );
  if (!r.ok) throw new Error(r.error);
  const o = r.out[0];
  expect(o.clusters.length).toBe(3);
  expect(o.dropped).toEqual(['already-known', 'repo-doc']);
  expect(o.run.trigger).toBe('manual-approve');
  expect(o.run.llm).toBe(false);
  expect(o.run.counts.entered).toBe(1);
  expect(o.run.counts.dropped).toBe(4);
  expect(o.run.counts.deferred).toBe(3); // Robin ×2 + policy ×1 stay pending
  // No model → no re-targeting: the pre-pass keeps the proposal's own target (memory).
  expect(o.userMd + o.memoryMd).toContain('futsal');
  expect(o.pending).toBe(3);
});

test('scheduler tick: defers under memory pressure (recorded), then runs on the batch trigger when RAM is back; a failed LLM leaves the queue intact', () => {
  const dir = tmp();
  const r = runInChild(
    SEED +
      STUB_LLM +
      "const L=await import('./server/memory-learning.ts');" +
      'let mem=300;let now=Date.parse("2026-09-02T10:00:00Z");' +
      "const l=L.createLearner({llm,now:()=>now,memAvailableMb:()=>mem,config:()=>({mode:'auto',minBatch:5,maxAgeHours:48,minFreeMb:600}),log:()=>{},emit:()=>{}});" +
      'const t1=await l.tick();const s1=l.status({preview:false});' +
      'mem=1500;const t2=await l.tick();const s2=l.status({preview:false});' +
      'const t3=await l.tick();' +
      // a fresh queue + a broken model → run fails, nothing applied, items remain pending
      "m.proposeFacts(['Dana prays Shacharit at the Oak Street hall, second minyan, Shabbat 8:00'],{source:'learn1-test',sessionId:'s9'});" +
      "const bad=L.createLearner({llm:async()=>{throw new Error('claude exited 1: not logged in')},now:()=>now,memAvailableMb:()=>1500,config:()=>({mode:'auto',minBatch:1,maxAgeHours:48,minFreeMb:600}),log:()=>{},emit:()=>{}});" +
      "let err=null;try{await bad.tick()}catch(e){err=e.message}" +
      'const s3=bad.status({preview:false});' +
      'emit({t1,d1:s1.lastDeferred,t2,last2:s2.lastRunAt,runs2:s2.runs.length,pend2:s2.pending,t3,err,pend3:s3.pending,run3:s3.runs[0]&&{error:s3.runs[0].error,applied:s3.runs[0].applied}});',
    { ARIGAMI_DIR: dir, ARIGAMI_PORT: '' }
  );
  if (!r.ok) throw new Error(r.error);
  const o = r.out[0];
  expect(o.t1).toEqual({ ran: false, verdict: { run: false, deferred: 'memory', reason: 'batch' } });
  expect(o.d1.reason).toBe('memory');
  expect(o.d1.availableMb).toBe(300);
  expect(o.t2).toEqual({ ran: true, verdict: { run: true, reason: 'batch' } });
  expect(o.last2).toBe('2026-09-02T10:00:00.000Z');
  expect(o.runs2).toBe(1);
  expect(o.pend2).toBe(0);
  expect(o.t3.ran).toBe(false);
  expect(o.t3.verdict.deferred).toBe('empty');
  expect(o.err).toMatch(/not logged in/);
  expect(o.pend3).toBe(1);
  expect(o.run3).toEqual({ error: 'claude exited 1: not logged in', applied: false });
});

test('proposeFacts refuses sensitive personal data (ID numbers, cards, addresses) and sanitize refuses ID numbers everywhere', () => {
  const dir = tmp();
  const r = runInChild(
    "const m=await import('./server/memory.ts');" +
    "const made=m.proposeFacts(['User ID 123456782','card 4111111111111111','גר ברחוב ראשי 12 תל אביב','Dana likes strong coffee'],{source:'learn1-test'});" +
    "const w=m.writeMemory({target:'user',action:'add',content:'ת.ז. של דנה: 123456782',source:'agent'});" +
    "const addr=m.writeMemory({target:'user',action:'add',content:'גר בהדקל 51, כפר אביב',source:'agent'});" +
    'emit({made:made.map(f=>f.content),w:{ok:w.ok,error:w.error},addr:addr.ok});',
    { ARIGAMI_DIR: dir, ARIGAMI_PORT: '' }
  );
  if (!r.ok) throw new Error(r.error);
  const o = r.out[0];
  expect(o.made).toEqual(['Dana likes strong coffee']);
  expect(o.w.ok).toBe(false);
  expect(o.w.error).toMatch(/sensitive/);
  expect(o.addr).toBe(true); // a human/agent may still store an address deliberately
});

test('a line that starts with **bold** is entered, merged and undone by exact line match (no whole-file fallback)', () => {
  const dir = tmp();
  const r = runInChild(
    "const m=await import('./server/memory.ts');" +
    "m.writeMemory({target:'user',action:'add',content:'first line stays',source:'seed'});" +
    "m.proposeFacts(['**איך לדבר עם דנה**: כמו בן אדם, ~2 משפטים, בלי טבלאות'],{source:'learn1-test',sessionId:'s1'});" +
    "const L=await import('./server/memory-learning.ts');" +
    "const llm=async(p)=>JSON.stringify({decisions:[{key:'c1',action:'ENTER',target:'user',content:'**איך לדבר עם דנה**: כמו בן אדם, ~2 משפטים, בלי טבלאות',reason:'r'}]});" +
    "const l=L.createLearner({llm,memAvailableMb:()=>1500,config:()=>({mode:'auto',minBatch:40,maxAgeHours:48,minFreeMb:600}),log:()=>{},emit:()=>{}});" +
    'const run=await l.run({});' +
    "m.writeMemory({target:'user',action:'add',content:'a later line that must survive the undo',source:'seed'});" +
    'const undo=l.undo(run.items[0].logSeq);' +
    'emit({entered:run.items[0].action,undo,userMd:m.getMemoryBootstrap().userMd});',
    { ARIGAMI_DIR: dir, ARIGAMI_PORT: '' }
  );
  if (!r.ok) throw new Error(r.error);
  const o = r.out[0];
  expect(o.entered).toBe('ENTER');
  expect(o.undo.ok).toBe(true);
  expect(o.undo.fallback).toBeFalsy(); // targeted remove, not undoLog()
  expect(o.userMd).not.toContain('איך לדבר');
  expect(o.userMd).toContain('a later line that must survive the undo'); // later writes survive
  expect(o.userMd).toContain('first line stays');
});

test('a lossy MERGE (the model shortened the existing line) stays pending instead of overwriting it', () => {
  const clusters = clusterItems([{ id: 'a', content: 'replies should be in Hebrew', target: 'user' }]);
  const line = '**How to talk to Dana**: like a person, ~2 sentences, no tables, no headers, bad news first. His own style: telegraphic; long paragraphs only in big moments. Lurker on WhatsApp, vocal on Facebook.';
  const userMd = `- ${line}\n`;
  const lossy = `{"decisions":[{"key":"c1","action":"MERGE","target":"user","content":"**How to talk to Dana**: in Hebrew, like a person, ~2 sentences, no tables, no headers, bad news first.","merge_into":${JSON.stringify(line)},"reason":"adds Hebrew"}]}`;
  const r1 = parseDecisions(lossy, clusters, { userMd, memoryMd: '' });
  expect(r1.decisions[0].action).toBe('DEFER');
  expect(r1.decisions[0].reasonKey).toBe('merge-lossy');
  expect(r1.notes[0]).toMatch(/merge would drop/);
  const full = `{"decisions":[{"key":"c1","action":"MERGE","target":"user","content":${JSON.stringify(line.replace('like a person', 'in Hebrew, like a person'))},"merge_into":${JSON.stringify(line)},"reason":"adds Hebrew"}]}`;
  const r2 = parseDecisions(full, clusters, { userMd, memoryMd: '' });
  expect(r2.decisions[0].action).toBe('MERGE');
  expect(tokenLoss(line, line + ' extra')).toBe(0);
  expect(tokenLoss('alpha beta gamma delta', 'alpha beta')).toBe(0.5);
});
