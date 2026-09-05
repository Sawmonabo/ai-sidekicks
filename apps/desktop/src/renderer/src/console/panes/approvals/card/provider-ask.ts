// Whether one approval arrived as a provider's mid-run permission ask, read off the
// entity the store holds.
//
// THE DISTINCTION IS REGISTERED AND THE READ DOES NOT CARRY IT. `Spec-006 §Approval
// Flow (approval_flow)` puts `askId` on the `approval.requested` payload exactly when
// the request originates from a provider permission ask, and
// `api-payload-contracts.md §Plan-012` pairs it with `expiryAt` — required whenever
// `askId` is present, enforced at the emission seam, mirrored by the
// ask-implies-deadline CHECK on the durable row. `approval.projectionRead` registers
// neither member, so the console learns the origin from the EVENT or not at all —
// which is why this reads the projected entity's body rather than the record the
// pane's own read answered with.
//
// A PURE FUNCTION OVER A BODY, and it lives here rather than in the pane for the
// reason every parse in this family does: a surface that decided for itself what
// counts as an ask would be a second reading of one registered member, and the two
// would drift the first time one of them grew a fallback.
//
// THE CONTRACT VIOLATION IS REPRESENTED RATHER THAN REPAIRED. A body carrying
// `askId` and no readable `expiryAt` cannot happen against a conformant daemon, and
// it is still a shape this build can be handed. Inventing a deadline for it would
// put a time on screen no daemon sent, and dropping the framing would hide a
// provider ask because one of its two members was missing — so the framing is
// answered with an absent deadline, and the pane counts it beside the records it
// could not read.

import { type ConsoleEntity } from "../../../store/index.js";

/**
 * One approval's provider-ask origin.
 *
 * `expiryAt` is `string | undefined` rather than required because the absence is a
 * state a caller has to render differently, not one it may treat as "no countdown
 * needed": the deadline is required beside `askId` on the wire, so its absence is a
 * defect this surface reports rather than a request without an expiry.
 */
export interface ProviderAsk {
  /** The originating `driver_ask` identifier, wire-verbatim. */
  readonly askId: string;
  /** The shared deadline. Absent only where the body breaks the registered pairing. */
  readonly expiryAt: string | undefined;
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
  const askId = nonEmptyString(entity?.body?.["askId"]);
  if (askId === undefined) {
    return undefined;
  }
  return { askId, expiryAt: nonEmptyString(entity?.body?.["expiryAt"]) };
}

/**
 * How many of these asks reached this build without the deadline the wire requires.
 *
 * Counted rather than each one flagged where it sits, because the pane already has a
 * vocabulary for "the read carried something this build could not use" and states it
 * once above the list. A per-card badge would say the same thing several times and
 * still leave the list's own summary claiming everything in it was whole.
 */
export function countAsksMissingDeadline(asks: Iterable<ProviderAsk | undefined>): number {
  let missing = 0;
  for (const ask of asks) {
    if (ask !== undefined && ask.expiryAt === undefined) {
      missing += 1;
    }
  }
  return missing;
}

/** A wire string, or `undefined` for anything that is not one. */
function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
