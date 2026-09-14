// VOICE1 host: /voice/stt pins Whisper to the client's `language` (the resolved
// mic-language pref); `lang` is the pre-VOICE1 field name; anything that is
// not an ISO code falls back to the host default so Groq never sees junk.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { isolate } from './_isolate.js';
isolate(); // restore globalThis/process.env after this file (bun test shares them)

let voice: any, origFetch: any;
const sent: any[] = [];

beforeAll(async () => {
  process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || 'gsk_test';
  origFetch = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => {
    const form = init?.body as FormData;
    sent.push({ url: String(url), language: form.get('language'), model: form.get('model'), file: form.get('file') });
    return new Response(JSON.stringify({ text: ' hello ' }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as any;
  voice = await import('../server/voice.js');
});
afterAll(() => { globalThis.fetch = origFetch; });

test('sttLanguage: language wins, lang is the legacy alias, junk → host default', () => {
  expect(voice.sttLanguage({ language: 'en' })).toBe('en');
  expect(voice.sttLanguage({ language: 'RU ' })).toBe('ru');
  expect(voice.sttLanguage({ lang: 'fr' })).toBe('fr');
  expect(voice.sttLanguage({ language: 'en', lang: 'fr' })).toBe('en');
  expect(voice.sttLanguage({ language: 'auto' })).toMatch(/^[a-z]{2,3}$/);
  expect(voice.sttLanguage({ language: 'auto' })).not.toBe('auto');
  expect(voice.sttLanguage({ language: '<script>' })).not.toContain('<');
  expect(voice.sttLanguage({})).toMatch(/^[a-z]{2,3}$/);
});

test('transcribe posts the clip to Groq with the requested language in the form', async () => {
  const audioBase64 = Buffer.from(new Uint8Array(3000)).toString('base64');
  sent.length = 0;
  const r = await voice.transcribe({ audioBase64, mimeType: 'audio/webm;codecs=opus', language: 'en' });
  expect(r).toEqual({ text: 'hello' });
  expect(sent).toHaveLength(1);
  expect(sent[0].url).toContain('/audio/transcriptions');
  expect(sent[0].language).toBe('en');
  expect((sent[0].file as File).name).toBe('clip.webm');
  sent.length = 0;
  await voice.transcribe({ audioBase64, mimeType: 'audio/mp4', lang: 'he' });
  expect(sent[0].language).toBe('he');
  expect((sent[0].file as File).name).toBe('clip.m4a');
});
