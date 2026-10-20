// Loaded first in every Claude session that has extension mods (server/claude.js pluginDirArgs). A mods API call is
// itself an event, so this sees the $.ui.log / toast / notice calls of the mods that run after it and copies each to
// the session's chat (POST .../mods/notice), then lets it through. Claude Code's own built-in mods are not echoed.
async function forward($, e, next) {
  if (next.origin && next.origin.tier !== 'builtin' && e && typeof e.text === 'string' && e.to !== 'debug') {
    try {
      const [base, sid, token] = await Promise.all([$.env.get('ARIGAMI_URL'), $.env.get('ARIGAMI_SESSION_ID'), $.env.get('ARIGAMI_TOKEN')])
      if (base && sid && token) {
        await $.http.fetch(base + '/__api/sessions/' + encodeURIComponent(sid) + '/mods/notice', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
          body: JSON.stringify({ plugin: next.origin.plugin, text: e.text }),
        })
      }
    } catch {}
  }
  return next(e)
}

export function register(on) {
  on('ui.log', async ($, e, next) => forward($, e, next))
  on('ui.toast', async ($, e, next) => forward($, e, next))
  on('ui.notice', async ($, e, next) => forward($, e, next))
}
