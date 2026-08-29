# TypeScript Migration PRD

## Overview

Migrate the Arigami codebase from JavaScript to TypeScript to add type safety, improve IDE support, catch bugs at compile-time, and enhance maintainability.

**Status:** Planning  
**Branch:** `feat/typescript-migration` (to be created)  
**Timeline:** Incremental, non-blocking

## Goals

1. **Type Safety** — Eliminate entire classes of runtime bugs (null checks, type mismatches, etc.)
2. **Developer Experience** — Full IDE autocomplete, refactoring support, inline documentation
3. **Code Quality** — Catch errors before runtime, self-documenting code
4. **Maintainability** — Easier to refactor, understand, and extend the codebase

## Success Criteria

- ✅ All server code (backend) compiles without errors
- ✅ All web code (frontend) compiles without errors
- ✅ All 49 existing tests pass
- ✅ Zero runtime regressions in production paths
- ✅ Type coverage >90% (strict mode for critical paths)

## Scope

### Phase 1: Server (Backend) — HIGH PRIORITY
**Goal:** Ensure routing logic is bulletproof with types

```
server/
├── proxy.ts          (★ CRITICAL — reverse proxy routing)
├── index.ts          (entry point, server setup)
├── api.ts            (REST endpoints)
├── claude.ts         (Claude API integration)
├── git.ts            (git operations)
├── state.ts          (session state management)
├── lib/config.ts     (configuration)
└── lib/secrets.ts    (secrets management)

mcp/
└── host-mcp.ts       (Host MCP server)
```

### Phase 2: Web (Frontend) — MEDIUM PRIORITY
**Goal:** Type-safe React components and state

```
web/src/
├── main.tsx
├── App.tsx
├── components/
│   ├── Rail.tsx
│   ├── SessionView.tsx
│   ├── ChatPane.tsx
│   ├── ChangesTab.tsx
│   ├── TabBar.tsx
│   └── ... (other components)
├── lib/
│   ├── store.ts      (Zustand state)
│   ├── prefs.ts      (preferences)
│   └── commands.ts   (command bus)
└── ...
```

## Technical Approach

### Configuration

**tsconfig.json (Bun-compatible)**
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "moduleResolution": "bundler",
    "strict": true,
    "jsx": "react-jsx",
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["server/**/*.ts", "mcp/**/*.ts", "web/src/**/*.ts", "web/src/**/*.tsx"],
  "exclude": ["node_modules", "dist", "build"]
}
```

**package.json scripts**
```json
{
  "scripts": {
    "typecheck": "tsc --noEmit",
    "dev": "bun server/index.ts",
    "test": "bun test",
    "build": "bun run typecheck && bun build --target=bun server/index.ts"
  }
}
```

### Port Configuration for Parallel Testing

To allow you to continue working on the original instance while testing the TypeScript branch:

- **Main instance:** PORT=3099 (your current production)
- **TypeScript branch:** PORT=3100 (test/validation instance)
- **Storybook:** Can use same config, different ports assigned per worktree

**Implementation:**
```bash
# In .env or config
PORT=${PORT:-3099}
STORYBOOK_PORT=${STORYBOOK_PORT:-6021}
```

Then run TypeScript instance:
```bash
PORT=3100 bun server/index.ts
```

### Migration Strategy

**Order (incremental, tests after each phase):**

1. **Setup** (5 min)
   - Add tsconfig.json
   - Update package.json with typecheck script
   - Install @types/* packages

2. **Server Core** (2-3 hours)
   - `server/proxy.ts` — routing types (HTTP, proxying)
   - `server/index.ts` — server types
   - `server/lib/*.ts` — config, secrets
   - Run tests after each file ✓ Tests at port 3100

3. **Server Integrations** (1-2 hours)
   - `server/api.ts` — REST routes
   - `server/claude.ts` — Claude API integration
   - `server/git.ts` — git operations
   - `server/state.ts` — session state
   - Run tests ✓

4. **MCP** (30 min)
   - `mcp/host-mcp.ts` — MCP server types
   - Run tests ✓

5. **Web** (2-3 hours)
   - React components: gradually add types
   - State management (Zustand)
   - Utility functions
   - Run tests/build ✓

### Type Definitions

**Priority order:**
1. Function signatures (most impactful)
2. Critical state/data structures
3. API request/response types
4. React component props

**Use `unknown` → `any` only if absolutely necessary** (and document why)

## Testing & Validation

### Continuous validation (after each phase):
```bash
# Type check
bun run typecheck

# Run existing tests (should all pass)
bun run test

# Run server on test port
PORT=3100 bun server/index.ts &

# Verify basic proxy functionality
curl http://localhost:3100/?__target=http://localhost:6021

# Verify Storybook loads
# (manual browser check or Playwright test)
```

### No breaking changes
- All existing tests must pass
- No changes to runtime behavior
- No changes to API contracts
- Backward compatible with deployed versions

## Files to Create/Modify

### Create
- `tsconfig.json` — TypeScript config
- `types/` directory (if needed for shared types)

### Modify
- `package.json` — Add typecheck script, update dev script
- All `.js` files → `.ts` / `.tsx`
- May need to add `.d.ts` files for external deps without types

### No changes
- Runtime behavior
- Tests (Bun test syntax works with TS)
- CI/CD pipeline (Bun handles TS natively)

## Rollback Plan

If issues arise:
1. Branch can be abandoned anytime (zero impact to main)
2. Main branch continues working at PORT=3099
3. Simple revert: `git checkout main`

## Expected Outcomes

After completion:

**Before:**
```javascript
// proxy.js — unclear types
export const rewriteLocation = (location, upstreamOrigin) => {
  try { return new URL(location).origin === upstreamOrigin ? ... }
}
```

**After:**
```typescript
// proxy.ts — fully typed
export const rewriteLocation = (
  location: string | null,
  upstreamOrigin: string | null
): string | null => {
  try { return new URL(location).origin === upstreamOrigin ? ... }
}
```

## Notes

- Bun has excellent TypeScript support (no separate compilation needed for dev)
- Tests will continue to work as-is (Bun test supports TS natively)
- Focus on routing code first (highest ROI, most critical)
- Web code can be gradually migrated (lower risk)

---

**Created:** 2026-06-18  
**Questions?** Reference this PRD in the TypeScript migration session
