// The tool-input pretty printer shared by the ToolUse row and the permission card.
export function prettyInput(input) {
  if (input == null) return '';
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

// A tool name a human can read: `mcp__arigami__browser_logins` →
// {source:'Arigami', action:'Browser logins'}; built-ins (`Bash`, `WebFetch`)
// keep their name as the action.
export function toolDisplayName(name) {
  const n = String(name || '').trim();
  const words = (s) => s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim();
  const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : s);
  const m = /^mcp__(.+?)__(.+)$/.exec(n);
  if (m) {
    const source = m[1].replace(/^(ext|plugin)[-_]/, '').split(/[-_]/).filter((w) => w && w !== 'mcp').map(cap).join(' ');
    return { source: source || m[1], action: cap(words(m[2])) };
  }
  return { source: '', action: words(n) || 'tool' };
}

// The input as short label/value rows for the permission card; null when it
// has nothing a row can show (then the card falls back to the raw JSON).
// `[]` = the call takes no parameters.
export function inputRows(input) {
  if (input == null) return [];
  if (typeof input !== 'object' || Array.isArray(input)) return null;
  const rows = [];
  for (const [k, v] of Object.entries(input)) {
    if (v == null || v === '') continue;
    let text;
    if (typeof v === 'string') text = v;
    else if (typeof v === 'number' || typeof v === 'boolean') text = String(v);
    else return null;
    rows.push({ key: k.replace(/_/g, ' '), value: text, long: text.length > 80 || text.includes('\n') });
  }
  return rows;
}
