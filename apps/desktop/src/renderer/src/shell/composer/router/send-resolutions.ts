// What Send can resolve to, and the two questions the router asks of its host.
//
// The router produces exactly one of these and four modules consume them: the
// controller that dispatches, the line that renders the path label, the command zone
// that supplies the predicates, and the send bar that renders the settlement. Holding
// the vocabulary beside the router rather than inside it keeps that seam one
// declaration read by both sides, and keeps the router the module that ROUTES.

import type { InterventionRequestPayload, QueueItemCreateRequest } from "@ai-sidekicks/contracts";

import type { ConsoleRefusal } from "../../../console/core/index.js";
import type { ComposerSendPath } from "../chips/chip-models.js";
import type { ProviderCatalogEntry } from "../commands/provider-command-catalog.js";

/** The new-turn arm: a message addressed to a channel. */
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
 * The interception arm: a registered client command.
 *
 * Spec-017's C-18 reserves the slash prefix: a registered command
 * is executed by the client and never composes into a message, a context, or a
 * provider turn on any path. So this arm carries the command's NAME and no request
 * at all: there is nothing for the wire to be handed.
 */
export interface ComposerClientCommandResolution {
  readonly outcome: "client-command";
  readonly commandName: string;
}

export interface ComposerRefusedResolution {
  readonly outcome: "refused";
  readonly refusal: ConsoleRefusal;
}

export type ComposerSendResolution =
  | ComposerNewTurnResolution
  | ComposerSteerResolution
  | ComposerClientCommandResolution
  | ComposerRefusedResolution;

/** What a dispatch settled as. The surface renders exactly one of these. */
export type ComposerSendOutcome =
  | { readonly status: "sent"; readonly path: ComposerSendPath }
  | { readonly status: "intercepted"; readonly commandName: string }
  | { readonly status: "refused"; readonly refusal: ConsoleRefusal };

/**
 * Whether a name is a registered client command.
 *
 * A PORT rather than a registry handle: the composer seat is handed a session
 * store, a bridge, a draft store, a route, and a focused pane, and no command
 * registry — so the router takes the one predicate it needs. The default answers
 * `false` for every name, which means an unrecognised `/word` refuses loudly and
 * names the escape, and no text is ever silently sent as prose.
 */
export type ClientCommandPredicate = (commandName: string) => boolean;

/**
 * What the console knows about a name the bound provider published.
 *
 * Narrowed from the catalog's own entry rather than restated, so the three members
 * the refusal reads can never disagree with the list a person read them off.
 */
export type EnumeratedProviderCommand = Pick<ProviderCatalogEntry, "name" | "kind" | "driverName">;

/**
 * Whether a name is one the addressed agent's provider published, for discovery.
 *
 * A SECOND port beside the client-command predicate and deliberately not a widening
 * of it: the two answers lead to opposite acts. A client command is run; a provider
 * entry is refused by name, because `Spec-023 §Signature Feature Composition
 * Sketches` §The Session Composer makes the enumeration a discovery surface — V1
 * sends exactly one enumerated entry, the compaction command, through its own control
 * and never through a typed line. The default answers `undefined` for every name,
 * which leaves a composer with no enumeration behind it saying exactly what it said
 * before this port existed.
 */
export type ProviderCommandPredicate = (
  commandName: string,
) => EnumeratedProviderCommand | undefined;
