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
