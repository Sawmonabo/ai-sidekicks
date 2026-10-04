// What Send can resolve to, and the predicate the router takes from its host. Held beside the
// router, not in it, so the controller, the command zone and the Send button read one
// declaration.

import type { InterventionRequestPayload } from "@ai-sidekicks/contracts/run-control";
import type { QueueItemCreateRequest } from "@ai-sidekicks/contracts/run-queue";

import type { Refusal } from "@renderer/lib/refusal.js";
import type { ComposerSendPath } from "../composer-target.js";

/** The new-turn arm: a message addressed to the session. */
export interface ComposerNewTurnResolution {
  readonly outcome: "new-turn";
  readonly request: QueueItemCreateRequest;
}

/** The steer arm: text handed to a run that is already going. */
export interface ComposerSteerResolution {
  readonly outcome: "steer";
  readonly request: InterventionRequestPayload;
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

/** What a message resolves to once no slash rule applies: a wire call, or a refusal. */
export type ComposerMessageResolution =
  | ComposerNewTurnResolution
  | ComposerSteerResolution
  | ComposerRefusedResolution;

/** What Send resolves to: one of the four arms. */
export type ComposerSendResolution = ComposerMessageResolution | ComposerConsoleCommandResolution;

/** What a message dispatch settled as: it reached the wire, or it was refused. */
export type ComposerMessageOutcome =
  | { readonly status: "sent"; readonly path: ComposerSendPath }
  | { readonly status: "refused"; readonly refusal: Refusal };

/** What a send settled as. The composer renders exactly one of these. */
export type ComposerSendOutcome =
  | ComposerMessageOutcome
  | { readonly status: "intercepted"; readonly commandName: string };

/**
 * Whether a name is a console command that runs here. A port, since the composer has no command
 * registry handle. The default answers `false`, so an unrecognized `/word` is not
 * intercepted.
 */
export type ConsoleCommandPredicate = (commandName: string) => boolean;
