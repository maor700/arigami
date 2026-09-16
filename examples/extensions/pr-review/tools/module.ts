// The server half of the PR-review extension.
//
// Three tools, and a deliberate absence: there is no `start_review_session`
// here. Creating the session is the TAB's job, through the bridge's
// `createSession` — that path is permissioned (`host:create-session`), the
// human sees the grant at install time, and the cockpit performs the handoff.
// A tool that quietly spawned agents would be the same power with none of that,
// which is exactly what the launcher seam exists to avoid.
//
// `gh` is shelled out to rather than hitting api.github.com: it already holds
// the human's credentials (the `git` capability), it handles enterprise hosts
// and it is what every other GitHub path in this product uses. No token is
// read, stored or logged here.
import type { ToolDef, ToolCtx } from '@arigami/sdk';

interface Gh {
  ok: boolean;
  out: string;
  err: string;
}

async function gh(args: string[], timeoutMs = 20_000): Promise<Gh> {
  try {
    const p = Bun.spawn(['gh', ...args], { stdout: 'pipe', stderr: 'pipe' });
    const kill = setTimeout(() => { try { p.kill(); } catch { /* already gone */ } }, timeoutMs);
    const [out, err, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ]);
    clearTimeout(kill);
    return { ok: code === 0, out, err };
  } catch (e) {
    // ENOENT: gh is not installed. Say that, rather than "command failed" —
    // it is the single most common reason this extension does nothing.
    return { ok: false, out: '', err: `could not run gh: ${e instanceof Error ? e.message : String(e)}` };
  }
}

const parseJson = <T,>(s: string, fallback: T): T => {
  try { return JSON.parse(s) as T; } catch { return fallback; }
};

/**
 * "owner/repo#123", a full PR url, or an api url → {slug, number}.
 *
 * Kept liberal on purpose: the field it backs accepts a paste, and a human
 * pasting a PR link should not have to know which of GitHub's several URL
 * shapes they copied.
 */
export function parsePrRef(input: string): { slug: string; number: number } | null {
  const s = String(input || '').trim();
  if (!s) return null;
  const short = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(s);
  if (short) return { slug: short[1], number: Number(short[2]) };
  const url = /(?:^|\/\/[^/]+\/)([\w.-]+\/[\w.-]+)\/(?:pull|pulls)\/(\d+)/.exec(s);
  if (url) return { slug: url[1], number: Number(url[2]) };
  return null;
}

/** The first message of a review session. */
export function reviewPrompt(prUrl: string, reviewMode: string): string {
  const checkout =
    reviewMode === 'nocheckout'
      ? 'Do NOT check the branch out. Read the diff with `gh pr diff` and review from that alone — this repo may be in use by another session.'
      : 'Check the PR out into its own worktree (`gh pr checkout`) so you can read the code around each change, not only the diff.';
  return [
    `Review the pull request ${prUrl}.`,
    '',
    checkout,
    '',
    'This is somebody else\'s pull request. Do not modify, stage, commit or push any code — the output of this session is a review, nothing else.',
    '',
    'Put each finding in the Changes tab as an inline comment on the line it belongs to, so the human can accept or reject it before anything is published. Run `pr_import_comments` first: the PR may already carry review comments, and repeating a point somebody already made is noise.',
    '',
    'When the human approves, publish the review to the PR.',
  ].join('\n');
}

const listRepos: ToolDef<{ limit?: number }> = {
  name: 'pr_list_repos',
  description: 'Repositories to offer in the PR picker: the extension\'s configured list, or the ones gh says you can push to.',
  inputSchema: {
    type: 'object',
    properties: { limit: { type: 'number', description: 'Max repos to return (default 30)' } },
  },
  async run(args, ctx: ToolCtx) {
    const configured = String((ctx.settings as Record<string, unknown>)?.repos || '')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);
    if (configured.length) return { repos: configured.map((slug) => ({ slug })), source: 'settings' };

    const limit = Math.min(Math.max(Number(args?.limit) || 30, 1), 100);
    const r = await gh(['repo', 'list', '--limit', String(limit), '--json', 'nameWithOwner']);
    if (!r.ok) return { repos: [], error: r.err.trim() || 'gh repo list failed', source: 'gh' };
    const rows = parseJson<{ nameWithOwner: string }[]>(r.out, []);
    return { repos: rows.map((x) => ({ slug: x.nameWithOwner })), source: 'gh' };
  },
};

const listPulls: ToolDef<{ repo: string; state?: string; author?: string; search?: string; limit?: number }> = {
  name: 'pr_list_pulls',
  description: 'Open (or closed/merged) pull requests in a repository, for the picker.',
  inputSchema: {
    type: 'object',
    required: ['repo'],
    properties: {
      repo: { type: 'string', description: 'owner/repo' },
      state: { type: 'string', description: 'open (default) | closed | merged | all' },
      author: { type: 'string', description: 'Filter by author login, or "@me"' },
      search: { type: 'string', description: 'Free-text search within the repo\'s PRs' },
      limit: { type: 'number', description: 'Max PRs to return (default 30)' },
    },
  },
  async run(args) {
    const repo = String(args?.repo || '').trim();
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return { pulls: [], error: 'repo must be owner/repo' };
    const limit = Math.min(Math.max(Number(args?.limit) || 30, 1), 100);
    const argv = [
      'pr', 'list',
      '--repo', repo,
      '--state', ['open', 'closed', 'merged', 'all'].includes(String(args?.state)) ? String(args.state) : 'open',
      '--limit', String(limit),
      '--json', 'number,title,author,updatedAt,isDraft,url,headRefName',
    ];
    if (args?.author) argv.push('--author', String(args.author));
    if (args?.search) argv.push('--search', String(args.search));
    const r = await gh(argv);
    if (!r.ok) return { pulls: [], error: r.err.trim() || 'gh pr list failed' };
    const rows = parseJson<any[]>(r.out, []);
    return {
      pulls: rows.map((p) => ({
        number: p.number,
        title: p.title,
        author: p.author?.login || '',
        updatedAt: p.updatedAt,
        draft: !!p.isDraft,
        url: p.url,
        branch: p.headRefName,
      })),
    };
  },
};

const importComments: ToolDef<{ session: string; pr?: string; repo?: string; number?: number }> = {
  name: 'pr_import_comments',
  description:
    'Pull a pull request\'s existing review comments into this session\'s Changes tab as suggestions the human can accept or reject. Run it before writing your own review so you do not repeat a point somebody already made.',
  inputSchema: {
    type: 'object',
    required: ['session'],
    properties: {
      session: { type: 'string', description: 'Session id to import into (your own)' },
      pr: { type: 'string', description: 'PR url or owner/repo#123. Omit to use the session\'s metadata.' },
      repo: { type: 'string', description: 'owner/repo (with `number`, instead of `pr`)' },
      number: { type: 'number', description: 'PR number (with `repo`)' },
    },
  },
  async run(args, ctx: ToolCtx) {
    const session = String(args?.session || '').trim();
    if (!session) return { error: 'session is required' };

    // Resolve the PR: explicit args win, otherwise the session already knows —
    // the launcher stamped metadata.pr / prNumber / repo when it created it.
    let slug = '';
    let number = 0;
    if (args?.pr) {
      const ref = parsePrRef(String(args.pr));
      if (!ref) return { error: `could not read a PR out of "${args.pr}"` };
      slug = ref.slug;
      number = ref.number;
    } else if (args?.repo && args?.number) {
      slug = String(args.repo);
      number = Number(args.number);
    } else {
      const s = await ctx.host.api('GET', `/__api/sessions/${encodeURIComponent(session)}`);
      slug = String(s?.metadata?.repo || '');
      number = Number(s?.metadata?.prNumber || 0);
      if (!slug || !number)
        return { error: 'this session carries no PR — pass `pr`, or start the session from the launcher\'s "From PR" mode' };
    }

    // Two endpoints, because GitHub keeps them apart: /comments on the issue is
    // the conversation, /comments on the pull is the inline review. Both are
    // "a comment on this PR" to a human, so both are imported.
    const [inline, general] = await Promise.all([
      gh(['api', `repos/${slug}/pulls/${number}/comments`, '--paginate']),
      gh(['api', `repos/${slug}/issues/${number}/comments`, '--paginate']),
    ]);
    if (!inline.ok && !general.ok)
      return { error: inline.err.trim() || general.err.trim() || 'gh api failed' };

    const comments: Record<string, unknown>[] = [];
    for (const c of parseJson<any[]>(inline.out, [])) {
      if (!c?.body) continue;
      comments.push({
        kind: c.line || c.original_line ? 'line' : 'file',
        path: c.path,
        // `line` is null on an outdated comment (the line is gone from the
        // current diff); original_line keeps it anchored somewhere useful
        // instead of dropping the comment on the floor.
        line: c.line ?? c.original_line ?? undefined,
        body: `**@${c.user?.login || 'someone'} on GitHub:**\n\n${c.body}`,
      });
    }
    for (const c of parseJson<any[]>(general.out, [])) {
      if (!c?.body) continue;
      comments.push({ kind: 'feature', body: `**@${c.user?.login || 'someone'} on GitHub:**\n\n${c.body}` });
    }
    if (!comments.length) return { imported: 0, pr: `${slug}#${number}` };

    // They arrive as SUGGESTIONS, not as the session's own comments: these are
    // other people's words, and the human decides which of them this review
    // should carry. That is the same accept/reject the auto-review already uses.
    await ctx.host.api('POST', `/__api/sessions/${encodeURIComponent(session)}/review/suggestions`, { comments });
    return { imported: comments.length, pr: `${slug}#${number}` };
  },
};

export const tools: ToolDef[] = [listRepos, listPulls, importComments];
