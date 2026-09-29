// Which of several refusals a caller hands to the frame as its banner.
//
// `lib/refusal-remedies.ts` records which of three shapes a named code calls for, and
// one of the three is the session screen banner — a refusal that changed what the whole room
// can do. A caller holding several candidates picks one here and hands it over through
// `hooks/useRefusalBannerEscalation.ts`.

import { refusalRemedyFor } from "@renderer/lib/refusal-remedies.js";
import { type Refusal } from "@renderer/lib/refusal.js";

/**
 * The banner-class refusal a caller PREFERS, or nothing where it listed none.
 *
 * FOR THE CALLERS WHOSE REFUSALS ARRIVE AS A COLLECTION rather than one at a time —
 * a reader holding a refusal per resolved request and per revoked rule, or the run
 * controls holding one per dispatch they recorded — so each of them would otherwise
 * write this walk itself, and two copies of "which of these is a banner" is two places for the
 * reading of which refusals span the whole session to drift.
 *
 * ONE SELECTION AND NOT ONE ESCALATION EACH. The frame keys a banner on the refusal's
 * ORIGIN and CODE together, so three independent handovers of one vanished session
 * raise one banner where the three reads happen to agree on an origin and several
 * where they do not — and those reads do not: a call that rejected wears the caller's
 * own origin while one the port refused wears the port's. A session that is
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

/**
 * True where this refusal changes what the whole session can do, so it goes across the
 * frame rather than beside one control.
 */
export function isBannerClass(refusal: Refusal): boolean {
  return refusalRemedyFor(refusal.code)?.rendering === "banner";
}

// ONE SELECTION, AND ITS ORDER MEANS PREFERENCE AND NEVER TIME. A caller's list is
// not newest-last: a `Map` keyed by request id moves a record to its end when the
// record is dropped and re-inserted, so a position says nothing about when.
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
