// Who owns this window's machine-settings store, and for how long.
//
// The store is the window's, not a page's: several pages read these keys. Module scope is
// window scope because an auxiliary window is its own renderer process.

import type { PlatformBridge } from "@renderer/services/platform/platform-bridge.js";
import { MachineSettingsStore } from "./machine-settings-store.js";

/**
 * Owns this window's preference store, keyed by bridge.
 *
 * A class so the two fields move together under one owner. At most one store is live: a
 * different bridge (a fixture scenario swap) disposes the old store and mints a new one, and a
 * superseded bridge never gets its disposed store back. `storeIfCurrent` is pure and safe in
 * render; `acquire` mints or disposes and belongs in an effect or event handler.
 */
class MachineSettingsStoreHolder {
  #bridge: PlatformBridge | undefined;
  #store: MachineSettingsStore | undefined;

  /**
   * The live store for `bridge`, or `undefined` when the holder is on another bridge or has not
   * been asked yet. Pure, because a render body calls it and may be discarded.
   */
  public storeIfCurrent(bridge: PlatformBridge): MachineSettingsStore | undefined {
    return this.#bridge === bridge ? this.#store : undefined;
  }

  /**
   * The store for this bridge, minted over its `machineSettings` on first ask and on a bridge
   * change.
   *
   * Mutates, so call it from an effect or event handler. Idempotent for one bridge, so strict
   * mode can run the acquiring effect twice.
   */
  public acquire(bridge: PlatformBridge): MachineSettingsStore {
    const held = this.storeIfCurrent(bridge);
    if (held !== undefined) {
      return held;
    }
    // The only disposal: a different bridge supersedes the store. A page unmounting disposes
    // nothing.
    this.#store?.dispose();
    const minted = new MachineSettingsStore(bridge.machineSettings);
    this.#bridge = bridge;
    this.#store = minted;
    return minted;
  }
}

/** This window's machine settings; module scope is window scope. */
export const machineSettingsHolder: MachineSettingsStoreHolder = new MachineSettingsStoreHolder();
