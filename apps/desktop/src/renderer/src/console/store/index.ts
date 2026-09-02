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

export type { ConsoleEntityRef, ConsoleSessionEvent } from "./entities.js";

export { SessionStore, type SessionStoreState } from "./session-store.js";

export type { FrameBanner } from "./frame-store.js";
export { FrameStore } from "./frame-store.js";

export { SessionStoreRegistry, type SessionSnapshotReader } from "./session-store-registry.js";

// `useSessionStore` ships beside the three that were already here for the reason
// stated above: it is the ONE selector-shaped read of a session store, and a
// surface that could not reach it through this door would reach for
// `useSyncExternalStore` and become the second subscription path with its own
// equality rule. `SessionStoreState` travels with it because a caller hoisting a
// selector to module scope has to name the state it selects from.
export { useFrameStore, useLocationHash, useOpenSessionStore, useSessionStore } from "./hooks.js";
