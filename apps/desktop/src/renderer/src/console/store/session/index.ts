// The session sub-module's door.
//
// A SUB-MODULE door and not a second family door: it publishes to `store/` only,
// it is reached by deep intra-family specifiers, and `store/index.ts` re-exports
// every one of these symbols from the module that DECLARES it rather than through
// this file (`console-no-barrel-chain`).
//
// It exists because two sibling sub-modules read this one: `act/` takes the store
// and its rebinding hook, and `read/` takes the store, its state shape, and the two
// hooks its trigger surface subscribes through. Everything else this directory
// holds — the registry, the open-session entry, the reconciler, the buffer, the
// selectors — is read only from inside it or from the family door, so it is not
// published here.

export { useSessionDegradedCause, useSessionStore } from "./session-hooks.js";
export { useSessionStoreRebind, type SessionStoreScoped } from "./session-store-rebind.js";
export { SessionStore, type SessionStoreState } from "./session-store.js";
