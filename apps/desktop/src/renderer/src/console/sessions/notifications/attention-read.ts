// When the attention projection is read, and what makes it be read again.
//
// `attention-projection-read.ts` owns the seam and the boundary narrowing;
// `attention-plane.ts` owns the fold and the reading vocabulary.
// This module owns the one thing those cannot: a lifetime. It performs the read,
// holds its result, and re-reads it when the session projections underneath it move
// — which is what makes the notification center and the all-sessions list report
// what needs a person NOW rather than what needed them when the destination was
// first opened.
//
// THE SIGNAL IS THE SESSION PROJECTION, NOT A TIMER. `Spec-023 §Console Design
// (Meridian)` §The eight rules forbids interval polling outright, and there is no
// `attention.subscribe` to open — the corpus registers a projection READ and no
// stream. What the console already holds is the session stores themselves: an
// attention item is derived from canonical session state, so a session store whose
// state moved is the honest signal that the projection may have moved with it. The
// registry's own open/close emitter carries the other half, because a session that
// has just been opened may already carry attention nobody has read yet. Both halves
// are `store/open-session-signal.ts`'s, hoisted there when the frame's honest chrome
// became the second caller that has to watch every open session at once.
//
// AND EVERY RE-READ GOES THROUGH THE CHOKEPOINT. `PushDrivenRead` is the console's
// one push-driven read discipline — subscribe first, treat the push as opaque,
// coalesce through `store/scheduling.ts`'s `RefreshScheduler`, serialize so no stale
// reply wins, and never return a loaded surface to its loading shape. A second read
// engine written here would be a second answer to all five of those questions; a
// stream of settling events therefore costs one read rather than one read per event.
//
// THE FOUR PHASES ARE THE READ'S OWN, MAPPED ONCE. `PushDrivenRead` reports
// `not-loaded | loaded | failed`, and the projection's "nothing was read" lives
// inside the loaded arm as an absent value — because the reader answers `undefined`
// for a question it could not put. That mapping is written here, in one function, so
// no surface narrows on both vocabularies at once.

import { useCallback, useEffect, useMemo } from "react";

import { useConsoleBridge, useConsoleClock } from "../../bridge/index.js";
import { useSettlementAnnouncement } from "../../primitives/index.js";
import { PushDrivenRead, usePushDrivenRead, type PushDrivenReadState } from "../../seats/index.js";
import { subscribeToOpenSessions, type SessionStoreRegistry } from "../../store/index.js";
import { describeAttentionSettlement } from "./attention-sentences.js";
import { AttentionPlane, type AttentionReading } from "./attention-plane.js";
import {
  narrowAttentionProjection,
  type AttentionProjectionRead,
  type AttentionProjectionReader,
} from "./attention-projection-read.js";

/** The subsystem name a failed attention read names itself with. */
const ATTENTION_READ_ORIGIN = "attention-plane";

/** The read's three states as the plane's four phases. Written once, here. */
function attentionReadingFrom(
  state: PushDrivenReadState<AttentionProjectionRead | undefined>,
): AttentionReading {
  if (state.kind === "not-loaded") {
    return { phase: "reading" };
  }
  if (state.kind === "failed") {
    return { phase: "refused", refusal: state.refusal };
  }
  if (state.value === undefined) {
    return { phase: "not-asked" };
  }
  const narrowed = narrowAttentionProjection(state.value.members);
  return {
    phase: "read",
    plane: new AttentionPlane(narrowed.items),
    droppedCount: narrowed.droppedCount,
    // Carried through untouched: which sessions went unanswered is the reader's
    // fact, and re-deriving it here would be a second authority on coverage.
    refusedSessions: state.value.refusedSessions,
  };
}

/**
 * What this destination holds: the reading, and the way back into a read that refused.
 *
 * A pair rather than a phase on {@link AttentionReading}, because the plane's phases
 * are what the READ settled on and the re-open is what the caller may DO about it —
 * folding the second into the first would make every consumer of a phase carry a
 * control it has no use for.
 */
export interface AttentionProjectionReading {
  readonly reading: AttentionReading;
  /** Re-open or re-read the projection. Offered on the refused phase and nowhere else. */
  readonly retry: () => void;
}

/**
 * Perform the projection read and keep it current.
 *
 * ONE read for the whole destination. The notification center renders it and the
 * all-sessions list takes each row's severity off the same plane, so the two cannot
 * disagree about what needs a person — which two reads, however carefully written,
 * eventually would.
 *
 * The read is CONSTRUCTED in the render body and STARTED in an effect, which is the
 * split `settings/pages/mounts/WorkspaceMountsPage.tsx` already makes: constructing one
 * opens nothing and arms nothing, so a render React discards leaves no subscription
 * behind, and the subscribe-and-read that must not happen during render rides the
 * effect.
 *
 * THE TRANSPORT IT IS SCOPED TO IS THE ONE THE CONSOLE RESOLVED, and it is read here
 * rather than taken as a parameter. This signature used to declare a `bridge` it named
 * nowhere in its body, so the read outlived the transport it was made through and the
 * surface went on reading over a bridge that had been replaced; it happened to be right
 * only because the one caller derives `read` from `bridge.growth`, which makes
 * correctness a property of a memo in a file this module does not own.
 *
 * A CALLER'S PROP IS THE WRONG SUBJECT, measured rather than assumed: the provider
 * publishes a replacement one commit AFTER the prop moves, so a read rebuilt on the
 * prop is constructed in the commit where the window's clock is still the retired one
 * — and `useConsoleClock` forwards to whatever is held when a method RUNS, so that
 * read arms its opening request on a clock nothing will ever advance again. Keyed on
 * the resolution instead, the rebuild and the clock swap are the same commit.
 */
export function useAttentionProjection(
  read: AttentionProjectionReader,
  sessionStoreRegistry: SessionStoreRegistry,
): AttentionProjectionReading {
  // The scenario's frozen clock under the fixture and the real one otherwise, from
  // the window's own clock hook rather than resolved inside the memo below: the live
  // arm of `consoleClockFor` MINTS, and a memo is a hint React may discard, so a pass
  // nothing moved on could rebuild this `dispose()`-bearing read around a new clock.
  const resolvedBridge = useConsoleBridge();
  const clock = useConsoleClock();
  const projectionRead = useMemo(
    () =>
      new PushDrivenRead<AttentionProjectionRead | undefined>({
        clock,
        origin: ATTENTION_READ_ORIGIN,
        read,
        subscribe: (onChangeSignal) =>
          subscribeToOpenSessions(sessionStoreRegistry, onChangeSignal),
      }),
    [clock, read, resolvedBridge, sessionStoreRegistry],
  );
  useEffect(() => {
    projectionRead.start();
    return () => {
      projectionRead.dispose();
    };
  }, [projectionRead]);

  // ONE CALL, because the seam owns the stream-then-read order now: `refresh` takes
  // the subscription first where it is not held and requests the read either way. A
  // branch here would be a second reading of a decision the read already makes, and
  // the branch this replaced could only be right while both halves agreed.
  const retry = useCallback(() => {
    projectionRead.refresh("participant-request");
  }, [projectionRead]);

  const state = usePushDrivenRead(projectionRead);
  const reading = useMemo(() => attentionReadingFrom(state), [state]);
  return useMemo(() => ({ reading, retry }), [reading, retry]);
}

/**
 * Say what this read settled on, through the console's one settlement announcer.
 *
 * COMPOSES A SENTENCE AND GUARDS NOTHING, the shape
 * `agents/definitions/definition-registry-view.ts` states: the repetition rule belongs to
 * `primitives/settlement-announcement.ts` and is keyed on the SENTENCE, which is the
 * only key that is correct here. This read RE-READS — every session store that moves
 * pushes it — so a flag held once for the life of the mount would speak the first
 * settlement and silence every one after it, and the coverage gap that appears on the
 * third re-read would be visible only to people who can see the screen.
 *
 * Keyed on the sentence, a re-read that found the same thing says nothing and a
 * re-read that found something different says it. That places this module under the
 * hook's one obligation — the sentence must carry no figure that moves without the
 * reading moving — which is why it is composed from counts and the port's own words
 * and never from a clock.
 *
 * SEPARATE FROM {@link useAttentionProjection} rather than folded into it, for the
 * same reason that precedent keeps them apart: the read is performed by a destination
 * and the announcement is made by a surface, and a read hook that announced would
 * make every future caller of it — including one that renders nothing — speak.
 */
export function useAttentionSettlementAnnouncement(reading: AttentionReading): void {
  useSettlementAnnouncement(
    reading.phase === "reading" ? undefined : describeAttentionSettlement(reading),
  );
}
