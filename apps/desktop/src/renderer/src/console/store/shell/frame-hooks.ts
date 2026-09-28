// React bindings for the frame store, one per window. They live apart from
// `session/session-hooks.ts`, which binds the per-session stores.
//
// A selector returns a stored reference so `Object.is` is a pointer check; a selector that
// built a value would re-render every frame.

import { useStore } from "zustand";

import type { FrameStore, FrameStoreState } from "./frame-store.js";
import type { ShellState } from "./shell-state.js";

/**
 * What the shell says about itself, subscribed rather than sampled.
 *
 * The store publishes a new `shellState` only when the report or the recovery fold moved, so
 * a subscriber re-renders exactly when the fact does.
 */
export function useShellState(store: FrameStore): ShellState {
  return useStore(store.readable, readShellState);
}

/** Select from the frame store. */
export function useFrameStore<TSelected>(
  store: FrameStore,
  selector: (state: FrameStoreState) => TSelected,
): TSelected {
  return useStore(store.readable, selector);
}

function readShellState(state: FrameStoreState): ShellState {
  return state.shellState;
}
