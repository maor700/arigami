// OPENUI pilot — standalone fixture page for `vite --port $PORT` → /__host/openui-demo.html.
// No host, no store: the cards render against a stubbed api.post that logs the message.
import { createRoot } from 'react-dom/client';
import '../index.css';
import { api } from '../lib/api.js';
import OpenUICard, { preloadOpenUI } from '../components/OpenUICard.jsx';
import { FIXTURES } from './fixtures.js';

const log = [];
api.post = async (url, body) => { log.push({ url, body }); render(); return { ok: true }; };

function Demo() {
  return (
    <div className="mx-auto max-w-[640px] p-4 text-fg" style={{ background: 'var(--term-bg)', minHeight: '100vh' }}>
      <h1 className="mb-3 text-[15px] font-bold">OpenUI card demo</h1>
      {FIXTURES.map((f) => (
        <section key={f.name} className="mb-4">
          <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.08em] text-fgdim">{f.name}</div>
          <OpenUICard sessionId="demo" event={{ kind: 'openui', ui: f.ui, title: f.title }} />
        </section>
      ))}
      <section>
        <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.08em] text-fgdim">messages sent</div>
        <pre className="rounded-md bg-[var(--term-codebg)] p-2 text-[11px]" dir="ltr">{log.map((l) => `${l.url}\n${l.body.text}`).join('\n\n') || '—'}</pre>
      </section>
    </div>
  );
}
const root = createRoot(document.getElementById('root'));
function render() { root.render(<Demo />); }
document.documentElement.dataset.theme = new URLSearchParams(location.search).get('theme') || 'dark';
preloadOpenUI().then(render);
