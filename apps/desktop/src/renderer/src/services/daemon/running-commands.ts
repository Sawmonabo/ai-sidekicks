// The commands an agent started in one session and that still run, followed through
// `agent.command.subscribe`, whose `commands` frames are the whole set in start order. A command's
// output frames are the working line's to draw and are not handed on here. Every delivery is
// checked with the contract's generated check; an unreadable delivery and a stream the daemon
// refuses are handed on as the set being lost, so no act aims at a command that may be gone.

import {
  type RunningCommand,
  validateAgentCommandSubscribeFrame,
} from "@ai-sidekicks/contracts/command";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import { checkFaultPaths } from "#shared/daemon/fault-path.js";
import type { Unsubscribe } from "#shared/preload-api.js";
import { recordRefusedMemberPaths } from "#renderer/lib/diagnostic-capture/refused-member-record.js";
import type { PlatformBridge } from "../platform/bridge.js";
import { openReopeningSubscription } from "../transport/reopening-subscription.js";

/** The subscription that delivers a session's running commands. */
const RUNNING_COMMAND_STREAM = "agent.command.subscribe";

/** One delivery: the whole running set in start order, or word that it could not be read. */
export type RunningCommandsFrame =
  | { readonly kind: "commands"; readonly commands: readonly RunningCommand[] }
  | { readonly kind: "lost" };

/** Follow one session's running commands, handing each set on, until the handle releases it. */
export function followRunningCommands(
  bridge: PlatformBridge,
  sessionId: SessionId,
  onFrame: (frame: RunningCommandsFrame) => void,
): Unsubscribe {
  return openReopeningSubscription({
    signal: bridge.transportReconnect,
    subject: RUNNING_COMMAND_STREAM,
    firstOpenFailure: "refuseAndRetry",
    open: (deliver, onEnded) =>
      bridge.daemon.subscribe(RUNNING_COMMAND_STREAM, { sessionId }, deliver, onEnded),
    onFrame: (payload) => {
      if (!validateAgentCommandSubscribeFrame(payload)) {
        recordRefusedMemberPaths({
          source: "services/daemon",
          kind: "notice-unreadable",
          subject: RUNNING_COMMAND_STREAM,
          issues: checkFaultPaths(validateAgentCommandSubscribeFrame, payload),
        });
        onFrame({ kind: "lost" });
        return;
      }
      if (payload.kind === "commands") {
        onFrame({ kind: "commands", commands: payload.commands });
      }
    },
    onReopenRefusal: (refusal) => {
      if (refusal !== undefined) {
        onFrame({ kind: "lost" });
      }
    },
  });
}
