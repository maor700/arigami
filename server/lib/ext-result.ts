// An extension tool that fails by RETURNING `{ error }` (instead of throwing) must not read as a
// success to the host: an approved outbound send would say "SENT" for a message that never left.
// mcp/ext-mcp.js now marks such a result `isError`; this is the host-side check for the same
// shape, so a result from an older/other MCP server cannot slip through.
export function failureOf(content: unknown, structured?: unknown): string | null {
  const objs: unknown[] = [structured];
  if (Array.isArray(content)) {
    const text = content.map((c: any) => (typeof c?.text === 'string' ? c.text : '')).join('');
    const t = text.trim();
    if (t.startsWith('{')) {
      try {
        objs.push(JSON.parse(t));
      } catch {
        /* not JSON — plain text is not a failure signal */
      }
    }
  }
  for (const o of objs as any[]) {
    if (o && typeof o === 'object' && o.ok !== true && o.error != null && o.error !== '') return String(o.error);
  }
  return null;
}
