# Editable instructions, per-agent/session inheritance, and a credential vault — design

Status: **phases 1, 2 and 3a built** (server/prompt-blocks.ts, Settings › Customization, agent and session Advanced;
server/lib/credentials.ts, web/src/lib/vault.worker.js, the sign-in card, Settings › Connections › Passwords). Phase 3b
(passkey unlock, TOTP filling, the sync setting) is still a proposal. Each phase is shippable on its own.

Goal: automate everything that can be automated and take load off the owner — without the model, the chat or the
host's disk ever holding a password.

## Today

What the host puts in a session's context (all hard-coded):

| Block | Where | Engines | When |
|---|---|---|---|
| Links (`URL_GUIDANCE`) | `server/claude.js` | Claude + Codex | first turn of a fresh process |
| Login (`loginGuidance()`) — new | `server/claude.js` | both | first turn |
| Identity + capabilities + extensions (`identityReminder`) | `server/claude.js` | both | first turn |
| Agent persona (`personaBlock`) | `server/agents.ts` | both, agent sessions | first turn |
| Memory snapshot (USER.md / MEMORY.md) | `memoryBootstrapPrefix` | both | first turn, when non-empty |
| Simple mode (`SIMPLE_MODE_REMINDER`) | `server/claude.js` | both | every turn while on |
| Host rules: $TMPDIR, logins, outbound cards, teardown, container | `INSTRUCTIONS`, `mcp/host-mcp.js` | engines that surface MCP server instructions | MCP initialize |

Logins today: each session's Chrome starts empty; the owner's **My browser** (`chrome-base`, the login vault in
`server/lib/login-vault.ts`) hands one site's cookies to a session on approval (`request_login`), and takes a fresh one
back on approval (`save_login`). A password is typed by the owner through take-over (`request_screen`). Nothing stores
passwords. `docs/LOGIN.md` describes an older path (copying a whole personal Chrome profile) that this design retires
from the core and leaves to a user's own instructions.

## Phase 1 — instruction blocks the owner can edit

**Model.** Every injected text becomes a named block in one registry, `server/prompt-blocks.ts`:

```ts
interface PromptBlock {
  id: string;              // 'links' | 'login' | 'identity' | 'host-rules' | 'container' | 'simple-mode' | custom ids
  title: string;           // shown in Settings
  when: 'first-turn' | 'every-turn';
  engines?: ('claude' | 'codex')[];      // default: all
  editable: boolean;       // persona and memory are data, edited where they live — not here
  render(ctx): string;     // default text; may use {{sharedDisplay}}, {{capabilities}}, {{extensions}}
}
```

`composeTurnText` asks the registry for the effective blocks instead of concatenating constants. The MCP server's
`INSTRUCTIONS` move into the registry too (`host-rules`, `container`), rendered on the first turn for **every** engine;
the MCP initialize keeps a two-line fallback for a session that runs without the host's composition.

**Overrides live in the user repo**, so they are versioned and travel with it:

```
$ARIGAMI_DIR/user/prompts/<id>.md            replaces a built-in block's text (front-matter `enabled: false` turns it off)
$ARIGAMI_DIR/user/prompts/custom/<name>.md   an extra block; front-matter: when, engines, title
```

A missing file = the built-in default, so Arigami updates keep improving untouched blocks.

**Guidance, not enforcement.** Blocks are advice to the model. Every rule that matters is enforced in code regardless
of the text (outbound cards, the login card's session-token 403, `humanGate` on password fields, A3 domains). The
Settings page says so next to the guardrail blocks (`login`, `host-rules`) and warns before they are turned off.

**API** (admin only): `GET /__api/prompts` (blocks: default, override, effective), `PUT /__api/prompts/:id`,
`DELETE /__api/prompts/:id` (reset), `GET /__api/prompts/effective?session=|agent=&engine=` (the exact text a session
would get).

**UI — deliberately out of the way.** Nothing new on any page a normal owner sees. The editor sits on the Host page,
inside its collapsed **Advanced** drawer, as one more collapsed row: **Instructions (expert)** — closed by default, with
a one-line warning that this changes how every agent behaves. Opened: the list of blocks; each opens an editor with the
default beside the override, Reset, On/Off, and an "as a session sees it" preview for a chosen engine/agent. A changed
block shows a small "edited" mark there and nowhere else. An owner who never opens it never sees any of this — the
defaults just work.

The `login` block ships with Arigami's order (connections → engine connector → `request_login` → fresh sign-in with the
credential card / take-over → "sign in in My browser" for sites that refuse automation). An owner whose machine has
another way (e.g. a personal Chrome profile on the shared desktop) writes it in `user/prompts/login.md` or a custom
block — the core stays generic.

## Phase 2 — what an agent or a session inherits

Resolution, most specific first: **session → agent → user → Arigami**. Per block, a layer says `inherit` (default),
`off`, or gives its own text. Custom blocks can be added at any layer.

- Agent: `agent.json` gains `prompts: { [blockId]: 'inherit' | 'off' | { text } }`, `customPrompts: [...]`.
  UI: the agent page → the existing Advanced section → a collapsed **Instructions (expert)** row (same editor, scoped).
- Session: `metadata.prompts`, same shape. No control in the launcher or the session menu by default; the session's
  settings get the same collapsed **Instructions (expert)** row at the bottom of Advanced. Agents set it through
  `create_session` when they spawn a child. First-turn blocks apply from the next fresh process (restart offered);
  every-turn blocks from the next turn.
- Everything defaults to `inherit`, so an untouched agent or session needs no UI at all.
- The effective preview shows, per block, which layer won.

## Phase 3 — the credential vault and the sign-in card

### What it protects, and what it cannot

| Kept from | How |
|---|---|
| The model / agent | it asks for a sign-in and gets `{filled: true}`; values never pass through a tool result, prompt or MCP |
| The chat log, transcripts, host logs | the card holds no values; the fill request is never logged or echoed |
| The host's disk, backups, the user repo's remote | only a KDBX4 file (AES-256 / Argon2id) is stored; the key never reaches the host |
| Other sessions | a fill targets one pending request of one session, origin-checked |

**Not** protected: the moment of filling. The browser that receives the password runs on the host, so a compromised
host at that moment can capture it — exactly as with today's take-over, where the owner's keystrokes cross the host's X
server. And an agent with shell access can read a field's value off the page right after the fill; mitigations below
narrow that, they don't close it.

### Storage

- Format: **KDBX 4** (KeePass) — open, audited, and the owner can open the same file in KeePassXC / KeePassDX /
  Strongbox without Arigami. One entry per service: title, URL (origin), username, password, optional TOTP secret,
  plus an Arigami field for the sign-in preference.
- File: `$ARIGAMI_DIR/user/vault/arigami.kdbx`. **Not synced by default** (added to the user repo's `.gitignore`);
  Settings → Vault → "Sync the vault with the user repo" turns it on (ciphertext only, but an offline target for
  guessing the master password — the setting says so).
- Uploads are ciphertext-only with an ETag (`PUT /__api/vault/file`, admin only), so two devices can't clobber each other.

### Unlocking — in the owner's browser, never on the host

- The cockpit decrypts the file with **kdbxweb** (Argon2 via WASM) inside a Web Worker. The unlocked database lives
  only in that tab's memory.
- First version: master password. Then: a **passkey** (WebAuthn PRF extension) that wraps a random key file, so
  unlocking is one touch. Needs a secure context: `https://` (Tailscale serve / public URL) or `http://localhost`.
- Stays unlocked **1 hour from last use** (Settings → Vault, adjustable); closing the tab locks it.
- Consequence: an automatic sign-in needs an open, unlocked cockpit somewhere. When none is, the card waits and a push
  asks the owner to open it.

### The sign-in card

1. The agent calls a new tool, `request_credentials({site, reason})`, when its browser is on a sign-in form (the login
   block tells it to; `browser_type` already refuses password fields and points here).
2. The host inspects the page over CDP: origin, and the username / password / one-time-code inputs (selectors only).
   Google and GitHub are refused here, as in `request_login`: the card says to sign in in My browser instead.
3. A **credential card** appears (session state, like `screenRequest` — not a chat event with values):
   - vault unlocked and an entry for this origin → **Sign in as `<user>`** (one tap); with the preference "automatic",
     no tap;
   - otherwise the detected fields, **[Fill]**, ☑ **Save for next time** (on by default), **[I'll type it myself]**,
     ☐ **Remember this choice for the site**.
4. Fill: the cockpit sends `{requestId, values-by-selector}` over the authenticated HTTPS connection to
   `POST /__api/sessions/:id/credentials/fill` — admin principal only (a session token gets 403, like the login card).
   The host checks the request is pending and the page's origin still equals the entry's origin (no filling a look-alike
   page), sets the values through CDP with input events, submits if the form has one submit, clears its copies, and
   resolves the tool with `{filled: true, submitted}`. The request body is excluded from request logging.
5. Save: the cockpit adds or updates the entry locally, re-encrypts, uploads the file.
6. One-time codes: an OTP field gets its own card. With a TOTP secret in the entry and "fill one-time codes" switched
   on for it (off by default), the cockpit computes the code and fills it.
7. "I'll type it myself" opens today's take-over (`request_screen`). With "remember", that site always goes straight to
   take-over. Preferences without secrets live in `$ARIGAMI_DIR/login-prefs.json` (origin → auto | ask | manual).

After a successful sign-in the agent still offers `save_login` (cookies into My browser), so most later sessions get
the site through `request_login` without any password at all.

### Hardening that comes with it

- Session Chrome profiles stop offering to save passwords (`credentials_enable_service=false`), so a filled password
  never lands in Chrome's own `Login Data` (which `--password-store=basic` keeps barely protected).
- Host DOM reads (`browser_snapshot`, click-by-text, any evaluate route) never return `input[type=password]` values —
  `innerText` already doesn't; this adds a test that pins it.
- Residual, documented: an agent with Bash can reach the session Chrome's DevTools port and read a field. Agents meant
  to sign in can be given the `browser` family without `Bash`.

### As built (3a) — what changed from the proposal above

- **Roles, not selectors.** The cockpit names `username` / `password` / `otp`; the host finds those fields with the
  same in-page detector the card's inspection used, so a value can't be aimed at any other field. The origin check runs
  inside the page in the same tick as the fill. A username-first form gets its password on the next screen (same tab,
  same origin, up to 10 s).
- **The host's record is the card.** The session's `credentialRequest` is a mirror for the UI; the fill and answer
  routes read the host's own pending record, and a session PATCH can never set the field (an agent that could rename
  the site on its card could get one site's password typed into another).
- **The owner's cockpit cookie only** for fill and answer — not a session token, not the host token, not an API token.
- **Non-blocking**, like `request_login`: the tool returns `{pending:true}` and the outcome arrives as a "[host] …" line.
- **No `type="password"` in the cockpit.** The card's secret inputs are text inputs drawn as dots; a real password input
  made the owner's own browser offer to save the value into its password manager.
- **Automatic** = the owner ticked "Remember this choice" after filling from the vault; any cockpit tab with the vault
  unlocked then fills it without a tap, only with exactly one saved entry for that exact origin.
- Lives in Settings › Connections › **Passwords** (status, lock, entries, unlock window, per-site choices, download the
  `.kdbx` for KeePassXC).

## Order of work

1. Phase 1: registry + overrides + Settings page + the `login` block (and the MCP rules moved in). Tests: composition
   per engine, override/disable/reset, effective preview.
2. Phase 2: agent and session layers + their Advanced sections. Tests: resolution order, restart prompt.
3. Phase 3a: vault file + cockpit unlock (master password) + credential card + fill route + preferences + the Chrome
   password-service switch. Tests: origin check, session-token 403, nothing in chat/log, KDBX round-trip with KeePassXC.
4. Phase 3b: passkey unlock, TOTP filling, sync setting.

Phase 3 gets a security review of this section before code.

## Decided

- Vault unlock window: 1 hour from last use, adjustable.
- Vault file not synced to the user repo's remote by default; a setting turns it on.
