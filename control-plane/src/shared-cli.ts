// `bun src/cli.ts shared …` — the operator's front door to shared workspaces (the admin page is the other one;
// both call shared-ops.ts). Whoever can run this already holds the control plane's database, so it is
// org-admin by construction; `--by` names the person for the log (default: $USER).
//
//   shared list   [<name>]
//   shared create <name> [--policy explicit|org] [--default-role <role>] [--no-org-host] [--owner <email>]
//   shared add-member    <name> <email> [--role owner|admin|member|viewer]
//   shared remove-member <name> <email>
//   shared set-policy    <name> explicit|org [--default-role <role>]
//   shared delete <name> --yes
//   shared sync   [<name>]          push the member roster into the pod(s) now
import { SHARED_ROLES, isMemberPolicy, isSharedRole, type SharedRole } from './shared.js';
import { SharedError, createShared, addMember, removeMember, setPolicy, deleteShared, syncRoster, rosterSyncTick, type SharedDeps } from './shared-ops.js';

export const SHARED_USAGE =
  'usage: bun src/cli.ts shared list [<name>] | create <name> [--policy explicit|org] [--default-role <role>] [--no-org-host] [--owner <email>]\n' +
  '                         | add-member <name> <email> [--role <role>] | remove-member <name> <email>\n' +
  '                         | set-policy <name> explicit|org [--default-role <role>] | delete <name> --yes | sync [<name>]\n' +
  `  roles: ${SHARED_ROLES.join(', ')}\n`;

function parse(argv: string[]): { pos: string[]; flags: Record<string, string | true> } {
  const pos: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { pos.push(a); continue; }
    const [k, v] = a.slice(2).split('=', 2);
    if (v !== undefined) flags[k] = v;
    else if (['policy', 'default-role', 'role', 'owner', 'by'].includes(k) && argv[i + 1] !== undefined) flags[k] = argv[++i];
    else flags[k] = true;
  }
  return { pos, flags };
}

const role = (v: string | true | undefined, def: SharedRole): SharedRole => {
  const r = typeof v === 'string' ? v : def;
  if (!isSharedRole(r)) throw new SharedError(`role must be one of ${SHARED_ROLES.join(', ')}`);
  return r;
};

/** Returns the process exit code. Output is JSON on `out`, errors as one line on `err`. */
export async function runSharedCli(argv: string[], deps: SharedDeps, out: (o: unknown) => void, err: (s: string) => void, env = process.env): Promise<number> {
  const { pos, flags } = parse(argv);
  const [sub, name, arg] = pos;
  const by = typeof flags.by === 'string' ? flags.by : `cli:${env.USER || 'operator'}`;
  const { store } = deps;
  const view = (t: NonNullable<ReturnType<typeof store.findShared>>) => ({
    name: t.name, ns: t.ns, state: t.state, policy: t.member_policy, defaultRole: t.default_role,
    orgHost: !!t.org_host, rosterApplied: t.roster_gen === t.roster_synced_gen,
    members: store.listMembers(t.ns).map((m) => ({ email: m.email, role: m.role, addedBy: m.added_by, addedAt: m.added_at })),
  });
  try {
    if (sub === 'list') {
      if (name) {
        const t = store.findShared(name);
        if (!t) throw new SharedError(`no shared workspace named "${name}"`, 404);
        out(view(t));
      } else out(store.listShared().map(view));
    } else if (sub === 'create') {
      if (!name) throw new SharedError('usage: shared create <name> …');
      const policy = typeof flags.policy === 'string' ? flags.policy : 'explicit';
      if (!isMemberPolicy(policy)) throw new SharedError('--policy must be explicit or org');
      const owner = typeof flags.owner === 'string' ? flags.owner : '';
      const { tenant, provisioned } = createShared(deps, {
        name, policy, defaultRole: role(flags['default-role'], 'member'), orgHost: !flags['no-org-host'], by,
        members: owner ? [{ email: owner, role: 'owner' }] : [],
      });
      const ok = await provisioned; // the operator sees the outcome, unlike the admin page
      out({ ok, ...view(store.findShared(tenant.name!)!) });
      if (!ok) return 1;
    } else if (sub === 'add-member') {
      if (!name || !arg) throw new SharedError('usage: shared add-member <name> <email> [--role <role>]');
      const r = await addMember(deps, name, arg, role(flags.role, 'member'), by);
      out({ ok: true, member: r.member, roster: r.sync });
    } else if (sub === 'remove-member') {
      if (!name || !arg) throw new SharedError('usage: shared remove-member <name> <email>');
      const r = await removeMember(deps, name, arg, by);
      out({ ok: true, removed: arg.toLowerCase(), roster: r.sync });
    } else if (sub === 'set-policy') {
      if (!name || !arg || !isMemberPolicy(arg)) throw new SharedError('usage: shared set-policy <name> explicit|org [--default-role <role>]');
      const r = await setPolicy(deps, name, arg, role(flags['default-role'], 'member'), by);
      out({ ok: true, policy: arg, roster: r.sync });
    } else if (sub === 'delete') {
      if (!name) throw new SharedError('usage: shared delete <name> --yes');
      if (!flags.yes) throw new SharedError(`this deletes "${name}"'s namespace and every file in it — re-run with --yes`);
      await deleteShared(deps, name, by);
      out({ ok: true, deleted: name });
    } else if (sub === 'sync') {
      if (name) out(await syncRoster(deps, name));
      else out({ pushed: await rosterSyncTick(deps) });
    } else {
      err(SHARED_USAGE);
      return 2;
    }
    return 0;
  } catch (e) {
    err(`error: ${(e as Error).message}\n`);
    return e instanceof SharedError && e.status === 404 ? 4 : 1;
  }
}
