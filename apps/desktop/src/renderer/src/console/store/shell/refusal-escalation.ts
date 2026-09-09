// When a surface's refusal stops being that surface's business.
//
// `core/refusal-remedies.ts` records which of rule 9's three shapes a named code
// calls for, and one of the three is the workspace banner — a refusal that changed
// what the whole room can do. A pane cannot draw one: the banner spans the frame and
// is held by the frame's store, so what a pane does is HAND it over. That handover is
// this hook, and it lives here because the frame store lives here.
//
// IT ESCALATES ONCE PER CONDITION, not once per render and not once per refusal
// VALUE. A pane whose read refuses on every retry would otherwise re-raise on every
// one, and a banner that keeps reappearing after a person dismisses it is a banner
// they stop reading. Keying the effect on the refusal object was not enough to stop
// that: no producer in this console reuses a refusal across retries — the approvals
// reader mints a fresh one on each failed refresh, including the window-focus ones
// the read triggers arm — so an unchanged condition arrived as a new object and the
// dismissal lasted until the next retry. What is remembered is therefore the
// refusal's CONTENT, and the two arms of that rule are both behaviours a person
// notices: an unchanged condition stays dismissed, and a changed one comes back.
//
// WHAT COUNTS AS THE SAME CONDITION is the whole of what a banner shows plus who
// raised it — the origin, the code, and the daemon's sentence. Not the code alone:
// two sessions' losses under one code carry different sentences, and suppressing the
// second would leave the first one's words on screen for a different failure. And not
// the object, for the reason above.
//
// AND ONLY FOR THE CODES THE TABLE NAMES AS BANNERS. A pane's ordinary refusal is
// the pane's own business and renders where it happened; escalating everything would
// put a read failure in one pane across the whole workspace.

import { useEffect, useRef } from "react";

import { refusalRemedyFor, type ConsoleRefusal } from "../../core/index.js";
import { type FrameStore } from "./frame-store.js";

/** True where rule 9 puts this refusal across the frame rather than in one surface. */
function isBannerClass(refusal: ConsoleRefusal): boolean {
  return refusalRemedyFor(refusal.code)?.rendering === "banner";
}

/**
 * What makes two refusals the same condition, as one comparable value.
 *
 * The three fields a banner is built from, joined by a separator no wire string
 * carries, so a code ending where a detail begins cannot collide with its neighbour.
 */
function escalationIdentityOf(refusal: ConsoleRefusal): string {
  return `${refusal.origin}\u0000${refusal.code}\u0000${refusal.detail}`;
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
  candidates: Iterable<ConsoleRefusal | undefined>,
): ConsoleRefusal | undefined {
  for (const candidate of candidates) {
    if (candidate !== undefined && isBannerClass(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/** Hand a whole-workspace refusal to the frame, and leave every other one alone. */
export function useRefusalBannerEscalation(
  frameStore: FrameStore,
  refusal: ConsoleRefusal | undefined,
): void {
  // What this mount has already handed over, and to which store. Held rather than
  // derived because the question is about the PAST — a condition already raised — and
  // the frame's banner stack is not the answer to it: a dismissed banner is gone from
  // there, which is exactly the state this must not re-raise into.
  const handedOver = useRef<{ frameStore: FrameStore; identity: string } | undefined>(undefined);
  useEffect(() => {
    if (refusal === undefined || !isBannerClass(refusal)) {
      return;
    }
    const identity = escalationIdentityOf(refusal);
    const previous = handedOver.current;
    if (previous?.frameStore === frameStore && previous.identity === identity) {
      return;
    }
    handedOver.current = { frameStore, identity };
    frameStore.raiseRefusalBanner(refusal);
  }, [frameStore, refusal]);
}
