// The one way a wire read takes its refresh signal from the session stream: watch the store's
// transitions, notice the ones that admitted an event of a set of kinds, and say so once. Only
// the set differs by caller. It lives in the store because no feature imports another, and the
// subject is a `SessionStore` transition.
//
// What arrived is the batch the stream admitted (`lastAdmittedEvents`), not what the transcript
// grew by: a detached tail folds rows the window does not hold. The cursor guard keeps a
// transition that admitted nothing from signaling again. The repair edge signals whatever it
// carried, since the rows a hole lost need not be rows the repaired window holds.

import type { SessionEventType } from "@ai-sidekicks/contracts/event/registry";

import { isRepairEdge } from "#renderer/store/reads/triggers.js";
import type { SessionStore } from "../store.js";

/**
 * Signal on every store transition that admitted an event of one of these kinds, and on every
 * repair, and return the unsubscribe. Keyed on the store's cursor so no event counts twice, and
 * scoped to the kinds so a busy run does not re-read per token. `watchedKinds` is typed as
 * registered event types, so a caller cannot watch a kind the wire never emits.
 */
export function subscribeToSessionEventKinds(
  sessionStore: SessionStore,
  watchedKinds: readonly SessionEventType[],
  onChangeSignal: () => void,
): () => void {
  const watched = new Set<string>(watchedKinds);
  let lastSeenCursor = sessionStore.snapshot().cursor;
  return sessionStore.readable.subscribe((state, previous) => {
    const isRepaired = isRepairEdge(previous.degradedCause, state.degradedCause);
    if (!isRepaired && state.cursor <= lastSeenCursor) {
      return;
    }
    lastSeenCursor = state.cursor;
    if (isRepaired || state.lastAdmittedEvents.some((event) => watched.has(event.kind))) {
      onChangeSignal();
    }
  });
}
