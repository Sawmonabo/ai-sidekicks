// Moving the command the agent waits on to the background, asked from anywhere in the window
// (Ctrl+B) and answered by the mounted composer, which follows its session's running commands. It
// is an event, not a store: an ask with no composer mounted reaches nobody, and nothing re-renders.

import type {
  AgentCommandBackgroundRequest,
  RunningCommand,
} from "@ai-sidekicks/contracts/command";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import type { Unsubscribe } from "#shared/preload-api.js";
import { Emitter } from "#renderer/lib/emitter.js";

/** The one thing the ask carries: that somebody asked. */
type BackgroundRequest = Readonly<Record<string, never>>;

const backgroundRequests = new Emitter<BackgroundRequest>("composer background request");

/** Ask the mounted composer to move its session's waited-on command to the background. */
export function requestMoveToBackground(): void {
  backgroundRequests.emit({});
}

/** The composer's side: act when asked, until the handle releases it. */
export function subscribeToBackgroundRequests(act: () => void): Unsubscribe {
  return backgroundRequests.subscribe(() => {
    act();
  });
}

/**
 * Send the background request for the newest running command the provider offers to move, or
 * send nothing and answer `false` where none does: the control does not exist then. The request
 * names the session and the command, nothing else.
 */
export function moveCommandToBackground(
  sessionId: SessionId,
  commands: readonly RunningCommand[],
  send: (request: AgentCommandBackgroundRequest) => void,
): boolean {
  const command = commands.findLast((running) => running.canMoveToBackground);
  if (command === undefined) {
    return false;
  }
  send({ sessionId, commandId: command.commandId });
  return true;
}
