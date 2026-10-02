// The schemas each daemon method the app calls is parsed against, in both directions. A
// registry keyed by method name makes the parse unskippable: the bridge's `daemon.call` is typed
// by the method map, but a type does not check what the other process actually sent.
//
// The set is closed at compile time. The table is built from `REGISTERED_DAEMON_METHODS` alone,
// each entry looked up in its namespace's descriptor table, so a name no table holds is a type
// error. Subscriptions are not in it: a stream has no reply to bind, and
// `session-event-streams.ts` owns the stream names.

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
 * Each method's descriptor, with its two schemas typed from the method map. Typed against the
 * contracts package's `ZodType` so callers need no direct `zod` import (the lint config enforces).
 */
export type DaemonMethodBindings = {
  readonly [MethodName in RegisteredDaemonMethod]: AnyMethodDescriptor & {
    readonly requestSchema: ZodType<DaemonParams<MethodName>>;
    readonly responseSchema: ZodType<DaemonResult<MethodName>>;
  };
};

/** The namespaces the app calls into, merged so one lookup finds any of their methods. */
const DAEMON_NAMESPACE_DESCRIPTORS = {
  ...DRIVER_METHOD_DESCRIPTORS,
  ...TIMELINE_METHOD_DESCRIPTORS,
  ...SESSION_METHOD_DESCRIPTORS,
  ...SESSION_DIRECTORY_METHOD_DESCRIPTORS,
  ...PRESENCE_METHOD_DESCRIPTORS,
  ...HIGHLIGHT_METHOD_DESCRIPTORS,
};

/**
 * The method-to-descriptor table, built from the method list so a method is named once and frozen
 * so no module can re-point an entry. The one cast widens `Object.fromEntries`' string-keyed
 * record to the mapped type; each entry is the descriptor its own method's table holds.
 */
export const DAEMON_METHOD_BINDINGS: DaemonMethodBindings = Object.freeze(
  Object.fromEntries(
    REGISTERED_DAEMON_METHODS.map((method) => [method, DAEMON_NAMESPACE_DESCRIPTORS[method]]),
  ) as DaemonMethodBindings,
);

/**
 * The descriptor for one method name known only at runtime, or `undefined`.
 * For the fixture bridge, which is handed a call name by a scenario and must decide whether the
 * app parses that method; typed callers index the table directly.
 */
export function daemonMethodBindingFor(method: string): AnyMethodDescriptor | undefined {
  return Object.hasOwn(DAEMON_METHOD_BINDINGS, method)
    ? DAEMON_METHOD_BINDINGS[method as RegisteredDaemonMethod]
    : undefined;
}
