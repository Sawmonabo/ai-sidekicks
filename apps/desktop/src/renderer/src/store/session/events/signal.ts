// The one way a wire read takes its refresh signal from the session stream: watch the store's
// transitions, notice the ones that admitted an event of a set of kinds, and say so once. Only
// the set differs by caller. It lives in the store because no feature imports another, and the
// subject is a `SessionStore` transition.
//
// Cursor bookkeeping is the hazard: comparing against the newly-arrived state rather than the
// last one seen would re-signal on every transition, and forgetting the `<=` guard would
// re-signal on one that admitted nothing. A read that resets the store moves its cursor back,
// so the last one seen moves back with it and the rows sent again are counted afresh.

import type { SessionEventType } from "@ai-sidekicks/contracts/event/registry";

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
  return sessionStore.readable.subscribe((state) => {
    const previousCursor = lastSeenCursor;
    if (state.cursor <= previousCursor) {
      lastSeenCursor = state.cursor;
      return;
    }
    lastSeenCursor = state.cursor;
    const admitted = state.transcript.filter((event) => event.sequence > previousCursor);
    if (admitted.some((event) => watched.has(event.kind))) {
      onChangeSignal();
    }
  });
}
