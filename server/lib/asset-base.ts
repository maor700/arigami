// Shared HTML rewriting for documents served under CSP `sandbox` — published
// artifacts (A1/K2/F5, server/artifacts.ts) and extension tabs (EXT,
// server/ext-serve.ts).
//
// Both live at an opaque origin, so the browser calls every sub-request they
// make cross-site and never attaches the SameSite=Lax session cookie. The cure
// is the same in both places: the entry HTML is served on an AUTHENTICATED
// request, and its own references are routed through a `~t/<token>/` path
// segment carrying a short-lived, object-scoped capability. Hence one module
// for the three string transforms that do it.
//
//   injectBase          — force a <base> so relative URLs resolve under our mount
//   rewriteBaseForToken — /__x/<id>/…        → /__x/<id>/~t/<token>/…   (in <base href>)
//   rewriteAbsoluteRefs — src|href="/__x/<id>/…" → the same (root-absolute URLs
//                         bypass <base>, so they need their own pass)

/** The path segment that carries a capability token: `/__x/<id>/~t/<token>/…`. */
export const TOKEN_SEG = '~t';

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// `<base href>` injection. The document is served from a mount of ours (and,
// for cookie-less viewers, its tokenized `~t/<token>/` form), so the document's
// OWN base — usually `./` or the site it was built for — would send every
// relative URL to the wrong place: any existing <base> is overridden (its
// `target` attribute is kept, that is the only other thing <base> does).
// Placed right after <head> so it precedes every relative URL. Root-absolute
// URLs (src="/x") are NOT fixed by <base> — see rewriteAbsoluteRefs.
export function injectBase(html: string, href: string): string {
  const own = /<base(\s[^>]*)?>/i.exec(html);
  if (own) {
    const tm = /\starget=(["'][^"']*["']|[^\s>]+)/i.exec(own[1] || '');
    const tag = `<base href="${href}"${tm ? ` target=${tm[1]}` : ''}>`;
    return html.slice(0, own.index) + tag + html.slice(own.index + own[0].length);
  }
  const tag = `<base href="${href}">`;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => m + tag);
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, (m) => m + '<head>' + tag + '</head>');
  return tag + html;
}

/**
 * `<base href="<prefix>v3/…">` → `<base href="<prefix>~t/<token>/v3/…">`.
 * `prefix` is the object's own mount, WITH its trailing slash
 * (`/__artifacts/<aid>/`, `/__ext/<name>/`). Idempotent.
 */
export function rewriteBaseForToken(html: string, prefix: string, token: string): string {
  const re = new RegExp(`(<base\\s[^>]*href=["'])(${escapeRe(prefix)})(?!${TOKEN_SEG}/)`, 'i');
  return html.replace(re, (_m, pre: string, base: string) => `${pre}${base}${TOKEN_SEG}/${token}/`);
}

/**
 * `src="<prefix>x.png"` → `src="<prefix>~t/<token>/x.png"`. Root-absolute URLs
 * bypass <base>, so a page that references its own mount that way needs this
 * second pass. Only attribute values are touched, never an already-tokenized
 * one. Idempotent.
 */
export function rewriteAbsoluteRefs(html: string, prefix: string, token: string): string {
  const re = new RegExp(`((?:src|href|poster|data)=["'])(${escapeRe(prefix)})(?!${TOKEN_SEG}/)`, 'gi');
  return html.replace(re, (_m, pre: string, base: string) => `${pre}${base}${TOKEN_SEG}/${token}/`);
}

/**
 * Split `<rel>` (a path under the mount, '' or '/a/b/c.html') off the token
 * segment: returns the token (or null) and the remaining rel. Shared so both
 * mounts accept `?t=` and `~t/` identically.
 */
export function stripTokenSegment(rel: string): { rel: string; token: string | null } {
  const segs = rel.split('/');
  // ['', '~t', '<token>', ...rest]
  if (segs.length >= 3 && segs[1] === TOKEN_SEG && segs[2])
    return { token: segs[2], rel: segs.length > 3 ? '/' + segs.slice(3).join('/') : '/' };
  return { rel, token: null };
}
