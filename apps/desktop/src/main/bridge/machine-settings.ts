// The bridge's `machineSettings` members main answers: the read, the write and the feed, each over
// main's own channel to the client helper, which checks the request against the settings contract
// before it reaches the service, the file's one writer, and main checks the reply.

import { MACHINE_SETTINGS_METHOD_DESCRIPTORS } from "@ai-sidekicks/contracts/machine/settings";

import { BRIDGE_CHANNELS } from "#shared/bridge-channels.js";
import type { DaemonCallOutcome } from "#shared/daemon/forwarding.js";
import { NOT_ANSWERING_MESSAGE } from "#shared/daemon/status-topic.js";
import { DaemonRefusal, type MainCallMethod } from "../services/daemon/client/process.js";
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
    [BRIDGE_CHANNELS.readMachineSettings]: () =>
      callOver(link, MACHINE_SETTINGS_METHOD_DESCRIPTORS["machine.settings.read"], {}),
    [BRIDGE_CHANNELS.writeMachineSettings]: async (_event, change) => {
      const outcome = await callOver(
        link,
        MACHINE_SETTINGS_METHOD_DESCRIPTORS["machine.settings.update"],
        { change },
      );
      return outcome.outcome === "served"
        ? { outcome: "served", value: outcome.value.settings }
        : outcome;
    },
  };
}

/** The settings' feed for main's topics; a page opens it with nothing, or it is refused. */
export function machineSettingsFeed(link: Pick<DaemonLink, "client">): MainTopicOpener {
  const feed = MACHINE_SETTINGS_METHOD_DESCRIPTORS["machine.settings.subscribe"];
  const isFeedRequest = feed.requestCheck;
  return (params, deliver, onEnded) => {
    if (!isFeedRequest(params)) {
      return { outcome: "unsendable" };
    }
    const client = link.client;
    if (client === undefined) {
      return { outcome: "failed", message: NOT_CONNECTED_MESSAGE };
    }
    return {
      outcome: "opened",
      close: client.subscribe(feed, params, deliver, onEnded),
    };
  };
}

/** One call over the link, answered as the page reads it: served, refused, or failed. */
async function callOver<Response>(
  link: Pick<DaemonLink, "client">,
  method: MainCallMethod<Response>,
  params: unknown,
): Promise<
  | { readonly outcome: "served"; readonly value: Response }
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
