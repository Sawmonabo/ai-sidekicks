import { useStore } from "zustand";

import type { FrameStore, FrameStoreState } from "../window-store.js";

/**
 * Select from the window's store.
 *
 * A selector returns a stored reference so `Object.is` is a pointer check; a selector that
 * built a value would re-render on every change.
 */
export function useFrameStore<TSelected>(
  store: FrameStore,
  selector: (state: FrameStoreState) => TSelected,
): TSelected {
  return useStore(store.readable, selector);
}
