// Main's asks of the client helper that reach past the link: ending the service through the
// addon, which runs the ending's whole sequence, and reading a process's identity. Each is
// answered once, an ask that threw as failed, so main's ask settles.

import type { ProcessIdentity } from "@ai-sidekicks/contracts/process-identity";

import { describeFailure } from "#shared/failure-message.js";

import type { ClientHelperAddon } from "./addon.js";
import type { ClientHelperServiceAnswer, ClientHelperServiceAsk } from "./messages.js";

/** The answer to one of main's service asks, made through `addon`; never rejects. */
export async function answerServiceAsk(
  addon: ClientHelperAddon,
  ask: ClientHelperServiceAsk,
): Promise<ClientHelperServiceAnswer> {
  try {
    switch (ask.kind) {
      case "daemon.end":
        return {
          kind: "daemon.ended",
          askId: ask.askId,
          outcome: await addon.endDaemon(ask.request, ask.presentsToken),
        };
      case "daemon.endProcess":
        return {
          kind: "daemon.ended",
          askId: ask.askId,
          outcome: await addon.endDaemonProcess(JSON.stringify(ask.identity)),
        };
      case "process.identityRead":
        return processIdentityAnswer(addon, ask.askId, ask.processId);
    }
  } catch (failure) {
    return { kind: "service.askFailed", askId: ask.askId, error: describeFailure(failure) };
  }
}

function processIdentityAnswer(
  addon: ClientHelperAddon,
  askId: number,
  processId: number,
): ClientHelperServiceAnswer {
  let identity: string | null;
  try {
    identity = addon.readProcessIdentity(processId);
  } catch (failure) {
    return { kind: "process.identityRefused", askId, error: describeFailure(failure) };
  }
  return {
    kind: "process.identity",
    askId,
    // The addon writes the contract's own identity.
    identity: identity === null ? undefined : (JSON.parse(identity) as ProcessIdentity),
  };
}
