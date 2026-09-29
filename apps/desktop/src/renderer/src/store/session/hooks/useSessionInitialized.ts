// What a view reads ABOUT one session's projection, rather than out of it.
//
// `useOpenSessionStore.ts` resolves stores and selects entities out of them — "give me
// this session's runs", "give me this row" — and every hook in it answers with session
// CONTENT. These answer with facts about the READ and the projection: has a base state
// landed, has the projection moved, is it known incomplete, and what did the newest
// read say about where the stream picks up. A view reaching for one of these is not
// asking what the session contains.
//
// The two files' inputs differ too. Everything in `useOpenSessionStore.ts` is a store
// and a selector; the resume reading below takes the REGISTRY as well, because the
// decision is a fact about the read that produced a projection rather than a member of
// the projection, and the registry is what holds it.
//
// Nothing here builds a value in a selector, for the reason `useOpenSessionStore.ts`
// states in full: zustand v5 compares with `Object.is` and does no shallow-equality
// pass, so a reading returns a stored reference or a primitive and derivation happens
// under `useMemo` in the component.

import { useCallback, useSyncExternalStore } from "react";
import { useStore } from "zustand";

import type { SessionStoreRegistry } from "../session-store-registry.js";
import type { SessionDegradedCause } from "../../session-degradation.js";
import type { SessionStore, SessionStoreState } from "../session-store.js";
import type { TimelineResumeDecision } from "../timeline-resume.js";

/** Whether the store has been initialized, so a view can tell "not loaded" apart. */
export function useSessionInitialized(store: SessionStore): boolean {
  return useStore(store.readable, readInitialized);
}

/**
 * The store's monotonic transition counter — "the projection moved", and nothing more.
 *
 * For the one consumer that cannot name a partition: a view which asks other
 * features to REPORT off their own projections during render, and so has no selector
 * to narrow to. The counter says a transition happened without saying which kind moved,
 * which is exactly the claim such a view needs and the widest one the store offers, so
 * a caller reaching for it is saying it could not be narrower.
 *
 * A number, so `Object.is` still decides the re-render and an unchanged store still
 * costs a pointer comparison.
 *
 * @consumedBy a view that re-renders whenever the session projection moves
 */
export function useSessionProjectionRevision(store: SessionStore): number {
  return useStore(store.readable, readRevision);
}

/**
 * Whether this session's projection is known-incomplete — the store's own sticky
 * flag, SUBSCRIBED rather than sampled.
 *
 * Two sidebar sections read this fact beside a read of their own and each of them
 * sampled `snapshot().degradedCause` in its render body, which is a read with no
 * subscription behind it: a store entering or leaving its degraded state without
 * that section's read settling — a sequence gap in an unrelated partition, a closed
 * subscription — moved the flag and re-rendered nothing, so the warning stayed
 * absent, or stayed on screen after a re-pull had cleared it.
 *
 * A boolean rather than the cause, because both readers ask only whether one is
 * standing, and a primitive is compared by value under zustand v5's `Object.is` —
 * so a transition between two causes costs no render to a view that renders
 * neither. A reader that renders the cause itself takes `useSessionStore` with a
 * selector that returns the stored value.
 *
 * @consumedBy a view that says when the session projection is incomplete
 */
export function useSessionDegraded(store: SessionStore): boolean {
  return useStore(store.readable, readDegraded);
}

/**
 * Why the projection is known-incomplete, or `undefined` while it is whole.
 *
 * A hook of its own rather than a `useSessionStore` call in each view, for the reason
 * `useOpenSessionStore.ts` states in full: the selector has to return a stored reference,
 * and one written per view is one more chance to build a value and re-render every
 * frame. A sidebar section renders "unavailable" from this rather than rendering a
 * zero, which is the distinction the design language draws between an answered empty
 * read and a read that never landed.
 *
 * The same subscription {@link useSessionDegraded} makes, narrowed one step less: a
 * reader that renders the cause takes this, and one that only asks whether a cause is
 * standing takes the boolean and pays no render when one cause becomes another.
 */
export function useSessionDegradedCause(store: SessionStore): SessionDegradedCause | undefined {
  return useStore(store.readable, readDegradedCause);
}

/**
 * What one session's newest completed read said about resuming its stream, or
 * `undefined` before one has landed.
 *
 * SUBSCRIBED THROUGH THE REGISTRY'S OWN SETTLEMENT FAN-OUT, and it has to be. The
 * store's revision counter is not enough, even though a completed read writes the
 * decision and calls `initialize` in the same tick:
 * `initialize` consults `admitsSnapshotAt` and refuses a snapshot behind the store's
 * cursor, which is exactly what the recovering re-read after a refused resume position
 * answers with. The read completes, the decision settles, the revision does not move,
 * and a reading watching the revision alone never learns the refusal happened. So the
 * entry reports its own settlement and this subscribes to that; there is still no
 * interval and no poll anywhere in the path.
 *
 * The registry rather than the store HOLDS the decision because the store is the
 * PROJECTION and this is a fact about the read that produced it — a store that never
 * initializes still has a decision to report, which is precisely the case above.
 */
export function useTimelineResume(
  registry: SessionStoreRegistry,
  sessionId: string,
): TimelineResumeDecision | undefined {
  // Bound to the registry alone: the fan-out is registry-wide, and a subscription
  // rebuilt whenever the session id changed would tear down and re-take one
  // subscription for a reader that answers the id question in its snapshot instead.
  const subscribe = useCallback(
    (onChange: () => void) => registry.subscribeToTimelineResume(onChange),
    [registry],
  );
  const readDecision = useCallback(
    () => registry.timelineResumeFor(sessionId),
    [registry, sessionId],
  );
  // The same reader on both sides: this console renders no server pass, and a second
  // reader for one would be a second answer to the question the first one answers.
  return useSyncExternalStore(subscribe, readDecision, readDecision);
}

function readInitialized(state: SessionStoreState): boolean {
  return state.initialized;
}

function readRevision(state: SessionStoreState): number {
  return state.revision;
}

function readDegraded(state: SessionStoreState): boolean {
  return state.degradedCause !== undefined;
}

function readDegradedCause(state: SessionStoreState): SessionDegradedCause | undefined {
  return state.degradedCause;
}
