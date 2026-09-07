// What a surface reads ABOUT one session's projection, rather than out of it.
//
// Split from `hooks.ts`, which had grown past the length `apps/desktop/AGENTS.md`
// allows by holding two jobs. That file resolves stores and selects entities out of
// them — "give me this session's runs", "give me this row" — and every hook in it
// answers with session CONTENT. These four answer with facts about the READ and the
// projection: has a base state landed, has the projection moved, is it known
// incomplete, and what did the newest read say about where the stream picks up. A
// surface reaching for one of these is not asking what the session contains.
//
// The seam is also where the two files' inputs stop agreeing. Everything in `hooks.ts`
// is a store and a selector; the resume reading below takes the REGISTRY as well,
// because the decision is a fact about the read that produced a projection rather than
// a member of the projection, and the registry is what holds it.
//
// Nothing here builds a value in a selector, for the reason `hooks.ts` states in full:
// zustand v5 compares with `Object.is` and does no shallow-equality pass, so a reading
// returns a stored reference or a primitive and derivation happens under `useMemo` in
// the component.

import { useCallback, useSyncExternalStore } from "react";
import { useStore } from "zustand";

import type { SessionStoreRegistry } from "./session-store-registry.js";
import type { SessionStore, SessionStoreState } from "./session-store.js";
import type { TimelineResumeDecision } from "./timeline-resume.js";

/** Whether the store has been initialised, so a surface can tell "not loaded" apart. */
export function useSessionInitialised(store: SessionStore): boolean {
  return useStore(store.readable, readInitialised);
}

function readInitialised(state: SessionStoreState): boolean {
  return state.initialised;
}

/**
 * The store's monotonic transition counter — "the projection moved", and nothing more.
 *
 * For the one consumer that cannot name a partition: a surface which asks other
 * families to REPORT off their own projections during render, and so has no selector
 * to narrow to. The counter says a transition happened without saying which kind moved,
 * which is exactly the claim such a surface needs and the widest one this family
 * offers, so a caller reaching for it is saying it could not be narrower.
 *
 * A number, so `Object.is` still decides the re-render and an unchanged store still
 * costs a pointer comparison.
 */
export function useSessionProjectionRevision(store: SessionStore): number {
  return useStore(store.readable, readRevision);
}

function readRevision(state: SessionStoreState): number {
  return state.revision;
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
 * so a transition between two causes costs no render to a surface that renders
 * neither. A reader that renders the cause itself takes `useSessionStore` with a
 * selector that returns the stored value.
 */
export function useSessionDegraded(store: SessionStore): boolean {
  return useStore(store.readable, readDegraded);
}

function readDegraded(state: SessionStoreState): boolean {
  return state.degradedCause !== undefined;
}

/**
 * What one session's newest completed read said about resuming its stream, or
 * `undefined` before one has landed.
 *
 * SUBSCRIBED THROUGH THE REGISTRY'S OWN SETTLEMENT FAN-OUT, and it has to be. This
 * reading used to subscribe to the store's revision counter on the claim that a
 * completed read writes the decision and calls `initialise` in the same tick — but
 * `initialise` consults `admitsSnapshotAt` and refuses a snapshot behind the store's
 * cursor, which is exactly what the recovering re-read after a refused resume position
 * answers with. The read completes, the decision settles, the revision does not move,
 * and a reading watching the revision alone never learns the refusal happened. So the
 * entry reports its own settlement and this subscribes to that; there is still no
 * interval and no poll anywhere in the path.
 *
 * The registry rather than the store HOLDS the decision because the store is the
 * PROJECTION and this is a fact about the read that produced it — a store that never
 * initialises still has a decision to report, which is precisely the case above.
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
