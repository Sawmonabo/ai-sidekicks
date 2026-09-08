// React bindings for the frame store.
//
// Beside `session/session-hooks.ts` rather than in it: these subscribe to the
// FRAME store, which is one per window and holds what the shell says about itself,
// while those subscribe to a session store, which is one per open session. One
// module holding both made the two look like one subscription surface.
//
// The selector rule is the session hooks' rule, for the same zustand reason: a
// selector returns a STORED reference so `Object.is` is a pointer check, and a
// selector that built a value would re-render every frame. That is why the two
// narrow reads below are hooks of their own rather than call sites of
// {@link useFrameStore} — one selector written per surface is one more chance to
// build a value in a render body.

import { useStore } from "zustand";

import type { FrameStore, FrameStoreState } from "./frame-store.js";
import type { ShellState } from "./shell-state.js";

/**
 * What the shell says about itself, subscribed rather than sampled.
 *
 * A hook of its own beside {@link useFrameStore} for `useSessionDegradedCause`'s
 * reason: the selector has to return a stored reference, and one written per surface
 * is one more chance to build a value in a render body and re-render every frame.
 * The store publishes a new `shellState` only when the report or the recovery fold
 * actually moved, so a subscriber here re-renders exactly when the fact does.
 */
export function useShellState(store: FrameStore): ShellState {
  return useStore(store.readable, readShellState);
}

function readShellState(state: FrameStoreState): ShellState {
  return state.shellState;
}

/**
 * How many sessions need a person, or `undefined` where nothing is reading.
 *
 * Narrowed one step further than {@link useShellState} because the rail renders this
 * and nothing else: the rail is the console's most-seen surface, and a subscriber to
 * the whole shell state would re-render it on every heartbeat.
 */
export function useRailAttentionCount(store: FrameStore): number | undefined {
  return useStore(store.readable, readRailAttentionCount);
}

function readRailAttentionCount(state: FrameStoreState): number | undefined {
  return state.railAttentionCount;
}

/** Select from the frame store. */
export function useFrameStore<TSelected>(
  store: FrameStore,
  selector: (state: FrameStoreState) => TSelected,
): TSelected {
  return useStore(store.readable, selector);
}
