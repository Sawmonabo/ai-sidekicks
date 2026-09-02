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

export type { ConsoleSessionEvent } from "./entities.js";

export { SessionStore } from "./session-store.js";

export type { FrameBanner } from "./frame-store.js";
export { FrameStore } from "./frame-store.js";

// `SessionSnapshotRead` and `SessionSnapshotReader` stay inside the family: the
// only thing a caller above needs to SAY today is that no read exists, and that is
// the sentinel. A reader type exported to nobody would be a door held open for a
// producer that does not exist yet.
export { SESSION_READ_UNREGISTERED, SessionStoreRegistry } from "./session-store-registry.js";

export { useFrameStore, useLocationHash, useOpenSessionStore } from "./hooks.js";
