// The `machineSettings` members as the preload carries them to main. The read and the write answer
// with main's outcome, as a daemon call does; the feed is a daemon subscription main checks
// against the settings contract.

import type {
  MachineSettings,
  MachineSettingsReading,
} from "@ai-sidekicks/contracts/machine-settings";

import { BRIDGE_CHANNELS } from "#shared/bridge-channels.js";
import { MACHINE_SETTINGS_STREAM } from "#shared/daemon/daemon-streams.js";
import type { PreloadApi } from "#shared/preload-api.js";
import { settleDaemonCall, type DaemonSubscriptions } from "./daemon-wire.js";
import type { PreloadIpc } from "./preload-ipc.js";

/** The `machineSettings` member the preload exposes, carried over `ipc`. */
export function createMachineSettingsBridge(
  ipc: Pick<PreloadIpc, "invoke">,
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
      subscriptions.open(MACHINE_SETTINGS_STREAM, {}, handler as (value: unknown) => void, onEnded),
  };
}
