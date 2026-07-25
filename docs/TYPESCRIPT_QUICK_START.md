# TypeScript Migration — Quick Start

## TL;DR

1. Create branch: `git checkout -b feat/typescript-migration`
2. Add `tsconfig.json` (from PRD)
3. Migrate server code first (proxy → api → state)
4. Run tests on PORT=3100: `PORT=3100 bun run test`
5. Migrate web code
6. Keep original instance at PORT=3099 running

## Current Status

- **Proxy fixes:** ✅ Committed (3 commits)
  - Referer fallback routing
  - Nested iframe inheritance  
  - Full target injection
  - WebSocket routing via cookie
  - MutationObserver iframe tracking (no polling)

- **Tests:** ✅ 49/49 pass
- **Storybook:** ✅ Working through proxy

## Parallel Instance Setup

```bash
# Terminal 1: Original instance (PORT=3099) — you keep working
bun server/index.js

# Terminal 2: TypeScript branch (PORT=3100) — test instance
PORT=3100 bun server/index.ts
```

Both run simultaneously. No conflicts.

## Migration Checklist

### Phase 1: Server
- [ ] Create `tsconfig.json`
- [ ] Update `package.json` (typecheck script)
- [ ] Migrate `server/proxy.ts` (CRITICAL)
  - [ ] Type HTTP methods, headers, request/response
  - [ ] Type target routing functions
  - [ ] Tests pass ✓
- [ ] Migrate `server/index.ts`
  - [ ] Type server setup, routes
  - [ ] Tests pass ✓
- [ ] Migrate remaining server files
  - [ ] `api.ts`, `claude.ts`, `git.ts`, `state.ts`
  - [ ] `lib/config.ts`, `lib/secrets.ts`
  - [ ] Tests pass ✓
- [ ] Migrate `mcp/host-mcp.ts`
  - [ ] Tests pass ✓

### Phase 2: Web
- [ ] Migrate React components (src/components/*.tsx)
  - [ ] Start with `Rail.tsx`, `TabBar.tsx`
  - [ ] Add prop types, state types
- [ ] Migrate state (src/lib/*.ts)
  - [ ] Zustand store types
  - [ ] Preferences, commands
- [ ] Migrate utilities
- [ ] Build verification

## Testing Each Phase

```bash
# After each file or phase:
PORT=3100 bun run typecheck    # TypeScript check
PORT=3100 bun run test         # Run tests
```

## Key Type Definitions to Create

**proxy.ts:**
```typescript
interface ProxyRequest extends IncomingMessage {
  headers: Record<string, string | string[]>;
  url: string;
}

interface ProxyResponse extends ServerResponse {
  writeHead(code: number, headers: OutgoingHttpHeaders): void;
  end(data?: string | Buffer): void;
}

type TargetOrigin = string | null;
type ProxyPath = string;
```

**state.ts:**
```typescript
interface Session {
  id: string;
  title: string;
  status: 'In Progress' | 'Done' | 'Approved';
  metadata: Record<string, any>;
}

interface TabData {
  id: string;
  type: 'url' | 'ticket';
  url: string;
  title: string;
}
```

**React components:**
```typescript
interface RailProps {
  sessions: Session[];
  onSelectSession: (id: string) => void;
}

const Rail: React.FC<RailProps> = ({ sessions, onSelectSession }) => { ... }
```

## Common Patterns

**Before (JS):**
```javascript
function getTarget(req) {
  return targetOrigin(req.headers['x-poc-target']);
}
```

**After (TS):**
```typescript
function getTarget(req: IncomingMessage): string | null {
  const header = req.headers['x-poc-target'];
  if (!header) return null;
  const raw = Array.isArray(header) ? header[0] : header;
  return targetOrigin(raw);
}
```

## When Stuck

- Check the PRD (`docs/TYPESCRIPT_MIGRATION_PRD.md`)
- Reference Bun's TypeScript docs: https://bun.sh/docs/runtime/typescript
- Keep scope small: one file at a time
- Run tests frequently to catch issues early

## Success Markers

✅ Tests pass at PORT=3100  
✅ No type errors on `tsc --noEmit`  
✅ Proxy still routes correctly  
✅ Storybook loads through proxy at 3100  

---

**Start in new session → Follow PRD → Reference this guide**
