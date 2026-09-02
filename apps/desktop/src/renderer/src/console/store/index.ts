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
// The base state a read establishes. Exported because the composition root now
// builds one — the adapter over the growth port's session read lives there, which
// is where a family that may reach the bridge is allowed to be.
export type { SessionSnapshot } from "./session-store.js";

export type { FrameBanner } from "./frame-store.js";
export { FrameStore } from "./frame-store.js";

// `SessionSnapshotRead` and `SessionSnapshotReader` now leave the family, because
// the producer they were held back for exists: the composition root builds a reader
// over the growth port's session read, and says so at the call site with a type
// rather than by convention.
export { SessionStoreRegistry } from "./session-store-registry.js";
// `SessionSnapshotReader` stays inside the family: what a caller above needs to
// SAY is what the registry takes, and the reader is one arm of that union rather
// than a type anything outside names.
export type { SessionSnapshotRead } from "./session-store-registry.js";

export { useFrameStore, useLocationHash, useOpenSessionIds, useOpenSessionStore } from "./hooks.js";
