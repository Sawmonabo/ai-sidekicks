// Why no act on this destination may be put right now — asked at render, and again
// at dispatch.
//
// SPLIT FROM `SessionsSurface.tsx`, which composes the screen. That file said which
// of two standing causes a control carries and how the start act's own cause ranks
// against them; this one owns that ordering, and together they were one file past the
// package's ceiling. The seam is clean because nothing here renders: every rule in it
// is a fold over two facts the store family already publishes, and it can be checked
// without mounting anything.
//
// TWO MOMENTS, ONE ANSWER, AND THAT IS THE WHOLE REASON THIS IS NOT A VALUE. A render
// decides what a control LOOKS like; a press decides whether a call is put. Those are
// different instants, and the block can land between them — a supervisor that stops in
// the frame between the render that enabled Send and the click that reaches its
// handler. A control guarded on the render's snapshot alone is fail-OPEN in exactly
// that gap, so this composes one reading that answers both: `blockedActSentence` for
// the affordance, and `readBlockedActSentence` for the guard, from the same two live
// sources. `onboarding/provider-readiness/provider-readiness.ts`' `recheck` is the
// precedent — the row is disabled from the block and the act re-reads it anyway.
//
// THE SHELL'S CAUSE OUTRANKS THE LIST'S. A window that cannot reach the runtime cannot
// put the act at all; a degraded list is a window that lost the stream and could still
// send. Both are real, one sentence fits on a control, and the stronger fact is the one
// a person needs in order to know what to do next. Neither cause is derived here:
// `store/shell/shell-mutation-block.ts` owns the shell's and `session-list-degradation.ts`
// owns the list's, which is what keeps this destination's disabled controls and the
// palette's read-only line from naming two different reasons for one state.

import { useCallback } from "react";

import {
  currentShellBlock,
  shellMutationBlock,
  useShellState,
  type FrameStore,
  type MutatingDaemonMethod,
  type SessionDegradedCause,
} from "../../store/index.js";
import type { NewSessionBlockedAct } from "../../seats/index.js";
import { sessionListDegradation } from "../session-list-degradation.js";

/**
 * The write every act on this destination reaches first, held to the mutating set.
 *
 * The dispatch guard is method-scoped where the render-time sentence is
 * whole-destination, and the two agree by construction rather than by coincidence:
 * `session.create` is a member of `MUTATING_DAEMON_METHODS`, so `currentShellBlock`
 * on it and `shellMutationBlock` over the same state are the same value. The `satisfies`
 * is what keeps that true — a method dropped from that tuple fails here.
 *
 * The start act mounts the probe, whose first call this is, and the composed draft's
 * send makes it as its own first leg; the join form and the import panel guard their
 * own dispatch sites, where they are performed.
 */
const SESSION_CREATE_METHOD = "session.create" satisfies MutatingDaemonMethod;

/** What this destination needs in order to answer "may an act be put right now". */
export interface SessionActBlockInput {
  readonly frameStore: FrameStore;
  /** The worst degraded cause standing over the open stores, as of this render. */
  readonly degradedCause: SessionDegradedCause | undefined;
  /** The same cause, live — the projection's own reader, held for the dispatch guard. */
  readonly readDegradedCause: () => SessionDegradedCause | undefined;
  /** Why the start act alone is closed, where nothing stronger is. */
  readonly startOutstandingSentence: string | undefined;
}

/** The sentences this destination's controls carry, and the guard behind them. */
export interface SessionActBlock {
  /**
   * Why no act may be put, at render and at dispatch.
   *
   * IN THE SEAT'S OWN SHAPE rather than a second one declared here. The composed-draft
   * control is handed exactly this object, and the three shipped controls beside it
   * read the same two members — so one reading serves every act on the destination and
   * there is no second declaration for a fourth act to be added to.
   */
  readonly act: NewSessionBlockedAct;
  /**
   * Why the START control in particular may not be pressed.
   *
   * The whole-destination sentence is asked first: a window that cannot reach the
   * runtime cannot put the act at all, while an outstanding create is a window that
   * CAN and already has. The join form and the import are not on this rule, because
   * neither is the act that is running.
   */
  readonly startBlockedSentence: string | undefined;
}

/**
 * Fold the two standing causes into the sentences this destination offers.
 *
 * A HOOK rather than a pure function, because half of the reading is a subscription:
 * the shell state moves under the surface and a control disabled from a snapshot
 * nobody re-reads is a control that stays disabled after the runtime comes back.
 */
export function useSessionActBlock(input: SessionActBlockInput): SessionActBlock {
  const { frameStore, degradedCause, readDegradedCause, startOutstandingSentence } = input;
  const shellBlock = shellMutationBlock(useShellState(frameStore));
  const blockedActSentence =
    shellBlock?.detail ?? sessionListDegradation(degradedCause).blockedActSentence;
  const readBlockedActSentence = useCallback(
    () =>
      currentShellBlock(frameStore, SESSION_CREATE_METHOD)?.detail ??
      sessionListDegradation(readDegradedCause()).blockedActSentence,
    [frameStore, readDegradedCause],
  );
  return {
    act: { sentence: blockedActSentence, readSentence: readBlockedActSentence },
    startBlockedSentence: blockedActSentence ?? startOutstandingSentence,
  };
}
