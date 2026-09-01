// Render the REAL waiting page (src/templates.ts startingPage) driven by the
// REAL progress logic (src/progress.ts stepsFor) into one self-contained HTML
// file, so the UI can be reviewed without a cluster.
//
// Everything here is genuine except the CLOCK: the phases are the ones k8s
// actually reports, computed by the same pure function the server calls, but
// replayed on a timer instead of waiting for a real pod. The page's own
// polling code is untouched — only `fetch` is stubbed, so what you see is the
// shipped markup, CSS and client script.
//
//   bun test/fixtures/preview-starting.ts [out.html]
import { startingPage } from '../../src/templates.js';
import { stepsFor, EMPTY_SNAPSHOT, type PodSnapshot } from '../../src/progress.js';

const snap = (over: Partial<PodSnapshot> = {}): PodSnapshot => ({ ...EMPTY_SNAPSHOT, ...over });
const ORG = 'Fake Org';

// One entry per state a first provision really passes through, in order.
const script: { afterMs: number; state: string; snap: PodSnapshot }[] = [
  { afterMs: 0, state: 'provisioning', snap: snap() },
  { afterMs: 3000, state: 'provisioning', snap: snap({ exists: true, phase: 'Pending', waitingReason: 'ContainerCreating' }) },
  { afterMs: 9000, state: 'provisioning', snap: snap({ exists: true, phase: 'Running' }) },
  { afterMs: 15000, state: 'provisioning', snap: snap({ exists: true, phase: 'Running', bundleApplied: true }) },
  { afterMs: 19000, state: 'running', snap: snap() },
];

const frames = script.map((s) => ({
  afterMs: s.afterMs,
  body: { ...stepsFor(s.state, s.snap, s.afterMs, ORG), ...(s.state === 'running' ? { redirect: '#preview-would-land-in-the-workspace' } : {}) },
}));

const stub = `<script>
(function () {
  var frames = ${JSON.stringify(frames)};
  var t0 = Date.now();
  var realFetch = window.fetch;
  window.fetch = function (url) {
    if (String(url).indexOf('/api/progress') === -1) return realFetch.apply(this, arguments);
    var elapsed = Date.now() - t0;
    var f = frames[0];
    for (var i = 0; i < frames.length; i++) if (elapsed >= frames[i].afterMs) f = frames[i];
    return Promise.resolve({ json: function () { return Promise.resolve(f.body); } });
  };
  // The real page navigates on ready; in a preview just say so and restart.
  var nav = false;
  Object.defineProperty(window, '__preview', { value: true });
  window.addEventListener('load', function () {
    var b = document.createElement('p');
    b.className = 'meta';
    b.textContent = 'Preview — real page, real progress logic, simulated timing. Restarts every 24s.';
    document.body.appendChild(b);
  });
  setInterval(function () { if (!nav) { t0 = Date.now(); location.hash = ''; location.reload(); } }, 24000);
})();
</script>`;

const html = startingPage().replace('</body>', `${stub}</body>`);
const out = process.argv[2] || 'starting-preview.html';
await Bun.write(out, html);
console.log(`wrote ${out} (${html.length} bytes)`);
