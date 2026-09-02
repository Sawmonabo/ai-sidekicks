// The persistence door.
//
// One chokepoint (`UiStateStore`), the adapter contract behind it and its two
// implementations, the value-class vocabulary that decides what may be stored at
// all, and the draft store.
//
// WHY THE ADAPTERS ARE BEHIND THE SAME DOOR AS THE CHOKEPOINT. They are exported
// because tests construct them and because `UiStateStore.opening()` composes them
// — not because a surface should. A surface that reached for
// `IndexedDbPersistenceAdapter` directly would bypass the value-class validation,
// the byte cap, and the partition trim, which are the three things the chokepoint
// exists to apply. The architecture tier asserts that no module outside this
// family constructs an adapter; the door is where that rule is legible.
//
// `PERSISTENCE_GLOBAL_PARTITION` and `SCHEME_PREFERENCE_KEY` travel with the
// adapter rather than with the store because they name a RECORD ADDRESS, and a
// second reader of the same record — the end-to-end tier opens its own connection
// to prove a write survived a reload — must address it by the same constants.

export { PERSISTENCE_GLOBAL_PARTITION, SCHEME_PREFERENCE_KEY } from "./adapter.js";

export { CONSOLE_DATABASE_NAME, UI_STATE_STORE_NAME } from "./indexeddb-adapter.js";

export { UiStateStore } from "./ui-state-store.js";

export { DraftStore } from "./draft-store.js";
