// The read-only face every console store presents to React.
//
// zustand's `useStore` needs only `getState`, `getInitialState` and `subscribe`. Handing React
// the full `StoreApi` would give every component `setState`, bypassing the `applyBatch`
// chokepoint. The functions are the store's own bound methods, so their identities are stable
// across renders.

import type { StoreApi } from "zustand/vanilla";

/** `StoreApi` minus `setState`. What components are allowed to hold. */
export type ReadableStore<TState> = Pick<
  StoreApi<TState>,
  "getState" | "getInitialState" | "subscribe"
>;

/** Builds the read-only face from a store, without letting the setter out. */
export function toReadableStore<TState>(store: StoreApi<TState>): ReadableStore<TState> {
  return {
    getState: store.getState,
    getInitialState: store.getInitialState,
    subscribe: store.subscribe,
  };
}
