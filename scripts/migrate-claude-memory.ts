// One-time, MANUAL migration (spec M1.6): propose — never write directly —
// pending facts in Arigami's own host memory ($ARIGAMI_DIR/memory/), sourced
// from Claude Code's own auto-memory files for the general "repos" workspace
// project (predates $ARIGAMI_DIR/memory — a separate store this script never
// touches). Every extracted fact lands in memory/pending.json as
// status:"pending"; nothing reaches USER.md/MEMORY.md until a human approves
// it via POST /__api/memory/pending/:id/approve (or the future M4 UI).
//
// Usage: bun scripts/migrate-claude-memory.ts [source-dir]
//   source-dir defaults to ~/.claude/projects/-home-arigami-repos/memory
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { proposeFacts } from '../server/memory.ts';

const SRC_DIR =
  process.argv[2] || path.join(os.homedir(), '.claude', 'projects', '-home-arigami-repos', 'memory');

function parseFrontmatter(content: string): Record<string, string> {
  const m = content.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const out: Record<string, string> = {};
  for (const line of m[1].split('\n')) {
    const mm = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (mm) out[mm[1]] = mm[2].trim();
  }
  return out;
}

function main(): void {
  if (!fs.existsSync(SRC_DIR)) {
    console.error(`no such source directory: ${SRC_DIR} — nothing to migrate.`);
    process.exit(1);
  }
  const files = fs
    .readdirSync(SRC_DIR)
    .filter((f) => f.endsWith('.md') && f !== 'MEMORY.md'); // MEMORY.md there is just an index, not a fact
  let proposed = 0;
  let skipped = 0;
  for (const f of files) {
    const full = path.join(SRC_DIR, f);
    const raw = fs.readFileSync(full, 'utf8');
    const fm = parseFrontmatter(raw);
    if (!fm.description) {
      skipped++;
      continue;
    }
    const target = fm.type === 'user' ? 'user' : 'memory';
    const line = fm.description.slice(0, 400);
    const created = proposeFacts([line], { source: `migration:${f}`, target });
    if (created.length) {
      proposed++;
      console.log(`+ [${target}] ${line}`);
    } else {
      skipped++;
      console.log(`- skipped (empty/duplicate/unsafe): ${f}`);
    }
  }
  console.log(`\nmigration done: proposed ${proposed} pending fact(s), skipped ${skipped}.`);
  console.log('Nothing was written to USER.md/MEMORY.md — review and approve via POST /__api/memory/pending/:id/approve.');
}

main();
