// Which participant this window is — the one composition of that question.
//
// WHY THE SEAT AND NOT `store/`. The read is the growth port's
// `callerParticipantRead`, which lives in `bridge/`; `store/session/caller-membership-role.ts` sits BELOW that
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
// TWO HOOKS BECAUSE THERE ARE TWO QUESTIONS, not because there are two mechanisms.
// A surface that gates a control on the caller's ROLE needs the identity chained to
// the session roster, and that chaining is the store's — it holds the roster and it
// owns the settlement rule that keeps a previous session's identity from being looked
// up in a new session's store. A surface that only needs to know WHICH participant is
// looking needs no roster at all, and handing it the chained hook would subscribe it
// to a partition it never reads. The identity-only arm therefore goes through the
// family's own `growth-read.ts` — the seat that already owns "ask one growth operation
// once per subject and hold the answer against it" — rather than through a second
// holder written here.
//
// ONE NARROWING, EXPORTED. Turning the port's outcome into "the identifier, or the
// refusal that says why not" is a single expression, and it was written out at six
// sites that then disagreed about what to do with the refusing arm: three carried it,
// one absorbed it, one published the whole outcome. Carrying it is what the arms below
// do; absorbing it is a policy a caller states for itself, over this result rather than
// over a second reading of the outcome.

import { useCallback } from "react";

import { membershipRoleOf, type ConsoleBridge, type GrowthReading } from "../../bridge/index.js";
import { type ConsoleRefusal } from "../../core/index.js";
import {
  useCallerMembershipRole,
  type CallerMembershipRoleResult,
  type CallerParticipantReader,
  type SessionStore,
} from "../../store/index.js";
import { useGrowthReadOnMount } from "../read/growth-read.js";

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

/** Which participant this window is, or why that could not be read. */
export type CallerParticipantIdentity =
  | { readonly status: "read"; readonly participantId: string }
  | { readonly status: "refused"; readonly refusal: ConsoleRefusal };

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
 * The one call, at module scope so every render hands the read the same function.
 *
 * `useGrowthReadOnMount` reads it through a ref rather than through its dependency
 * list, so a fresh closure would re-ask nothing — but a stable one states that there
 * is nothing per-render about how this question is asked.
 */
function askCallerParticipant(
  bridge: ConsoleBridge,
  request: { readonly sessionId: string },
): Promise<CallerParticipantOutcome> {
  return bridge.growth.callerParticipantRead(request);
}

/**
 * Which participant this window is, asked once per session and held against it.
 *
 * Three arms and not two: `undefined` is the not-yet-answered absence, which is a
 * different fact from a read that landed and refused. A surface that collapses them
 * renders its fail-closed shape either way and says nothing about which it is in —
 * the distinction is here so a surface that wants to speak can.
 */
export function useCallerParticipantIdentity(
  bridge: ConsoleBridge,
  sessionId: string | undefined,
): CallerParticipantIdentity | undefined {
  return callerParticipantIdentityOf(
    useGrowthReadOnMount({
      bridge,
      subject: sessionId,
      request: sessionId === undefined ? undefined : { sessionId },
      origin: CALLER_PARTICIPANT_ORIGIN,
      ask: askCallerParticipant,
    }),
  );
}

/**
 * This window's own membership role for one session: the identity read, chained.
 *
 * The adapter is memoised on the bridge and the SESSION ID rather than on the store
 * that holds it, because the chaining hook keys its read on the reader's identity: a
 * fresh function every pass would re-read the identity every pass, and a dependency
 * list naming the store rather than the subject the closure captures reads as a
 * callback that could be rebound without re-reading.
 */
export function useCallerMembershipRoleFor(
  bridge: ConsoleBridge,
  sessionStore: SessionStore,
): CallerMembershipRoleResult {
  const sessionId = sessionStore.sessionId;
  const readCallerParticipant = useCallback<CallerParticipantReader>(
    async () => callerParticipantIdentityFrom(await askCallerParticipant(bridge, { sessionId })),
    [bridge, sessionId],
  );
  // The role is read off the store's own roster entry through the bridge's one
  // narrowing read — the store names no wire member, so the reader is injected.
  return useCallerMembershipRole(readCallerParticipant, sessionStore, membershipRoleOf);
}

/** The seat's own read, projected onto the three arms a surface renders from. */
function callerParticipantIdentityOf(
  reading: GrowthReading<CallerParticipantOutcome> | undefined,
): CallerParticipantIdentity | undefined {
  if (reading === undefined) {
    return undefined;
  }
  if (reading.kind === "unreadable") {
    return { status: "refused", refusal: reading.refusal };
  }
  const identity = callerParticipantIdentityFrom(reading.outcome);
  return typeof identity === "string"
    ? { status: "read", participantId: identity }
    : { status: "refused", refusal: identity };
}
