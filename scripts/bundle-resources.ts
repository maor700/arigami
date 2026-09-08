#!/usr/bin/env bun
// `bun scripts/bundle-resources.ts <dest-dir>`
//
// Copies everything server/lib/resource-root.ts's compiled-binary branch
// expects to find next to the executable, under `<dest-dir>/resources/`
// (bin/host convention: `path.join(dirname(execPath), 'resources')`).
//
// The list below is not a guess — it's every resourceRoot()-relative path
// actually read at runtime (grepped across server/):
//   web/dist/            — the cockpit (index.ts serveHost)
//   sdk/                 — /__ext-sdk.js AND the real dir an extension's
//                          node_modules/@arigami/sdk symlink resolves into
//                          (extensions.ts)
//   skills/ + .claude-plugin/ — the shipped skill pack; Claude Code's
//                          `--plugin-dir ROOT` needs BOTH at ROOT's root
//                          (skills.ts, claude.js pluginDirArgs())
//   mcp/                  — host-mcp.js / policy-hook.js / ext-mcp.js
//                          (bun-exec.ts, in the non-compiled fallback path —
//                          also harmless to ship since bunExec() re-execs
//                          the binary itself once compiled)
//   profiles/             — bundle profiles (profiles.ts, onboarding.ts)
//   server/assets/        — card.jsx (pages.js)
//   server/lib/pty-bridge.py — the pty relay for `gh auth login` etc.
//                          (mcp-auth.js, git-login.ts, accounts-auth.js)
//   package.json          — version fallback (version.ts, backup.ts)
//   VERSION                — version.ts currentVersion()
//
// Deliberately NOT copied: deploy/, control-plane/, Dockerfile,
// docker-compose.yml, install.sh, test/, node_modules/ — none of these are
// read via resourceRoot() at runtime; they're build/deploy-time only.
//
// host-mcp.js and ext-mcp.js get an extra pass below: re-bundled with
// `Bun.build({target:'bun'})` after the plain copy, overwriting it. Why:
// bunExec()'s compiled-binary branch reaches them via
// `await import(<absolute path on disk>)`, NOT through the main
// executable's embedded module graph — loaded fresh from disk, their own
// `import ... from '@modelcontextprotocol/sdk/...'` needs a real
// node_modules tree next to them, which a bare resources/ doesn't ship.
// Verified live: without this, `<binary> --mcp host` fails with
// "Cannot find module '@modelcontextprotocol/sdk/...'". Bundling inlines
// that dependency (and the local blocking-call.js import) so the files are
// self-contained. policy-hook.js has no npm deps (only node: builtins +
// fetch) so it's left as a plain copy.
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

const ENTRIES: { src: string; required: boolean }[] = [
  { src: 'web/dist', required: true },
  { src: 'sdk', required: true },
  { src: 'skills', required: true },
  { src: '.claude-plugin', required: true },
  { src: 'mcp', required: true },
  { src: 'profiles', required: true },
  { src: 'server/assets', required: true },
  { src: 'server/lib/pty-bridge.py', required: true },
  { src: 'package.json', required: true },
  { src: 'VERSION', required: true },
];

function copy(src: string, dest: string): void {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true });
}

async function main(): Promise<void> {
  const destArg = process.argv[2];
  if (!destArg) {
    console.error('usage: bun scripts/bundle-resources.ts <dest-dir>');
    process.exit(1);
  }
  const dest = path.resolve(destArg);
  fs.mkdirSync(dest, { recursive: true });

  for (const { src, required } of ENTRIES) {
    const abs = path.join(REPO_ROOT, src);
    if (!fs.existsSync(abs)) {
      if (required) {
        console.error(`[bundle-resources] missing required resource: ${src}${src === 'web/dist' ? ' — run `bun run build:web` first' : ''}`);
        process.exit(1);
      }
      continue;
    }
    copy(abs, path.join(dest, src));
    console.log(`[bundle-resources] copied ${src}`);
  }

  for (const name of ['host-mcp.js', 'ext-mcp.js']) {
    const entry = path.join(REPO_ROOT, 'mcp', name);
    const out = await Bun.build({ entrypoints: [entry], target: 'bun' });
    if (!out.success) {
      console.error(`[bundle-resources] failed to bundle mcp/${name}:`, out.logs.join('\n'));
      process.exit(1);
    }
    await Bun.write(path.join(dest, 'mcp', name), await out.outputs[0].text());
    console.log(`[bundle-resources] bundled mcp/${name} (inlines @modelcontextprotocol/sdk)`);
  }

  console.log(`[bundle-resources] done → ${dest}`);
}

await main();
