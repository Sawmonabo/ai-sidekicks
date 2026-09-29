import { useStore } from "zustand";

import type { FrameStore, WindowStoreState } from "../window-store.js";
import type { ShellState } from "../main-process-state.js";

/**
 * What the main process says about itself, subscribed rather than sampled.
 *
 * The store publishes a new `mainProcessState` only when the report or the recovery fold
 * moved, so a subscriber re-renders exactly when the fact does.
 */
export function useShellState(store: FrameStore): ShellState {
  return useStore(store.readable, readShellState);
}

function readShellState(state: WindowStoreState): ShellState {
  return state.mainProcessState;
}
