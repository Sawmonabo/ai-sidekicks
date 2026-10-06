import { useStore } from "zustand";

import type { WindowStore, WindowStoreState } from "../store.js";
import type { MainProcessState } from "#shared/daemon/status-topic.js";

/**
 * What the main process says about itself, subscribed rather than sampled.
 *
 * The store publishes a new `mainProcessState` only when the report or the recovery fold
 * moved, so a subscriber re-renders exactly when the fact does.
 */
export function useMainProcessState(store: WindowStore): MainProcessState {
  return useStore(store.readable, readMainProcessState);
}

function readMainProcessState(state: WindowStoreState): MainProcessState {
  return state.mainProcessState;
}
