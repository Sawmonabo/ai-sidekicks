// What Send can resolve to, and the predicate the router takes from its host. Held beside the
// router, not in it, so the controller, the command zone and the Send button read one
// declaration.

import type { AgentQueueItemCreateRequest } from "@ai-sidekicks/contracts/run/queue";

import type { Refusal } from "#renderer/lib/refusal/contract.js";

/**
 * The queue arm: a message for the session's queue, whether a turn is running or not. The agent
 * takes it at its next step.
 */
export interface ComposerQueueResolution {
  readonly outcome: "queue";
  readonly request: AgentQueueItemCreateRequest;
}

/**
 * The interception arm: a console command that runs here. It is handed to the client's executor
 * rather than composed into a message, so this arm carries only its name.
 */
export interface ComposerConsoleCommandResolution {
  readonly outcome: "console-command";
  readonly commandName: string;
}

/** The refusal arm: Send is refused, carrying the refusal to show. */
export interface ComposerRefusedResolution {
  readonly outcome: "refused";
  readonly refusal: Refusal;
}

/** The empty arm: a message with no words and no staged file, which does nothing. */
export interface ComposerEmptyResolution {
  readonly outcome: "empty";
}

/** What a message resolves to once no slash rule applies: a wire call, or a refusal. */
export type ComposerMessageResolution = ComposerQueueResolution | ComposerRefusedResolution;

/** What Send resolves to: one of the four arms. */
export type ComposerSendResolution =
  | ComposerMessageResolution
  | ComposerConsoleCommandResolution
  | ComposerEmptyResolution;

/** What a message dispatch settled as: it reached the wire, or it was refused. */
export type ComposerMessageOutcome =
  | { readonly status: "sent" }
  | { readonly status: "refused"; readonly refusal: Refusal };

/** What a send settled as. The composer renders exactly one of these; `empty` draws nothing. */
export type ComposerSendOutcome =
  | ComposerMessageOutcome
  | { readonly status: "intercepted"; readonly commandName: string }
  | { readonly status: "empty" };

/**
 * Whether a name is a console command that runs here. A port, since the composer has no command
 * registry handle. The default answers `false`, so an unrecognized `/word` is not
 * intercepted.
 */
export type ConsoleCommandPredicate = (commandName: string) => boolean;
