// One batch of wire events, folded into the state a store commits. `store/session/store.ts` owns
// the chokepoint (who may write, the re-entrancy latch, the tripwire, the queue); this is a
// function over a state and a list of rows.
//
// It mutates the dependencies it is handed (the reconciler's cursor, the pre-initialization
// buffer, the hue wheel and the waiting-on-person register), because they are the store's and all
// advance on exactly the rows a batch admits. It never sets the store's own zustand cell: the
// state is answered, so the one writer stays one.
//
// The reconciler keeps the stream's contiguity and the transcript only the window's span: every
// admitted row folds into the entities, the register and the standing events, and joins the
// transcript only while the tail is live and the window holds every row the stream admitted before
// it. A tail that went live again behind the stream reopens the stream after its newest row, so the
// stream sends again rows it already folded; those join the transcript, in order, and fold nowhere
// else, and the rows past them join once the window has caught up.
//
// A row fault (a hole, a refused sequence, a projector that threw) records where a repair can take
// the stream up again: the newest row folded whole before it, with the partitions as they stood
// there. An admitted rollback marks the held rows it supersedes.

import type { EventCursor } from "@ai-sidekicks/contracts/session/event-cursor";

import { AgentHueAllocator } from "#renderer/styles/agent-hue.js";
import { worstDegradedCause } from "../degradation.js";
import type { ProjectedSessionEvent } from "../entities/vocabulary.js";
import type { SessionPartitions } from "../entities/partitions.js";
import { EntityProjectionRunner } from "../entities/projection-runner.js";
import { markSupersededByRollback } from "../events/run/superseded.js";
import { WaitingOnPersonRegister } from "../waiting-on-person/register.js";
import { PreInitializationBuffer } from "../pre-initialization-buffer.js";
import { mergeStandingEvents } from "../standing-events.js";
import {
  SequenceReconciler,
  isReconcilableSequence,
  orderBatchBySequence,
} from "../sequence-reconciler.js";
import {
  HEAD_RESUME_POINT,
  heldRowCursor,
  liveTailAfter,
  type RepairResumePoint,
  type SessionStoreState,
} from "../state.js";
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
  let streamAfterCursor = current.streamAfterCursor;
  let repairResumePoint = current.repairResumePoint;
  // Copied on the first change, so a batch that changes no row keeps the transcript's identity.
  let held: ProjectedSessionEvent[] | undefined;
  let hasAppended = false;
  const admittedEvents: ProjectedSessionEvent[] = [];
  const isTailLive = current.transcriptTail.following === "live";
  // The newest row the window holds as the fold stands, which a row must lie past to join it.
  const newestHeldSequence = (): number | undefined =>
    (held ?? current.transcript).at(-1)?.sequence;
  const appendToTranscript = (event: ProjectedSessionEvent): void => {
    held ??= [...current.transcript];
    held.push(event);
    hasAppended = true;
  };
  // Where a repair resumes once a row fault lands on the row in hand: the run as it stood at
  // `cursorBefore`, read off the fold so far, which holds every row before this one.
  const resumePointBefore = (cursorBefore: number): RepairResumePoint =>
    resumePointBeforeFault(repairResumePoint, partitions, cursorBefore, streamAfterCursor);

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

    // Read before the reconciler admits the row: the window has caught up with the stream when it
    // holds the row the stream stood at.
    const cursorBefore = dependencies.reconciler.cursor;
    const admission = dependencies.reconciler.reconcile(event.sequence);
    if (admission.outcome === "duplicate") {
      duplicates += 1;
      // A row the stream sends again after the tail rejoined it: already folded, not yet held.
      const newestHeld = newestHeldSequence();
      if (isTailLive && newestHeld !== undefined && event.sequence > newestHeld) {
        appendToTranscript(event);
      }
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
    streamAfterCursor = heldRowCursor(event);

    if (event.actorId !== undefined) {
      dependencies.hueAllocator.admit(event.actorId);
    }
    // The register advances on the admitted row, not the transcript it joins: what is outstanding
    // outlives the window, and a release or the next read can drop this row.
    dependencies.waitingOnPersonRegister.admit([event]);
    const newestHeld = newestHeldSequence();
    if (
      isTailLive &&
      (newestHeld === undefined || (newestHeld >= cursorBefore && event.sequence > newestHeld))
    ) {
      appendToTranscript(event);
    }
    const source = held ?? current.transcript;
    const marked = markSupersededByRollback(source, event);
    if (marked !== source) {
      held = [...marked];
    }
    admittedEvents.push(event);
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
    held === undefined &&
    droppedBeforeInitialization === 0 &&
    refusedDivergedSequence === 0
  ) {
    return { outcome, nextState: undefined };
  }

  const transcript = held ?? current.transcript;
  return {
    outcome,
    nextState: {
      ...current,
      partitions,
      transcript,
      transcriptTail: hasAppended ? liveTailAfter(transcript) : current.transcriptTail,
      lastAdmittedEvents: admittedEvents,
      // Like the register, from the admitted rows, not the transcript they may not join.
      standingEvents: mergeStandingEvents(current.standingEvents, admittedEvents),
      cursor: dependencies.reconciler.cursor,
      streamAfterCursor,
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

/**
 * Where a repair resumes once a row fault lands: unchanged when a fault already moved it, a
 * checkpoint at the newest row folded whole before this one, or the head when no row precedes the
 * fault, since nothing then names where the stream could reopen.
 */
function resumePointBeforeFault(
  point: RepairResumePoint,
  partitions: SessionPartitions,
  cursorBefore: number,
  rowCursorBefore: EventCursor | undefined,
): RepairResumePoint {
  if (point.kind !== "whole") {
    return point;
  }
  return rowCursorBefore === undefined
    ? HEAD_RESUME_POINT
    : { kind: "checkpoint", partitions, cursor: cursorBefore, rowCursor: rowCursorBefore };
}
