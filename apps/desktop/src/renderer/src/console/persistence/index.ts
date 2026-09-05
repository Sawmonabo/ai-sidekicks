// The persistence door.
//
// One chokepoint (`UiStateStore`), the value-class vocabulary that decides what may
// be stored at all, the draft store, and one of the two adapters behind the
// chokepoint.
//
// WHY ONLY ONE ADAPTER IS BEHIND THE DOOR. `MemoryPersistenceAdapter` is the one a
// caller outside this family has a legitimate reason to construct: it is what a test
// hands the chokepoint to drive a failure a real disk would take a real disk to
// reproduce — a full one, most of all. `IndexedDbPersistenceAdapter` is not exported
// at all, because the only correct way to acquire it is `UiStateStore.opening()`,
// which composes it behind the value-class validation, the byte cap, and the
// partition trim that the chokepoint exists to apply.
//
// `PERSISTENCE_GLOBAL_PARTITION` and `SCHEME_PREFERENCE_KEY` travel with the
// adapter rather than with the store because they name a RECORD ADDRESS, and a
// second reader of the same record — the end-to-end tier opens its own connection
// to prove a write survived a reload — must address it by the same constants.

export { PERSISTENCE_GLOBAL_PARTITION, SCHEME_PREFERENCE_KEY } from "./adapter.js";

// The database and object-store NAMES are not published beside them. A record
// address is what a second reader of the same record needs; the connection names
// are what one reader needs to open its own connection, which only the end-to-end
// tier does, and it reaches them in `indexeddb-adapter.ts` where the store this
// door deliberately does not export is composed.

// The one grammar that tells an identifier from authored content, published because
// a family above this one holds the SAME value to it. A pane address's entity id is
// a string that reaches disk through this family's own value walk, so a boundary
// parse that admitted a whitespace-, NUL-, or path-bearing id would accept what the
// durable path refuses — one value, two boundaries, disagreeing. The alternative was
// a second grammar in `seats/`, which is how two sources of truth start.
export { IDENTIFIER_MAX_LENGTH, isSingleNameIdentifierShaped } from "./identifier-grammar.js";

export { MemoryPersistenceAdapter } from "./memory-adapter.js";

export { UiStateStore } from "./ui-state-store.js";

export { DraftStore } from "./draft-store.js";
