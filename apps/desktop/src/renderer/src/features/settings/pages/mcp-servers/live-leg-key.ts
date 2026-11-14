// The identity one live leg is keyed by (its session and the binding that session holds open),
// encoded once for both lists that render a leg.
//
// The identity is the pair, never the binding handle: one configuration backs many sessions, so
// two legs can carry one `bindingId` and a list keyed on it alone reuses the wrong row. The pair
// goes through the tuple encoder because both members are wire strings that may contain any
// separator.

import { structuralKey } from "#renderer/lib/structural-key.js";

/**
 * The two members that identify one live leg.
 *
 * Structural, since a leg status and a live application result are different values about the
 * same leg and this needs only the pair.
 */
export interface McpLiveLegIdentity {
  readonly sessionId: string;
  readonly bindingId: string;
}

/** The string one live leg is keyed by. */
export function mcpLiveLegKeyOf(leg: McpLiveLegIdentity): string {
  return structuralKey([leg.sessionId, leg.bindingId]);
}
