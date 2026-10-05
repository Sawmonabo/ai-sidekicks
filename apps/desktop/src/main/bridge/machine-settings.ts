// The bridge's `machineSettings` members main answers: the read and the write, each forwarded over
// main's own connection to the service, the file's one writer, and checked against the settings
// contract on the way in and out. The feed rides the daemon's subscription channel.

import {
  MACHINE_SETTINGS_METHOD_DESCRIPTORS,
  type MachineSettingsUpdateResponse,
} from "@ai-sidekicks/contracts/machine-settings";

import { BRIDGE_CHANNELS } from "@shared/bridge-channels.js";
import type { DaemonCallOutcome } from "@shared/daemon/forwarding.js";
import type { DaemonForwarding } from "./daemon.js";

/** One channel's answer, given the asking event and the one request it carried. */
type MachineSettingsAnswer = (event: unknown, request: unknown) => Promise<DaemonCallOutcome>;

/** The channels the `machineSettings` members ride, besides the daemon's subscription channel. */
type MachineSettingsChannel =
  | typeof BRIDGE_CHANNELS.readMachineSettings
  | typeof BRIDGE_CHANNELS.writeMachineSettings;

/**
 * The `machineSettings` answers, by channel. A change the contract refuses is answered as failed
 * with nothing sent; a written one is answered with the file as written.
 */
export function machineSettingsAnswers(
  forwarding: Pick<DaemonForwarding, "callDescribed">,
): Readonly<Record<MachineSettingsChannel, MachineSettingsAnswer>> {
  return {
    [BRIDGE_CHANNELS.readMachineSettings]: () =>
      forwarding.callDescribed(
        MACHINE_SETTINGS_METHOD_DESCRIPTORS["daemon.machineSettingsRead"],
        {},
      ),
    [BRIDGE_CHANNELS.writeMachineSettings]: async (_event, change) => {
      const outcome = await forwarding.callDescribed(
        MACHINE_SETTINGS_METHOD_DESCRIPTORS["daemon.machineSettingsUpdate"],
        { change },
      );
      return outcome.outcome === "served"
        ? { outcome: "served", value: (outcome.value as MachineSettingsUpdateResponse).settings }
        : outcome;
    },
  };
}
