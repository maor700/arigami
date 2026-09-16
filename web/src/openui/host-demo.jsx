// OPENUI phase 2 — fixture page: every host card kind through the REAL
// ChatPane, no host behind it (WebSocket + api stubbed before anything loads).
//   /__host/host-demo.html?theme=dark|light&lang=he|en&w=390
import '../index.css';

globalThis.WebSocket = class { constructor() { setTimeout(() => this.onerror?.(new Event('error')), 0); } close() {} send() {} addEventListener() {} removeEventListener() {} };
const q = new URLSearchParams(location.search);
const theme = q.get('theme') || 'dark';
const lang = q.get('lang') || 'en';
const width = Number(q.get('w')) || 0;

const [{ createRoot }, { api }, prefs, { default: ChatPane }, { HOST_EVENTS, HOST_ACTION }] = await Promise.all([
  import('react-dom/client'),
  import('../lib/api.js'),
  import('../lib/prefs.js'),
  import('../components/ChatPane.jsx'),
  import('./host-fixtures.js'),
]);
const log = [];
const stub = async (url, body) => { log.push({ url, body }); render(); return { ok: true, skills: [], sessions: [], delivered: 'tool', canMerge: true }; };
api.get = stub; api.post = stub; api.del = stub; api.patch = stub;
prefs.setPrefs({ theme, language: lang, termTheme: theme, termDir: lang === 'he' ? 'rtl' : 'ltr' });
document.documentElement.dataset.theme = theme;

function Demo() {
  return (
    <div className="mx-auto flex h-screen flex-col" style={{ maxWidth: width || 760, background: 'var(--term-bg)' }}>
      <div className="min-h-0 flex-1">
        <ChatPane sessionId="demo" events={HOST_EVENTS} awaiting action={HOST_ACTION} mode="full" />
      </div>
      <pre className="max-h-24 shrink-0 overflow-auto border-t border-hair p-2 font-mono text-[10px] text-fgdim" dir="ltr">
        {log.map((l) => `${l.url} ${l.body ? JSON.stringify(l.body).slice(0, 80) : ''}`).join('\n') || 'no api calls yet'}
      </pre>
    </div>
  );
}
const root = createRoot(document.getElementById('root'));
function render() { root.render(<Demo />); }
render();
