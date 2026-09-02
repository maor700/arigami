// CHAT1 — long-poll wrapper for the host endpoints that BLOCK on a human
// (permission_prompt incl. AskUserQuestion cards, request_screen, request_setup).
//
// Why: one HTTP request that stays open until the human clicks dies after
// ~5 minutes (Bun's fetch idle timeout — "The operation timed out"). The tool
// then returned "arigami unreachable", the model carried on without the
// answer, while the host kept the card open for its own 10/15/30-minute
// timer — so a click that came later resolved a promise nobody was listening
// to and the chat looked stuck ("I answered and nothing happened").
//
// How: the client mints a `wait_key`; the host holds each HTTP leg for at
// most ARIGAMI_WAIT_LEG_MS (4 min, well under the fetch timeout) and answers
// `{pending:true, wait_key}` when the human has not acted yet; the client
// re-attaches with POST /__mcp/wait {wait_key} until the real result lands.
// The pending card lives as long as the process keeps polling; the host's
// own timer still bounds it. A transport hiccup (timeout, reset, the host
// restarting) re-attaches with the same key a few times before giving up.
import { randomUUID } from 'node:crypto';

const TRANSIENT_RE = /timed out|timeout|ECONNRESET|ECONNREFUSED|Unable to connect|socket hang up|fetch failed|network/i;
const MAX_TRANSIENT = 6;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function isPending(r) {
  return !!r && typeof r === 'object' && r.pending === true && typeof r.wait_key === 'string';
}

/**
 * makeBlockingCall(api) → blockingCall(path, body): the same `api(method,
 * path, body)` helper host-mcp.js uses for everything else, wrapped in the
 * wait loop. Resolves with the endpoint's real result; throws on a hard
 * error (4xx from the host, or the wait key vanishing — e.g. the host
 * restarted and the card is gone).
 */
export function makeBlockingCall(api, { sleepFn = sleep } = {}) {
  return async function blockingCall(path, body) {
    const wait_key = 'wait_' + randomUUID();
    let transient = 0;
    let r;
    try {
      r = await api('POST', path, { ...body, wait_key });
    } catch (e) {
      // The host may have accepted the request and only the response leg
      // died — re-attach by key instead of failing the tool.
      if (!TRANSIENT_RE.test(String(e?.message || e))) throw e;
      transient++;
      r = { pending: true, wait_key };
    }
    while (isPending(r)) {
      try {
        r = await api('POST', '/__mcp/wait', { wait_key });
        transient = 0;
      } catch (e) {
        if (!TRANSIENT_RE.test(String(e?.message || e)) || ++transient > MAX_TRANSIENT) throw e;
        await sleepFn(Math.min(1000 * 2 ** (transient - 1), 15000));
        r = { pending: true, wait_key };
      }
    }
    return r;
  };
}
