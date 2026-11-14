// The commands an agent started in one session and that still run, followed through
// `agent.command.subscribe`, whose `commands` frames are the whole set in start order. A command's
// output frames are the working line's to draw and are not handed on here. A stream the daemon
// refuses is handed on as the set being lost, so no act aims at a command that may be gone.

import type { AgentCommandSubscribeFrame, RunningCommand } from "@ai-sidekicks/contracts/command";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import { RUNNING_COMMAND_STREAM } from "#shared/daemon/streams.js";
import type { Unsubscribe } from "#shared/preload-api.js";
import type { PlatformBridge } from "../platform/bridge.js";
import { openReopeningSubscription } from "../transport/reopening-subscription.js";

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
      const frame = payload as AgentCommandSubscribeFrame;
      if (frame.kind === "commands") {
        onFrame({ kind: "commands", commands: frame.commands });
      }
    },
    onReopenRefusal: (refusal) => {
      if (refusal !== undefined) {
        onFrame({ kind: "lost" });
      }
    },
  });
}
