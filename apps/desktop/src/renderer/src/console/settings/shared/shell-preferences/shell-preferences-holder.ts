// Who owns this window's shell preference store, for how long, and how React binds it.
//
// The store is the window's and not a page's: more than one surface reads these keys, and
// a store built per calling component would die with its page. Module scope is window
// scope here, because an auxiliary window is its own renderer process and no channel
// joins two windows' module graphs. That plurality is also why these modules live in
// `settings/shared/` rather than under `pages/`.

import { useCallback, useEffect, useSyncExternalStore } from "react";

import type { ConsoleBridge } from "@renderer/console/bridge/console-bridge.js";
import {
  NO_TRIGGERING_EVENT_KINDS,
  useWindowReadTriggers,
  type ReadTriggerTarget,
} from "@renderer/console/store/read/read-triggers.js";
import { useSubjectScopedState } from "@renderer/hooks/subject-scoped/useSubjectScopedState.js";
import {
  ShellPreferenceStore,
  type ShellPreferenceCarrier,
} from "@renderer/features/settings/machine-settings/machine-settings-store.js";
import {
  NOTHING_CHOSEN,
  effectivePreference,
  type ShellPreferenceKey,
  type ShellPreferenceSnapshot,
} from "@renderer/features/settings/machine-settings/machine-settings-snapshot.js";

/** What a page reads and what it presses. One object, so a row takes one prop set. */
export interface ShellPreferenceBinding {
  readonly snapshot: ShellPreferenceSnapshot;
  /** The effective value: what the carrier holds, or the default. */
  readonly isEnabled: (key: ShellPreferenceKey) => boolean;
  readonly isPending: (key: ShellPreferenceKey) => boolean;
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
 * READING AND ACQUIRING ARE TWO METHODS, so a render React replays or abandons never
 * disposes the store the committed tree is subscribed to. {@link storeIfCurrent} is
 * what a render body calls and mutates nothing; {@link acquire} is what an effect or an
 * event handler calls and is the only place a store is minted or disposed.
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
   * The store for this bridge, minting one over `carrier` on first ask and on a bridge
   * change. A store already held for the bridge keeps the carrier it was minted with.
   *
   * MUTATES, so it is reached from an effect or from an event handler and never
   * from a render body. Idempotent for one bridge, which is what lets strict mode
   * invoke the acquiring effect twice without the second invocation superseding
   * what the first one minted.
   */
  public acquire(bridge: ConsoleBridge, carrier: ShellPreferenceCarrier): ShellPreferenceStore {
    const held = this.storeIfCurrent(bridge);
    if (held !== undefined) {
      return held;
    }
    // The only disposal there is: the store a DIFFERENT bridge supersedes. A page
    // unmounting disposes nothing, because this store's lifetime is the window's.
    this.#store?.dispose();
    const minted = new ShellPreferenceStore(bridge, carrier);
    this.#bridge = bridge;
    this.#store = minted;
    return minted;
  }
}

/**
 * This window's shell preferences.
 *
 * Module scope IS window scope here, for the reason
 * `palette/keybindings/keybinding-override-store.ts` gives about the overrides it holds the same
 * way: an auxiliary window is its own renderer process, so no channel joins two
 * windows' module graphs.
 */
export const consoleShellPreferences: ShellPreferenceStoreHolder = new ShellPreferenceStoreHolder();

/**
 * The target the window triggers are wired to while no store is held.
 *
 * A hook may not be called conditionally and the acquired store is `undefined` for
 * the render that first sees a new bridge, so the triggers need something to hold in
 * that frame. Asking it for a read does nothing, which is the honest answer: there is
 * no transport to ask. At module scope so the hook's dependency compares one identity
 * across renders rather than a fresh literal each pass.
 */
const NO_STORE_HELD: ReadTriggerTarget = {
  triggeringEventKinds: NO_TRIGGERING_EVENT_KINDS,
  requestRead: () => undefined,
};

/**
 * Bind this window's shell preferences over `carrier`, the machine's settings file. The
 * caller holds `carrier` stable, because it is an effect dependency.
 *
 * THE STORE IS ACQUIRED IN AN EFFECT AND ONLY READ DURING RENDER, because acquiring
 * can dispose the store a replaced bridge left behind and a memo is not a safe place
 * for that. The effect has no teardown: this store's lifetime is the WINDOW's and a
 * page unmount is not the window closing; the one disposal there is belongs to the
 * replacement, inside `acquire`, after a commit.
 *
 * A page that renders before the effect settles gets the `not-read` snapshot, never a
 * disposed store: the store answered is this mount's own only while the holder still
 * holds it for this bridge.
 */
export function useShellPreferences(
  bridge: ConsoleBridge,
  carrier: ShellPreferenceCarrier,
): ShellPreferenceBinding {
  // Held against the TRANSPORT, through the console's one holder. The seed reads the
  // pure lookup so the SECOND page to bind in a window opens on the store the first
  // one acquired rather than on one frame of the opening arm — and because the seed
  // is re-read in the render that first sees a new bridge, a page carried across a
  // scenario switch never reads the retired bridge's store even for a frame.
  const { value: acquiredStore, publish: publishAcquiredStore } = useSubjectScopedState<
    ShellPreferenceStore | undefined
  >(bridge, undefined, () => consoleShellPreferences.storeIfCurrent(bridge));

  useEffect(() => {
    const store = consoleShellPreferences.acquire(bridge, carrier);
    // Idempotent, so strict mode's second invocation asks nothing twice.
    store.start();
    publishAcquiredStore(store);
  }, [bridge, carrier, publishAcquiredStore]);

  const liveStore = consoleShellPreferences.storeIfCurrent(bridge);
  const store = acquiredStore === liveStore ? acquiredStore : undefined;

  // The window half only: the preferences are per user rather than per session, so
  // no session's repair and no session's timeline bear on them. The window half now
  // carries the transport's own reconnect, which a per-user reading needs exactly as
  // much as a session-scoped one — a preference read that refused while the wire was
  // away is a row rendering its default with nothing asking again.
  useWindowReadTriggers(store ?? NO_STORE_HELD, bridge.transportReconnect);

  const subscribe = useCallback(
    (onStoreChange: () => void) => store?.subscribe(onStoreChange) ?? noPreferenceSubscription,
    [store],
  );
  const read = useCallback(() => store?.snapshot() ?? NOTHING_CHOSEN, [store]);
  const snapshot = useSyncExternalStore(subscribe, read, read);
  return {
    snapshot,
    isEnabled: (key) => effectivePreference(snapshot, key),
    isPending: (key) => snapshot.pendingKeys.has(key),
    choose: (key, enabled) => {
      // Reached from an event handler and never from a render, so this acquires
      // rather than reads: a press must move a store rather than be swallowed by
      // the frame before the effect ran, and the handler settles on the same store
      // that effect acquired because a press cannot outrun a passive effect.
      void consoleShellPreferences.acquire(bridge, carrier).choose(key, enabled);
    },
  };
}

/** The unsubscribe a mount whose effect has not acquired a store yet hands React. */
function noPreferenceSubscription(): void {
  return undefined;
}
