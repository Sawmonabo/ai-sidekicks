// Which user this window is — the one composition of that question.
//
// WHY THE SEAT. The read is the growth port's `callerUserRead`, which lives in
// `bridge/`, and three composition roots each wrote the same adapter over it with the
// same comment, in three sibling view families — and sibling families cannot take each
// other's copy, so the second and third were unavoidable where they stood. `seats/` is
// the lowest family that sits above `bridge/`, so it is where the adapter stops being
// three answers to one question.
//
// AND IN `identity/` RATHER THAN THE FAMILY ROOT. The seam is the subject, not a
// count of what the root will hold. It publishes no door of its own —
// `bridge/readings/index.ts` records the rule, and a sub-door exporting what no
// sibling inside the family takes is a dead export.
//
// ONE NARROWING, EXPORTED. Turning the port's outcome into "the identifier, or the
// refusal that says why not" is a single expression, and it was written out at six
// sites that then disagreed about what to do with the refusing arm: three carried it,
// one absorbed it, one published the whole outcome. Carrying it is what the arms below
// do; absorbing it is a policy a caller states for itself, over this result rather than
// over a second reading of the outcome.

import { type ConsoleBridge } from "../../bridge/index.js";
import { type ConsoleRefusal } from "../../core/index.js";

/**
 * Names a refusal the caller-identity read itself did not name.
 *
 * One spelling for every reader of this question: the scheduled reading on the
 * notifications page composes its `unreadable` arm under the same origin the seat's
 * own read does, so a refusal surfacing from either says the same word about where it
 * was raised.
 */
export const CALLER_USER_ORIGIN = "caller-user";

/**
 * What one `callerUserRead` answers, named once for every reader of it.
 *
 * Derived off the port rather than restated, on `attention-preference-model.ts`'s rule
 * — which held this declaration before the seat did: the bridge door exports the bridge
 * and not the port's vocabulary, and a hand-written copy of a reply shape is a second
 * declaration nothing checks against the first.
 */
export type CallerUserOutcome = Awaited<ReturnType<ConsoleBridge["growth"]["callerUserRead"]>>;

/**
 * The served/refused narrowing, written once.
 *
 * A served value answers with the identifier; a refusal IS a `ConsoleRefusal` and
 * travels back untouched, so the reason an identity is unknown survives the adaptation
 * instead of becoming a bare absence. A caller that wants the absence — attribution
 * that is optional on the wire it rides — collapses this result itself and says so
 * where it does it.
 */
export function callerUserIdentityFrom(outcome: CallerUserOutcome): string | ConsoleRefusal {
  return outcome.status === "served" ? outcome.value.userId : outcome;
}
