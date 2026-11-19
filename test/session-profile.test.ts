// Restricted run mode (server/session-profile.ts): the profile model, the narrowing (child ⊆ parent) rule, the
// policy layers every engine's enforcement reads, the per-session API scope and the messaging rule — pure, no host.
import { test, expect, describe } from 'bun:test';
import * as sp from '../server/session-profile.ts';
import * as pol from '../server/agent-policy.ts';

const P = (spec: sp.ProfileSpec, parent: string | null = null) => sp.fromSpec(spec, parent);

// Tool names spanning every kind the allowlist knows: built-ins (restricted + always-on), host tools (core + not),
// external MCP tools, codex aliases.
const NAMES = [
  'Bash', 'Edit', 'Write', 'Read', 'Grep', 'WebFetch', 'WebSearch', 'Agent', 'CronCreate', 'shell', 'apply_patch',
  'create_session', 'task_session', 'send_message', 'report_to_master', 'set_title', 'memory_write', 'memory_search',
  'list_agents', 'request_setup', 'cronjob', 'register_listener', 'list_listeners', 'cancel_listener', 'open_tab',
  'publish_artifact', 'share_artifact', 'capture_screen', 'request_screen', 'desktop_pointer', 'browser_open',
  'shared_desktop_acquire', 'sign_in', 'vault_fill', 'host_restart', 'create_agent', 'whatsapp',
  'mcp__arigami__open_tab', 'mcp__composio-mcp__GMAIL_SEND', 'mcp__composio-mcp__GOOGLECALENDAR_LIST', 'mcp__linear__save_issue',
  'mcp__ext-chromatic__run',
];

const SPECS: sp.ProfileSpec[] = [
  {},
  { tools: ['git'] },
  { tools: ['git', 'web'], desktop: 'own', maySpawn: true },
  { tools: ['git', 'sessions', 'triggers'], desktop: 'shared', maySpawn: true, triggers: true, hostRoutes: ['memory', 'setup'] },
  { tools: ['mcp__composio-mcp__GMAIL_*', 'Bash'], talkTo: ['parent'], hostRoutes: ['agents'] },
  { tools: null, desktop: 'shared', talkTo: ['parent', 'children'], maySpawn: true, triggers: true, hostRoutes: Object.keys(sp.HOST_ROUTE_GROUPS) },
  { hostTools: ['open_tab', 'publish_artifact'], tools: ['git'], domains: ['example.com'] },
  { tools: ['ext:chromatic', 'mcp__linear__*'], desktop: 'own', talkTo: [] },
];

const allows = (p: sp.SessionProfile | null, name: string) => pol.toolAllowed(sp.policyForSession(p ? { profile: p } : {}), name);

describe('the profile model', () => {
  test('a spec missing fields starts closed: no desktop, no spawn, no triggers, no host routes, talks to parent+children', () => {
    const p = P({});
    expect(p).toMatchObject({ desktop: 'none', maySpawn: false, triggers: false, hostRoutes: [], talkTo: ['parent', 'children'], layers: [] });
  });
  test('unknown values are dropped, not trusted', () => {
    const p = P({ desktop: 'everything' as any, talkTo: ['parent', 'anyone' as any], hostRoutes: ['memory', 'root'] });
    expect(p.desktop).toBe('none');
    expect(p.talkTo).toEqual(['parent']);
    expect(p.hostRoutes).toEqual(['memory']);
  });
  test('the shipped "restricted" profile resolves by name; "full" and unknown ids are no profile', () => {
    expect(sp.namedProfile('restricted')?.layers[0].tools).toContain('Bash');
    expect(sp.namedProfile('full')).toBeNull();
    expect(sp.namedProfile('nope')).toBeNull();
    expect(sp.knownProfile('full') && sp.knownProfile('restricted') && !sp.knownProfile('nope')).toBe(true);
  });
});

describe('the subset rule: a child can only narrow its parent', () => {
  test('inheriting with no narrowing gives exactly the parent profile (with the child\'s own parent pointer)', () => {
    for (const s of SPECS) {
      const parent = P(s, 'sess_root');
      const child = sp.narrow(parent, null, 'sess_parent')!;
      expect({ ...child, parent: null }).toEqual({ ...parent, parent: null });
      expect(child.parent).toBe('sess_parent');
      expect(sp.isWithin(child, parent)).toBe(true);
    }
  });
  test('every parent × every narrowing: child ⊆ parent on every axis, and on every tool name', () => {
    for (const ps of SPECS)
      for (const cs of SPECS) {
        const parent = P(ps);
        const child = sp.narrow(parent, cs, 'sess_p')!;
        expect(sp.isWithin(child, parent)).toBe(true);
        // …and within the narrowing spec too: both are upper bounds.
        expect(sp.isWithin(child, { ...P(cs), layers: child.layers.filter((l) => P(cs).layers.some((x) => JSON.stringify(x) === JSON.stringify(l))) })).toBe(true);
        for (const n of NAMES) {
          if (allows(child, n)) {
            expect(allows(parent, n)).toBe(true);
            expect(allows(P(cs), n)).toBe(true);
          }
        }
        for (const d of ['none', 'own', 'shared'] as const) if (child.desktop === d) expect(['none', 'own', 'shared'].indexOf(d)).toBeLessThanOrEqual(['none', 'own', 'shared'].indexOf(parent.desktop));
        expect(child.talkTo.every((t) => parent.talkTo.includes(t))).toBe(true);
        if (child.maySpawn) expect(parent.maySpawn).toBe(true);
        if (child.triggers) expect(parent.triggers).toBe(true);
        expect(child.hostRoutes.every((g) => parent.hostRoutes.includes(g))).toBe(true);
      }
  });
  test('a child asking for MORE gets no more: wide spec under a narrow parent', () => {
    const parent = P({ tools: ['git'], desktop: 'none', maySpawn: false, triggers: false, talkTo: ['parent'] });
    const child = sp.narrow(parent, { tools: null, desktop: 'shared', maySpawn: true, triggers: true, talkTo: ['parent', 'children'], hostRoutes: ['memory'] })!;
    expect(child).toMatchObject({ desktop: 'none', maySpawn: false, triggers: false, talkTo: ['parent'], hostRoutes: [] });
    expect(allows(child, 'WebFetch')).toBe(false);
    expect(allows(child, 'Bash')).toBe(true);
  });
  test('narrowing chains: grandchild ⊆ child ⊆ parent, and the layers only ever grow', () => {
    const a = P({ tools: ['git', 'web', 'sessions'], maySpawn: true, desktop: 'shared' });
    const b = sp.narrow(a, { tools: ['git', 'sessions'], maySpawn: true, desktop: 'own' })!;
    const c = sp.narrow(b, { tools: ['Bash', 'Read'], desktop: 'shared' })!;
    expect(sp.isWithin(b, a) && sp.isWithin(c, b) && sp.isWithin(c, a)).toBe(true);
    expect(c.layers.length).toBe(3);
    expect(allows(c, 'Edit')).toBe(false); // the last layer dropped it
    expect(allows(c, 'WebFetch')).toBe(false); // the middle layer dropped it
    expect(c.desktop).toBe('own');
  });
  test('isWithin catches a widened child on each axis', () => {
    const parent = P({ tools: ['git'], desktop: 'own', talkTo: ['parent'], maySpawn: false, triggers: false, hostRoutes: [] });
    expect(sp.isWithin({ ...parent, desktop: 'shared' }, parent)).toBe(false);
    expect(sp.isWithin({ ...parent, talkTo: ['parent', 'children'] }, parent)).toBe(false);
    expect(sp.isWithin({ ...parent, maySpawn: true }, parent)).toBe(false);
    expect(sp.isWithin({ ...parent, triggers: true }, parent)).toBe(false);
    expect(sp.isWithin({ ...parent, hostRoutes: ['memory'] }, parent)).toBe(false);
    expect(sp.isWithin({ ...parent, layers: [] }, parent)).toBe(false); // dropped the parent's allowlist
    expect(sp.isWithin(null, parent)).toBe(false); // Full is never within a restriction
    expect(sp.isWithin(parent, null)).toBe(true); // everything is within Full
  });
  test('a Full parent with no other source → a Full child (null): nothing changes for Full sessions', () => {
    expect(sp.resolveForNewSession({ parent: { id: 'sess_a' } })).toBeNull();
    expect(sp.resolveForNewSession({})).toBeNull();
    expect(sp.resolveForNewSession({ explicit: 'full' })).toBeNull();
  });
  test('resolveForNewSession: the parent\'s profile is inherited and an explicit pick can only narrow it', () => {
    const parent = { id: 'sess_p', profile: P({ tools: ['git'], maySpawn: true, desktop: 'own' }) };
    const r = sp.resolveForNewSession({ parent, explicit: { tools: null, desktop: 'shared', maySpawn: true } })!;
    expect(r.parent).toBe('sess_p');
    expect(sp.isWithin(r, parent.profile)).toBe(true);
    expect(r.desktop).toBe('own');
    expect(sp.resolveForNewSession({ parent, explicit: 'full' })).toMatchObject({ desktop: 'own', parent: 'sess_p' }); // 'full' cannot widen
  });
});

describe('the policy every engine enforces (A3 layers)', () => {
  test('a Full session without an agent has no policy (null) — the spawn adds no flags, no hook', () => {
    expect(sp.policyForSession({})).toBeNull();
    expect(sp.policyForSession({ metadata: {} })).toBeNull();
    expect(pol.disallowedToolsFor(null, ['composio-mcp'])).toEqual([]);
    expect(pol.strictMcpFor(null)).toBe(false);
  });
  test('an agent-only policy behaves exactly as before the layers existed', () => {
    const a: pol.Policy = { slug: 'bot', tools: pol.expandTools(['gmail', 'desktop']), domains: ['example.com'], autoApprove: [] };
    expect(pol.isRestrictive(a)).toBe(true);
    expect(pol.disallowedToolsFor(a, ['composio-mcp', 'linear'])).toEqual(['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Agent', 'Task', 'CronCreate', 'CronDelete', 'CronList', 'mcp__linear']);
    expect(pol.strictMcpFor(a)).toBe(false);
    expect(pol.serverReachable(a, 'composio-mcp')).toBe(true);
    expect(pol.serverReachable(a, 'linear')).toBe(false);
    expect(pol.toolAllowed(a, 'memory_write')).toBe(true); // CORE stays on for an agent
    expect(pol.checkToolCall(a, 'Bash', {}).reason).toContain('agent bot');
    const domainsOnly: pol.Policy = { slug: 'd', tools: null, domains: ['example.com'], autoApprove: [] };
    expect(pol.disallowedToolsFor(domainsOnly, ['linear'])).toEqual([]);
    expect(pol.capabilityDenied(domainsOnly, 'composio:gmail')).toBe(false);
  });
  test('the restricted profile: built-ins and servers outside it are denied at spawn; flags beat CORE tools', () => {
    const p = sp.policyForSession({ profile: sp.namedProfile('restricted')! })!;
    expect(pol.isRestrictive(p)).toBe(true);
    const denied = pol.disallowedToolsFor(p, ['composio-mcp', 'linear']);
    expect(denied).toContain('WebFetch');
    expect(denied).toContain('CronCreate');
    expect(denied).toContain('mcp__composio-mcp');
    expect(denied).not.toContain('Bash');
    expect(pol.strictMcpFor(p)).toBe(true);
    for (const t of ['memory_write', 'list_agents', 'request_setup', 'create_session', 'cronjob', 'host_restart', 'sign_in', 'capture_screen']) expect(pol.toolAllowed(p, t)).toBe(false);
    for (const t of ['report_to_master', 'set_title', 'request_action', 'Read', 'Bash', 'list_listeners']) expect(pol.toolAllowed(p, t)).toBe(true);
    expect(pol.checkToolCall(p, 'WebFetch', {}).reason).toContain('profile');
  });
  test('desktop modes: own keeps its own screen, never the owner\'s; shared keeps both', () => {
    const own = sp.policyForSession({ profile: P({ tools: null, desktop: 'own' }) });
    expect(pol.toolAllowed(own, 'desktop_pointer')).toBe(true);
    expect(pol.toolAllowed(own, 'browser_open')).toBe(true);
    expect(pol.toolAllowed(own, 'shared_desktop_acquire')).toBe(false);
    expect(pol.toolAllowed(own, 'sign_in')).toBe(false);
    const shared = sp.policyForSession({ profile: P({ tools: null, desktop: 'shared' }) });
    expect(pol.toolAllowed(shared, 'shared_desktop_acquire') && pol.toolAllowed(shared, 'sign_in')).toBe(true);
  });
  test('an agent session with a profile: both must allow (the profile narrows the agent, never widens it)', () => {
    const agent: pol.Policy = { slug: 'bot', tools: pol.expandTools(['gmail', 'web']), domains: null, autoApprove: [] };
    const both: pol.Policy = { ...agent, and: sp.profilePolicies(P({ tools: ['web', 'git'], hostRoutes: [] })) };
    expect(pol.toolAllowed(both, 'WebFetch')).toBe(true);
    expect(pol.toolAllowed(both, 'Bash')).toBe(false); // the agent lacks git
    expect(pol.toolAllowed(both, 'mcp__composio-mcp__GMAIL_SEND')).toBe(false); // the profile lacks gmail
    expect(pol.serverReachable(both, 'composio-mcp')).toBe(false);
  });
  test('domains intersect across layers', () => {
    const p = sp.policyForSession({ profile: sp.narrow(P({ tools: null, domains: ['example.com', 'example.org'] }), { tools: null, domains: ['example.org'] })! });
    expect(pol.domainAllowed(p, 'https://example.org/x')).toBe(true);
    expect(pol.domainAllowed(p, 'https://example.com/x')).toBe(false);
    expect(pol.domainAllowed(p, 'http://localhost:5173')).toBe(true);
  });
});

describe('per-session API scope', () => {
  const sessions: Record<string, any> = {
    full: { id: 'full' },
    parent: { id: 'parent', profile: P({ tools: ['git'], maySpawn: true }) },
    me: { id: 'me', profile: P({ tools: ['git', 'publish'], maySpawn: false, desktop: 'own' }, 'parent') },
    kid: { id: 'kid', profile: P({ tools: ['git'] }, 'me') },
    stranger: { id: 'stranger' },
  };
  const deps = { getSession: (id: string) => sessions[id] || null, toolAllowed: (me: any, t: string) => pol.toolAllowed(sp.policyForSession(me), t) };
  const scope = (caller: string, m: string, p: string, upgrade = false) => sp.scopeRefusal(caller, m, p, { ...deps, upgrade });

  test('a Full session is never scoped (today\'s behaviour)', () => {
    for (const [m, p] of [['GET', '/__api/sessions/stranger'], ['POST', '/__api/triggers'], ['GET', '/__api/config'], ['PUT', '/__api/session-profiles'], ['POST', '/__api/host/restart']])
      expect(scope('full', m, p)).toBeNull();
    expect(scope('full', 'GET', '/__ws', true)).toBeNull();
  });
  test('its own session: plumbing yes, what the profile lacks no, unknown sub-routes no', () => {
    for (const [m, p] of [['GET', '/__api/sessions/me'], ['PATCH', '/__api/sessions/me'], ['POST', '/__api/sessions/me/policy/check'], ['GET', '/__api/sessions/me/policy'], ['POST', '/__api/sessions/me/report'], ['POST', '/__api/sessions/me/action'], ['POST', '/__api/sessions/me/artifacts'], ['POST', '/__api/sessions/me/desktop/act'], ['POST', '/__api/sessions/me/browser/open'], ['GET', '/__api/sessions/me/listeners']])
      expect(scope('me', m, p)).toBeNull();
    for (const [m, p] of [['DELETE', '/__api/sessions/me'], ['POST', '/__api/sessions/me/listeners'], ['POST', '/__api/sessions/me/shared-desktop/acquire'], ['POST', '/__api/sessions/me/sign-in'], ['POST', '/__api/sessions/me/vault/fill'], ['POST', '/__api/sessions/me/adopt-agent'], ['POST', '/__api/sessions/me/action/answer'], ['POST', '/__api/sessions/me/delegate'], ['POST', '/__api/sessions/me/permission/answer'], ['POST', '/__api/sessions/me/merge']])
      expect(scope('me', m, p)).toContain('restricted session');
  });
  test('other sessions: its parent (send only), its children (lifecycle + task/send), nobody else', () => {
    expect(scope('me', 'POST', '/__api/sessions/parent/send')).toBeNull();
    expect(scope('me', 'GET', '/__api/sessions/parent')).toContain('parent');
    expect(scope('me', 'POST', '/__api/sessions/parent/task')).toContain('parent');
    expect(scope('me', 'GET', '/__api/sessions/kid')).toBeNull();
    expect(scope('me', 'DELETE', '/__api/sessions/kid')).toBeNull();
    expect(scope('me', 'POST', '/__api/sessions/kid/task')).toBeNull();
    expect(scope('me', 'POST', '/__api/sessions/kid/send')).toBeNull();
    expect(scope('me', 'PATCH', '/__api/sessions/kid')).toContain('child');
    for (const t of ['stranger', 'full']) {
      expect(scope('me', 'POST', `/__api/sessions/${t}/send`)).toContain('only reach');
      expect(scope('me', 'GET', `/__api/sessions/${t}`)).toContain('only reach');
    }
  });
  test('talkTo without "parent" / "children" closes those channels', () => {
    sessions.mute = { id: 'mute', profile: P({ tools: ['git'], talkTo: [] }, 'parent') };
    sessions.mutekid = { id: 'mutekid', profile: P({}, 'mute') };
    expect(scope('mute', 'POST', '/__api/sessions/parent/send')).not.toBeNull();
    expect(scope('mute', 'POST', '/__api/sessions/mutekid/task')).not.toBeNull();
    expect(scope('mute', 'DELETE', '/__api/sessions/mutekid')).toBeNull(); // lifecycle of its own child stays
  });
  test('host routes: only what the profile allows', () => {
    expect(scope('me', 'GET', '/__api/listener-types')).toBeNull();
    expect(scope('me', 'POST', '/__mcp/wait')).toBeNull();
    expect(scope('me', 'POST', '/__mcp/s/arigami')).toBeNull(); // judged in the gateway
    expect(scope('me', 'GET', '/__api/sessions')).toBeNull(); // filtered to the family by the route
    for (const [m, p] of [['POST', '/__api/sessions'], ['POST', '/__api/triggers'], ['GET', '/__api/triggers'], ['GET', '/__api/config'], ['GET', '/__api/memory/search'], ['POST', '/__api/memory/write'], ['GET', '/__api/agents'], ['PUT', '/__api/session-profiles'], ['POST', '/__api/host/restart'], ['GET', '/__api/accounts'], ['POST', '/__mcp/agent-card'], ['POST', '/__mcp/setup-request'], ['POST', '/__api/whatsapp/tool'], ['GET', '/__artifacts/x/index.html'], ['GET', '/'], ['GET', '/__api/webhooks/events']])
      expect(scope('me', m, p)).toContain('restricted session');
    expect(scope('parent', 'POST', '/__api/sessions')).toBeNull(); // maySpawn
    sessions.mem = { id: 'mem', profile: P({ tools: null, hostRoutes: ['memory'], triggers: true }) };
    expect(scope('mem', 'GET', '/__api/memory/search')).toBeNull();
    expect(scope('mem', 'POST', '/__api/triggers')).toBeNull();
    expect(scope('mem', 'POST', '/__api/sessions/mem/listeners')).toBeNull();
    expect(scope('mem', 'GET', '/__api/agents')).not.toBeNull();
  });
  test('no WebSocket / VNC stream for a restricted token', () => {
    expect(scope('me', 'GET', '/__ws', true)).toContain('WebSocket');
    expect(scope('me', 'GET', '/__vnc/x', true)).toContain('WebSocket');
  });
});

describe('messaging, list and PATCH rules', () => {
  const parent = { id: 'p', profile: P({ maySpawn: true }) };
  const me = { id: 'm', profile: P({}, 'p') };
  const kid = { id: 'k', profile: P({}, 'm') };
  const other = { id: 'o' };
  test('mayMessage: parent and own children only; a Full session may message anyone', () => {
    expect(sp.mayMessage(me, parent)).toBe(true);
    expect(sp.mayMessage(me, kid)).toBe(true);
    expect(sp.mayMessage(me, me)).toBe(true);
    expect(sp.mayMessage(me, other)).toBe(false);
    expect(sp.mayMessage(kid, parent)).toBe(false); // grandparent
    expect(sp.mayMessage(other, me)).toBe(true);
    expect(sp.mayMessage({ id: 'x', profile: P({ talkTo: ['children'] }, 'p') }, parent)).toBe(false);
  });
  test('inFamily: itself, its parent, its children', () => {
    expect([parent, me, kid, other].filter((s) => sp.inFamily(me, s)).map((s) => s.id)).toEqual(['p', 'm', 'k']);
  });
  test('sanitizeOwnPatch keeps cockpit fields and drops every authority key', () => {
    const out = sp.sanitizeOwnPatch({ title: 't', status: 'Done', archived: true, folderId: 'f', action: {}, profile: {}, metadata: { note: 1, master: 'o', agent: 'bot', screen: { vncPort: 5900 }, fromCronTrigger: null, prompts: {} } });
    expect(out).toEqual({ title: 't', status: 'Done', metadata: { note: 1 } });
  });
});
