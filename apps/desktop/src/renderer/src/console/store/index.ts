// The store door.
//
// The two stores (`SessionStore` for wire-projected entities, `FrameStore` for the
// shell's own state), their React hooks, the entity vocabulary they project into,
// and the two schedulers that decide WHEN a store notifies.
//
// WHY THE HOOKS SHIP THROUGH THE SAME DOOR AS THE STORES. A surface that reads a
// store through `useSyncExternalStore` itself would be a second subscription path
// with its own equality rule, and the whole point of `hooks.ts` is that there is
// exactly one — `Spec-023 §Console Design (Meridian)` §The eight rules, rule 6:
// a store is read through its selector and never by reaching into its state.
// Exporting the stores without the hooks would quietly invite the second path.
//
// `readable.ts` narrows a `zustand` store to the two methods a consumer needs, so
// nothing outside this family holds a handle that can also WRITE.

// `ConsoleEntity` joins its ref on the door with `useSessionPartition` below: a
// partition is a map OF entities, so a consumer that can subscribe to one and
// cannot name what it holds would have to restate the shape to read it.
export type { ConsoleEntity, ConsoleEntityRef, ConsoleSessionEvent } from "./entities.js";

export { SessionStore, type SessionStoreState } from "./session-store.js";

export type { FrameBanner } from "./frame-store.js";
export { FrameStore } from "./frame-store.js";

export { SessionStoreRegistry, type SessionSnapshotReader } from "./session-store-registry.js";

// The refresh chokepoint, on the family door because the rule it realises binds
// every family above this one: `Spec-023 §Console Design (Meridian)` §The eight
// rules puts every read behind one scheduler, and a view family that could not
// reach it through this barrel would have to arm a timer of its own — which is
// exactly what the rule forbids. `ApplyQueue` stays off the door: its only caller
// is `SessionStoreRegistry`, and a second one would be a second writer into the
// apply chokepoint.
export { RefreshScheduler, type RefreshReason } from "./scheduling.js";

// `useSessionPartition` joins the door with its first cross-family consumer: the
// composer reads the `agent`, `run`, and `channel` partitions to resolve what a
// send is addressed to. It is the partitioned subscription rule 6 asks for — a
// surface that reached for `useSessionStore` with a selector of its own would be
// the second subscription path this module exists to prevent.
// `useSessionStore` ships beside them for the reason stated above: it is the ONE
// selector-shaped read of a session store, and a surface that could not reach it
// through this door would reach for `useSyncExternalStore` and become the second
// subscription path with its own equality rule. `SessionStoreState` travels with
// it because a caller hoisting a selector to module scope has to name the state
// it selects from.
//
// `useSessionInitialised` and `useSessionDegradedCause` are the two absences a
// partition read cannot express: a map with no rows means one thing before the
// read has answered, another when the daemon has said the projection is
// incomplete, and a third when the session simply has none of that kind. A
// surface that could reach only the partition would have to render all three as
// "empty", which is the collapse rule 8 forbids.
export {
  useFrameStore,
  useLocationHash,
  useOpenSessionStore,
  useSessionDegradedCause,
  useSessionInitialised,
  useSessionPartition,
  useSessionStore,
} from "./hooks.js";
