// Who owns this window's shell preference store, for how long, and how React binds it.
//
// `shell-preferences-store.ts` next door decides what a preference IS and what each
// carrier answer means. This module answers the other question: which store a page
// is reading, and what happens to the one it replaces. They were one file, and a
// file holding a state machine and a React lifetime is two jobs — the store's own
// behaviour and the acquisition rule below are checked against different failures,
// and each was harder to read for the other being there.
//
// WHY THE STORE IS THE WINDOW'S AND NOT A PAGE'S
//
// A held value's note is a promise, and a store built per calling component cannot
// keep it: three pages read these keys, each would own a separate store, and the
// store would die with the page — so switching settings sections destroyed a choice
// while the row still said it was held for the window. {@link consoleShellPreferences}
// is the one holder, on the precedent `frame/keybinding-override-store.ts` states in
// its own words: module scope IS window scope here, because an auxiliary window is
// its own renderer process and no channel joins two windows' module graphs.

import { useCallback, useEffect, useSyncExternalStore } from "react";

import type { ConsoleBridge } from "../../bridge/index.js";
import type { ConsoleRefusal } from "../../core/index.js";
import { useSubjectScopedState } from "../../store/index.js";
import {
  NOTHING_CHOSEN,
  ShellPreferenceStore,
  effectivePreference,
  type ShellPreferenceKey,
  type ShellPreferenceSnapshot,
} from "./shell-preferences-store.js";

/** What a page reads and what it presses. One object, so a row takes one prop set. */
export interface ShellPreferenceBinding {
  readonly snapshot: ShellPreferenceSnapshot;
  /** The effective value: what the carrier holds, what this window chose, or the default. */
  readonly isEnabled: (key: ShellPreferenceKey) => boolean;
  /** True when this window is the only place the choice lives. */
  readonly isHeldLocally: (key: ShellPreferenceKey) => boolean;
  readonly isPending: (key: ShellPreferenceKey) => boolean;
  readonly refusalFor: (key: ShellPreferenceKey) => ConsoleRefusal | undefined;
  readonly choose: (key: ShellPreferenceKey, enabled: boolean) => void;
}

/**
 * Who owns this window's preference store.
 *
 * A holder rather than a bare module-level `let`, which `apps/desktop/AGENTS.md`
 * rejects: the supersession rule below is an invariant over two fields moving
 * together, and an invariant is only checkable when the state has one owner.
 *
 * EXACTLY ONE STORE IS LIVE, AND THE BRIDGE IS STILL THE KEY. The fixture's
 * scenario swap replaces the bridge, and a store built against the old one would
 * keep answering with the old one's reading — so a different bridge disposes the
 * store before it, and the disposed one is dropped rather than kept: asking again
 * for a bridge that has been superseded mints a fresh store instead of handing back
 * a terminal one whose replies write nothing.
 *
 * READING AND ACQUIRING ARE TWO METHODS, and that split is what keeps the rule
 * above safe under React. The one method this used to carry did both, so the render
 * body that looked a store up also disposed the one the committed tree was
 * subscribed to; a replayed or abandoned render then left the mounted pages reading
 * and choosing into a disposed store while this holder held one that was never
 * committed. {@link storeIfCurrent} is what a render body calls and mutates
 * nothing; {@link acquire} is what an effect or an event handler calls and is the
 * only place a store is minted or disposed.
 */
class ShellPreferenceStoreHolder {
  #bridge: ConsoleBridge | undefined;
  #store: ShellPreferenceStore | undefined;

  /**
   * The live store for `bridge`, or `undefined` when this holder is on another
   * bridge or has not been asked for one yet.
   *
   * PURE — a field read and a comparison, nothing else — because this is the call a
   * render body makes, and a render body may run for a pass React discards.
   */
  public storeIfCurrent(bridge: ConsoleBridge): ShellPreferenceStore | undefined {
    return this.#bridge === bridge ? this.#store : undefined;
  }

  /**
   * The store for this bridge, minting one on first ask and on a bridge change.
   *
   * MUTATES, so it is reached from an effect or from an event handler and never
   * from a render body. Idempotent for one bridge, which is what lets strict mode
   * invoke the acquiring effect twice without the second invocation superseding
   * what the first one minted.
   */
  public acquire(bridge: ConsoleBridge): ShellPreferenceStore {
    const held = this.storeIfCurrent(bridge);
    if (held !== undefined) {
      return held;
    }
    // The only disposal there is: the store a DIFFERENT bridge supersedes. A page
    // unmounting disposes nothing, because this store's lifetime is the window's.
    this.#store?.dispose();
    const minted = new ShellPreferenceStore(bridge);
    this.#bridge = bridge;
    this.#store = minted;
    return minted;
  }
}

/**
 * This window's shell preferences.
 *
 * Module scope IS window scope here, for the reason
 * `frame/keybinding-override-store.ts` gives about the overrides it holds the same
 * way: an auxiliary window is its own renderer process, so no channel joins two
 * windows' module graphs — and a choice held for this window then outlives the page
 * that was open when it was made, which is what the row's own note promises.
 */
export const consoleShellPreferences: ShellPreferenceStoreHolder = new ShellPreferenceStoreHolder();

/**
 * Bind this window's shell preferences.
 *
 * THE STORE IS ACQUIRED IN AN EFFECT AND ONLY READ DURING RENDER. It was acquired
 * during render, from a `useMemo` over the bridge, and a memo is not a safe place
 * for an acquisition that disposes something: a replacement bridge disposed the
 * store the committed tree was subscribed to and installed a successor, so a render
 * React replayed or abandoned left every mounted page reading and choosing into a
 * disposed store while the holder held one that was never committed. Every other
 * bridge-bound holder in this console already acquires from an effect and renders
 * the absence until it settles — `agents/agent-console-model.ts` and
 * `panes/agent-console/session-projection.ts` are both that shape — and this is the
 * same shape rather than a second lifecycle beside them.
 *
 * THE EFFECT STILL HAS NO TEARDOWN. This store's lifetime is the WINDOW's and a
 * page unmount is not the window closing, which is the defect the holder was
 * introduced to fix; the one disposal there is belongs to the replacement, inside
 * `acquire`, where it happens after a commit rather than during a render.
 *
 * A PAGE THAT RENDERS BEFORE THE EFFECT SETTLES renders the opening arm — the
 * `not-read` snapshot every row already draws in the frame before the carrier
 * answers — and never a disposed store, because the store answered is this mount's
 * own only while the holder still holds it for this bridge. State replaced from an
 * effect lags its own inputs by one committed frame, which is the rule
 * `agents/agent-console-model.ts` states for the same hazard.
 */
export function useShellPreferences(bridge: ConsoleBridge): ShellPreferenceBinding {
  // Held against the TRANSPORT, through the console's one holder. The seed reads the
  // pure lookup so the SECOND page to bind in a window opens on the store the first
  // one acquired rather than on one frame of the opening arm — and because the seed
  // is re-read in the render that first sees a new bridge, a page carried across a
  // scenario switch never reads the retired bridge's store even for a frame.
  const { value: acquiredStore, publish: publishAcquiredStore } = useSubjectScopedState<
    ShellPreferenceStore | undefined
  >(bridge, undefined, () => consoleShellPreferences.storeIfCurrent(bridge));

  useEffect(() => {
    const store = consoleShellPreferences.acquire(bridge);
    // Idempotent, so strict mode's second invocation asks nothing twice.
    store.start();
    publishAcquiredStore(store);
  }, [bridge, publishAcquiredStore]);

  const liveStore = consoleShellPreferences.storeIfCurrent(bridge);
  const store = acquiredStore === liveStore ? acquiredStore : undefined;

  const subscribe = useCallback(
    (onStoreChange: () => void) => store?.subscribe(onStoreChange) ?? noPreferenceSubscription,
    [store],
  );
  const read = useCallback(() => store?.snapshot() ?? NOTHING_CHOSEN, [store]);
  const snapshot = useSyncExternalStore(subscribe, read, read);
  return {
    snapshot,
    isEnabled: (key) => effectivePreference(snapshot, key),
    isHeldLocally: (key) => Object.hasOwn(snapshot.heldLocally, key),
    isPending: (key) => snapshot.pendingKeys.has(key),
    refusalFor: (key) => snapshot.refusalByKey[key],
    choose: (key, enabled) => {
      // Reached from an event handler and never from a render, so this acquires
      // rather than reads: a press must move a store rather than be swallowed by
      // the frame before the effect ran, and the handler settles on the same store
      // that effect acquired because a press cannot outrun a passive effect.
      void consoleShellPreferences.acquire(bridge).choose(key, enabled);
    },
  };
}

/** The unsubscribe a mount whose effect has not acquired a store yet hands React. */
function noPreferenceSubscription(): void {
  return undefined;
}
