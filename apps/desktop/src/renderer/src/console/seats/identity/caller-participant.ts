// Which participant this window is — the one composition of that question.
//
// WHY THE SEAT AND NOT `store/`. The read is the growth port's
// `callerParticipantRead`, which lives in `bridge/`; `store/session/caller-identity.ts` sits BELOW that
// family on the console's DAG and may not reach up for it, which is why it declares
// `CallerParticipantReader` as an injected function and states that a composition root
// must adapt the port's outcome into that shape. Three composition roots then wrote
// the same adapter, with the same comment, in three sibling view families — and
// sibling families cannot take each other's copy, so the second and third were
// unavoidable where they stood. `seats/` is the lowest family that sits above
// `bridge/`, so it is where the adapter stops being three answers to one question.
//
// AND IN `identity/` RATHER THAN THE FAMILY ROOT. The seam is the subject, not a
// count of what the root will hold: `terminal/lease/`'s
// `viewer-identity.ts` still hand-rolls a holder for this same question and folds in
// here, which is what makes this a directory rather than one file in a new folder.
// It publishes no door of its own — `bridge/readings/index.ts` records the rule, and
// a sub-door exporting what no sibling inside the family takes is a dead export.
//
// ONE NARROWING, EXPORTED. Turning the port's outcome into "the identifier, or the
// refusal that says why not" is a single expression, and it was written out at six
// sites that then disagreed about what to do with the refusing arm: three carried it,
// one absorbed it, one published the whole outcome. Carrying it is what the arms below
// do; absorbing it is a policy a caller states for itself, over this result rather than
// over a second reading of the outcome.

import { useCallback } from "react";

import { type ConsoleBridge } from "../../bridge/index.js";
import { type ConsoleRefusal } from "../../core/index.js";
import {
  useCallerIdentity,
  type CallerIdentityResult,
  type CallerParticipantReader,
  type SessionStore,
} from "../../store/index.js";

/**
 * Names a refusal the caller-identity read itself did not name.
 *
 * One spelling for every reader of this question: the scheduled reading on the
 * notifications page composes its `unreadable` arm under the same origin the seat's
 * own read does, so a refusal surfacing from either says the same word about where it
 * was raised.
 */
export const CALLER_PARTICIPANT_ORIGIN = "caller-participant";

/**
 * What one `callerParticipantRead` answers, named once for every reader of it.
 *
 * Derived off the port rather than restated, on `attention-preference-model.ts`'s rule
 * — which held this declaration before the seat did: the bridge door exports the bridge
 * and not the port's vocabulary, and a hand-written copy of a reply shape is a second
 * declaration nothing checks against the first.
 */
export type CallerParticipantOutcome = Awaited<
  ReturnType<ConsoleBridge["growth"]["callerParticipantRead"]>
>;

/**
 * The served/refused narrowing, written once.
 *
 * A served value answers with the identifier; a refusal IS a `ConsoleRefusal` and
 * travels back untouched, so the reason an identity is unknown survives the adaptation
 * instead of becoming a bare absence. A caller that wants the absence — attribution
 * that is optional on the wire it rides — collapses this result itself and says so
 * where it does it.
 */
export function callerParticipantIdentityFrom(
  outcome: CallerParticipantOutcome,
): string | ConsoleRefusal {
  return outcome.status === "served" ? outcome.value.participantId : outcome;
}

/**
 * Which participant this window is for one session, held against that session's store.
 *
 * The adapter is memoised on the bridge and the SESSION ID rather than on the store
 * that holds it, because the holding hook keys its read on the reader's identity: a
 * fresh function every pass would re-read the identity every pass, and a dependency
 * list naming the store rather than the subject the closure captures reads as a
 * callback that could be rebound without re-reading.
 */
export function useCallerIdentityFor(
  bridge: ConsoleBridge,
  sessionStore: SessionStore,
): CallerIdentityResult {
  const sessionId = sessionStore.sessionId;
  const readCallerParticipant = useCallback<CallerParticipantReader>(
    async () => callerParticipantIdentityFrom(await askCallerParticipant(bridge, { sessionId })),
    [bridge, sessionId],
  );
  return useCallerIdentity(readCallerParticipant, sessionStore);
}

/** The one call, at module scope so every render hands the read the same function. */
function askCallerParticipant(
  bridge: ConsoleBridge,
  request: { readonly sessionId: string },
): Promise<CallerParticipantOutcome> {
  return bridge.growth.callerParticipantRead(request);
}
