// OPENUI phase 2 — how a HOST card becomes a library component.
// `defineHostComponent({name, props, description, component})` is the same
// contract as react-lang's defineComponent; the definition lands in the
// HOST_COMPONENTS registry that host.jsx folds into `hostLibrary` (the agent
// set + these). The react-lang wrapper itself (schema tagging, `.ref`) is
// applied when that library object is materialized — lazily — because the
// eager path (ChatPane → HostCard) renders straight from the registry and needs
// no parser, so the main bundle pays for zod + primitives only.
// The agent-facing library (library.jsx) and its prompt never see these names,
// so render_ui cannot forge a permission / merge / setup / screen / action
// card — it gets "unknown component".
// zod/mini: the tree-shakable functional API — the host schemas ship in the
// main bundle, so they use the small build; the agent library (lazy) uses classic zod.
import * as z from 'zod/mini';

export const HOST_COMPONENTS = [];
export const HOST_BY_NAME = new Map();

export function defineHostComponent({ name, props, description, component }) {
  if (HOST_BY_NAME.has(name)) throw new Error(`host component ${name} defined twice`);
  const def = { name, props, description, component, hostOnly: true };
  HOST_COMPONENTS.push(def);
  HOST_BY_NAME.set(name, def);
  return def;
}

// Every host card gets its event/props as a LOOSE object: unknown keys pass
// through (an event field the schema forgot must not vanish), and a shape
// mismatch is reported, never fatal.
export const loose = (shape) => z.looseObject(shape);
export const opt = (schema) => z.optional(schema);
export const maybe = (schema) => z.optional(z.nullable(schema));
export const str = opt(z.string());
export const bool = opt(z.boolean());
export const num = opt(z.number());
export const any = z.any();
export const agentRef = maybe(loose({ slug: str, name: str, emoji: str, color: str }));
export { z };
