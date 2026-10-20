// Redesign phase 2 — the `changes` area: Changes tab diff + comments, merge
// pill/panel, orchestration, machine and screen chrome. SSR of the pieces that
// carry logic, plus guards that the legacy look does not creep back.
import { test, expect, beforeAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolate } from './_isolate.js';
isolate();

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const web = (p) => path.join(ROOT, 'web/src', p);
const read = (p) => fs.readFileSync(web(p), 'utf8');

let React, render, prefs, DiffView, CommentItem, CommentComposer, MergePill, TooltipProvider;
const h = (...a) => React.createElement(...a);

beforeAll(async () => {
  const mem = new Map();
  globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
  globalThis.window = globalThis;
  globalThis.location = { origin: 'http://host.test', port: '', pathname: '/', hash: '' };
  globalThis.document = {
    documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} }, setAttribute() {}, classList: { add() {}, remove() {} }, dir: 'ltr' },
    querySelector: () => null, addEventListener() {}, removeEventListener() {},
  };
  globalThis.navigator = { language: 'en-US', userAgent: 'test' };
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  React = (await import(path.join(ROOT, 'web/node_modules/react/index.js'))).default;
  ({ renderToStaticMarkup: render } = await import(path.join(ROOT, 'web/node_modules/react-dom/server.js')));
  prefs = await import(web('lib/prefs.js'));
  prefs.setPrefs({ language: 'en' });
  ({ DiffView } = await import(web('components/DiffView.jsx')));
  ({ CommentItem, CommentComposer } = await import(web('components/Comments.jsx')));
  ({ MergePill } = await import(web('components/MergeCard.jsx')));
  ({ TooltipProvider } = await import(web('components/ui/tooltip.jsx')));
});

const DIFF = ['diff --git a/a.js b/a.js', '--- a/a.js', '+++ b/a.js', '@@ -1,3 +1,3 @@', ' keep', '-old line', '+new line'].join('\n');

test('diff: add/del rows use the shared --diff-* tokens, not literal rgba', () => {
  for (const mode of ['split', 'inline']) {
    const html = render(h(DiffView, { diff: DIFF, mode, path: 'a.js' }));
    expect(html).toContain('var(--diff-add-bg)');
    expect(html).toContain('var(--diff-del-bg)');
    expect(html).toContain('var(--diff-add-gutter)');
    expect(html).not.toContain('rgba(');
    expect(html).toMatch(/old[\s\S]*line/);
    expect(html).toMatch(/new[\s\S]*line/);
  }
});

test('diff: split columns are pinned LTR (old left, new right) so Hebrew does not swap them', () => {
  const html = render(h(DiffView, { diff: DIFF, mode: 'split', path: 'a.js' }));
  expect(html).toMatch(/<div dir="ltr" class="group relative grid grid-cols-2"/);
});

test('diff: the tokens exist in light and dark', () => {
  const css = read('index.css').replaceAll(':root,\n[data-theme="light"] {', ':root {'); // the light blocks also open a light chat-theme scope
  const light = css.slice(css.indexOf(':root {\n  --diff-add-bg'), css.indexOf('[data-theme="dark"] {\n  --diff-add-bg'));
  const dark = css.slice(css.indexOf('[data-theme="dark"] {\n  --diff-add-bg'));
  for (const name of ['--diff-add-bg', '--diff-del-bg', '--diff-add-gutter', '--diff-del-gutter', '--diff-add-mark', '--diff-del-mark', '--diff-gap-bg', '--diff-hunk-bg']) {
    expect(light).toContain(name);
    expect(dark).toContain(name);
  }
});

test('diff: line comments resolve by label and orphans are kept', () => {
  const comments = [
    { id: 'c1', body: 'on the new line', target: { kind: 'line', lineLabel: 'L2' } },
    { id: 'c2', body: 'nowhere to be found', target: { kind: 'line', lineLabel: 'L999' } },
  ];
  const html = render(h(TooltipProvider, null, h(DiffView, { diff: DIFF, mode: 'inline', path: 'a.js', comments })));
  expect(html).toContain('on the new line');
  expect(html).toContain('nowhere to be found');
  expect(html).toContain('Comments on lines outside this view');
});

test('comments: states and the actions each state offers', () => {
  const noop = () => {};
  const handlers = { onDelete: noop, onResolve: noop, onEdit: noop, onReply: noop, onAccept: noop, onReject: noop };
  const open = render(h(TooltipProvider, null, h(CommentItem, { comment: { id: 'a', body: 'plain' }, ...handlers })));
  expect(open).toContain('data-comment="open"');
  for (const label of ['edit', 'reply', 'resolve']) expect(open.toLowerCase()).toContain(`>${label}<`);
  expect(open).not.toContain('accept');

  const sug = render(h(TooltipProvider, null, h(CommentItem, { comment: { id: 'b', body: 's', suggested: true }, ...handlers })));
  expect(sug).toContain('data-comment="suggestion"');
  expect(sug.toLowerCase()).toContain('>accept<');
  expect(sug.toLowerCase()).toContain('>reject<');
  expect(sug).toContain('data-status="violet"');

  const done = render(h(TooltipProvider, null, h(CommentItem, { comment: { id: 'c', body: 'r', resolved: true }, ...handlers })));
  expect(done).toContain('data-comment="resolved"');
  expect(done.toLowerCase()).toContain('>reopen<');
  expect(done).toContain('line-through');
});

test('comments: the composer disables submit while empty and its submit is not a primary button', () => {
  const html = render(h(CommentComposer, { onSubmit() {}, onCancel() {} }));
  expect(html).toMatch(/data-variant="default"[^>]*disabled=""/);
  expect(html).not.toContain('data-variant="primary"');
});

test('merge pill: merged / conflict / approved map to status dots; nothing otherwise', () => {
  const pill = (metadata) => render(h(MergePill, { session: { metadata } }));
  expect(pill({})).toBe('');
  expect(pill({ merged: { sha: 'abcdef0123', base: 'master' } })).toContain('data-status="ok"');
  expect(pill({ review: { state: 'approved' }, branch: 'b', mergeConflict: { files: ['x'] } })).toContain('data-status="err"');
  expect(pill({ review: { state: 'approved' }, branch: 'b' })).toContain('data-status="info"');
});

// The old look must not creep back into the files of this area.
const AREA = ['ChangesTab', 'DiffView', 'Comments', 'MergeCard', 'OrchestrationTab', 'Machine', 'ScreenSidePanel', 'ScreenModal'];
test('area files carry no legacy classes or FontAwesome', () => {
  for (const f of AREA) {
    const src = read(`components/${f}.jsx`);
    expect(src).not.toMatch(/border-ink|border-\[1\.5px\]|border-2\b|shadow-\[\d|bg-brand|fgdim|text-\[\d+(\.\d+)?px\]|free-solid-svg-icons|hover:border-ink/);
  }
});

test('ChangesTab keeps every control: review verdicts, explain, auto review, work mode, merge strip, base picker, VS Code', () => {
  const src = read('components/ChangesTab.jsx');
  for (const needle of [
    "submit('request-changes')", "submit('comment')", "submit('approve')",
    'runExplain', 'runReview', "'work', 'uncommitted', 'pr'", '<MergePanel session={session} dense status={reviewStatus} onRefresh={refreshReviewStatus} />',
    '<BasePicker', 'openEditor', 'saveDefaultBase', 'setSwitchOffer', 'setFullscreen', 'navigate({ kind: \'feature\'',
    "t('chat.commentOnFileBtn')", 'acceptSwitchOffer',
  ]) expect(src).toContain(needle);
  // Merge and Approve never both claim the accent
  expect(src).toContain("variant={mergeReady || approved ? 'default' : 'primary'}");
  // ONE approve action: one label whatever the target, its effect in the hint, Approved once current
  expect(src).not.toContain('chat.approvePr');
  expect(src).toContain("approved ? t('chat.approved') : t('chat.approve')");
  expect(src).toContain('t(...approveEffect(approval))');
  // the merge strip appears only when the host says this viewer can merge (or passively says why not)
  expect(src).toContain('const mergeReady = !!reviewStatus?.offer?.show');
});

test('screen panel keeps take over (via enlarge), enlarge, collapse; modal keeps type-into, note, done, fullscreen', () => {
  const panel = read('components/ScreenSidePanel.jsx');
  for (const needle of ['takeOver', 'enlarge', 'setScreenPanel(false)', "t('screen.viewShared')", 'allocate']) expect(panel).toContain(needle);
  const modal = read('components/ScreenModal.jsx');
  for (const needle of ['typeIt', 'done', 'cancel', 'toggleFullscreen', 'setupDone', "e.key === 'Escape' && !document.fullscreenElement"]) expect(modal).toContain(needle);
});

test('orchestration keeps jump, kill, retry, merge panel and groups; adds only derived rollups', () => {
  const src = read('components/OrchestrationTab.jsx');
  for (const needle of ['onKill', 'onRetry', 'jump(worker.id)', '<MergePanel', 'GROUP_ORDER', 'data-needs-you', 'data-orch-rollup']) expect(src).toContain(needle);
  // the strip only navigates; approving a child's request inline is a separate product decision (D12)
  expect(src).not.toMatch(/api\.post\([^)]*approve/);
});

test('new strings exist in both languages', () => {
  for (const lang of ['en', 'he']) {
    const s = read(`locales/${lang}/chat.js`);
    expect(s).toContain("'chat.orchProgress'");
    expect(s).toContain("'chat.orchOpen'");
  }
});
