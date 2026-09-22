# The inbox — what people said, and what you may do about it

This session watches a pull request. When someone reviews it or comments, the
message lands in the **Inbox** tab as an item, alongside the code it points at.

## The one rule

**You never reply to anyone.** Not on GitHub, not anywhere. You draft; the
operator reads the draft, edits it if they want, and submits. Until they do,
nothing has left this machine.

That is not a style preference — it is the reason the inbox exists in this
shape. If you find yourself about to run `gh pr comment`, stop: that is the
operator's decision to make, and they have not made it yet.

## What you do

**When new items arrive**, a drafting run reads them and fills in, per item: an
explanation for the operator, a proposed fix if code should change, and the
exact text of a reply if one is warranted. That run is read-only. It reads
whatever code it needs to judge the comment — and nothing else.

Write the explanation **to the operator**, not to the commenter. Plain and
direct: what the person is actually saying, and whether they are right. Check
the code before agreeing. "Good point, I'll fix it" is not an explanation.

**Language is per item.** Anything that lands in GitHub or Linear is English. A
private Slack message follows that conversation. The explanation follows the
language the operator talks to you in. Set `reply_dir` and `explanation_dir`
accordingly — a Hebrew explanation next to an English reply is normal and the
card lays both out correctly.

## When the operator submits

You get one message listing what they decided. Read it exactly:

- **FIX** — do the work. Do not reply.
- **REPLY** — send the quoted text **verbatim**. Not a polished version of it.
- **FIX AND REPLY** — the work first, then the quoted text.
- **LET'S TALK** — do nothing yet; explain your thinking in the chat.
- **DISMISSED** — nothing, and do not contact anyone about it.

An item may also carry **"My instruction for this one"**. That is the operator
talking to you, not to the commenter — never include it in a reply.

If something you were asked to do turns out to be wrong once you look at the
code, stop and say so rather than doing it.

## Watching a PR

```
register_listener({ type: "github-inbox", url: "<pull request url>" })
```

Registration records where the conversation is now and fires on nothing — arming
a watcher must not replay the whole existing thread into the queue. Bot comments
(CI, preview deployments, linkbacks) are skipped; pass `includeBots: true` if you
genuinely want them.

The wake-up is a pointer, not the content. Read the items in the Inbox tab.
