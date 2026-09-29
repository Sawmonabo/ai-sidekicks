// When the attention projection is read, and what makes it be read again.
//
// `attention-plane.ts` owns the fold and the reading vocabulary. This module owns the
// one thing that cannot: a lifetime. It performs the read, holds its result, and
// re-reads it when the session projections underneath it move — which is what makes
// the notification center and the all-sessions list report what needs a person NOW
// rather than what needed them when the destination was first opened.
//
// The call that reads the projection is the caller's, taken as an argument, so this
// module keeps only its own logic.
//
// THE SIGNAL IS THE SESSION PROJECTIONS, NOT A TIMER.
// Interval polling is forbidden outright, so what re-reads this projection is a
// subscription over the session stores this window has open. An attention item is
// derived from canonical session state, so a session store whose state moved is the
// honest signal that the projection may have moved with it, and the registry's own
// open/close emitter carries the rest, because a session that has just been opened
// may already carry attention nobody has read yet. Both come through
// `store/session/open-session-signal.ts`.
//
// AND EVERY RE-READ GOES THROUGH THE CHOKEPOINT. `PushDrivenRead` is the console's
// one push-driven read discipline — subscribe first, treat the push as opaque,
// coalesce through `lib/reads/refresh-scheduler.ts`'s `RefreshScheduler`, serialize so no stale
// reply wins, and never return a loaded surface to its loading shape. A second read
// engine written here would be a second answer to all five of those questions; a
// stream of settling events therefore costs one read rather than one read per event.
//
// THE FOUR PHASES ARE THE READ'S OWN, MAPPED ONCE. `PushDrivenRead` reports
// `not-loaded | loaded | failed`, and the projection's "nothing was read" lives
// inside the loaded arm as an absent value — because the reader answers `undefined`
// for a question it could not put. That mapping is written here, in one function, so
// no surface narrows on both vocabularies at once.

import { useEffect, useMemo } from "react";

import { type Clock } from "@renderer/lib/clock.js";
import { RefusalError } from "@renderer/lib/refusal.js";
import { type AttentionItem } from "@ai-sidekicks/contracts";
import { PushDrivenRead, type PushDrivenReadState } from "../../reads/push-driven-read.js";
import { usePushDrivenRead } from "../../reads/hooks/usePushDrivenRead.js";
import { subscribeToOpenSessions } from "../../session/open-session-signal.js";
import { type SessionStoreRegistry } from "../../session/session-store-registry.js";
import {
  AttentionSummary,
  type AttentionReading,
  type RefusedAttentionSession,
} from "../attention-summary.js";

/**
 * What one fan-out over the session-scoped read produced.
 *
 * TWO HALVES, BECAUSE COVERAGE IS A SEPARATE FACT FROM CONTENT. The items are what the
 * sessions that answered carried; the refusals are the sessions that did not. A
 * reading that carried only the first would let a served empty projection beside a
 * refused one render as an all-clear.
 */
export interface AttentionProjectionRead {
  /** Items served, concatenated across the sessions that answered. */
  readonly items: readonly AttentionItem[];
  /** Deliveries the call could not read as items. A fact about the reader. */
  readonly droppedCount: number;
  /** The sessions that refused. Empty when every session that was asked answered. */
  readonly refusedSessions: readonly RefusedAttentionSession[];
  /** Every session this read ASKED about — the denominator the refusals are over. */
  readonly addressedSessionIds: readonly string[];
}

/** The call that reads the attention projection. */
export type AttentionProjectionReadCall = () => Promise<AttentionProjectionRead>;

/** The subsystem name a failed attention read names itself with. */
const ATTENTION_READ_ORIGIN = "attention-plane";

/**
 * Perform the projection read and keep it current.
 *
 * ONE read for the whole destination. The notification center renders it and the
 * all-sessions list takes each row's severity off the same plane, so the two cannot
 * disagree about what needs a person — which two reads, however carefully written,
 * eventually would.
 *
 * The read is CONSTRUCTED in the render body and STARTED in an effect: constructing one
 * opens nothing and arms nothing, so a render React discards leaves no subscription
 * behind, and the subscribe-and-read that must not happen during render rides the
 * effect.
 *
 * The clock is the caller's, handed down by the window's composition, so the read is
 * rebuilt in the same commit it is replaced and the store reaches no service.
 */
export function useAttentionProjection(
  read: AttentionProjectionReadCall,
  sessionStoreRegistry: SessionStoreRegistry,
  clock: Clock,
): AttentionReading {
  const projectionRead = useMemo(
    () =>
      new PushDrivenRead<AttentionProjectionRead>({
        clock,
        origin: ATTENTION_READ_ORIGIN,
        read,
        subscribe: (onChangeSignal) =>
          subscribeToOpenSessions(sessionStoreRegistry, onChangeSignal),
      }),
    [clock, read, sessionStoreRegistry],
  );
  useEffect(() => {
    projectionRead.start();
    return () => {
      projectionRead.dispose();
    };
  }, [projectionRead]);

  const state = usePushDrivenRead(projectionRead);
  return useMemo(() => attentionReadingFrom(state), [state]);
}

/** The read's states as the plane's phases. Written once, here. */
function attentionReadingFrom(
  state: PushDrivenReadState<AttentionProjectionRead>,
): AttentionReading {
  if (state.kind === "not-loaded") {
    return { phase: "reading" };
  }
  if (state.kind === "failed") {
    throw new RefusalError(state.refusal);
  }
  return {
    phase: "read",
    plane: new AttentionSummary(state.value.items),
    droppedCount: state.value.droppedCount,
    // Both halves of coverage carried through untouched: which sessions were asked
    // and which of them went unanswered are the reader's facts, and re-deriving
    // either here would be a second authority on what this read speaks for.
    refusedSessions: state.value.refusedSessions,
    addressedSessionIds: state.value.addressedSessionIds,
  };
}
