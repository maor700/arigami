// ZIP: composer attachment logic (web/src/lib/attachments.js) — the size
// threshold that picks base64-in-JSON vs. streamed upload, and the streamed
// path itself (progress events, success, failure), against a fake XHR/File
// since bun:test has no browser globals by default.
import { test, expect, describe, beforeAll } from 'bun:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const web = (p) => path.join(ROOT, 'web/src', p);

let lastXhr = null;

class FakeXHR {
  constructor() {
    this.upload = {};
    this.requestHeaders = {};
    lastXhr = this;
  }
  open(method, url) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(k, v) {
    this.requestHeaders[k] = v;
  }
  send(body) {
    this.sentBody = body;
  }
  respond(status, json) {
    this.status = status;
    this.responseText = JSON.stringify(json);
    this.onload?.();
  }
  progress(loaded, total) {
    this.upload.onprogress?.({ lengthComputable: true, loaded, total });
  }
  networkError() {
    this.onerror?.();
  }
}

let attachments;

beforeAll(async () => {
  globalThis.XMLHttpRequest = FakeXHR;
  attachments = await import(web('lib/attachments.js'));
});

const file = (name, size, type = 'application/zip') => {
  const f = new File([new Uint8Array(Math.min(size, 16))], name, { type });
  Object.defineProperty(f, 'size', { value: size }); // avoid actually allocating `size` bytes
  return f;
};

describe('shouldStream', () => {
  test('below the threshold stays inline (base64)', () => {
    expect(attachments.shouldStream(file('small.txt', attachments.STREAM_THRESHOLD - 1))).toBe(false);
  });
  test('at/above the threshold streams', () => {
    expect(attachments.shouldStream(file('big.zip', attachments.STREAM_THRESHOLD))).toBe(true);
    expect(attachments.shouldStream(file('bigger.zip', attachments.STREAM_THRESHOLD + 1))).toBe(true);
  });
  test('HARD_CAP is well above STREAM_THRESHOLD', () => {
    expect(attachments.HARD_CAP).toBeGreaterThan(attachments.STREAM_THRESHOLD);
  });
});

describe('uploadAttachment', () => {
  test('posts to the session-scoped endpoint with the filename header, reports progress, resolves with the descriptor', async () => {
    const f = file('bundle.zip', attachments.STREAM_THRESHOLD + 1);
    const progressEvents = [];
    const p = attachments.uploadAttachment('sess_123', f, { onProgress: (pct) => progressEvents.push(pct) });
    expect(lastXhr.method).toBe('POST');
    expect(lastXhr.url).toBe('/__api/sessions/sess_123/attachments');
    expect(lastXhr.requestHeaders['X-Arigami-Filename']).toBe(encodeURIComponent('bundle.zip'));
    expect(lastXhr.requestHeaders['Content-Type']).toBe('application/zip');
    lastXhr.progress(50, 100);
    lastXhr.progress(100, 100);
    const descriptor = { ok: true, name: 'bundle.zip', path: '/tmp/x/bundle.zip', archive: { entryCount: 3 } };
    lastXhr.respond(201, descriptor);
    const result = await p;
    expect(result).toEqual(descriptor);
    expect(progressEvents).toEqual([0.5, 1]);
  });

  test('a non-2xx status rejects with the server error message and a .status', async () => {
    const f = file('big.zip', attachments.STREAM_THRESHOLD + 1);
    const p = attachments.uploadAttachment('sess_123', f);
    lastXhr.respond(413, { error: 'upload exceeds the 200MB cap' });
    let caught;
    try { await p; } catch (e) { caught = e; }
    expect(caught.message).toContain('upload exceeds the 200MB cap');
    expect(caught.status).toBe(413);
  });

  test('a network error rejects too', async () => {
    const f = file('big.zip', attachments.STREAM_THRESHOLD + 1);
    const p = attachments.uploadAttachment('sess_123', f);
    lastXhr.networkError();
    await expect(p).rejects.toThrow();
  });
});

// ZIP2 regression: the chip used to be tracked by object identity — the first
// progress update already swaps the placeholder for a new object, so every
// later event (more progress, done, fail) matched nothing and the chip froze
// at whatever % the first event reported. These drive the same lifecycle
// through the `uid`-keyed reducer and assert every step lands on the SAME entry.
describe('applyUploadEvent', () => {
  test('multiple progress events all update the same entry, by uid — not by object identity', () => {
    const f = file('bundle.zip', attachments.STREAM_THRESHOLD + 1);
    const placeholder = attachments.pendingAttachment(f);
    let list = [placeholder];

    list = attachments.applyUploadEvent(list, placeholder.uid, { type: 'progress', progress: 0.1 });
    expect(list[0]).not.toBe(placeholder); // confirms the update DOES replace the object...
    expect(list[0].progress).toBe(0.1);

    list = attachments.applyUploadEvent(list, placeholder.uid, { type: 'progress', progress: 0.5 });
    list = attachments.applyUploadEvent(list, placeholder.uid, { type: 'progress', progress: 0.9 });
    expect(list).toHaveLength(1);
    expect(list[0].progress).toBe(0.9); // ...yet later events still find it, via uid
    expect(list[0].uploading).toBe(true);
  });

  test('completion after several progress events replaces the entry with the descriptor', () => {
    const f = file('bundle.zip', attachments.STREAM_THRESHOLD + 1);
    const placeholder = attachments.pendingAttachment(f);
    let list = [placeholder];
    list = attachments.applyUploadEvent(list, placeholder.uid, { type: 'progress', progress: 0.3 });
    list = attachments.applyUploadEvent(list, placeholder.uid, { type: 'progress', progress: 0.7 });

    const descriptor = { name: 'bundle.zip', path: '/tmp/x/bundle.zip', type: 'application/zip', size: f.size, archive: { entryCount: 3 } };
    list = attachments.applyUploadEvent(list, placeholder.uid, { type: 'done', descriptor });

    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ ...descriptor, uploading: false });
    expect(list[0].progress).toBeUndefined(); // the descriptor fully replaces the placeholder, no stale progress left over
  });

  test('a failure after progress events marks the same entry failed, not a stray one', () => {
    const f = file('bundle.zip', attachments.STREAM_THRESHOLD + 1);
    const placeholder = attachments.pendingAttachment(f);
    let list = [{ name: 'other.txt', size: 5 }, placeholder];
    list = attachments.applyUploadEvent(list, placeholder.uid, { type: 'progress', progress: 0.2 });
    list = attachments.applyUploadEvent(list, placeholder.uid, { type: 'fail', error: 'HTTP 500' });

    expect(list).toHaveLength(2);
    expect(list[0]).toEqual({ name: 'other.txt', size: 5 }); // untouched
    expect(list[1]).toMatchObject({ uploading: false, failed: true, error: 'HTTP 500' });
  });

  test('an event for an unknown uid changes nothing', () => {
    const list = [attachments.pendingAttachment(file('a.zip', attachments.STREAM_THRESHOLD + 1))];
    const next = attachments.applyUploadEvent(list, 'no-such-uid', { type: 'progress', progress: 0.5 });
    expect(next).toEqual(list);
  });

  test('pendingAttachment mints a distinct uid per call', () => {
    const a = attachments.pendingAttachment(file('a.zip', attachments.STREAM_THRESHOLD + 1));
    const b = attachments.pendingAttachment(file('b.zip', attachments.STREAM_THRESHOLD + 1));
    expect(a.uid).toBeTruthy();
    expect(a.uid).not.toBe(b.uid);
  });
});
