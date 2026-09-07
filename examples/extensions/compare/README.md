# compare — a vs-baseline slider, as an extension

Two panes, one draggable divider: on the right the build you are looking at, on
the left a baseline (staging, production, the last published Storybook). Drag the
divider to wipe between them; clicks, typing and scrolling in one pane are
mirrored into the other, so both stay on the same screen of the same flow.

```bash
bin/host ext add examples/extensions/compare --trust
```

Then, from the chat or the tab bar:

```
/compare                                        # opens empty — type both URLs
open_tab({ type: 'ext', ext: 'compare' })
open_tab({ type: 'ext', ext: 'compare', params: { a: '<dev url>' } })
open_tab({ type: 'ext', ext: 'compare', params: { a: '<dev url>', b: '<baseline url>' } })
```

With one URL, the baseline comes from the extension's settings
(Settings › Extensions › compare):

| setting | does |
|---|---|
| `baselineUrl` | the default right-hand side, e.g. your staging origin. Empty by default — nothing personal ships with this example. |
| `autoPath` | on (default): take the path + query of the URL under review and apply them to the baseline origin. Off: open `baselineUrl` exactly as written. |

## Why `"trusted": true`

Both panes are embedded through the **host proxy** (`/?__target=<href>`): each
iframe becomes its own service-worker client pinned to its own target, which is
what makes the two pages same-origin with the cockpit — iframable, logged in,
and with their DOM reachable, which the click/scroll mirroring needs.

A sandboxed extension tab has an opaque origin, and an opaque origin can neither
register or be served by a service worker nor carry the session cookie: both
panes would come back blank or 401. So this extension asks for the trusted tier
(docs/EXTENSIONS.md §7.1) — its tab is served without the CSP sandbox, like the
cockpit's own pages. That is a real grant with a real consequence, which is why
it is a `--trust` / a checkbox and never implied by the manifest.

## Known edges

* A baseline behind a WAF (Cloudflare and friends) may 403 a few assets through
  the proxy, so that pane can look slightly degraded — layout and content still
  compare fine.
* A baseline whose SSO rejects the proxy's redirect URI loops on its own login
  page. The tab detects that and offers "open directly" / "retry" instead of
  flickering forever.
* Mirroring is best-effort: it locates the "same" element by `data-testid`, a
  stable `id`, an `href`, an `aria-label` or a positional CSS path. Across two
  structurally different builds some clicks will not find a twin — turn sync off
  and drive each pane by hand.
