// OPENUI phase 2 — one fixture event per host card kind, shared by the
// host-demo page (before/after screenshots) and test/openui-host-cards.test.js.
const AGENT = { slug: 'nili', name: 'נילי', emoji: '🌿', color: '#1F9C82' };
const now = Date.now();
let seq = 0;
const ev = (o) => ({ id: `fx_${++seq}`, ts: now - (60 - seq) * 60_000, ...o });
const label = (text) => ev({ kind: 'user', text });

export const HOST_ACTION = { id: 'act_1', prompt: 'Merge the branch into master now?', kind: 'merge', agent: AGENT, buttons: [{ label: 'Merge', value: 'merge', style: 'primary' }, { label: 'Not yet', value: 'later' }, { label: 'Discard', value: 'discard', style: 'danger' }] };

export const HOST_EVENTS = [
  label('ext-card'),
  ev({ kind: 'ext-card', extension: 'hello', title: 'Pick one', body: 'The **compare** tab is ready — open it or re-run.\n\n- one\n- two', buttons: [{ label: 'Open', prompt: 'open the compare tab' }, { label: 'Re-run', prompt: 'rerun compare' }] }),
  label('action-auto'),
  ev({ kind: 'action-auto', actionId: 'act_0', prompt: 'Send the weekly digest mail?', actionKind: 'send-email', value: 'send', label: 'Send', agent: AGENT }),
  label('artifact'),
  ev({ kind: 'artifact', artifactId: 'fQxvlBEmbVw', title: 'OpenUI pilot — screenshots', path: '/__artifacts/fQxvlBEmbVw/', entry: 'index.html', version: 2, bytes: 251143, files: 5, warnings: ['a root-absolute url was found in index.html'] }),
  label('screenshot ×1'),
  ev({ kind: 'screenshot', url: '/__host/apple-touch-icon.png', caption: 'Login page loaded' }),
  label('screenshot ×5'),
  ...[1, 2, 3, 4, 5].map((i) => ev({ kind: 'screenshot', url: '/__host/apple-touch-icon.png', caption: `Step ${i}` })),
  label('delegated'),
  ev({ kind: 'delegated', agent: AGENT, target: 's_child', targetTitle: 'נילי: לכתוב את הפוסט', how: 'child', delivered: 'queued', mode: 'mention', text: 'write it' }),
  label('agent-adopt'),
  ev({ kind: 'agent-adopt', agent: AGENT, prevAgent: null }),
  label('agent-card pending'),
  ev({ kind: 'agent-card', cardId: 'agc_1', action: 'create', state: 'pending', draft: { name: 'Ops Bot', slug: 'ops-bot', emoji: '🛠️', persona: 'Keep the fleet green.\nAsk before merging.', skills: ['dispatch'], tools: ['git'] } }),
  label('agent-card created'),
  ev({ kind: 'agent-card', cardId: 'agc_2', action: 'create', state: 'created', agent: { slug: 'ops-bot', name: 'Ops Bot', emoji: '🧰', color: '#1F9C82', skills: ['dispatch'], persona: 'Keep the fleet green.' } }),
  label('merge ok / conflict'),
  ev({ kind: 'merge', state: 'merged', branch: 'child/x-1', base: 'master', sha: '53ba82c1234', child: 'sess_child' }),
  ev({ kind: 'merge', state: 'conflict', branch: 'child/y-2', base: 'master', files: ['server/api.ts', 'web/src/App.jsx'] }),
  label('setup pending'),
  ev({ kind: 'setup', requestId: 'r1', capability: 'composio:gmail', why: 'read your inbox', autoCapable: true, identity: { email: 'user@example.test' }, state: 'pending' }),
  label('setup done'),
  ev({ kind: 'setup', requestId: 'r2', capability: 'composio:gmail', why: 'read your inbox', autoCapable: true, identity: { email: 'user@example.test' }, state: 'done', evidence: '/__artifacts/ev1/' }),
  label('question (answered)'),
  ev({ kind: 'tool-use', name: 'AskUserQuestion', toolUseId: 'tu_0', input: { questions: [{ question: 'Which color?', header: 'Color', options: [{ label: 'Red', description: 'warm' }, { label: 'Blue' }] }] }, answered: 'allow', answers: { 'Which color?': 'Red' } }),
  label('permission (answered)'),
  ev({ kind: 'permission-request', requestId: 'perm_0', toolName: 'Bash', input: { command: 'rm -rf build' }, answered: 'deny', answeredMessage: 'timed out' }),
  label('screen-request (answered)'),
  ev({ kind: 'screen-request', requestId: 'scrn_0', prompt: 'התחבר לחשבון הבנק', reason: 'login', hint: 'הסיסמה אצלך', answered: true, takenOver: true, note: 'done' }),
  label('screen-request (live)'),
  ev({ kind: 'screen-request', requestId: 'scrn_1', prompt: 'Log in to the bank', reason: '2fa', hint: 'the code is on your phone' }),
  label('question (live)'),
  ev({ kind: 'tool-use', name: 'AskUserQuestion', toolUseId: 'tu_1', input: { questions: [{ question: 'איזה מודל?', header: 'Model', options: [{ label: 'Fable', description: 'הכי חזק' }, { label: 'Sonnet', description: 'מהיר' }] }] } }),
  label('permission (live)'),
  ev({ kind: 'permission-request', requestId: 'perm_1', toolName: 'Bash', input: { command: 'git push origin master' } }),
];
