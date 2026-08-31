// ZIP: attachment upload logic, split out of SessionView so it's testable
// without rendering JSX (this repo's "-web" tests exercise lib modules
// directly against a mocked fetch/XHR, not a component tree).
//
// Two paths, chosen by size: small files still ride inline as base64 in the
// POST .../message body (unchanged); anything at or past STREAM_THRESHOLD
// streams to POST .../attachments first (raw body + X-Arigami-Filename
// header — needs XHR, not fetch, for upload.onprogress) and the message send
// references the path that came back instead of re-sending bytes.

export const STREAM_THRESHOLD = 8 * 1024 * 1024; // 8MB — below this, base64-in-JSON is simpler and fast enough
export const HARD_CAP = 200 * 1024 * 1024; // 200MB — matches the server's ATTACHMENT_MAX_BYTES

export const shouldStream = (file) => file.size >= STREAM_THRESHOLD;

// ZIP2: a streamed chip used to be tracked by object identity (`x === placeholder`)
// — the first progress update already replaces the placeholder with a new
// object, so every later update (more progress, done, fail) matched nothing
// and the chip froze at whatever % the first event reported. `uid` is a
// stable key that survives every replacement in the list.
let uidSeq = 0;
export const makeUid = () =>
  (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : `${Date.now()}-${++uidSeq}-${Math.random()}`;

/** The chip shown for a streamed upload from the moment it starts. */
export const pendingAttachment = (file) => ({
  uid: makeUid(),
  name: file.name,
  type: file.type || 'application/octet-stream',
  size: file.size,
  uploading: true,
  progress: 0,
});

/** Applies one upload lifecycle event (progress/done/fail) to the attachment list, matched by `uid`. */
export function applyUploadEvent(list, uid, event) {
  return list.map((x) => {
    if (x.uid !== uid) return x;
    if (event.type === 'progress') return { ...x, progress: event.progress };
    if (event.type === 'done') return { ...event.descriptor, uid, uploading: false };
    if (event.type === 'fail') return { ...x, uploading: false, failed: true, error: event.error };
    return x;
  });
}

export const fileToBase64 = (file) =>
  new Promise((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => resolve('');
    r.readAsDataURL(file);
  });

/**
 * Streams `file` to POST /__api/sessions/:id/attachments. Resolves with the
 * server's descriptor ({name, path, type, size, isImage, archive?}) or
 * rejects with an Error carrying `.status`.
 */
export function uploadAttachment(sessionId, file, { onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/__api/sessions/${sessionId}/attachments`);
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    xhr.setRequestHeader('X-Arigami-Filename', encodeURIComponent(file.name));
    if (xhr.upload && onProgress) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(e.loaded / e.total);
      };
    }
    xhr.onload = () => {
      let body = null;
      try { body = JSON.parse(xhr.responseText); } catch { /* non-JSON error body */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body);
      else reject(Object.assign(new Error(body?.error || `HTTP ${xhr.status}`), { status: xhr.status }));
    };
    xhr.onerror = () => reject(new Error('upload failed'));
    xhr.send(file);
  });
}
