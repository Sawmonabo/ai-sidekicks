// One batch of wire events, folded into the state a store commits. `store/session/store.ts` owns
// the chokepoint (who may write, the re-entrancy latch, the tripwire, the queue); this is a
// function over a state and a list of rows.
//
// It mutates the dependencies it is handed (the reconciler's cursor, the pre-initialization
// buffer, the hue wheel and the waiting-on-person register), because they are the store's and all
// advance on exactly the rows a batch admits. It never sets the store's own zustand cell: the
// state is answered, so the one writer stays one.

import { AgentHueAllocator } from "#renderer/styles/agent-hue.js";
import { worstDegradedCause } from "../degradation.js";
import type { ProjectedSessionEvent } from "../entities/vocabulary.js";
import { EntityProjectionRunner } from "../entities/projection-runner.js";
import { WaitingOnPersonRegister } from "../waiting-on-person/register.js";
import { PreInitializationBuffer } from "../pre-initialization-buffer.js";
import {
  SequenceReconciler,
  isReconcilableSequence,
  orderBatchBySequence,
} from "../sequence-reconciler.js";
import {
  HEAD_RESUME_POINT,
  capTranscript,
  type RepairResumePoint,
  type TranscriptRetainedEnd,
} from "../state.js";
import type { SessionStoreState } from "../state.js";
import type { SessionPartitions } from "../entities/partitions.js";
import type { ApplyOutcome } from "./outcome.js";

/** Everything one fold advances beside the state it answers with. */
export interface AppliedBatchDependencies {
  readonly sessionId: string;
  readonly reconciler: SequenceReconciler;
  readonly projectionRunner: EntityProjectionRunner;
  readonly preInitializationBuffer: PreInitializationBuffer;
  readonly hueAllocator: AgentHueAllocator;
  /** The register of what is still waiting on a person. Advanced by every admitted row. */
  readonly waitingOnPersonRegister: WaitingOnPersonRegister;
  readonly transcriptCap: number | undefined;
  readonly retainedEnd: TranscriptRetainedEnd;
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
  dependencies: AppliedBatchDependencies,
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
  let repairResumePoint = current.repairResumePoint;
  // Where a repair resumes once a row fault lands on the row in hand, the run standing at
  // `cursorBefore` before it: read off the fold so far, which holds every row before this one.
  const resumePointBefore = (cursorBefore: number): RepairResumePoint =>
    resumePointBeforeFault(repairResumePoint, {
      partitions,
      cursor: cursorBefore,
      newestRow: (appended ?? current.transcript).at(-1),
    });

  for (const event of orderBatchBySequence(events)) {
    if (event.sessionId !== dependencies.sessionId) {
      refusedForeignSession += 1;
      continue;
    }
    if (!isReconcilableSequence(event.sequence)) {
      // Refused before the buffer: no base state makes it applicable, so buffering only defers.
      refusedDivergedSequence += 1;
      if (current.initialized) {
        repairResumePoint = resumePointBefore(dependencies.reconciler.cursor);
      }
      continue;
    }
    if (!current.initialized) {
      buffered += 1;
      if (dependencies.preInitializationBuffer.push(event)) {
        droppedBeforeInitialization += 1;
      }
      continue;
    }

    // Read before the reconciler admits the row, since a checkpoint stands at the row before it.
    const cursorBefore = dependencies.reconciler.cursor;
    const admission = dependencies.reconciler.reconcile(event.sequence);
    if (admission.outcome === "duplicate") {
      duplicates += 1;
      continue;
    }
    if (admission.outcome === "diverged") {
      refusedDivergedSequence += 1;
      repairResumePoint = resumePointBefore(cursorBefore);
      continue;
    }
    if (admission.openedGap !== undefined) {
      gapDetected = true;
      repairResumePoint = resumePointBefore(cursorBefore);
    }

    const projected = dependencies.projectionRunner.run(partitions, event);
    if (projected === undefined) {
      projectionFailures += 1;
      repairResumePoint = resumePointBefore(cursorBefore);
    } else {
      partitions = projected;
    }

    if (event.actorId !== undefined) {
      dependencies.hueAllocator.admit(event.actorId);
    }
    // The register advances on the admitted row, not the transcript it joins: what is outstanding
    // outlives the window, and the cap or the next read can drop this row.
    dependencies.waitingOnPersonRegister.admit([event]);
    appended ??= [...current.transcript];
    appended.push(event);
    admitted += 1;
  }

  // The dedupe set answers only for sequences the cursor cannot, so a long session holds a
  // batch's worth of numbers rather than its whole history.
  dependencies.reconciler.releaseSequencesAtOrBelowCursor();

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
      transcript:
        appended === undefined
          ? current.transcript
          : capTranscript(appended, dependencies.transcriptCap, dependencies.retainedEnd),
      cursor: dependencies.reconciler.cursor,
      // A drop at the cap is incomplete like a skipped sequence, so it takes the same cause. Its
      // sequences are not recorded here; the drain re-derives them as an ordinary range.
      degradedCause: worstDegradedCause(
        current.degradedCause,
        refusedDivergedSequence > 0 ? "sequence-diverged" : undefined,
        gapDetected || droppedBeforeInitialization > 0 ? "sequence-gap" : undefined,
        projectionFailures > 0 ? "projection-failed" : undefined,
      ),
      gaps: dependencies.reconciler.gaps(),
      repairResumePoint,
      revision: current.revision + 1,
    },
  };
}

/** The state folded so far when a row fault lands: the partitions and the newest row before it. */
interface FoldBeforeFault {
  readonly partitions: SessionPartitions;
  readonly cursor: number;
  readonly newestRow: ProjectedSessionEvent | undefined;
}

/**
 * Where a repair resumes once a row fault lands: unchanged when a fault already moved it, a
 * checkpoint at the newest row folded whole before this one, or the head when no row precedes the
 * fault (or a cap cut it), since nothing then names where the stream could reopen.
 */
function resumePointBeforeFault(
  point: RepairResumePoint,
  before: FoldBeforeFault,
): RepairResumePoint {
  if (point.kind !== "whole") {
    return point;
  }
  const { newestRow } = before;
  return newestRow?.sequence === before.cursor
    ? {
        kind: "checkpoint",
        partitions: before.partitions,
        cursor: before.cursor,
        rowCursor: newestRow.cursor,
      }
    : HEAD_RESUME_POINT;
}
