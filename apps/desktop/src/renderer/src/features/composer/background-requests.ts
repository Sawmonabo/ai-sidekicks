// Moving the command the agent waits on to the background, asked from anywhere in the window
// (Ctrl+B) and answered by the mounted composer, which follows its session's running commands. The
// ask is an event, not a store: an ask with no composer mounted reaches nobody. Whether a command
// can move is published beside it, so Ctrl+B is bound only then and is otherwise the line's own
// key.

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

/** Say whether a running command can move now; the composer publishes `false` as it unmounts. */
export function publishCanMoveToBackground(canMove: boolean): void {
  backgroundMoveAvailability.publish(canMove);
}

/** Whether a running command can move now, as the mounted composer last said. */
export function readCanMoveToBackground(): boolean {
  return backgroundMoveAvailability.read();
}

/** Watch whether a running command can move. */
export function subscribeToCanMoveToBackground(listener: () => void): Unsubscribe {
  return backgroundMoveAvailability.subscribe(listener);
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
  const command = commands.findLast(canMoveToBackground);
  if (command === undefined) {
    return false;
  }
  send({ sessionId, commandId: command.commandId });
  return true;
}

/** Whether the provider offers to move this running command to the background. */
export function canMoveToBackground(command: RunningCommand): boolean {
  return command.canMoveToBackground;
}

/** Whether the mounted composer's session runs a command its provider offers to move. */
class BackgroundMoveAvailability {
  readonly #changes = new Emitter<void>("composer background move availability");
  #canMove = false;

  public read = (): boolean => this.#canMove;

  public subscribe = (listener: () => void): Unsubscribe => this.#changes.subscribe(listener);

  public publish(canMove: boolean): void {
    if (this.#canMove !== canMove) {
      this.#canMove = canMove;
      this.#changes.emit();
    }
  }
}

const backgroundMoveAvailability = new BackgroundMoveAvailability();
