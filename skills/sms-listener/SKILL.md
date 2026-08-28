---
description: Register an SMS listener that receives incoming SMS messages from the user's phone via Macrodroid webhook. Use when Claude needs to receive SMS verification codes, OTPs, or monitor incoming text messages. The phone forwards SMS to Arigami's webhook endpoint, and the listener wakes the session when new messages arrive.
argument-hint: [from-filter, e.g. "+972..." to only match a specific sender]
---

# SMS Listener

Receive incoming SMS messages from the user's Android phone in real time.

## How it works

1. **Macrodroid** on the user's phone detects incoming SMS
2. Sends a GET request to `/__api/sms/inbound?from={sms_number}&body={sms_message}`
3. Arigami stores the SMS and the listener polls for new messages
4. Session is woken with the SMS content + push notification to phone

## Setup

- **Phone app**: Macrodroid (free) with an SMS Received trigger → HTTP GET action
- **Webhook URL**: `https://<your-tailnet-hostname>/__api/sms/inbound?from={sms_number}&body={sms_message}`
  — get `<your-tailnet-hostname>` from `GET /__api/remote`, or from the
  cockpit's Settings → Remote access panel, once Tailscale Serve is enabled
  for this host.
- **Tailscale**: Phone and host on the same tailnet — endpoint is VPN-only, not public

## Registering a listener

```bash
# All SMS
curl -X POST http://localhost:3099/__api/sessions/{SESSION_ID}/listeners \
  -H "Content-Type: application/json" \
  -d '{"type":"sms"}'

# Only SMS from a specific number (partial match)
curl -X POST http://localhost:3099/__api/sessions/{SESSION_ID}/listeners \
  -H "Content-Type: application/json" \
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
