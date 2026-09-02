// The read-only face every console store presents to React.
//
// zustand's `useStore` needs three members — `getState`, `getInitialState`, and
// `subscribe` — and a store that handed React its full `StoreApi` would hand every
// component `setState` along with them. That is the whole apply-chokepoint rule
// undone by a getter: any component could write, and the tripwire that catches a
// re-entrant write would never fire because the write would not go through
// `applyBatch` at all.
//
// So each store exposes this three-member face instead. The functions are the
// store's own bound methods, so their identities are stable across renders and
// `useSyncExternalStore` re-subscribes exactly never; only the wrapper object is
// fresh, and nothing depends on its identity.

import type { StoreApi } from "zustand/vanilla";

/** `StoreApi` minus `setState`. What components are allowed to hold. */
export type ConsoleReadableStore<TState> = Pick<
  StoreApi<TState>,
  "getState" | "getInitialState" | "subscribe"
>;

/** Build the read-only face from a store, without letting the setter out. */
export function toReadableStore<TState>(store: StoreApi<TState>): ConsoleReadableStore<TState> {
  return {
    getState: store.getState,
    getInitialState: store.getInitialState,
    subscribe: store.subscribe,
  };
}
