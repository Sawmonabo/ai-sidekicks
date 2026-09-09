// The one way a wire read takes its refresh signal from the session stream.
//
// A push-driven read is a read plus a signal, and for every read whose subject
// changes when the session does, that signal is the same act: watch the store's own
// transitions, notice the ones that admitted an event of a set of kinds, and say so
// once. Only the SET differs between callers — the agent roster watches the three
// agent-lifecycle kinds, one run's child links watch the two child-run kinds, and
// the channel directory watches the four channel-lifecycle kinds.
//
// WHY IT LIVES IN THE STORE FAMILY. It was written twice, once inside `agents/` and
// once inside `collaboration/`, and view families are siblings that may not import
// each other — so the second copy was not laziness, it was the only place the second
// caller could put one. `apps/desktop/AGENTS.md` hoists a helper on its second use
// and puts a cross-family one in the lowest family that needs it, which is this one:
// the subject is a `SessionStore` transition and nothing here reaches above it.
//
// THE DRIFT THIS CLOSES IS SPECIFIC. Both copies were cursor-keyed, and cursor
// bookkeeping is where this is easy to get wrong — a filter that compared against
// the newly-arrived state rather than the last one it saw would re-signal on every
// transition, and a filter that forgot the `<=` guard would re-signal on a
// transition that admitted nothing at all. Two copies of that agree until one is
// fixed.

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
