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
// The projection contract leaves the family with its first producer: the
// composition root's run-lifecycle projector. A projector reads WIRE member names
// and this family deliberately knows none, so the type travels out and the
// implementation stays where the wire is already understood.
export type { EntityMutation, EntityProjector, EntityProjectorRegistry } from "./entities.js";

// The entity vocabulary itself joins the door with its first consumer outside this
// family: the inspector keys one record body per kind and its table is total over
// this set by type, so a twelfth kind fails to compile at the table rather than
// reaching a deck that renders it blank. The enumeration ships beside the union
// because a claim about a CLOSED SET has to be countable at runtime for a test to
// hold it — deriving a second union here instead would be the mirrored closed set
// `apps/desktop/AGENTS.md` rejects.
export { CONSOLE_ENTITY_KINDS } from "./entities.js";
export type { ConsoleEntityKind } from "./entities.js";

export { SessionStore, type SessionStoreState } from "./session-store.js";
// The base state a read establishes. Exported because the composition root now
// builds one — the adapter over the growth port's session read lives there, which
// is where a family that may reach the bridge is allowed to be.
export type { SessionSnapshot } from "./session-store.js";

export type { FrameBanner } from "./frame-store.js";
export { FrameStore } from "./frame-store.js";

// `SessionSnapshotRead` now leaves the family, because the producer it was held
// back for exists: the composition root builds a reader over the growth port's
// session read, and says so at the call site with a type rather than by convention.
export { SessionStoreRegistry } from "./session-store-registry.js";
// Straight from the module that DECLARES it rather than through the registry that
// consumes it: a barrel re-exporting a re-export is the chain this family's one
// door exists to avoid.
//
// `SessionSnapshotReader` stays inside the family: what a caller above needs to
// SAY is what the registry takes, and the reader is one arm of that union rather
// than a type anything outside names.
export type { SessionSnapshotRead } from "./open-session-entry.js";

// The refresh chokepoint, on the family door because the rule it realises binds
// every family above this one: `Spec-023 §Console Design (Meridian)` §The eight
// rules puts every read behind one scheduler, and a view family that could not
// reach it through this barrel would have to arm a timer of its own — which is
// exactly what the rule forbids. `ApplyQueue` stays off the door: its only caller
// is `SessionStoreRegistry`, and a second one would be a second writer into the
// apply chokepoint.
export { RefreshScheduler, type RefreshReason } from "./scheduling.js";

// `useSessionPartition` joins the door with its cross-family consumers: the
// composer reads the `agent`, `run`, and `channel` partitions to resolve what a
// send is addressed to, and the frame's agent step reads a session's agents. It is
// the partitioned subscription rule 6 asks for — a surface that reached for
// `useSessionStore` with a selector of its own would be the second subscription
// path this module exists to prevent.
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
//
// `useOpenSessionIds` ships with them because the sessions surface and the
// context picker each have to name which sessions are open before either can
// read one, and the registry is the only thing that knows.
export {
  useFrameStore,
  useLocationHash,
  useOpenSessionIds,
  useOpenSessionStore,
  useSessionDegradedCause,
  useSessionInitialised,
  useSessionPartition,
  useSessionStore,
} from "./hooks.js";
