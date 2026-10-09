// The one way a wire read takes its refresh signal from the session stream: watch the store's
// transitions, notice the ones that admitted an event of a set of kinds, and say so once. Only
// the set differs by caller. It lives in the store because no feature imports another, and the
// subject is a `SessionStore` transition.
//
// Cursor bookkeeping is the hazard: comparing against the newly-arrived state rather than the
// last one seen would re-signal on every transition, and dropping the guard on an unmoved cursor
// would re-signal on one that admitted nothing. A repair swaps in a window whose filled holes sit
// below the cursor already seen, so on the swap the rows the window did not hold before are the
// ones counted, whether or not a cause raised during the replay still stands.

import type { SessionEventType } from "@ai-sidekicks/contracts/event/registry";

import { isRepairEdge } from "#renderer/store/reads/triggers.js";
import type { ProjectedSessionEvent } from "../entities/vocabulary.js";
import type { SessionStore } from "../store.js";

/**
 * Signal on every store transition that admitted an event of one of these kinds, and return the
 * unsubscribe. Keyed on the store's cursor so no event counts twice, and scoped to the kinds so
 * a busy run does not re-read per token. `watchedKinds` is typed as registered event types, so
 * a caller cannot watch a kind the wire never emits.
 */
export function subscribeToSessionEventKinds(
  sessionStore: SessionStore,
  watchedKinds: readonly SessionEventType[],
  onChangeSignal: () => void,
): () => void {
  const watched = new Set<string>(watchedKinds);
  let lastSeenCursor = sessionStore.snapshot().cursor;
  return sessionStore.readable.subscribe((state, previous) => {
    const previousCursor = lastSeenCursor;
    let arrived: readonly ProjectedSessionEvent[];
    // A replay that passed the held rows ends replaying; one passed at once never showed it, and
    // only clears the cause.
    const isSwap =
      (previous.isReplaying && !state.isReplaying) ||
      isRepairEdge(previous.degradedCause, state.degradedCause);
    if (isSwap) {
      const heldRows = new Set(previous.transcript);
      arrived = state.transcript.filter((event) => !heldRows.has(event));
    } else if (state.cursor > previousCursor) {
      arrived = state.transcript.filter((event) => event.sequence > previousCursor);
    } else {
      return;
    }
    lastSeenCursor = state.cursor;
    if (arrived.some((event) => watched.has(event.kind))) {
      onChangeSignal();
    }
  });
}
