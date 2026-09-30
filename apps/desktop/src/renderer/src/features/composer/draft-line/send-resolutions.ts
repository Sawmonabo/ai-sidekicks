// What Send can resolve to, and the two predicates the router takes from its host. Held beside
// the router, not in it, so the controller, the command zone and the Send button read one
// declaration.

import type { InterventionRequestPayload, QueueItemCreateRequest } from "@ai-sidekicks/contracts";

import type { Refusal } from "@renderer/lib/refusal.js";
import type { ComposerSendPath } from "../composer-target.js";
import type { ProviderCommandEntry } from "../command-list/command-list-entries.js";

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
 * The interception arm: a registered client command. A registered command is executed by the
 * client and never composes into a message on any path, so this arm carries only its name.
 */
export interface ComposerClientCommandResolution {
  readonly outcome: "client-command";
  readonly commandName: string;
}

export interface ComposerRefusedResolution {
  readonly outcome: "refused";
  readonly refusal: Refusal;
}

export type ComposerSendResolution =
  | ComposerNewTurnResolution
  | ComposerSteerResolution
  | ComposerClientCommandResolution
  | ComposerRefusedResolution;

/** What a dispatch settled as. The composer renders exactly one of these. */
export type ComposerSendOutcome =
  | { readonly status: "sent"; readonly path: ComposerSendPath }
  | { readonly status: "intercepted"; readonly commandName: string }
  | { readonly status: "refused"; readonly refusal: Refusal };

/**
 * Whether a name is a registered client command. A port, since the composer has no command
 * registry handle. The default answers `false`, so an unrecognized `/word` is not
 * intercepted.
 */
export type ClientCommandPredicate = (commandName: string) => boolean;

/** What the console knows about a provider-published name, narrowed from the catalog entry. */
export type EnumeratedProviderCommand = Pick<ProviderCommandEntry, "name" | "kind" | "driverName">;

/**
 * Whether a name is one the addressed agent's provider published, for discovery. A second
 * port because the outcome differs: a client command runs, a provider entry is refused by
 * name (only the compaction command has its own control). The default answers `undefined`.
 */
export type ProviderCommandPredicate = (
  commandName: string,
) => EnumeratedProviderCommand | undefined;
