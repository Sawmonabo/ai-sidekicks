// What Send can resolve to, and the predicate the router takes from its host. Held beside the
// router, not in it, so the controller, the command zone and the Send button read one
// declaration.

import type { InterventionRequestPayload, QueueItemCreateRequest } from "@ai-sidekicks/contracts";

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
 * The interception arm: a registered console command. A registered command is executed by the
 * client and never composes into a message on any path, so this arm carries only its name.
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

/** What Send resolves to: one of the four arms. */
export type ComposerSendResolution =
  | ComposerNewTurnResolution
  | ComposerSteerResolution
  | ComposerConsoleCommandResolution
  | ComposerRefusedResolution;

/** What a dispatch settled as. The composer renders exactly one of these. */
export type ComposerSendOutcome =
  | { readonly status: "sent"; readonly path: ComposerSendPath }
  | { readonly status: "intercepted"; readonly commandName: string }
  | { readonly status: "refused"; readonly refusal: Refusal };

/**
 * Whether a name is a registered console command. A port, since the composer has no command
 * registry handle. The default answers `false`, so an unrecognized `/word` is not
 * intercepted.
 */
export type ConsoleCommandPredicate = (commandName: string) => boolean;
