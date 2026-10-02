// What a view reads about one session's projection rather than out of it: whether a base state
// landed, whether it is known incomplete, and what the newest read said about where the stream
// picks up. `useOpenSessionStore.ts` answers with session content.
// The resume reading here also takes the registry, because the decision is a fact about the read
// that produced a projection, and the registry holds it.
//
// Like the content hooks, nothing builds a value in a selector (zustand v5 compares with
// `Object.is`), so a reading returns a stored reference or a primitive.

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
 * Whether this session's projection is known-incomplete: the store's sticky flag, subscribed
 * rather than sampled. Sampling `snapshot().degradedCause` in a render body has no subscription
 * behind it, so a section would keep a stale warning, or miss one, until an unrelated re-render.
 * A boolean, so a change between two causes re-renders nothing that renders neither. A reader
 * that renders the cause takes `useSessionDegradedCause`.
 */
export function useSessionDegraded(store: SessionStore): boolean {
  return useStore(store.readable, readDegraded);
}

/**
 * Why the projection is known-incomplete, or `undefined` while it is whole. A shared hook so no
 * view writes a selector that builds a value. A section renders "unavailable" from this rather
 * than a zero, separating an answered empty read from one that never landed.
 */
export function useSessionDegradedCause(store: SessionStore): SessionDegradedCause | undefined {
  return useStore(store.readable, readDegradedCause);
}

/**
 * What one session's newest completed read said about resuming its stream, or `undefined`
 * before one has landed.
 *
 * Subscribed through the registry's settlement fan-out because the store's revision is not
 * enough: `initialize` refuses a snapshot behind the store's cursor, which is what the
 * recovering re-read after a refused resume position answers with, so the decision settles
 * while the revision does not move. The registry holds the decision, not the store, because it
 * is a fact about the read and a store that never initializes still has one to report.
 */
export function useTimelineResume(
  registry: SessionStoreRegistry,
  sessionId: string,
): TimelineResumeDecision | undefined {
  // Bound to the registry alone: the fan-out is registry-wide and the snapshot answers the id.
  const subscribe = useCallback(
    (onChange: () => void) => registry.subscribeToTimelineResume(onChange),
    [registry],
  );
  const readDecision = useCallback(
    () => registry.timelineResumeFor(sessionId),
    [registry, sessionId],
  );
  // The same reader on both sides: the console renders no server pass.
  return useSyncExternalStore(subscribe, readDecision, readDecision);
}

function readInitialized(state: SessionStoreState): boolean {
  return state.initialized;
}

function readDegraded(state: SessionStoreState): boolean {
  return state.degradedCause !== undefined;
}

function readDegradedCause(state: SessionStoreState): SessionDegradedCause | undefined {
  return state.degradedCause;
}
