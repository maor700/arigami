// PWA push notification subscription manager.

async function ensureSW() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return null;
  await navigator.serviceWorker.register('/__host/sw.js', { scope: '/__host/' });
  return navigator.serviceWorker.ready;
}

export async function subscribePush() {
  const reg = await ensureSW();
  if (!reg) throw new Error('Push not supported');

  const res = await fetch('/__api/push/vapid-public-key');
  if (!res.ok) throw new Error('Failed to fetch VAPID key');
  const { publicKey } = await res.json();

  const raw = atob(publicKey.replace(/-/g, '+').replace(/_/g, '/'));
  const key = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) key[i] = raw.charCodeAt(i);

  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: key,
    });
  }

  const resp = await fetch('/__api/push/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(sub.toJSON()),
  });
  if (!resp.ok) throw new Error('Server rejected subscription');
  return sub;
}

export async function unsubscribePush() {
  const reg = await navigator.serviceWorker?.ready;
  if (!reg) return;
  const sub = await reg.pushManager.getSubscription();
  if (sub) {
    await fetch('/__api/push/unsubscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: sub.endpoint }),
    });
    await sub.unsubscribe();
  }
}

export async function isPushSubscribed() {
  if (!('serviceWorker' in navigator)) return false;
  const reg = await navigator.serviceWorker.getRegistration('/__host/');
  if (!reg) return false;
  return !!(await reg.pushManager.getSubscription());
}
