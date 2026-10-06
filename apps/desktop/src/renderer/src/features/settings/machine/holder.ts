// Who owns this window's machine-settings store, and for how long.
//
// The store is the window's, not a page's: several pages read these keys. Module scope is
// window scope.

import { KeyBoundHolder } from "#renderer/lib/key-bound-holder.js";
import type { PlatformBridge } from "#renderer/services/platform/bridge.js";
import { MachineSettingsStore } from "./store.js";

/**
 * This window's preference store, keyed by bridge and minted over its `machineSettings`. At most
 * one store is live: a different bridge (a fixture scenario swap) disposes the old store and
 * mints a new one, and a superseded bridge never gets its disposed store back.
 */
export const machineSettingsHolder: KeyBoundHolder<PlatformBridge, MachineSettingsStore> =
  new KeyBoundHolder(
    (bridge: PlatformBridge) =>
      new MachineSettingsStore(bridge.machineSettings, bridge.transportReconnect),
  );
