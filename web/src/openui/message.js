// OPENUI pilot — pure helpers shared by the card, the lazy body and the tests.
export const OPENUI_MAX_CHARS = 64 * 1024;

/** The message a Button/Form action becomes: the label plus the form's values, if any. */
export function actionToMessage(ev) {
  const text = String(ev?.humanFriendlyMessage || '').trim();
  const raw = ev?.formState && typeof ev.formState === 'object' ? ev.formState : null;
  // The Renderer nests fields under the form's name: {order: {qty: {value, componentType}}}.
  const scope = raw && ev.formName && raw[ev.formName] && typeof raw[ev.formName] === 'object' ? raw[ev.formName] : raw;
  const fields = {};
  for (const [k, v] of Object.entries(scope || {})) {
    if (k.startsWith('$')) continue;
    fields[k] = v && typeof v === 'object' && !Array.isArray(v) && 'value' in v ? v.value : v;
  }
  const hasFields = Object.keys(fields).length > 0;
  if (!text && !hasFields) return '';
  return hasFields ? `${text || 'Form submitted'}\n\n\`\`\`json\n${JSON.stringify(fields, null, 2)}\n\`\`\`` : text;
}
