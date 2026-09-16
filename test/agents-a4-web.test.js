// A4 web: composer parsing (slash-commands incl. "/agent new", the data-driven
// skill `slash:` items, @mentions → agents, the mention palette query /
// completion), the palette merge (host agent commands + skill slashes + CLI
// commands), the `delegated` receipt line, the /team panel and the mention
// palette render.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolate } from './_isolate.js';
isolate(); // restore globalThis/process.env after this file (bun test shares them)

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const web = (p) => path.join(ROOT, 'web/src', p);

let React, render, prefs, composer, slash, DelegatedLine;
const h = (...a) => React.createElement(...a);
const AGENTS = [
  { slug: 'mila', name: 'Mila', emoji: '✍️', color: '#E0594F', skills: ['campaign-brief'] },
  { slug: 'awesome', name: 'awesome', emoji: '🧭', color: '#6A4FC4', skills: [] },
  { slug: 'reachard', name: 'Reachard', emoji: '🔍', color: '#C9A227', skills: [] },
];
const SKILLS = [
  { name: 'dispatch', description: 'orchestrate', argumentHint: '[task]', slash: 'plan', source: 'shipped' },
  { name: 'explain-changes', description: 'explain the diff', argumentHint: '', slash: 'review', source: 'shipped' },
  { name: 'my-brief', description: 'user brief', argumentHint: '', slash: 'brief', source: 'user' },
  { name: 'onboarding', description: 'no slash', argumentHint: '', slash: '', source: 'shipped' },
];

beforeAll(async () => {
  const mem = new Map();
  globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
  globalThis.window = globalThis;
  globalThis.location = { origin: 'http://host.test', port: '', pathname: '/', hash: '' };
  globalThis.document = {
    documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} }, setAttribute() {}, classList: { add() {}, remove() {} }, dir: 'ltr' },
    body: {}, querySelector: () => null, addEventListener() {}, removeEventListener() {},
  };
  globalThis.navigator = { language: 'en-US', userAgent: 'test' };
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  globalThis.WebSocket = class { close() {} };
  globalThis.fetch = async (url) => ({ ok: true, status: 200, url: String(url), json: async () => ({}), text: async () => '' });
  React = (await import(path.join(ROOT, 'web/node_modules/react/index.js'))).default;
  ({ renderToStaticMarkup: render } = await import(path.join(ROOT, 'web/node_modules/react-dom/server.js')));
  prefs = await import(web('lib/prefs.js'));
  composer = await import(web('lib/composer.js'));
  slash = await import(web('components/SlashCommands.jsx'));
  ({ DelegatedLine } = await import(web('components/DelegatedLine.jsx')));
});

// ---- parsing ---------------------------------------------------------------------

test('parseSlash: name + args, "/agent new [name]" folds into one command, non-slash → null', () => {
  expect(composer.parseSlash('/plan ship the launch')).toEqual({ name: 'plan', args: 'ship the launch' });
  expect(composer.parseSlash('/review')).toEqual({ name: 'review', args: '' });
  expect(composer.parseSlash('  /as mila write it  ')).toEqual({ name: 'as', args: 'mila write it' });
  expect(composer.parseSlash('/agent new Jord')).toEqual({ name: 'agent new', args: 'Jord' });
  expect(composer.parseSlash('/agent new')).toEqual({ name: 'agent new', args: '' });
  expect(composer.parseSlash('/arigami:dispatch x')).toEqual({ name: 'arigami:dispatch', args: 'x' });
  expect(composer.parseSlash('plain text')).toBeNull();
  expect(composer.parseSlash('a /b')).toBeNull();
});

test('skillSlashItems: only skills with a slash field; user skills get the arigami-user namespace', () => {
  const items = composer.skillSlashItems(SKILLS);
  expect(items.map((i) => i.name)).toEqual(['plan', 'review', 'brief']);
  expect(items[0]).toMatchObject({ skill: 'dispatch', command: 'arigami:dispatch', host: false, argumentHint: '[task]' });
  expect(items[2].command).toBe('arigami-user:my-brief');
});

test('parseMentions: @slug / @Name anywhere, unknown @tokens and emails stay text, mentions stripped once', () => {
  const r = composer.parseMentions('@mila please write the launch email, cc @Reachard for facts', AGENTS);
  expect(r.agents.map((a) => a.slug)).toEqual(['mila', 'reachard']);
  expect(r.text).toBe('please write the launch email, cc for facts');
  const none = composer.parseMentions('mail sam@example.com at @2pm', AGENTS);
  expect(none.agents).toEqual([]);
  expect(none.text).toBe('mail sam@example.com at @2pm');
  const dup = composer.parseMentions('@mila and @mila again', AGENTS);
  expect(dup.agents.length).toBe(1);
  expect(dup.text).toBe('and again');
});

test('mentionQuery / completeMention / buildMentionItems', () => {
  expect(composer.mentionQuery('hello @mi')).toBe('mi');
  expect(composer.mentionQuery('@')).toBe('');
  expect(composer.mentionQuery('hello @mila done')).toBeNull();
  expect(composer.mentionQuery('a@b')).toBeNull();
  expect(composer.completeMention('hello @mi', 'mila')).toBe('hello @mila ');
  expect(composer.buildMentionItems('', AGENTS).map((a) => a.slug)).toEqual(['awesome', 'mila', 'reachard']);
  expect(composer.buildMentionItems('re', AGENTS).map((a) => a.slug)).toEqual(['reachard']);
  expect(composer.buildMentionItems('a', AGENTS).map((a) => a.slug)).toEqual(['awesome', 'mila', 'reachard']); // prefix first
});

test('resolveSubmission: host commands, skill rewrite, mention routing, plain pass-through', () => {
  const ctx = { skills: SKILLS, agents: AGENTS };
  expect(composer.resolveSubmission('/team', ctx)).toEqual({ type: 'team' });
  expect(composer.resolveSubmission('/agent new Jord', ctx)).toEqual({ type: 'agent-new', name: 'Jord' });
  expect(composer.resolveSubmission('/as mila write three subject lines', ctx)).toMatchObject({ type: 'as', agent: { slug: 'mila' }, text: 'write three subject lines' });
  expect(composer.resolveSubmission('/as Mila x', ctx).agent.slug).toBe('mila');
  expect(composer.resolveSubmission('/as mila', ctx)).toEqual({ type: 'as-usage' });
  expect(composer.resolveSubmission('/as nobody do it', ctx)).toEqual({ type: 'unknown-agent', name: 'nobody' });
  expect(composer.resolveSubmission('/plan ship the launch', ctx)).toEqual({ type: 'skill', text: '/arigami:dispatch ship the launch', skill: 'dispatch' });
  expect(composer.resolveSubmission('/review', ctx)).toEqual({ type: 'skill', text: '/arigami:explain-changes', skill: 'explain-changes' });
  expect(composer.resolveSubmission('/brief q3', ctx).text).toBe('/arigami-user:my-brief q3');
  expect(composer.resolveSubmission('@mila write it', ctx)).toMatchObject({ type: 'mention', text: 'write it' });
  expect(composer.resolveSubmission('@mila', ctx)).toEqual({ type: 'plain', text: '@mila' }); // nothing to hand over
  expect(composer.resolveSubmission('/compact', ctx)).toEqual({ type: 'plain', text: '/compact' }); // CLI pass-through
  expect(composer.resolveSubmission('just text', ctx)).toEqual({ type: 'plain', text: 'just text' });
});

// ---- palette merge -----------------------------------------------------------------

test('buildSlashItems merges host agent commands + skill slashes with the CLI commands; host first, prefix matches first', () => {
  prefs.setPrefs({ language: 'en' });
  const extra = [...composer.agentCommandItems(), ...composer.skillSlashItems(SKILLS)];
  const all = slash.buildSlashItems('', [{ name: 'compact', description: 'c' }, { name: 'plan-mode', description: 'x' }], extra);
  const names = all.map((i) => i.name);
  expect(names).toContain('team');
  expect(names).toContain('as');
  expect(names).toContain('agent new');
  expect(names).toContain('plan');
  expect(names).toContain('review');
  expect(names).toContain('brief');
  expect(names).toContain('compact');
  const p = slash.buildSlashItems('pl', [{ name: 'plan-mode', description: 'x' }], extra);
  expect(p[0]).toMatchObject({ name: 'plan', skill: 'dispatch' }); // the skill slash before the CLI's plan-mode
  expect(p.map((i) => i.name)).toEqual(['plan', 'plan-mode']);
  const team = slash.buildSlashItems('te', [], extra).find((i) => i.name === 'team');
  expect(team).toMatchObject({ host: true, agentCmd: 'team', run: true });
  expect(team.desc.length).toBeGreaterThan(5);
  // legacy 2-arg call still works
  expect(slash.buildSlashItems('usa', []).map((i) => i.name)).toEqual(['usage']);
});

test('SlashPalette shows the skill command chip; MentionPalette lists agents with avatars', () => {
  prefs.setPrefs({ language: 'he' });
  const items = slash.buildSlashItems('re', [], composer.skillSlashItems(SKILLS));
  const html = render(h(slash.SlashPalette, { items, active: 0, onPick() {}, onHover() {} }));
  expect(html).toContain('data-slash-skill="explain-changes"');
  expect(html).toContain('arigami:explain-changes');
  const m = render(h(slash.MentionPalette, { items: composer.buildMentionItems('', AGENTS), active: 1, onPick() {}, onHover() {} }));
  expect(m).toContain('data-mention-palette');
  expect(m).toContain('data-mention-item="mila"');
  expect(m).toContain('data-agent-avatar="reachard"');
  expect(m).toContain('@awesome');
  expect(m).toContain('campaign-brief');
});

// ---- receipt line + /team panel ---------------------------------------------------

// UX1 reworded this line: it now says WHICH of the two things happened, in a
// sentence, instead of "assigned to X" with the destination as a suffix.
test('DelegatedLine: a work session names its title, a home hand-off says "נפתח בבית של"', () => {
  prefs.setPrefs({ language: 'he' });
  const ev = { kind: 'delegated', agent: AGENTS[0], target: 's_child', targetTitle: 'Mila: write it', how: 'child', delivered: 'now', mode: 'mention', text: 'write it' };
  const html = render(h(DelegatedLine, { event: ev }));
  expect(html).toContain('data-delegated-line="mila"');
  expect(html).toContain('data-delegated-how="child"');
  expect(html).toContain('נוצר סשן עבודה «Mila: write it» עם Mila');
  expect(html).toContain('בפרויקט הזה');
  expect(html).toContain('data-delegated-open="s_child"');
  expect(html).toContain('פתח סשן');
  expect(html).toContain('write it');
  // home → the agent surface's home tab, not a session
  const home = render(h(DelegatedLine, { event: { ...ev, how: 'home', delivered: 'queued' } }));
  expect(home).toContain('נפתח בבית של Mila');
  expect(home).toContain('data-delegated-open-home="mila"');
  expect(home).not.toContain('data-delegated-open="s_child"');
  expect(home).toContain('פתח בית');
  expect(home).toContain('בתור');
  prefs.setPrefs({ language: 'en' });
  expect(render(h(DelegatedLine, { event: { ...ev, how: 'session' } }))).toContain('Work session «Mila: write it» created with Mila');
});

test('teamRows + TeamPanel: status per agent (working / n sessions / idle)', () => {
  prefs.setPrefs({ language: 'he' });
  const sessions = [
    { id: 's1', metadata: { agent: 'mila' }, claude: { state: 'working' } },
    { id: 's2', metadata: { agent: 'awesome' }, claude: { state: 'idle' } },
    { id: 's3', metadata: { agent: 'awesome' }, claude: { state: 'idle' }, archived: true },
    { id: 's4', metadata: {}, claude: { state: 'working' } },
  ];
  const rows = slash.teamRows(AGENTS, sessions);
  expect(rows.map((r) => [r.agent.slug, r.sessions, r.working])).toEqual([['mila', 1, true], ['awesome', 1, false], ['reachard', 0, false]]);
  const html = render(h(slash.TeamPanel, { agents: AGENTS, sessions, onClose() {}, onMention() {} }));
  expect(html).toContain('data-team-panel');
  expect(html).toContain('data-team-row="mila"');
  expect(html).toContain('עובד');
  expect(html).toContain('סשן אחד');
  expect(html).toContain('פנוי');
  expect(html).toContain('@reachard');
  expect(html).toContain('צ׳אט הבית');
});
