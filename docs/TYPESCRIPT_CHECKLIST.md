# TypeScript Migration Checklist

## Setup Phase
- [ ] Create branch: `git checkout -b feat/typescript-migration`
- [ ] Create `tsconfig.json` in repo root
- [ ] Update `package.json`:
  - [ ] Add `"typecheck": "tsc --noEmit"` script
  - [ ] Verify bun can handle TS natively (no build step needed)
- [ ] Install/verify type packages: `@types/node`, etc.

## Phase 1: Server Core (CRITICAL PATH)

### server/proxy.ts
- [ ] Add types for HTTP request/response
- [ ] Type all exported functions
- [ ] Type internal helpers (INH, KEEP, SCAN, etc.)
- [ ] Type target routing (targetOrigin, refererTarget, etc.)
- [ ] Type header manipulation functions
- [ ] Run: `bun run typecheck` ✓
- [ ] Run: `bun run test` ✓ (49/49 pass)

### server/index.ts
- [ ] Type server creation
- [ ] Type request handlers
- [ ] Type route definitions
- [ ] Run: `bun run typecheck` ✓
- [ ] Run: `bun run test` ✓

### server/lib/config.ts
- [ ] Type configuration object
- [ ] Type config values (port, env vars, etc.)
- [ ] Run: `bun run typecheck` ✓

### server/lib/secrets.ts
- [ ] Type secrets object
- [ ] Run: `bun run typecheck` ✓

### server/api.ts
- [ ] Type REST endpoint handlers
- [ ] Type request/response bodies
- [ ] Run: `bun run typecheck` ✓
- [ ] Run: `bun run test` ✓

### server/claude.ts
- [ ] Type Claude API client
- [ ] Type API request/response types
- [ ] Run: `bun run typecheck` ✓

### server/git.ts
- [ ] Type git operations
- [ ] Type command outputs
- [ ] Run: `bun run typecheck` ✓

### server/state.ts
- [ ] Type session state
- [ ] Type session management functions
- [ ] Run: `bun run typecheck` ✓

## Phase 2: MCP

### mcp/host-mcp.ts
- [ ] Type MCP server
- [ ] Type tool definitions
- [ ] Type tool handlers
- [ ] Run: `bun run typecheck` ✓
- [ ] Run: `bun run test` ✓

## Phase 3: Web (Frontend)

### web/src/components/*.tsx
- [ ] Rail.tsx — type session management
- [ ] TabBar.tsx — type tab operations
- [ ] SessionView.tsx — type session view
- [ ] ChatPane.tsx — type chat state
- [ ] ChangesTab.tsx — type changes
- [ ] Other components — add prop types
- [ ] Run: `bun run build` ✓

### web/src/lib/*.ts
- [ ] store.ts — type Zustand state
- [ ] prefs.ts — type preferences
- [ ] commands.ts — type command handlers
- [ ] Run: `bun run typecheck` ✓

## Validation Checkpoints

After each phase:

```bash
# Type check
bun run typecheck

# Tests
bun run test

# Server runs
PORT=3100 bun server/index.ts &
sleep 2

# Quick proxy test
curl http://localhost:3100/?__target=http://localhost:6021

# Kill server
kill %1
```

## Sign-Off Criteria

- [ ] `tsc --noEmit` produces zero errors
- [ ] `bun run test` shows 49/49 pass (no regressions)
- [ ] HTTP proxy works (manual curl or Playwright test)
- [ ] Storybook loads through proxy at port 3100
- [ ] No runtime errors in normal usage
- [ ] Type coverage: >90% of critical paths

## Known Gotchas

- Bun handles `.ts` and `.tsx` natively — no compilation step needed
- Keep `tsconfig.json` with `"module": "ESNext"` for Bun
- Use `import type { ... }` for type-only imports
- Avoid circular dependencies (use interfaces instead of concrete classes)
- React FC types: `React.FC<Props>` or destructure with types in params

## If Blocked

1. Check PRD (`docs/TYPESCRIPT_MIGRATION_PRD.md`)
2. Check quick start (`docs/TYPESCRIPT_QUICK_START.md`)
3. Bun TypeScript docs: https://bun.sh/docs/runtime/typescript
4. TypeScript handbook: https://www.typescriptlang.org/docs/

## Progress Tracking

**Session started:** _______________  
**Phase 1 complete:** _______________  
**Phase 2 complete:** _______________  
**Phase 3 complete:** _______________  
**Sign-off date:** _______________

