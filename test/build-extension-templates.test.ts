// EXT wave 2 — the build-extension templates.
//
// The skill's promise is "copy a template, fill the {{placeholders}}, and
// `bin/host ext validate` is clean". This suite holds that promise honest: it
// copies each template into a temp $ARIGAMI_DIR exactly the way the skill tells
// Claude to, substitutes the placeholders, and runs the REAL validateExtension
// (server/extensions.ts) against it — same pattern as test/extensions.test.ts,
// one bun child per case, no host, no network.
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runInChild } from './_child.js';

const REPO = path.resolve(import.meta.dir, '..');
const SKILL = path.join(REPO, 'skills', 'build-extension');
const TEMPLATES = path.join(SKILL, 'templates');

const env = (dir: string) => ({
  ARIGAMI_DIR: dir,
  ARIGAMI_PORT: '',
  ARIGAMI_STATE_FILE: path.join(dir, 'state.json'),
  ARIGAMI_CHAT_DIR: path.join(dir, 'chat'),
});

/** Every {{placeholder}} the templates use, and what the skill would fill in. */
const VALUES: Record<string, string> = {
  name: '', // per-case, set below
  title: 'בודק תבניות',
  description: 'A template filled in by the test, exactly as the skill would fill it.',
  type: '', // per-case
  tool: 'demo_search',
  // No raw double quotes: this value is substituted into manifest.json as-is.
  trigger: 'Use when the user asks to search the demo source, or says demo search.',
};

/** Copy a template into $ARIGAMI_DIR/user/extensions/<name>, substituting placeholders. */
function scaffold(root: string, template: string, name: string): string {
  const dest = path.join(root, 'user', 'extensions', name);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(path.join(TEMPLATES, template), dest, { recursive: true });
  fs.rmSync(path.join(dest, 'README.md'), { force: true }); // the skill says to delete it
  const vals = { ...VALUES, name, type: `${name}-events` };
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else fs.writeFileSync(full, fs.readFileSync(full, 'utf8').replace(/\{\{(\w+)\}\}/g, (m, k) => vals[k] ?? m));
    }
  };
  walk(dest);
  return dest;
}

const validate = (root: string, dir: string) => {
  const r = runInChild(
    "const ext=await import('./server/extensions.ts');" +
      `const v=await ext.validateExtension(${JSON.stringify(dir)});` +
      'emit({ok:v.ok,errors:v.errors,warnings:v.warnings,manifest:v.manifest});',
    env(root)
  );
  if (!r.ok) throw new Error(r.error);
  return r.out[0] as { ok: boolean; errors: string[]; warnings: string[]; manifest: any };
};

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-tpl-'));

// ---------------------------------------------------------------------------
// the four templates
// ---------------------------------------------------------------------------
for (const [template, name] of [
  ['tab', 'demo-tab'],
  ['listener', 'demo-listener'],
  ['tool', 'demo-tool'],
  ['hooks', 'demo-hooks'],
] as [string, string][]) {
  test(`template "${template}" validates clean once the placeholders are filled`, () => {
    const root = tmp();
    const v = validate(root, scaffold(root, template, name));
    expect(v.errors).toEqual([]);
    expect(v.warnings).toEqual([]); // a warning in a TEMPLATE is a bug in the template
    expect(v.ok).toBe(true);
    expect(v.manifest.name).toBe(name);
    expect(v.manifest.apiVersion).toBe(1);
  });
}

test('an unfilled template is REFUSED — a stray {{name}} can never load as an extension', () => {
  const root = tmp();
  const dest = path.join(root, 'user', 'extensions', 'raw');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(path.join(TEMPLATES, 'tab'), dest, { recursive: true });
  const v = validate(root, dest);
  expect(v.ok).toBe(false);
  expect(v.errors.join(' ')).toContain('name must match');
});

// ---------------------------------------------------------------------------
// what each template actually contributes (the skill's table must stay true)
// ---------------------------------------------------------------------------
test('each template contributes exactly the kind it is named after', () => {
  const root = tmp();
  const m = (t: string, n: string) => validate(root, scaffold(root, t, n)).manifest;

  const tab = m('tab', 'demo-tab');
  expect(tab.tabs).toHaveLength(1);
  expect(tab.tabs[0].entry.startsWith('ui/')).toBe(true);
  expect(tab.tabs[0].id).toBe('main');
  expect(tab.permissions).toContain('session:message');

  const listener = m('listener', 'demo-listener');
  expect(listener.listeners).toHaveLength(1);
  expect(listener.listeners[0].type).toBe('demo-listener-events');
  expect(listener.listeners[0].export).toBe('provider');
  expect(listener.webhooks[0].listener).toBe('demo-listener-events');

  const tool = m('tool', 'demo-tool');
  expect(tool.tools[0].kind).toBe('module');
  expect(tool.docs[0].skill).toBe('demo-tool');
  expect(tool.docs[0].description.length).toBeGreaterThan(20); // the trigger text

  const hooks = m('hooks', 'demo-hooks');
  expect(hooks.hooks.module).toBe('hooks.ts');
  expect(hooks.hooks.gates).toEqual(['merge.before']);
});

// ---------------------------------------------------------------------------
// the tab template and the sandbox rule
// ---------------------------------------------------------------------------
test('the tab template talks ONLY through window.arigami — no /__api, no token, no localhost', () => {
  const raw = fs.readFileSync(path.join(TEMPLATES, 'tab', 'ui', 'index.html'), 'utf8');
  const html = raw.replace(/<!--[\s\S]*?-->/g, '').replace(/^\s*\/\/.*$/gm, ''); // comments explain the rule; code must obey it
  expect(html).toContain('<script src="/__ext-sdk.js"></script>');
  expect(html).toContain('arigami.ready()');
  expect(html).toContain('arigami.sendPrompt(');
  expect(html).not.toContain('/__api');
  expect(html).not.toContain('fetch(');
  expect(html).not.toContain('ARIGAMI_TOKEN');
  expect(html).not.toContain('localhost');
  expect(raw).toContain('dir="auto"'); // RTL-aware, per the skill: direction follows the page's language, not a hardcoded one
});

// ---------------------------------------------------------------------------
// the skill itself — discovery (server/skills.ts needs both of these)
// ---------------------------------------------------------------------------
test('build-extension is discoverable as a skill: lowercase dir + a description in the frontmatter', () => {
  expect(path.basename(SKILL)).toMatch(/^[a-z0-9][a-z0-9-]*$/);
  const md = fs.readFileSync(path.join(SKILL, 'SKILL.md'), 'utf8');
  const fm = /^---\n([\s\S]*?)\n---/.exec(md);
  expect(fm).not.toBeNull();
  const description = /^description:\s*(.+)$/m.exec(fm![1])?.[1] || '';
  expect(description.length).toBeGreaterThan(80);
  // the triggers the task asks for, in both languages
  for (const t of ['tab', 'listener', 'tool', 'תבנה לי טאב', 'תוסיף כלי', 'תעקוב אחרי', 'מאזין', 'הרחבה'])
    expect(description).toContain(t);
  // the reference the skill tells Claude to read before writing a tab
  expect(fs.existsSync(path.join(SKILL, 'reference', 'browser-sdk.md'))).toBe(true);
  expect(md).toContain('reference/browser-sdk.md');
});
