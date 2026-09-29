// The one way a wire read takes its refresh signal from the session stream.
//
// A push-driven read is a read plus a signal, and for every read whose subject
// changes when the session does, that signal is the same act: watch the store's own
// transitions, notice the ones that admitted an event of a set of kinds, and say so
// once. Only the SET differs between callers — the agent roster watches the three
// agent-lifecycle kinds and one run's child links watch the two child-run kinds.
//
// WHY IT LIVES IN THE STORE. No feature imports another, so a helper two features use
// sits in the lowest folder that needs it, which is this one: the subject is a
// `SessionStore` transition and nothing here reaches above it.
//
// CURSOR BOOKKEEPING IS THE HAZARD. A filter that compared against the newly-arrived
// state rather than the last one it saw would re-signal on every transition, and a
// filter that forgot the `<=` guard would re-signal on a transition that admitted
// nothing at all.

import type { SessionEventType } from "@ai-sidekicks/contracts";

import type { SessionStore } from "./session-store.js";

/**
 * Signal on every store transition that admitted an event of one of these kinds.
 *
 * Keyed on the store's own cursor so one event is never counted twice, and scoped to
 * the caller's kinds so a busy run does not re-read on every token. A transition that
 * admitted nothing the caller cares about produces no signal at all — which is what
 * keeps a coalescing window honest rather than permanently full.
 *
 * `watchedKinds` is typed as registered `SessionEventType` members rather than as
 * strings, so a caller cannot watch for a kind the wire never emits and then wonder
 * why its read never refreshes.
 *
 * Returns the unsubscribe the caller's `subscribe` contract owes.
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
      return;
    }
    lastSeenCursor = state.cursor;
    const admitted = state.timeline.filter((event) => event.sequence > previousCursor);
    if (admitted.some((event) => watched.has(event.kind))) {
      onChangeSignal();
    }
  });
}
