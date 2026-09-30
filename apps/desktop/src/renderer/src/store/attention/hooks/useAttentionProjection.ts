// When the attention projection is read, and what makes it be read again. `attention-summary.ts`
// owns the fold and the reading vocabulary; this module owns the lifetime: it performs the
// read, holds its result, and re-reads it when the session projections underneath it move, so
// the notification center and the all-sessions list report what needs a person now. The call
// that reads the projection is the caller's.
//
// The signal is the session projections, not a timer: interval polling is forbidden. An
// attention item is derived from canonical session state, so a moved session store may have
// moved the projection, and the registry's open/close emitter covers a session just opened
// that already carries unread attention. Both come through `store/session/open-session-signal.ts`.
//
// Every re-read goes through `PushDrivenRead`, the console's one push-driven read discipline
// (subscribe first, treat the push as opaque, coalesce through `RefreshScheduler`, serialize so
// no stale reply wins, never return a loaded view to its loading shape), so a stream of
// settling events costs one read.
//
// `PushDrivenRead` reports `not-loaded | loaded | failed`, and the projection's "nothing was
// read" lives inside the loaded arm as an absent value; that mapping is written once, here.

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
 * What one fan-out over the session-scoped read produced. Coverage is a separate fact from
 * content: the items are what the answering sessions carried and the refusals are the sessions
 * that did not, so a served empty projection beside a refused one cannot render as an
 * all-clear.
 */
export interface AttentionProjectionRead {
  /** Items served, concatenated across the sessions that answered. */
  readonly items: readonly AttentionItem[];
  /** Deliveries the call could not read as items. A fact about the reader. */
  readonly droppedCount: number;
  /** The sessions that refused. Empty when every session that was asked answered. */
  readonly refusedSessions: readonly RefusedAttentionSession[];
  /** Every session this read asked about, the denominator the refusals are over. */
  readonly addressedSessionIds: readonly string[];
}

/** The call that reads the attention projection. */
export type AttentionProjectionReadCall = () => Promise<AttentionProjectionRead>;

/** The subsystem name a failed attention read names itself with. */
const ATTENTION_READ_ORIGIN = "attention-projection";

/**
 * Performs the projection read and keeps it current. One read serves the whole destination, so
 * no two views of it can disagree about what needs a person.
 *
 * The read is constructed in the render body and started in an effect, so a render React
 * discards leaves no subscription behind. The clock is the caller's, so the read is rebuilt in
 * the same commit it is replaced and the store reaches no service.
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

/** The read's states as the attention reading's phases. Written once, here. */
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
    summary: new AttentionSummary(state.value.items),
    droppedCount: state.value.droppedCount,
    // Both halves of coverage are carried through untouched; re-deriving either here would be a
    // second authority on what this read speaks for.
    refusedSessions: state.value.refusedSessions,
    addressedSessionIds: state.value.addressedSessionIds,
  };
}
