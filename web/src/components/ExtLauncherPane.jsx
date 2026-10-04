// An extension's tab, rendered as a MODE OF THE LAUNCHER (manifest
// `openFrom: ["launcher"]`).
//
// Why this is its own component and not SessionView's ExtTab: that one is built
// around a tab RECORD on a session — it reads `tab.url`, patches
// `/sessions/:id/tabs/:tabId` for setStatus, and closes itself by deleting the
// record. None of those exist here. A launcher tab has no session and no tab
// record; it has the extension's entry URL and a bridge running in sessionless
// mode, where the session-scoped calls refuse and `runTool` + `createSession`
// are the surface.
//
// The seam this serves: a creation flow that belongs to a ROLE ("review a pull
// request" is a developer's, not everyone's) should not be a fourth hardcoded
// mode in the core launcher. It arrives as an extension that claims a mode.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../lib/store.js';
import { tabSrc } from '../lib/hostUrl.js';
import { findExtension } from '../lib/ext.js';
import { createExtBridge } from '../lib/ext-bridge.js';
import { currentLang, useT } from '../lib/i18n.js';
import { currentTheme, usePrefs } from '../lib/prefs.js';

export default function ExtLauncherPane({ item, onCreated, getSessionOptions }) {
  const t = useT();
  const { extensions } = useStore();
  const [reloadKey, setReloadKey] = useState(0);
  const iframeRef = useRef(null);
  const bridgeRef = useRef(null);
  const extRecord = useMemo(() => findExtension(extensions, item.ext), [extensions, item.ext]);
  // Fail closed, exactly as ExtTab does: an extension we have no record for is
  // sandboxed, and flipping the answer remounts the iframe because `sandbox`
  // only takes effect at navigation.
  const sandboxed = extRecord?.trusted !== true;

  // Read live so a settings edit or a reload lands without tearing the bridge
  // (and the page's own state) down.
  const liveRef = useRef(null);
  liveRef.current = { ext: extRecord, getSessionOptions };

  useEffect(() => {
    const bridge = createExtBridge({
      // The whole point: no session yet.
      sessionId: null,
      tabId: null,
      extension: item.ext,
      getWindow: () => iframeRef.current?.contentWindow || null,
      getPermissions: () => liveRef.current?.ext?.permissions || [],
      getContext: () => {
        const l = liveRef.current || {};
        return {
          sessionId: null,
          tabId: null,
          extension: item.ext,
          apiVersion: l.ext?.apiVersion ?? 1,
          agent: null,
          cwd: '',
          settings: l.ext?.settings || {},
          lang: currentLang(),
          theme: currentTheme(),
          permissions: l.ext?.permissions || [],
        };
      },
      onCreated: (session) => onCreated?.(session),
      getSessionOptions: () => liveRef.current?.getSessionOptions?.() || null,
      // targetOrigin '*' is forced: a sandboxed page has an opaque origin and
      // cannot be named. Inbound messages are authenticated the other way
      // round, by contentWindow identity.
      post: (msg) => {
        try { iframeRef.current?.contentWindow?.postMessage(msg, '*'); } catch { /* iframe gone */ }
      },
    });
    bridgeRef.current = bridge;
    const onMsg = (e) => bridge.onMessage(e);
    window.addEventListener('message', onMsg);
    return () => {
      window.removeEventListener('message', onMsg);
      bridge.dispose();
      bridgeRef.current = null;
    };
  }, [item.ext, item.tab, onCreated]);

  // A live theme switch must reach the tab: it is a separate document that
  // cannot see our CSS, so without this it keeps the palette it booted with.
  // Re-sending the context is enough — the SDK treats init as idempotent.
  const prefs = usePrefs();
  useEffect(() => { bridgeRef.current?.sendInit?.(); }, [prefs.theme]);

  if (!extRecord) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1 bg-bg text-center">
        <div className="text-[13px] font-bold text-fg">{t('launcher.ext.gone')}</div>
        <div className="text-[11.5px] text-fgdim">{item.ext}</div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-bg">
      <iframe
        key={`${item.mode}:${sandboxed ? 's' : 't'}:${reloadKey}`}
        ref={iframeRef}
        src={tabSrc(item.url)}
        title={item.title}
        className="min-h-0 flex-1 border-0 bg-white"
        {...(sandboxed ? { sandbox: 'allow-scripts allow-forms allow-popups' } : {})}
      />
      <div className="flex h-7 shrink-0 items-center gap-2 border-t border-hair bg-panel px-2.5">
        <span className="font-mono text-[9.5px] tracking-[0.06em] text-fgdim uppercase">
          {extRecord.title || item.ext}
        </span>
        <button
          type="button"
          onClick={() => setReloadKey((k) => k + 1)}
          className="ml-auto cursor-pointer font-mono text-[9.5px] text-fgdim uppercase hover:text-fg"
        >
          {t('launcher.ext.reload')}
        </button>
      </div>
    </div>
  );
}
