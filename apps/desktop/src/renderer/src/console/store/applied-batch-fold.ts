// One batch of wire events, folded into the state a store commits.
//
// SPLIT FROM `session-store.ts`, which owns the chokepoint. That module answers who may
// write and what a re-entrant write costs; this one answers what ONE admitted batch does
// to a state — and together they were one file past the package's ceiling. The seam is
// clean because nothing here is part of the chokepoint: the re-entrancy latch, the
// tripwire, and the queue that drains into it all stay with the class, and this is a
// function over a state and a list of rows.
//
// IT MUTATES THE COLLABORATORS IT IS HANDED, and that is what it is for rather than a
// leak: the reconciler's cursor, the pre-initialisation buffer, the hue wheel, and the
// outstanding-ask register are all the STORE's, they all advance on exactly the rows a
// batch admits, and a fold that copied them would leave four objects to be advanced
// again by whoever committed the state. What it does not touch is the store's own
// zustand cell — the state is ANSWERED and never set, so the one writer stays one.

import { ParticipantHueAllocator } from "../tokens/index.js";
import { worstDegradedCause } from "./degradation.js";
import type { ConsoleSessionEvent } from "./entities.js";
import { EntityProjectionRunner } from "./entity-projection.js";
import { OutstandingAskJournal } from "./outstanding-asks/index.js";
import { PreInitialisationBuffer } from "./pre-initialisation-buffer.js";
import {
  SequenceReconciler,
  isReconcilableSequence,
  orderBatchBySequence,
} from "./sequence-reconciler.js";
import { capTimeline, type TimelineRetainedEnd } from "./session-state.js";
import type { SessionStoreState } from "./session-state.js";
import type { ApplyOutcome } from "./apply-outcome.js";

/** Everything one fold advances beside the state it answers with. */
export interface AppliedBatchCollaborators {
  readonly sessionId: string;
  readonly reconciler: SequenceReconciler;
  readonly projectionRunner: EntityProjectionRunner;
  readonly preInitialisationBuffer: PreInitialisationBuffer;
  readonly hueAllocator: ParticipantHueAllocator;
  /** The ledger of what is still waiting on a person. Advanced by every admitted row. */
  readonly outstandingAsks: OutstandingAskJournal;
  readonly timelineCap: number | undefined;
  readonly retainedEnd: TimelineRetainedEnd;
}

/** What one batch did, and the state that records it. */
export interface AppliedBatch {
  readonly outcome: ApplyOutcome;
  /**
   * The state to commit, or `undefined` where nothing about the projection moved.
   *
   * An absent state is not an empty one: a batch of pure duplicates changes nothing a
   * subscriber could render, and committing a fresh object for it would re-render every
   * open surface on a re-delivery that cost nothing.
   */
  readonly nextState: SessionStoreState | undefined;
}

/**
 * Fold one batch against a committed state.
 *
 * Ordered before anything else is decided, because every rule below is about a row's
 * position relative to the cursor and a batch that arrived out of order would have each
 * of them answered against the wrong neighbour.
 */
export function foldAppliedBatch(
  current: SessionStoreState,
  events: readonly ConsoleSessionEvent[],
  collaborators: AppliedBatchCollaborators,
): AppliedBatch {
  let admitted = 0;
  let duplicates = 0;
  let buffered = 0;
  let refusedForeignSession = 0;
  let gapDetected = false;
  let droppedBeforeInitialisation = 0;
  let refusedDivergedSequence = 0;
  let projectionFailures = 0;

  let partitions = current.partitions;
  let appended: ConsoleSessionEvent[] | undefined;

  for (const event of orderBatchBySequence(events)) {
    if (event.sessionId !== collaborators.sessionId) {
      refusedForeignSession += 1;
      continue;
    }
    if (!isReconcilableSequence(event.sequence)) {
      // Refused BEFORE the buffer: no base state makes such a sequence applicable, so
      // buffering it would only defer the same refusal.
      refusedDivergedSequence += 1;
      continue;
    }
    if (!current.initialised) {
      buffered += 1;
      if (collaborators.preInitialisationBuffer.push(event)) {
        droppedBeforeInitialisation += 1;
      }
      continue;
    }

    const admission = collaborators.reconciler.reconcile(event.sequence);
    if (admission.outcome === "duplicate") {
      duplicates += 1;
      continue;
    }
    if (admission.outcome === "diverged") {
      refusedDivergedSequence += 1;
      continue;
    }
    if (admission.openedGap !== undefined) {
      gapDetected = true;
    }

    const projected = collaborators.projectionRunner.run(partitions, event);
    if (projected === undefined) {
      projectionFailures += 1;
    } else {
      partitions = projected;
    }

    if (event.actorId !== undefined) {
      collaborators.hueAllocator.admit(event.actorId);
    }
    // THE REGISTER ADVANCES ON THE ADMITTED ROW AND NOT ON THE TIMELINE IT JOINS. What
    // is outstanding outlives the window: this row can be pruned by the cap or thrown
    // away wholesale by the next read, and the lifecycle it opened is still open.
    collaborators.outstandingAsks.admit([event]);
    appended ??= [...current.timeline];
    appended.push(event);
    admitted += 1;
  }

  // The dedupe set answers only for sequences the cursor cannot. Released here rather
  // than never, so a session that runs all day holds a batch's worth of numbers instead
  // of its whole history.
  collaborators.reconciler.releaseSequencesAtOrBelowCursor();

  const outcome: ApplyOutcome = {
    admitted,
    duplicates,
    buffered,
    refusedForeignSession,
    gapDetected,
    droppedBeforeInitialisation,
    refusedDivergedSequence,
    projectionFailures,
  };
  if (
    admitted === 0 &&
    !gapDetected &&
    droppedBeforeInitialisation === 0 &&
    refusedDivergedSequence === 0
  ) {
    return { outcome, nextState: undefined };
  }

  return {
    outcome,
    nextState: {
      ...current,
      partitions,
      timeline:
        appended === undefined
          ? current.timeline
          : capTimeline(appended, collaborators.timelineCap, collaborators.retainedEnd),
      cursor: collaborators.reconciler.cursor,
      // A drop at the cap is a known-incomplete projection for the same reason a skipped
      // sequence is, so it takes the same cause. The sequences it cost are deliberately
      // NOT recorded here — the drain re-derives them against the base state as an
      // ordinary range.
      degradedCause: worstDegradedCause(
        current.degradedCause,
        refusedDivergedSequence > 0 ? "stream-diverged" : undefined,
        gapDetected || droppedBeforeInitialisation > 0 ? "sequence-gap" : undefined,
        projectionFailures > 0 ? "projection-failed" : undefined,
      ),
      gaps: collaborators.reconciler.gaps(),
      revision: current.revision + 1,
    },
  };
}
