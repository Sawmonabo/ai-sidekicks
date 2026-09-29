// Which of several refusals a surface hands to the frame as its banner.
//
// `lib/refusal-remedies.ts` records which of three shapes a named code calls for, and
// one of the three is the session screen banner — a refusal that changed what the whole room
// can do. A surface holding several candidates picks one here and hands it over through
// `hooks/useRefusalBannerEscalation.ts`.

import { refusalRemedyFor } from "@renderer/lib/refusal-remedies.js";
import { type Refusal } from "@renderer/lib/refusal.js";

/**
 * The banner-class refusal a caller PREFERS, or nothing where it listed none.
 *
 * FOR THE SURFACES WHOSE REFUSALS ARRIVE AS A COLLECTION rather than one at a time —
 * the approvals reader holds a refusal per resolved request and per revoked rule and
 * puts three independent calls on the wire besides, and the run-control surface holds
 * one per run's newest settlement — so each of them would otherwise write this walk
 * itself, and two copies of "which of these is a banner" is two places for rule 9's
 * reading to drift.
 *
 * ONE SELECTION AND NOT ONE ESCALATION EACH. The frame keys a banner on the refusal's
 * ORIGIN and CODE together, so three independent handovers of one vanished session
 * raise one banner where the three reads happen to agree on an origin and several
 * where they do not — and those reads do not: a call that rejected wears the calling
 * surface's own origin while one the port refused wears the port's. A session that is
 * gone is one fact however many reads noticed it, so the caller passes its candidates
 * in the order it wants them preferred and hands over exactly one.
 */
export function preferredBannerClassRefusalAmong(
  candidates: Iterable<Refusal | undefined>,
): Refusal | undefined {
  for (const candidate of candidates) {
    if (candidate !== undefined && isBannerClass(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/** True where rule 9 puts this refusal across the frame rather than in one surface. */
export function isBannerClass(refusal: Refusal): boolean {
  return refusalRemedyFor(refusal.code)?.rendering === "banner";
}

// ONE SELECTION, AND ITS ORDER MEANS PREFERENCE AND NEVER TIME. This module used to
// carry two, separated by a claim about the callers that was false of every one of
// them: that a caller whose members are APPENDED hands them over newest-last, so the
// last banner-class member is the newest thing the daemon said. No caller appends in
// that sense. The approvals pane hands its three concurrent reads over as a literal,
// in the order it wants them preferred. The approvals reader spreads two `Map.values()`
// keyed by approval id and rule id, and those positions do not even hold still: its
// `resolve` drops a record's key at dispatch and `#settleResolve` re-inserts it, so a
// record refused a second time moves to the END of its map rather than staying where
// it was. The run-control surface maps over its run ids in record order and reads each
// run's own newest settlement, so its list is ordered by run and not by time.
//
// Nothing in this console stamps a refusal with a time, so no collection of them
// carries recency at all, and a selection that inferred it would be reading a position
// as a fact about the wire. What one walk rests on instead is the IDENTITY the frame
// dedups on — `useRefusalBannerEscalation` remembers `escalationIdentityOf`, the
// origin, the code, and the daemon's sentence — so candidates naming ONE condition
// raise one banner in whatever order they sit, and where they name different ones the
// caller has already put first the one it wants. A session that is gone is ONE fact
// however many reads noticed it, so the caller lists its candidates in the order it
// wants them preferred and hands over exactly one.
