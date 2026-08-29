// REST helpers — all under /__api (vite proxies to :3099 in dev).

// C1: the store registers a handler so any 401 (cookie expired / logged out
// elsewhere) flips the app to the Login screen instead of spraying errors.
let onUnauthorized = null;
export function setUnauthorizedHandler(fn) {
  onUnauthorized = fn;
}

async function handle(res) {
  if (res.status === 401 && onUnauthorized && !/\/__api\/auth\//.test(res.url || '')) {
    try { onUnauthorized(); } catch { /* ignore */ }
  }
  if (!res.ok) {
    let detail = '';
    try {
      detail = await res.text();
    } catch {
      /* ignore */
    }
    const err = new Error(`HTTP ${res.status}${detail ? ` — ${detail.slice(0, 200)}` : ''}`);
    err.status = res.status;
    throw err;
  }
  try {
    return await res.json();
  } catch {
    return null;
  }
}

const json = (method) => (path, body) =>
  fetch(`/__api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }).then(handle);

export const api = {
  get: (path) => fetch(`/__api${path}`).then(handle),
  post: json('POST'),
  put: json('PUT'),
  patch: json('PATCH'),
  del: (path) => fetch(`/__api${path}`, { method: 'DELETE' }).then(handle),
};

export const PALETTE = [
  '#E0594F',
  '#1F9C82',
  '#6A4FC4',
  '#2C6BD6',
  '#CE8324',
  '#3C9A4E',
  '#C2459E',
  '#5B62D6',
];
