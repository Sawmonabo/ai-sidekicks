// The bridge's `machineSettings` members main answers: the read, the write and the feed, each over
// main's own channel to the client helper, whose addon checks the request against the settings
// contract before it reaches the service, the file's one writer.

import { BRIDGE_CHANNELS } from "#shared/bridge-channels.js";
import type { DaemonCallOutcome } from "#shared/daemon/forwarding.js";
import { NOT_ANSWERING_MESSAGE } from "#shared/daemon/status-topic.js";
import { DaemonRefusal } from "../services/daemon/client/process.js";
import type { MainMethodTypes } from "../services/daemon/client/method-allowlist.js";
import { NOT_CONNECTED_MESSAGE, type DaemonLink } from "../services/daemon/link/status.js";
import type { MainTopicOpener } from "./daemon.js";
import { pageSafeMessage } from "./page-safe-message.js";

/** One channel's answer, given the asking event and the one request it carried. */
type MachineSettingsAnswer = (event: unknown, request: unknown) => Promise<DaemonCallOutcome>;

/** The channels the read and the write ride; the feed rides main's topic channel. */
type MachineSettingsChannel =
  | typeof BRIDGE_CHANNELS.readMachineSettings
  | typeof BRIDGE_CHANNELS.writeMachineSettings;

/**
 * The read and the write, by channel. A change the contract refuses is answered as refused with
 * nothing written; a written one is answered with the file as written.
 */
export function machineSettingsAnswers(
  link: Pick<DaemonLink, "client">,
): Readonly<Record<MachineSettingsChannel, MachineSettingsAnswer>> {
  return {
    [BRIDGE_CHANNELS.readMachineSettings]: () => callOver(link, "machine.settings.read", {}),
    [BRIDGE_CHANNELS.writeMachineSettings]: async (_event, change) => {
      const outcome = await callOver(link, "machine.settings.update", { change });
      return outcome.outcome === "served"
        ? { outcome: "served", value: outcome.value.settings }
        : outcome;
    },
  };
}

/** The settings' feed for main's topics; a page opens it with nothing, or the addon refuses it. */
export function machineSettingsFeed(link: Pick<DaemonLink, "client">): MainTopicOpener {
  return (params, deliver, onEnded) => {
    const client = link.client;
    if (client === undefined) {
      return { outcome: "failed", message: NOT_CONNECTED_MESSAGE };
    }
    return {
      outcome: "opened",
      close: client.subscribe("machine.settings.subscribe", params, deliver, onEnded),
    };
  };
}

/** One call over the link, answered as the page reads it: served, refused, or failed. */
async function callOver<Method extends keyof MainMethodTypes>(
  link: Pick<DaemonLink, "client">,
  method: Method,
  params: unknown,
): Promise<
  | { readonly outcome: "served"; readonly value: MainMethodTypes[Method]["result"] }
  | Exclude<DaemonCallOutcome, { readonly outcome: "served" }>
> {
  const client = link.client;
  if (client === undefined) {
    return { outcome: "failed", message: NOT_CONNECTED_MESSAGE };
  }
  try {
    return { outcome: "served", value: await client.call(method, params) };
  } catch (failure) {
    return failure instanceof DaemonRefusal
      ? { outcome: "refused", refusal: failure.refusal }
      : { outcome: "failed", message: pageSafeMessage(failure, NOT_ANSWERING_MESSAGE) };
  }
}
