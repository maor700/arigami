// Web Push notification service.
// Stores subscriptions in memory (lost on restart — re-subscribes on page load).
// VAPID keys are stored in the config directory.

import fs from 'node:fs';
import path from 'node:path';
import webpush from 'web-push';

const KEYS_FILE = path.join(
  process.env.HOME || '/home/arigami',
  '.arigami',
  'vapid-keys.json'
);

interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

let keys: VapidKeys;

function loadOrGenerateKeys(): VapidKeys {
  try {
    if (fs.existsSync(KEYS_FILE)) {
      return JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8'));
    }
  } catch {}
  const generated = webpush.generateVAPIDKeys();
  try {
    fs.mkdirSync(path.dirname(KEYS_FILE), { recursive: true });
    fs.writeFileSync(KEYS_FILE, JSON.stringify(generated, null, 2));
  } catch {}
  return generated;
}

keys = loadOrGenerateKeys();
webpush.setVapidDetails('mailto:push@arigami.local', keys.publicKey, keys.privateKey);

// ---- subscription store (in-memory) ----------------------------------------

const SUBS_FILE = path.join(path.dirname(KEYS_FILE), 'push-subscriptions.json');

function loadSubscriptions(): Map<string, webpush.PushSubscription> {
  try {
    if (fs.existsSync(SUBS_FILE)) {
      const arr = JSON.parse(fs.readFileSync(SUBS_FILE, 'utf8'));
      return new Map(arr.map((s: webpush.PushSubscription) => [s.endpoint, s]));
    }
  } catch {}
  return new Map();
}

function saveSubscriptions(): void {
  try {
    fs.writeFileSync(SUBS_FILE, JSON.stringify([...subscriptions.values()], null, 2));
  } catch {}
}

const subscriptions = loadSubscriptions();

export function getVapidPublicKey(): string {
  return keys.publicKey;
}

export function addSubscription(sub: webpush.PushSubscription): void {
  subscriptions.set(sub.endpoint, sub);
  saveSubscriptions();
}

export function removeSubscription(endpoint: string): void {
  subscriptions.delete(endpoint);
  saveSubscriptions();
}

// ---- send ------------------------------------------------------------------

interface PushPayload {
  title: string;
  body: string;
  tag?: string;
  sessionId?: string;
  url?: string;
}

export async function sendPush(payload: PushPayload): Promise<void> {
  const data = JSON.stringify(payload);
  const dead: string[] = [];
  await Promise.allSettled(
    [...subscriptions.values()].map((sub) =>
      webpush.sendNotification(sub, data).catch((err: any) => {
        if (err?.statusCode === 404 || err?.statusCode === 410) {
          dead.push(sub.endpoint);
        }
      })
    )
  );
  if (dead.length) {
    for (const ep of dead) subscriptions.delete(ep);
    saveSubscriptions();
  }
}

export function hasSubscriptions(): boolean {
  return subscriptions.size > 0;
}
