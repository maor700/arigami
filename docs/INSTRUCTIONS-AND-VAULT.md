# Editable instructions, per-agent/session inheritance, and a credential vault — design

Status: **phases 1, 2, 3a and 3c built** (server/prompt-blocks.ts, Settings › Customization, agent and session Advanced;
server/lib/credentials.ts, web/src/lib/vault.worker.js, the sign-in card, Settings › Connections › Passwords; `sign_in`
filling in the owner's Chrome on the shared desktop, TOTP from an entry). Phase 3b (passkey unlock, the sync setting) is
still a proposal. Each phase is shippable on its own. **The order of signing in lives in `docs/LOGIN.md`** — this file
is about storing and filling values.

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

Logins before this design: each session's Chrome starts empty; the owner's **My browser** (`chrome-base`, the login
vault in `server/lib/login-vault.ts`) handed one site's cookies to a session on approval, and took a fresh one back on
approval. A password was typed by the owner through take-over (`request_screen`). Nothing stored passwords. Today all
of it sits behind one tool, `sign_in` — see `docs/LOGIN.md`.

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

The `login` block is three lines: sign in with `sign_in`, never type or ask for a secret yourself, report a `blocked`
reason. The order itself is code (`server/lib/sign-in.ts`, `docs/LOGIN.md`), so editing the block cannot reorder it.

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
   Google and GitHub are refused here (an automated browser): `sign_in` signs in to them in the owner's own Chrome.
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

(As built, 3c: the agent no longer calls this tool — `sign_in` does, and its new sign-ins run in the owner's Chrome.
Later sessions get the site from that profile; nothing is saved back into My browser.)

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

### As built (3c) — filling in the owner's Chrome on the shared desktop

`sign_in` (`docs/LOGIN.md`) does a new sign-in in the owner's everyday Chrome, driven with real input, never DevTools.
The same vault and card fill it, with three differences:

- **One field per card, typed with real keys.** The agent clicks into a field and asks for that role
  (`sign_in({fill})`); the card (`target: "shared"`, the Chrome profile shown on it) fills exactly that one value — the
  worker's `exact` flag drops the "password for the next screen" a CDP card adds. The host types it with
  `xinput.py type-secret`, the value on stdin; nothing is submitted for the agent.
- **The origin is read from the outside.** No DevTools port means no in-page origin check; the host requires the focused
  window to be the owner's Chrome browser process and the profile's last navigation (History) to be on the lease's site
  or a sign-in provider, before the card and again right before typing (`sharedFillGuard`, `recheck`).
- **The answer goes to `sign_in`**, which is waiting on it: no "[host] …" line, the tool result says "typed" and never a
  value.
- TOTP: an entry's `otp` field (`otpauth://totp/…`) or `TOTP Seed` fills an `otp` field (`web/src/lib/totp.js`, RFC 6238).

### As built (VAULT2) — named fields: a secure form, a field fill, a names-only catalog

An entry holds more than a sign-in. The owner's details for a site — a card number and its expiry for a payment
verification, an ID number, a customer code — are **named fields** on the same KDBX entry (KeePassXC shows them as
additional attributes), each with a **type** that only shapes the cockpit's input (`secret` default, `text`, `multiline`,
`number`, `date`, `email`, `phone`, `otp`). Names are free (any language, ≤ 64 chars; `Title`/`URL`/`Notes`/`Arigami …`
are the entry's own). Values are memory-protected in the file unless the type is `text` or `multiline`; the types that the protected flag alone
would not say live in one JSON field, `Arigami field types`. Several accounts for one site are several entries, told
apart by title (and username). Entries that predate this keep working unchanged: `username` / `password` / `otp` are
the standard keys under their agent names.

Three tools, all riding with the `browser` family (`server/agent-policy.ts`), none of which ever returns a value:

| Tool | What happens | What the model hears |
|---|---|---|
| `vault_fields({site})` | reads the **catalog** (below) for that site's registrable domain | entries: id, title, origin, `[{name, type}]` |
| `vault_collect({site, fields:[{name,type?,label?}], title?, reason})` | a **secure form card** (`credentialRequest.kind = 'form'`): the owner types the values in the cockpit; the vault worker encrypts them into the entry (new or the one with that title) and uploads the ciphertext; the cockpit answers the card `saved` with the entry's id, title and field **names** | `{status:'saved', entry:{id,title,fields}}` / `cancelled` / `expired` |
| `vault_fill({site, field, entry?, target?, reason})` | in the **session browser only**: the host marks the field the agent means (the focused one, or by `target` words of its label/name/placeholder) with the request id, puts a card up (`kind:'field'`), and on the owner's tap types that one value into the marked element only, after re-checking the origin in the same tick, then draws the field as dots. Nothing is submitted. **While the session drives a sign-in in the owner's Chrome** (lease held) the call is refused before any card or value (`vaultFillTarget`): the owner's Chrome has no DOM for the host to mask in. | `{status:'filled'}` / `manual` / `blocked` / `cancelled` / `expired` |

- **The catalog** — `$ARIGAMI_DIR/user/vault/catalog.json` (0600, inside the ignored `vault/`): the cockpit uploads it
  after every save and on every unlock (`PUT /__api/vault/catalog`, admin only), so entries from before VAULT2 are
  known once the owner has unlocked the vault once. It is **names only**: ids, titles, origins and
  `[{name,type}]`. The host projects it on the way in (`cleanCatalog`) so whatever shape arrives, a value or a username
  cannot land in it. A session reads it per site: `GET /__api/sessions/:id/vault/fields?site=`.
- **The card is the same card.** `credentialRequest` gained `kind`, `spec` and `entry`; a request with no `kind` is a
  sign-in exactly as before. The host's own pending record stays authoritative; the fill route reads only the keys the
  card announced (a sign-in's roles, or the one named field); a form card is never filled into a page (`400`), and
  `saved` is accepted only for a form.
- **Automatic only under a one-time grant (VAULT4).** The per-site `auto` choice (made with "Remember" on a sign-in
  card) is a sign-in's and never reaches a named field (`pref` is `ask` on a field card). What does: the owner unlocks
  the vault on a field card and ticks "also fill the other details saved for this site in this session" — a grant held
  in that cockpit tab's memory only (`web/src/lib/vault-grants.js`), keyed by session + **exact origin**, for ONE entry
  and the field **names** it holds at that moment (the tick spells them out, with the session's name and the time), at
  most 60 minutes, off by default, gone when the vault locks, the session ends, the time is up or the owner taps Stop. A
  field saved on the entry later is not covered. Under it `VaultAutoFill` fills a field card from that entry (`auto:true,
  grant:true` on the fill body; the chat line says so); a miss or an error leaves the card up with the reason. Never a
  form, never the owner's Chrome (`target:'shared'`), never another origin. A field card also carries `saved` (the
  catalog, names only, holds this field for the origin) so a locked vault says "unlock to fill the saved X" instead of
  a dead end; the card's Fill is never a silent no-op.
- **The HTTP answer settles the card, the socket only tidies it.** A tap's outcome (`filled` / `cancel` / `manual`, or
  `404 no longer open` for a request another tab or the clock already settled) is shown on the card itself with nothing
  left to press, so a cockpit tab whose socket died never shows a live card for a dead request. A call into the vault
  worker always settles too (60 s clock, the worker's crash): a silent worker is dropped and restarted on the next call.
  All of it runs end to end in `test/vault-card-e2e.test.ts` — a real host, a real session Chrome, a real cockpit tab.
- **The card says where.** A field card carries `page: {tag, type, label}` read from the element the host marked, and
  shows "Into the page field “Card number” (input · text) · bank.example" — the owner judges the target, not only the
  site. A detail whose saved type is not plain text (secret, number, date, otp — or a name the catalog does not know)
  is refused before any card when the target is a `<textarea>`, a `type=search` / `role=searchbox` input or a field whose
  words say search: such fields echo their content back on the page.
- **No oracle through clicks.** `browser_click({text})` no longer matches an input's or textarea's *value* (it used to:
  `el.innerText || el.value`, a prefix oracle on anything the host had filled), and skips masked fields; labels,
  buttons, placeholders and select options still match (pinned in `test/credentials-fill.test.js`).
- **Host, not site.** The agent's `site` and `vault_fields({site})` are matched to the page's host exactly (`www.`
  aside, `sameHost`) — no hand-written "same site" suffix list decides where a value may go or which entries are
  listed. The sign-in card's legacy `registrable()` matching is unchanged for sign-ins.
- **Masking by input type.** Text inputs and textareas are drawn as dots after a fill; `number`, `date`, `month`,
  `week`, `time`, `datetime-local` and `range` inputs (Chrome draws no dots there) get a transparent text colour instead
  — pinned in pixels for text, textarea, number and date. A `<select>` shows its option text and is not masked.
- **Route-level allowlist.** `GET /sessions/:id/vault/fields` checks the agent's A3 policy (`toolAllowed`) itself, not
  only through the MCP tool list and the PreToolUse hook.
- **VAULT3 — an expiry into two selects.** `vault_fill({…, part: "month" | "year"})` on a saved expiry (`MM/YY`,
  `MM/YYYY`, `YYYY-MM`, `MMYY`…): the **vault worker** splits it (`expiryPart`, month → two digits, year → four, a
  two-digit year is 20YY) and sends only that part; the host and the agent never see the whole value, and a value in
  an unknown format is reported as "not an expiry in a known format" without the value. The host checks the part's
  shape itself before touching the page (`partShape`: month exactly `01`–`12`, year exactly `20YY`). Compatibility
  for a cockpit tab older than the host, which ignores `part` and sends the whole expiry: the fill route splits it in
  its own memory (`expiryPartOf`, the worker's rule) into the part that was asked for — never a whole expiry in a
  month field; anything that is neither a well-shaped part nor a whole expiry gets a 400 with a reload hint, nothing
  filled, and no message carries what was sent. The request's `reason` line, which every card generation shows,
  says `month of the saved expiry → select cmbExpiryMonth`, so the target is clear on an old card too. The new card
  shows the source as `expiry · month` and the target as `select · cmbExpiryMonth`. A `<select>` target gets the ONE
  enabled option that matches by value or text or as the same number (`03` ↔ `3`); a year (part `year`) also by its
  last two digits (`2027` ↔ `27`) — a month `03` never picks `2003`; disabled options and disabled optgroups are
  skipped (they would not be submitted); two candidates are no choice. No match → nothing chosen, the request stays
  open and the field keeps its mark so the owner can try again from the same card; the error names the select and
  its enabled-option count only. Every filled element is marked `data-arigami-filled`
  and, for a select, drawn transparent and made **`inert`** (plus `pointer-events: none`, `tabindex=-1`): no click —
  not through its `<label>` either — no focus (programmatic or Tab) and no key reaches it, so the native dropdown can
  never open, while the value stays in the form's submission (unlike `disabled`). `browser_click` refuses its spot and
  its label's (`clickGuardJs`), click-by-text skips both, `browser_type` refuses while a filled field has the focus
  (`humanGate` reason `filled`), and two different choices render byte-identical screenshots (pinned in
  `test/credentials-fill.test.js`: label click, programmatic focus, ArrowDown / Space / F4 via CDP — the value, the
  focus and the pixels unchanged, FormData still carrying it). Residual: the option list itself is public (months, years).
  **Intentional hardening (review F-6):** the same mark is on every filled input and textarea too — `browser_click`
  refuses a filled field and its `<label>`, click-by-text skips both, `browser_type` refuses while a filled field has
  the focus. An agent presses the page's own buttons; it never touches a filled field again.
- **The owner's side** — Settings › Connections › Passwords lists each entry's fields by name and type; the owner can add
  a field (name, type, value), replace one, **Reveal** / **Copy** a value (their own click, in their own tab, shown for
  20 s), remove one, and add an entry by hand (site, account name, username). The worker's `reveal` op is the one op
  that returns a value to the page script, and only on that click.
- **What the agent can see afterwards — session browser.** `browser_snapshot` reads `body.innerText`, which never
  includes an input's or a textarea's value. The pixels: the fill leaves the element drawn with
  `-webkit-text-security: disc !important` — dots on screen, the value intact for the page to submit; two different
  values of the same length render byte-identical screenshots (pinned in `test/credentials-fill.test.js`, where a plain
  field is the control that does change). Not perfect, and said so: the dot count still tells the value's length; a page
  script can remove the inline style; and, as in VAULT1, an agent with Bash can read the field over the session Chrome's
  DevTools port. "Never read the field back" in the tool text is advice, not the guard.
- **The owner's Chrome is not a target for named values.** The host has no DOM there, so a plain field would show the
  value as the site draws it to the agent's next `desktop_screenshot({shared:true})`. Rather than promise a masking it
  cannot do, `vault_fill` refuses while the session is driving a sign-in in the owner's Chrome (`vaultFillTarget`, pure,
  pinned in `test/sign-in.test.ts`): no card goes up, no value moves, and the answer says what to do — finish the
  sign-in (`sign_in({site, done:true})` brings the login into the session browser) and fill there, or hand a step only
  the owner should type to them (`sign_in({site, human})`). The three sign-in roles in the owner's Chrome stay
  `sign_in({fill})`'s, unchanged. Limit: a value the OWNER types on the shared desktop during a hand-over is on their
  screen like any typing of theirs.
- **Trust in `site`, and origin vs site.** The agent's `site` is a sanity check only: the origin that counts is the
  page's own (`location.origin`, read in-page at the request and again in the same tick as the fill). The worker then
  fills from an entry only if `entryAllowedFor` says so: a
  **named field** needs the entry's origin to be exactly the page's (a sibling subdomain or `http://` is another origin
  and gets nothing without the owner typing it there — which saves it for that origin); a **sign-in role** keeps the
  sign-in card's legacy rule, the same registrable domain (`login.x.example` serves `x.example`) — legacy, not claimed
  as isolation.
- **Logs and chat lines** name the field and the host (`🔑 Typed your card_number for bank.example…`, `Saved 3
  detail(s)…`); the fill and answer bodies are read and dropped, never echoed. `test/credentials.test.js`,
  `test/sign-in.test.ts`, `test/vault-host.test.ts` and `test/credentials-fill.test.js` pin it.

## Order of work

1. Phase 1: registry + overrides + Settings page + the `login` block (and the MCP rules moved in). Tests: composition
   per engine, override/disable/reset, effective preview.
2. Phase 2: agent and session layers + their Advanced sections. Tests: resolution order, restart prompt.
3. Phase 3a: vault file + cockpit unlock (master password) + credential card + fill route + preferences + the Chrome
   password-service switch. Tests: origin check, session-token 403, nothing in chat/log, KDBX round-trip with KeePassXC.
4. Phase 3b: passkey unlock, sync setting. (TOTP filling shipped with 3c.)

Phase 3 gets a security review of this section before code.

## Decided

- Vault unlock window: 1 hour from last use, adjustable.
- Vault file not synced to the user repo's remote by default; a setting turns it on.
