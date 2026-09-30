// The schemas each daemon method the console calls is parsed against, in both
// directions.
//
// WHY A REGISTRY AND NOT A PARSE AT EACH CALL SITE. The bridge's `daemon.call` is
// typed by the daemon's method map, but a type is a claim about the other process,
// not a check of it: what arrives over the preload is whatever the other side sent.
// One table, keyed by method name, is what makes the parse unskippable rather than
// merely available.
//
// THE SET IS CLOSED, AT COMPILE TIME. `REGISTERED_DAEMON_METHODS`
// (`daemon-method-contract.ts`) names the methods and is checked against the method
// map; the table below is built from that list alone, each entry looked up in its
// namespace's descriptor table, so a name none of those tables holds is a type
// error at the lookup. Nothing here pairs a schema with a method: the descriptor
// that owns the method already did.
//
// WHAT IS IN THE SET. A method the console calls and the daemon answers. A method
// with no daemon handler has no entry: its caller takes the call as an argument
// until the method is built.
//
// WHAT IS NOT IN THE SET. Subscriptions. `daemon.subscribe` names a stream rather
// than a call and answers with an unsubscribe handle, so it has no reply to bind;
// which names are streams and what each carries is `session-event-streams.ts`'s
// table.

import {
  DRIVER_METHOD_DESCRIPTORS,
  HIGHLIGHT_METHOD_DESCRIPTORS,
  PRESENCE_METHOD_DESCRIPTORS,
  SESSION_DIRECTORY_METHOD_DESCRIPTORS,
  SESSION_METHOD_DESCRIPTORS,
  TIMELINE_METHOD_DESCRIPTORS,
  type AnyMethodDescriptor,
  type DaemonParams,
  type DaemonResult,
  type ZodType,
} from "@ai-sidekicks/contracts";

import {
  REGISTERED_DAEMON_METHODS,
  type RegisteredDaemonMethod,
} from "./daemon-method-contract.js";

/**
 * Each method's descriptor, with its two schemas typed from the method map.
 *
 * Typed against the contracts package's re-exported `ZodType` rather than an import
 * from `zod`, which keeps every module above this one free of the dependency, the
 * property the lint rule in `apps/desktop/eslint.config.mjs` enforces.
 */
export type DaemonMethodBindings = {
  readonly [MethodName in RegisteredDaemonMethod]: AnyMethodDescriptor & {
    readonly requestSchema: ZodType<DaemonParams<MethodName>>;
    readonly responseSchema: ZodType<DaemonResult<MethodName>>;
  };
};

/** The namespaces the console calls into, merged so one lookup finds any of their methods. */
const CONSOLE_NAMESPACE_DESCRIPTORS = {
  ...DRIVER_METHOD_DESCRIPTORS,
  ...TIMELINE_METHOD_DESCRIPTORS,
  ...SESSION_METHOD_DESCRIPTORS,
  ...SESSION_DIRECTORY_METHOD_DESCRIPTORS,
  ...PRESENCE_METHOD_DESCRIPTORS,
  ...HIGHLIGHT_METHOD_DESCRIPTORS,
};

/**
 * The method-to-descriptor table, frozen.
 *
 * Built from the list rather than written out, so a method is named once, and the
 * lookup into the merged tables is what refuses a name none of them declares. The one
 * cast widens `Object.fromEntries`' string-keyed record to the mapped type: each
 * entry is the descriptor its own method's table holds, and the method map reads
 * `DaemonParams` and `DaemonResult` off that same descriptor. Frozen because it is a
 * registry: a module that could re-point an entry at start-up could change what the
 * console sends on a method without touching the contract that owns the shape. The
 * descriptors themselves are frozen by their tables.
 */
export const DAEMON_METHOD_BINDINGS: DaemonMethodBindings = Object.freeze(
  Object.fromEntries(
    REGISTERED_DAEMON_METHODS.map((method) => [method, CONSOLE_NAMESPACE_DESCRIPTORS[method]]),
  ) as DaemonMethodBindings,
);

/**
 * The descriptor for one method name known only at runtime, or `undefined`.
 *
 * The one lookup that admits an arbitrary string, and it exists for exactly one
 * caller: the fixture bridge, which is handed a call name by a scenario rather than
 * by a typed call site and has to decide whether the console parses that method.
 * Every other consumer reaches the table through `RegisteredDaemonMethod`, where
 * the lookup cannot miss.
 */
export function daemonMethodBindingFor(method: string): AnyMethodDescriptor | undefined {
  return Object.hasOwn(DAEMON_METHOD_BINDINGS, method)
    ? DAEMON_METHOD_BINDINGS[method as RegisteredDaemonMethod]
    : undefined;
}
