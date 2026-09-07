// The per-device fan-out behind one person's aggregated presence state.
//
// ADDRESSED BY A SUBJECT, AND ASKED ONLY WHEN SOMEBODY ASKS. The roster shows the
// aggregate for everyone; this is the detail behind one row, read when that row is
// opened and never before. Reading it for every row on mount would ask an
// owner/operator-only question about every person in the session in order to render
// something nobody has looked at.
//
// THE REFUSAL IS THE CONTRACT'S OWN, AND IT IS NOT AN ERROR. `Spec-018` makes the
// aggregated summary the UNAUTHORIZED-DEFAULT projection: a caller who may not see
// the fan-out is not told less than the truth, they are told the summary, which is
// exactly what the roster row already shows. So `presence.permission_denied` renders
// as one sentence saying the detail is not this caller's to see, never as a refusal
// card, and never as a reason to disturb the row it opened from.
//
// AND THE AGGREGATE IS CARRIED BUT NOT PREFERRED. The reply states the aggregate it
// fans out from, and the row beside it already has one from `presence.read`. Where
// they disagree the ROW's is kept — this read is the detail behind the summary, not
// a second answer to it.

import type {
  ConsoleBridge,
  GrowthOutcome,
  GrowthPresenceDetail,
  GrowthReading,
} from "../../bridge/index.js";
import type { ConsoleRefusal } from "../../core/index.js";
import { useGrowthReadOnMount } from "../../seats/index.js";

/** Names this read in a refusal the call itself did not name. */
export const PRESENCE_DETAIL_ORIGIN = "presence-detail";

/**
 * The refusal code that means "you get the summary", not "something went wrong".
 *
 * Registered under `Spec-018` and rendered as a sentence rather than as a card. It is
 * compared against the code the daemon sent and never produced: the console does not
 * raise refusals, it recognises them.
 */
export const PRESENCE_PERMISSION_DENIED_CODE = "presence.permission_denied";

/** What one `participantPresenceDetailRead` call answers. */
export type PresenceDetailOutcome = GrowthOutcome<GrowthPresenceDetail>;

/** What an opened row holds for its detail call. */
export type PresenceDetailReading = GrowthReading<PresenceDetailOutcome>;

/**
 * Read one participant's device fan-out, once, and hold it against that participant.
 *
 * The subject names BOTH halves. A detail read is about a participant IN a session,
 * and a subject carrying only the participant would hold an answer from the session
 * being left under a key the arriving session reads as current. `undefined` — no row
 * open, or no session — asks nothing at all.
 */
export function usePresenceDetail(
  bridge: ConsoleBridge,
  sessionId: string | undefined,
  participantId: string | undefined,
): PresenceDetailReading | undefined {
  const request =
    sessionId === undefined || participantId === undefined
      ? undefined
      : { sessionId, participantId };
  return useGrowthReadOnMount({
    bridge,
    subject: request === undefined ? undefined : `${request.sessionId} ${request.participantId}`,
    request,
    origin: PRESENCE_DETAIL_ORIGIN,
    ask: (readBridge, detailRequest) =>
      readBridge.growth.participantPresenceDetailRead(detailRequest),
  });
}

/** The served fan-out, or `undefined` on every arm that is not a served answer. */
export function presenceDetailValue(
  reading: PresenceDetailReading | undefined,
): GrowthPresenceDetail | undefined {
  return reading?.kind === "answered" && reading.outcome.status === "served"
    ? reading.outcome.value
    : undefined;
}

/** Why the fan-out is not here, or `undefined` where it is or is still coming. */
export function presenceDetailRefusal(
  reading: PresenceDetailReading | undefined,
): ConsoleRefusal | undefined {
  if (reading === undefined) {
    return undefined;
  }
  if (reading.kind === "unreadable") {
    return reading.refusal;
  }
  return reading.outcome.status === "served" ? undefined : reading.outcome;
}

/**
 * Whether a refusal is the authorization answer rather than a failure.
 *
 * One predicate rather than a comparison at each render site, because the two
 * renderings are different SHAPES — a sentence and a refusal line — and a surface
 * that spelled the code itself would be the second place this distinction lives.
 */
export function isPresenceDetailUnauthorized(refusal: ConsoleRefusal | undefined): boolean {
  return refusal?.code === PRESENCE_PERMISSION_DENIED_CODE;
}
