// The tool-input pretty printer shared by the ToolUse row and the permission card.
export function prettyInput(input) {
  if (input == null) return '';
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}
