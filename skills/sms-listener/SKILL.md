---
description: Register an SMS listener that receives incoming SMS messages from the user's phone via Macrodroid webhook. Use when Claude needs to receive SMS verification codes, OTPs, or monitor incoming text messages. The phone forwards SMS to Arigami's webhook endpoint, and the listener wakes the session when new messages arrive.
argument-hint: [from-filter, e.g. "+972..." to only match a specific sender]
---

# SMS Listener

Receive incoming SMS messages from the user's Android phone in real time.

## How it works

1. **Macrodroid** on the user's phone detects incoming SMS
2. Sends a GET request to `/__api/webhooks/sms?t=<token>&from={sms_number}&body={sms_message}`
3. Arigami verifies the token, stores the SMS and the listener polls for new messages
4. Session is woken with the SMS content + push notification to phone

## Setup

- **Phone app**: Macrodroid (free) with an SMS Received trigger → HTTP GET action
- **Webhook URL + token**: cockpit → Settings → Webhooks → SMS → *Rotate* shows the
  complete URL (built from `ARIGAMI_PUBLIC_URL`). Append the Macrodroid
  placeholders: `…/__api/webhooks/sms?t=<token>&from={sms_number}&body={sms_message}`.
  The token can also travel as an `X-Arigami-Token` header, and POST JSON
  `{from, body}` works too. An admin can fetch it with `GET /__api/webhooks/token`.
- **Token lifecycle**: long-lived (1 year), *Rotate* invalidates the old one
  immediately, *Revoke* closes the route. Without/with a wrong token the host
  answers `401 {"error":"unauthorized"}` with no detail.
- **Reachability**: phone and host on the same tailnet (via `tailscale serve`),
  or — only if you need it from outside the tailnet — Settings → Webhooks →
  *Funnel*, which exposes `/__api/webhooks` and nothing else.
- **Legacy**: `/__api/sms/inbound?from=&body=` (no token) still works for one
  release and logs a deprecation warning — repoint the phone to the new URL.

## Registering a listener

```bash
# All SMS
curl -X POST "$ARIGAMI_URL/__api/sessions/$ARIGAMI_SESSION_ID/listeners" \
  -H "Authorization: Bearer $ARIGAMI_TOKEN" -H "Content-Type: application/json" \
  -d '{"type":"sms"}'

# Only SMS from a specific number (partial match)
curl -X POST "$ARIGAMI_URL/__api/sessions/$ARIGAMI_SESSION_ID/listeners" \
  -H "Authorization: Bearer $ARIGAMI_TOKEN" -H "Content-Type: application/json" \
  -d '{"type":"sms","from_filter":"+972..."}'
```

Or via the MCP `register_listener` tool:
```
type: "sms"
from_filter: "+972..."  (optional)
interval_sec: 5         (default)
ttl_days: 7             (default)
```

## Notification format

When SMS arrives, the session receives:
```
🔔 1 new SMS:
📱 SMS from NEXTTV|: Your code is 665372...
```

## Use cases

- **SMS verification codes**: Register a listener before triggering a login/signup flow that sends an OTP
- **2FA codes**: Receive authentication codes during automated flows
- **SMS monitoring**: Watch for messages from a specific sender

## Tips

- Register the listener BEFORE triggering the SMS (so it's ready to catch it)
- Use `from_filter` to narrow to a specific sender when you know who will send the code
- The listener auto-stops after `ttl_days` (default 7)
- Push notification is sent to the user's phone when SMS arrives
