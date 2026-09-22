// The GitHub adapter: the only part of the inbox that knows what GitHub calls
// things.
//
// Everything downstream — the queue, the decisions, the drafting run, the
// submit gate — is provider-agnostic core. All this does is turn "a review or
// a comment arrived on this PR" into `InboxItem`s and hand them to
// `ctx.inbox.add()`. A second provider (Linear, Slack) is another file exactly
// this shape and nothing else moves.
//
// It does NOT reply to anybody, and it has no way to: adding an item is the
// whole of its outward surface, and items sit pending until a human submits.
import type { ListenerProvider, ListenerCtx, InboxItemInput } from '@arigami/sdk';

interface Args {
  url: string;
  includeBots?: boolean;
}

/** Per-endpoint high-water marks. GitHub ids are monotonic per collection. */
interface Watermark {
  reviewId: number;
  issueCommentId: number;
  reviewCommentId: number;
}

interface Ref {
  owner: string;
  repo: string;
  number: number;
}

function parsePr(input: string): Ref | null {
  const s = String(input || '').trim();
  const short = /^([\w.-]+)\/([\w.-]+)#(\d+)$/.exec(s);
  if (short) return { owner: short[1], repo: short[2], number: Number(short[3]) };
  const url = /(?:^|\/\/[^/]+\/)([\w.-]+)\/([\w.-]+)\/(?:pull|pulls)\/(\d+)/.exec(s);
  if (url) return { owner: url[1], repo: url[2], number: Number(url[3]) };
  return null;
}

/**
 * A bot's comment is not review feedback.
 *
 * Measured on a real PR: of four comments, two were a linear-code linkback (an
 * HTML comment) and a vercel deployment table of base64. Importing those buries
 * the two a human wrote — and worse, each would be handed to the drafting run
 * as something that might deserve a reply.
 */
const isBot = (u: { type?: string; login?: string } | undefined): boolean =>
  u?.type === 'Bot' || /\[bot\]$/i.test(String(u?.login || ''));

/**
 * Is this worth a model run?
 *
 * `signal: false` items still arrive — they are part of the conversation — but
 * they render raw with an "explain it" button instead of costing a drafting
 * run. Approvals with no body, "LGTM", a thumbs up: nothing to explain.
 */
function isSignal(body: string): boolean {
  const t = String(body || '').trim();
  if (!t) return false;
  if (t.length < 12 && /^(lgtm|ok|👍|\+1|nice|thanks?|ty)\b/i.test(t)) return false;
  return true;
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const maxId = (rows: { id?: number }[], floor = 0): number =>
  rows.reduce((mx, r) => (num(r.id) > mx ? num(r.id) : mx), floor);

/** GitHub's `diff_hunk` — a few lines around the comment, not a file diff. */
function codeContext(c: {
  diff_hunk?: string;
  path?: string;
  line?: number | null;
  original_line?: number | null;
  start_line?: number | null;
  original_start_line?: number | null;
}): InboxItemInput['context'] {
  const hunk = String(c.diff_hunk || '').trim();
  if (!hunk) return { kind: 'none' };
  const start = c.start_line ?? c.original_start_line;
  // `line` is null on an outdated comment (the line left the diff);
  // original_line keeps it anchored somewhere useful instead of nowhere.
  const end = c.line ?? c.original_line;
  const lines = end ? (start && start !== end ? `L${start}–L${end}` : `L${end}`) : undefined;
  return { kind: 'code', path: String(c.path || ''), ...(lines ? { lines } : {}), hunk };
}

async function gh<T>(ctx: ListenerCtx, path: string, fallback: T): Promise<T> {
  const token = ctx.secrets.GITHUB_TOKEN || ctx.secrets.GH_TOKEN || '';
  try {
    const r = await ctx.fetch(`https://api.github.com${path}`, {
      signal: ctx.signal,
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'arigami-inbox-github',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    });
    if (!r.ok) {
      ctx.log(`GET ${path} → ${r.status}`);
      return fallback;
    }
    return (await r.json()) as T;
  } catch (e) {
    ctx.log(`GET ${path} failed: ${(e as Error)?.message}`);
    return fallback;
  }
}

export const githubInbox: ListenerProvider<Args, Watermark> = {
  type: 'github-inbox',

  label: (a) => {
    const ref = parsePr(a?.url || '');
    return ref ? `Inbox · ${ref.owner}/${ref.repo}#${ref.number}` : 'GitHub inbox';
  },

  /**
   * Baseline at registration: record where the PR is NOW and fire on nothing.
   * Arming a watcher must never replay the whole existing conversation into the
   * operator's queue.
   */
  async register(ctx, args) {
    const ref = parsePr(args?.url || '');
    if (!ref) throw new Error(`not a pull request: ${args?.url}`);
    const base = `/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`;
    const issues = `/repos/${ref.owner}/${ref.repo}/issues/${ref.number}`;
    const [reviews, ics, rcs] = await Promise.all([
      gh<{ id: number }[]>(ctx, `${base}/reviews?per_page=100`, []),
      gh<{ id: number }[]>(ctx, `${issues}/comments?per_page=100`, []),
      gh<{ id: number }[]>(ctx, `${base}/comments?per_page=100`, []),
    ]);
    return {
      params: { url: args.url, includeBots: !!args.includeBots },
      watermark: { reviewId: maxId(reviews), issueCommentId: maxId(ics), reviewCommentId: maxId(rcs) },
    };
  },

  async poll(ctx, l) {
    const ref = parsePr(l.params?.url || '');
    if (!ref) return { kind: 'gone', error: 'the listener has no valid PR url' };
    const wantBots = l.params?.includeBots === true;
    const wm = l.watermark || { reviewId: 0, issueCommentId: 0, reviewCommentId: 0 };
    const base = `/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`;
    const issues = `/repos/${ref.owner}/${ref.repo}/issues/${ref.number}`;
    const tag = `${ref.owner}/${ref.repo}#${ref.number}`;
    const url = `https://github.com/${ref.owner}/${ref.repo}/pull/${ref.number}`;

    type Review = { id: number; body?: string; state?: string; user?: { login?: string; type?: string }; html_url?: string; submitted_at?: string };
    type Comment = Review & { path?: string; diff_hunk?: string; created_at?: string; line?: number | null; original_line?: number | null };

    const [reviews, ics, rcs] = await Promise.all([
      gh<Review[]>(ctx, `${base}/reviews?per_page=100`, []),
      gh<Comment[]>(ctx, `${issues}/comments?per_page=100`, []),
      gh<Comment[]>(ctx, `${base}/comments?per_page=100`, []),
    ]);

    const newReviews = reviews.filter((r) => num(r.id) > wm.reviewId);
    const newIcs = ics.filter((c) => num(c.id) > wm.issueCommentId);
    const newRcs = rcs.filter((c) => num(c.id) > wm.reviewCommentId);

    const items: InboxItemInput[] = [];
    const push = (i: InboxItemInput, user: Review['user']) => {
      if (!wantBots && isBot(user)) return;
      if (!String(i.body || '').trim()) return; // a bare approval carries nothing to read
      items.push(i);
    };

    for (const r of newReviews)
      push(
        {
          source: {
            provider: 'github',
            kind: r.state === 'CHANGES_REQUESTED' ? 'changes-requested' : 'review',
            ref: `github:review:${r.id}`,
            url: r.html_url || url,
            author: r.user?.login || 'someone',
            at: r.submitted_at,
            title: tag,
          },
          body: String(r.body || ''),
          context: { kind: 'none' },
          // Changes-requested is by definition someone asking for something
          // back, whatever the wording.
          signal: r.state === 'CHANGES_REQUESTED' || isSignal(r.body || ''),
        },
        r.user
      );

    for (const c of newIcs)
      push(
        {
          source: {
            provider: 'github',
            kind: 'issue-comment',
            ref: `github:ic:${c.id}`,
            url: c.html_url || url,
            author: c.user?.login || 'someone',
            at: c.created_at,
            title: tag,
          },
          body: String(c.body || ''),
          context: { kind: 'none' },
          signal: isSignal(c.body || ''),
        },
        c.user
      );

    for (const c of newRcs)
      push(
        {
          source: {
            provider: 'github',
            kind: 'review-comment',
            ref: `github:rc:${c.id}`,
            url: c.html_url || url,
            author: c.user?.login || 'someone',
            at: c.created_at,
            title: tag,
          },
          body: String(c.body || ''),
          context: codeContext(c),
          signal: isSignal(c.body || ''),
        },
        c.user
      );

    // The host dedups on source.ref, so re-delivering after a failed wake is
    // safe — which is what lets the watermark advance only once below.
    const added = items.length ? ctx.inbox.add(items) : 0;
    if (added) ctx.log(`${added} message(s) → inbox`);

    const next: Watermark = {
      reviewId: maxId(newReviews, wm.reviewId),
      issueCommentId: maxId(newIcs, wm.issueCommentId),
      reviewCommentId: maxId(newRcs, wm.reviewCommentId),
    };

    // The wake is a POINTER, not the content: the items are already in the
    // inbox, and the session reads them there rather than from a chat message.
    return {
      kind: 'ok',
      shouldFire: added > 0,
      summary: added ? `📥 ${added} new message(s) on ${tag} — see the Inbox tab.` : '',
      nextWatermark: next,
    };
  },
};
