// Who owns this window's machine-settings store, and for how long.
//
// The store is the window's and not a page's: more than one surface reads these keys, and
// a store built per calling component would die with its page. Module scope is window
// scope here, because an auxiliary window is its own renderer process and no channel
// joins two windows' module graphs.

import type { ConsoleBridge } from "@renderer/console/bridge/console-bridge.js";
import { MachineSettingsStore, type ShellPreferenceCarrier } from "./machine-settings-store.js";

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
  #store: MachineSettingsStore | undefined;

  /**
   * The live store for `bridge`, or `undefined` when this holder is on another
   * bridge or has not been asked for one yet.
   *
   * PURE — a field read and a comparison, nothing else — because this is the call a
   * render body makes, and a render body may run for a pass React discards.
   */
  public storeIfCurrent(bridge: ConsoleBridge): MachineSettingsStore | undefined {
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
  public acquire(bridge: ConsoleBridge, carrier: ShellPreferenceCarrier): MachineSettingsStore {
    const held = this.storeIfCurrent(bridge);
    if (held !== undefined) {
      return held;
    }
    // The only disposal there is: the store a DIFFERENT bridge supersedes. A page
    // unmounting disposes nothing, because this store's lifetime is the window's.
    this.#store?.dispose();
    const minted = new MachineSettingsStore(bridge, carrier);
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
export const machineSettingsHolder: ShellPreferenceStoreHolder = new ShellPreferenceStoreHolder();
