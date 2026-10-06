import { useStore } from "zustand";

import type { WindowStore, WindowStoreState } from "../store.js";

/**
 * Select from the window's store.
 *
 * A selector returns a stored reference so `Object.is` is a pointer check; a selector that
 * built a value would re-render on every change.
 */
export function useWindowStore<TSelected>(
  store: WindowStore,
  selector: (state: WindowStoreState) => TSelected,
): TSelected {
  return useStore(store.readable, selector);
}
