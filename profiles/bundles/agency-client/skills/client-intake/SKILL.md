---
description: Turn a new client request (pasted message, email, or a sentence from the human) into a well-formed ticket and, if the human approves, a child session that works it. Use when the human says "new request from the client", "intake this", "the client asked for …", or pastes a client message and asks what to do with it.
argument-hint: [the client's request, verbatim]
---

# Client intake — request → ticket → child session

Nothing here is automatic: the human sees the ticket before it is filed and
chooses whether a session starts. Your job is to make both decisions easy.

## 1. Understand
1. Read `CLIENT.md` (workspace root) for the ticket source, labels and
   definition of done.
2. Restate the request in one sentence. If it is ambiguous in a way that
   changes the work, list the 1–3 interpretations — do not guess silently.
3. Classify: `bug` / `feature` / `question` / `change-request`. Estimate size
   (S / M / L) from the codebase — grep the `app` repo for the relevant area
   before estimating.

## 2. Draft the ticket
Write it in the client's language (per CLIENT.md), in this shape:

```
Title:      <verb + object, ≤ 60 chars>
Label(s):   client-request, <type>
Context:    <the request, quoted, and where it came from>
Acceptance: - <observable outcome 1>
            - <observable outcome 2>
Notes:      <size, affected area, open questions>
```

## 3. Ask before filing
`request_action({prompt:"File ticket '<title>' (<type>, <size>)?", buttons:[
  {label:"File + start session", value:"file-start", style:"primary"},
  {label:"File only", value:"file"},
  {label:"Edit first", value:"edit"},
  {label:"Drop", value:"drop", style:"danger"}]})`
and stop until the answer arrives. On `edit`, show the draft and wait for the
human's text.

## 4. File
- GitHub: `gh issue create --repo <owner/app> --title … --label … --body …`
  (only if CLIENT.md names GitHub; otherwise write the ticket to
  `./tickets/<date>-<slug>.md` in the workspace and say where it is).
- Record one line in the journal: `memory_write({target:"journal", action:"add",
  content:"intake: <title> → <ticket ref>"})`.

## 5. Start a child session (only on `file-start`)
`create_session({kind:"full", title:"<ticket ref> — <title>", prompt:"Work ticket <ref>: <title>. Acceptance: …. Read CLIENT.md first. Open a PR against main and request_review when done.", metadata:{ticket:"<ref>"}})`.
Reply with the child's host-relative `url` as returned. Track it like the
`project-manager` skill does: the human reviews the child's work directly; you
only relay status.
