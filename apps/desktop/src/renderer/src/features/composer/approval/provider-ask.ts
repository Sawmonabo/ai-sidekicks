// Whether one approval arrived as a provider's mid-run permission ask, read off the
// entity the store holds.
//
// THE DISTINCTION IS REGISTERED AND THE READ DOES NOT CARRY IT. The event taxonomy puts
// `askId` on the `approval.requested` payload exactly when the request originates from
// a provider permission ask. `approval.projectionRead` registers no `askId`, so the
// console learns the origin from the EVENT or not at all — which is why this reads the
// projected entity's body rather than the record the pane's own read answered with.
//
// A PURE FUNCTION OVER A BODY, and it lives here rather than in the pane for the
// reason every parse in this family does: a surface that decided for itself what
// counts as an ask would be a second reading of one registered member, and the two
// would drift the first time one of them grew a fallback.

import { readWireString } from "@renderer/lib/wire-strings.js";
import { type ConsoleEntity } from "@renderer/store/session/entities/entities.js";

/** One approval's provider-ask origin. */
export interface ProviderAsk {
  /** The originating `driver_ask` identifier, wire-verbatim. */
  readonly askId: string;
}

/**
 * The provider-ask origin of one approval, or `undefined` where there is none.
 *
 * `undefined` for four different inputs, and they are one answer on purpose: no
 * entity in the partition, an entity with no body, a body with no `askId`, and a
 * body whose `askId` is not a non-empty string all mean the same thing to a caller —
 * this build has not been told the request came from a provider ask, so it renders
 * the ordinary card. Distinguishing them would invite a surface to render a fifth
 * thing for a distinction nobody can act on.
 */
export function providerAskFor(entity: ConsoleEntity | undefined): ProviderAsk | undefined {
  const askId = readWireString(entity?.body?.["askId"]);
  if (askId === undefined) {
    return undefined;
  }
  return { askId };
}
