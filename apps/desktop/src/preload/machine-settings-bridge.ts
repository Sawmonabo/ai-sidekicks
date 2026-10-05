// The `machineSettings` members as the preload carries them to main. The read and the write answer
// with main's outcome, as a daemon call does; the feed is a daemon subscription main checks
// against the settings contract.

import type {
  MachineSettings,
  MachineSettingsMethodDescriptors,
  MachineSettingsReading,
} from "@ai-sidekicks/contracts/machine-settings";

import { BRIDGE_CHANNELS } from "#shared/bridge-channels.js";
import type { PreloadApi } from "#shared/preload-api.js";
import { settleDaemonCall, type DaemonSubscriptions, type DaemonWireIpc } from "./daemon-wire.js";

/**
 * The service's settings feed. Typed by the contract, so a renamed method fails the build, and
 * written out so the sandboxed preload loads none of the contract's schemas.
 */
const MACHINE_SETTINGS_FEED: MachineSettingsMethodDescriptors["daemon.machineSettingsSubscribe"]["method"] =
  "daemon.machineSettingsSubscribe";

/** The `machineSettings` member the preload exposes, carried over `ipc`. */
export function createMachineSettingsBridge(
  ipc: Pick<DaemonWireIpc, "invoke">,
  subscriptions: DaemonSubscriptions,
): PreloadApi["machineSettings"] {
  return {
    read: async (): Promise<MachineSettingsReading> =>
      settleDaemonCall(await ipc.invoke(BRIDGE_CHANNELS.readMachineSettings))
        .value as MachineSettingsReading,
    write: async (change): Promise<MachineSettings> =>
      settleDaemonCall(await ipc.invoke(BRIDGE_CHANNELS.writeMachineSettings, change))
        .value as MachineSettings,
    subscribe: (handler, onEnded) =>
      subscriptions.open(MACHINE_SETTINGS_FEED, {}, handler as (value: unknown) => void, onEnded),
  };
}
