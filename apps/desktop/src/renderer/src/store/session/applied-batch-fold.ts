// One batch of wire events, folded into the state a store commits. `session-store.ts` owns the
// chokepoint (who may write, the re-entrancy latch, the tripwire, the queue); this is a function
// over a state and a list of rows.
//
// It mutates the collaborators it is handed (the reconciler's cursor, the pre-initialization
// buffer, the hue wheel and the outstanding-ask register), because they are the store's and all
// advance on exactly the rows a batch admits. It never sets the store's own zustand cell: the
// state is answered, so the one writer stays one.

import { AgentHueAllocator } from "@renderer/styles/agent-hue.js";
import { worstDegradedCause } from "../session-degradation.js";
import type { ProjectedSessionEvent } from "./entities/entities.js";
import { EntityProjectionRunner } from "./entities/entity-projection-runner.js";
import { WaitingOnPersonRegister } from "./waiting-on-person/waiting-on-person-register.js";
import { PreInitializationBuffer } from "./pre-initialization-buffer.js";
import {
  SequenceReconciler,
  isReconcilableSequence,
  orderBatchBySequence,
} from "./sequence-reconciler.js";
import { capTimeline, type TimelineRetainedEnd } from "./session-state.js";
import type { SessionStoreState } from "./session-state.js";
import type { ApplyOutcome } from "./apply-outcome.js";

/** Everything one fold advances beside the state it answers with. */
export interface AppliedBatchDependencies {
  readonly sessionId: string;
  readonly reconciler: SequenceReconciler;
  readonly projectionRunner: EntityProjectionRunner;
  readonly preInitializationBuffer: PreInitializationBuffer;
  readonly hueAllocator: AgentHueAllocator;
  /** The ledger of what is still waiting on a person. Advanced by every admitted row. */
  readonly outstandingAsks: WaitingOnPersonRegister;
  readonly timelineCap: number | undefined;
  readonly retainedEnd: TimelineRetainedEnd;
}

/** What one batch did, and the state that records it. */
export interface AppliedBatch {
  readonly outcome: ApplyOutcome;
  /**
   * The state to commit, or `undefined` where nothing about the projection moved. A batch of
   * pure duplicates must not re-render every open view on a free re-delivery.
   */
  readonly nextState: SessionStoreState | undefined;
}

/**
 * Fold one batch against a committed state. The batch is ordered first, because every rule
 * below is about a row's position relative to the cursor.
 */
export function foldAppliedBatch(
  current: SessionStoreState,
  events: readonly ProjectedSessionEvent[],
  collaborators: AppliedBatchDependencies,
): AppliedBatch {
  let admitted = 0;
  let duplicates = 0;
  let buffered = 0;
  let refusedForeignSession = 0;
  let gapDetected = false;
  let droppedBeforeInitialization = 0;
  let refusedDivergedSequence = 0;
  let projectionFailures = 0;

  let partitions = current.partitions;
  let appended: ProjectedSessionEvent[] | undefined;

  for (const event of orderBatchBySequence(events)) {
    if (event.sessionId !== collaborators.sessionId) {
      refusedForeignSession += 1;
      continue;
    }
    if (!isReconcilableSequence(event.sequence)) {
      // Refused before the buffer: no base state makes it applicable, so buffering only defers.
      refusedDivergedSequence += 1;
      continue;
    }
    if (!current.initialized) {
      buffered += 1;
      if (collaborators.preInitializationBuffer.push(event)) {
        droppedBeforeInitialization += 1;
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
    // The register advances on the admitted row, not the timeline it joins: what is outstanding
    // outlives the window, and the cap or the next read can drop this row.
    collaborators.outstandingAsks.admit([event]);
    appended ??= [...current.timeline];
    appended.push(event);
    admitted += 1;
  }

  // The dedupe set answers only for sequences the cursor cannot, so a long session holds a
  // batch's worth of numbers rather than its whole history.
  collaborators.reconciler.releaseSequencesAtOrBelowCursor();

  const outcome: ApplyOutcome = {
    admitted,
    duplicates,
    buffered,
    refusedForeignSession,
    gapDetected,
    droppedBeforeInitialization,
    refusedDivergedSequence,
    projectionFailures,
  };
  if (
    admitted === 0 &&
    !gapDetected &&
    droppedBeforeInitialization === 0 &&
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
      // A drop at the cap is incomplete like a skipped sequence, so it takes the same cause. Its
      // sequences are not recorded here; the drain re-derives them as an ordinary range.
      degradedCause: worstDegradedCause(
        current.degradedCause,
        refusedDivergedSequence > 0 ? "stream-diverged" : undefined,
        gapDetected || droppedBeforeInitialization > 0 ? "sequence-gap" : undefined,
        projectionFailures > 0 ? "projection-failed" : undefined,
      ),
      gaps: collaborators.reconciler.gaps(),
      revision: current.revision + 1,
    },
  };
}
