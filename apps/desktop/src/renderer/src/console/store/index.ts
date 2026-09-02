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

export { SessionStore } from "./session-store.js";

export type { FrameBanner } from "./frame-store.js";
export { FrameStore } from "./frame-store.js";

export { SessionStoreRegistry, type SessionSnapshotReader } from "./session-store-registry.js";

export { useFrameStore, useLocationHash, useOpenSessionStore } from "./hooks.js";

// The selector hook, and the state its selector reads.
//
// `useOpenSessionStore` hands a caller the store; reading it is a second act, and
// until T-023p-1C-7 every caller of that second act lived inside this family. A
// view family that reached for `useSyncExternalStore` itself would be the second
// subscription path this family's header exists to prevent — so the one path
// ships through the door beside the store it reads.
export type { SessionStoreState } from "./session-store.js";
export { useSessionStore } from "./hooks.js";
