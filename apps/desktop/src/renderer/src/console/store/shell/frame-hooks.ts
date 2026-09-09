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

import { useMemo } from "react";
import { useStore } from "zustand";

import type { FrameStore, FrameStoreState } from "./frame-store.js";
import { shellBlockForMethod, type ShellMutationBlock } from "./shell-mutation-block.js";
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

/**
 * What closes one method's control right now, subscribed, or `undefined` while
 * nothing closes it.
 *
 * THE ONE HOOK EVERY DISPATCHING SURFACE READS, hoisted here rather than written per
 * family. The three lines it replaces — subscribe to the shell state, derive the
 * block for this method, hold its identity — were about to appear in the run
 * controls, the repo mount acts, and the composer, and a family writing them itself
 * is a family free to subscribe to the whole frame state or to derive in a render
 * body.
 *
 * MEMOISED, BECAUSE `shellMutationBlock` MINTS. It composes a fresh object per call
 * and one of its sentences carries the reconnect attempt number, so an unmemoised
 * derivation would hand a control a new object on every publish and re-render it on
 * every heartbeat. The subscribed `shellState` is a stored reference that moves only
 * when the report actually moved, so the memo holds exactly as long as the fact does.
 *
 * THE RENDERED HALF ONLY. A surface that dispatches also reads `currentShellBlock`
 * inside its handler and again after any await, because a block landing between the
 * render and the press leaves a render-captured one fail-open.
 */
export function useShellBlockFor(
  store: FrameStore,
  method: string,
): ShellMutationBlock | undefined {
  const shellState = useShellState(store);
  return useMemo(() => shellBlockForMethod(shellState, method), [shellState, method]);
}

/** Select from the frame store. */
export function useFrameStore<TSelected>(
  store: FrameStore,
  selector: (state: FrameStoreState) => TSelected,
): TSelected {
  return useStore(store.readable, selector);
}
