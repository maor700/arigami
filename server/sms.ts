// SMS inbound store — receives webhooks from a phone-side SMS gateway app,
// persists to <ARIGAMI_DIR>/sms.jsonl, and exposes a polling query for the
// listener scheduler.

import fs from 'node:fs';
import path from 'node:path';
import { ARIGAMI_DIR } from './lib/instance.js';

const SMS_FILE = path.join(ARIGAMI_DIR, 'sms.jsonl');

export interface SmsMessage {
  id: string;
  from: string;
  body: string;
  timestamp: string; // ISO
}

// ---- in-memory tail --------------------------------------------------------

const TAIL_MAX = 200;
const messages: SmsMessage[] = [];
let seq = 0;

function shortId(): string {
  return Date.now().toString(36) + (++seq).toString(36);
}

// Load existing messages on first import
try {
  if (fs.existsSync(SMS_FILE)) {
    const lines = fs.readFileSync(SMS_FILE, 'utf8').split('\n').filter(Boolean);
    for (const l of lines.slice(-TAIL_MAX)) {
      try { messages.push(JSON.parse(l)); } catch {}
    }
  }
} catch {}

// ---- inbound ---------------------------------------------------------------

export function receiveSms(from: string, body: string, timestamp?: string): SmsMessage {
  const msg: SmsMessage = {
    id: shortId(),
    from: from || 'unknown',
    body: body || '',
    timestamp: timestamp || new Date().toISOString(),
  };
  messages.push(msg);
  if (messages.length > TAIL_MAX) messages.shift();
  try {
    fs.mkdirSync(path.dirname(SMS_FILE), { recursive: true });
    fs.appendFileSync(SMS_FILE, JSON.stringify(msg) + '\n');
  } catch {}
  return msg;
}

// ---- query -----------------------------------------------------------------

export function getSmsAfter(since: string): SmsMessage[] {
  return messages.filter((m) => m.timestamp > since);
}
