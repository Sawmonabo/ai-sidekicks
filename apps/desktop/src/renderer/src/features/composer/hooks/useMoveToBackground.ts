// The composer's answer to Ctrl+B: it follows the session's running commands for as long as it is
// mounted, publishes whether one can move so Ctrl+B is bound only then, and an ask moves the newest
// one the provider offers to move. A refusal is held for the session it was refused in and read
// back to be drawn under the line.

import { useEffect, useRef, useState } from "react";

import type { RunningCommand } from "@ai-sidekicks/contracts/command";

import type { Refusal } from "#renderer/lib/refusal/contract.js";
import { callDaemon } from "#renderer/services/daemon/reply.js";
import { followRunningCommands } from "#renderer/services/daemon/running-commands.js";
import { readSessionId } from "#renderer/services/daemon/wire/identifiers.js";
import type { PlatformBridge } from "#renderer/services/platform/bridge.js";
import {
  canMoveToBackground,
  moveCommandToBackground,
  publishCanMoveToBackground,
  subscribeToBackgroundRequests,
} from "../background-requests.js";

/** The last background request's refusal in `sessionId`, or `undefined`. */
export function useMoveToBackground(
  bridge: PlatformBridge,
  sessionId: string,
): Refusal | undefined {
  // Read at the ask, never rendered, so the stream's sets re-render nothing.
  const commandsRef = useRef<readonly RunningCommand[]>(NO_COMMANDS);
  const [refused, setRefused] = useState<
    { readonly sessionId: string; readonly refusal: Refusal } | undefined
  >(undefined);
  useEffect(() => {
    const wireSessionId = readSessionId(sessionId);
    commandsRef.current = NO_COMMANDS;
    if (wireSessionId === undefined) {
      return undefined;
    }
    // A lost set aims at nothing: a command it named may be gone.
    const stopFollowing = followRunningCommands(bridge, wireSessionId, (frame) => {
      commandsRef.current = frame.kind === "commands" ? frame.commands : NO_COMMANDS;
      publishCanMoveToBackground(commandsRef.current.some(canMoveToBackground));
    });
    const stopListening = subscribeToBackgroundRequests(() => {
      moveCommandToBackground(wireSessionId, commandsRef.current, (request) => {
        setRefused(undefined);
        void callDaemon(bridge, "agent.command.background", request).then((reply) => {
          if (reply.status === "refused") {
            setRefused({ sessionId, refusal: reply.refusal });
          }
        });
      });
    });
    return () => {
      stopFollowing();
      stopListening();
      publishCanMoveToBackground(false);
    };
  }, [bridge, sessionId]);
  return refused?.sessionId === sessionId ? refused.refusal : undefined;
}

/** No command running, or none known. */
const NO_COMMANDS: readonly RunningCommand[] = [];
