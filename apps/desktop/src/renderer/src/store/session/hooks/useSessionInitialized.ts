// What a view reads about one session's projection rather than out of it: whether a base state
// landed, whether the projection moved, whether it is known incomplete, and whether a read the
// session's screen depends on failed.
// `useOpenSessionStore.ts` answers with session content.
//
// Like the content hooks, nothing builds a value in a selector (zustand v5 compares with
// `Object.is`), so a reading returns a stored reference or a primitive.

import { useStore } from "zustand";

import type { SessionDegradedCause } from "../degradation.js";
import type { FailedDependentReadsState } from "../failed-dependent-reads.js";
import type { SessionStore, SessionStoreState } from "../session-store.js";

/** Whether the store has been initialized, so a view can tell "not loaded" apart. */
export function useSessionInitialized(store: SessionStore): boolean {
  return useStore(store.readable, readInitialized);
}

/**
 * The store's monotonic transition counter: "the projection moved", and nothing more. For the
 * one consumer that cannot name a partition, a view asking other features to report off their
 * own projections during render. It says a transition happened without saying which kind moved,
 * the widest claim the store offers. A number, so an unchanged store costs a pointer comparison.
 *
 * @consumedBy a view that re-renders whenever the session projection moves
 */
export function useSessionProjectionRevision(store: SessionStore): number {
  return useStore(store.readable, readRevision);
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
 * Whether a read this session's screen depends on beside its own failed its last pass, and
 * has not succeeded since. A good read of the session itself does not clear it.
 */
export function useDependentReadFailed(store: SessionStore): boolean {
  return useStore(store.failedDependentReads.readable, readAnyDependentReadFailed);
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

function readAnyDependentReadFailed(state: FailedDependentReadsState): boolean {
  return state.failedReads.length > 0;
}
