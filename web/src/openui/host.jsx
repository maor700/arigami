// OPENUI phase 2 — the HOST side of the one library.
//   HostCard          the one path ChatPane takes for a host event:
//                     name → registry definition → zod check → component
//   getHostLibrary()  the agent components + every host-only card as ONE
//                     react-lang library (createLibrary), built lazily —
//                     tests, tooling and the prompt generator use it; the
//                     render path does not need the parser.
//
// Why event → props and not event → OpenUI Lang: host events are already
// structured (ids, arrays, booleans, nested objects) and their cards keep the
// store/api handlers, focus and keyboard rules exactly as they were.
// Serialising them to Lang text and re-parsing through the Renderer would be
// lossy, would mount a frame late (the Renderer resolves in effects) and
// would break SSR. Same definitions, same zod schemas, same primitives — only
// the parse step is skipped because there is nothing to parse.
import { HOST_BY_NAME, HOST_COMPONENTS } from './define.js';
// Registering imports: each file calls defineHostComponent at load time.
import '../components/ExtCard.jsx';

const warned = new Set();
/** Render host component `name` with `props` (an event + sessionId etc.). Unknown / non-host name → nothing. */
export function HostCard({ name, props }) {
  const def = HOST_BY_NAME.get(name);
  if (!def) return null;
  let p = props;
  const r = def.props?.safeParse ? def.props.safeParse(props) : null;
  if (r?.success) p = r.data;
  else if (r && !warned.has(name)) { warned.add(name); console.warn(`[openui] host card ${name}: props did not match its schema`, r.error?.issues?.slice(0, 3)); }
  const Comp = def.component;
  return <Comp props={p} />;
}

/** True when `name` is a host-only component. */
export const isHostOnly = (name) => HOST_BY_NAME.has(name);

let libPromise = null;
/** The full library object (agent + host components) — lazy: pulls in react-lang. */
export function getHostLibrary() {
  if (!libPromise) {
    libPromise = Promise.all([import('@openuidev/react-lang'), import('./library.jsx')]).then(([rl, agent]) => {
      const hostDefs = HOST_COMPONENTS.map((d) => Object.assign(rl.defineComponent({ name: d.name, props: d.props, description: d.description, component: d.component }), { hostOnly: true }));
      return rl.createLibrary({ components: [...agent.AGENT_COMPONENTS, ...hostDefs], root: 'Stack' });
    });
  }
  return libPromise;
}
