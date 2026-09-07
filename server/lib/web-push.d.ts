// `web-push` ships no types (and there is no @types package). It is used in
// exactly one place (server/push.ts) through a handful of calls, so declare
// that surface instead of turning `strict` off for the file.
declare module 'web-push' {
  namespace webpush {
    interface VapidKeys {
      publicKey: string;
      privateKey: string;
    }
    interface PushSubscription {
      endpoint: string;
      expirationTime?: number | null;
      keys: { p256dh: string; auth: string };
    }
    function generateVAPIDKeys(): VapidKeys;
    function setVapidDetails(subject: string, publicKey: string, privateKey: string): void;
    function sendNotification(subscription: PushSubscription, payload?: string, options?: Record<string, unknown>): Promise<unknown>;
  }
  export = webpush;
}
