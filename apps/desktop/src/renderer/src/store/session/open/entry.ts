// One open session: the store, and the two schedulers bound to its life. Split from
// `store/session/registry.ts`, which owns the set of open sessions.
//
// An entry owns the `SessionStore`, the `ApplyQueue` in front of its chokepoint and the
// `RefreshScheduler` behind its re-pull, created and disposed together so neither outlives the
// store. One owner also closes the repair loop: the drain reads each `ApplyOutcome` and asks this
// session's scheduler for a re-pull when a hole opened, so a quiet session still repairs itself.
//
// The resume rule lands here too. `transcript-resume.ts` decides `acknowledged ?? earliest`; this
// entry submits that position as the third argument of `SessionBaseStateReader` on the read that
// already happens, since a separate resume read would be a second writer of the base state racing
// the scheduler. A read resumed from `earliest` opens a window with nothing before it, so only an
// acknowledged position becomes the window's head.
//
// A refused position degrades honestly. When the daemon answers `event.cursor_unresolvable` the
// entry forgets the position, re-reads with no cursor through the same reader, and records the
// refusal in the window's diagnostic capture. The refused cursor is remembered so the next read
// does not submit it again (two reads per refresh otherwise).
//
// It reads no wire; the composition root supplies `read`, keeping `store/` below `services/`.

import { RealClock, type Clock } from "#renderer/lib/clock.js";
import { describeFailure } from "#shared/failure-message.js";
import {
  diagnosticStampAt,
  windowDiagnosticCapture,
} from "#renderer/lib/diagnostic-capture/capture.js";
import type { SessionDegradedCause } from "../degradation.js";
import type { EntityProjectorTable } from "../entities/vocabulary.js";
import { ApplyQueue } from "../apply/queue.js";
import { RefreshScheduler, type RefreshReason } from "#renderer/lib/reads/refresh/scheduler.js";
import { type ApplyOutcome } from "../apply/outcome.js";
import type { SessionBaseState } from "../state.js";
import { SessionStore } from "../store.js";
import {
  isUnresolvableCursorRejection,
  resolveTranscriptResume,
  type TranscriptResumeDecision,
} from "../transcript-resume.js";

/** What the diagnostic capture records when the daemon refuses the submitted position. */
const UNRESOLVABLE_RESUME_DETAIL =
  "the remembered read position could not be resolved, so " + "the log was re-read from its start";

/** The decision a store holds before any read has named a position. */
const RESUME_WITH_NO_CURSOR: TranscriptResumeDecision = { outcome: "restart" };

/**
 * The read a refresh performs.
 *
 * Returns the base state to establish, or `undefined` for "nothing was read", deliberately not an
 * empty base state, which would tell the store the session is empty and clear its degraded flag
 * on a read that never happened.
 *
 * `resumeFromCursor` is where the reader is asked to start: the position the previous read
 * acknowledged, else its `earliest`, or `undefined` before any readable read. The parameter is
 * required, but a function of fewer parameters is still assignable, so an adapter can ignore the
 * position and type-check; `sessionReadThroughDaemon` does, because the `session.read` request
 * names only the session.
 */
export type SessionBaseStateReader = (
  sessionId: string,
  reasons: readonly RefreshReason[],
  resumeFromCursor: string | undefined,
) => Promise<SessionBaseState | undefined>;

/**
 * Everything one open session needs. Declared here, in the lower module, because the registry
 * passes its options straight through; a copy in the registry would make this file import back
 * from it, the cycle `.dependency-cruiser.mjs` forbids.
 */
export interface OpenSessionEntryOptions {
  /** The read every session's refresh scheduler performs; required, or a refresh reads nothing. */
  readonly read: SessionBaseStateReader;
  /** Defaults to `RealClock`. Every queue and scheduler made from this shares it. */
  readonly clock?: Clock;
  /** Event-kind projectors handed to each store opened. */
  readonly projectors?: EntityProjectorTable;
  /** Transcript rows each store retains. */
  readonly transcriptCap?: number;
  /** Apply-queue coalescing window. `0` means one drain per paint. */
  readonly applyCoalesceMs?: number;
  readonly refreshDebounceMs?: number;
  readonly refreshMaxWaitMs?: number;
}

/** One open session: its store and the two schedulers bound to it. */
export class OpenSessionEntry {
  public readonly store: SessionStore;
  public readonly applyQueue: ApplyQueue;
  public readonly refreshScheduler: RefreshScheduler;
  /**
   * Where the next read starts, decided by the last read that landed. After a refused position it
   * is what the recovering re-read named.
   */
  #nextResume: TranscriptResumeDecision = RESUME_WITH_NO_CURSOR;
  /**
   * The one position the daemon refused, remembered so it is never submitted twice. One value,
   * not a set: the daemon issues one acknowledged position per read, so only the last read's
   * could be re-submitted, and a set would grow without bound in a long session.
   */
  #unresolvableCursor: string | undefined = undefined;
  readonly #releaseCauseCapture: () => void;
  readonly #clock: Clock;

  public constructor(sessionId: string, options: OpenSessionEntryOptions) {
    const clock = options.clock ?? new RealClock();
    this.#clock = clock;
    this.store = new SessionStore({
      sessionId,
      ...(options.projectors === undefined ? {} : { projectors: options.projectors }),
      ...(options.transcriptCap === undefined ? {} : { transcriptCap: options.transcriptCap }),
    });
    this.applyQueue = new ApplyQueue({
      clock,
      // The only place a batch of wire events reaches the store: the chokepoint is structural.
      drain: (events) => {
        const outcome = this.store.applyBatch(events);
        if (needsAuthoritativeRepull(outcome)) {
          // The outcome is the only notice a hole opened. Through the scheduler, so a lossy burst
          // costs one repair and never overlaps a read in flight.
          this.refreshScheduler.request("gap-repull");
        }
      },
      // A throwing drain keeps its batch; the session says it is behind and the cause is kept
      // for diagnostics, since the store could not take rows it was handed.
      onDrainError: (error) => {
        this.store.markDegraded("projection-failed");
        windowDiagnosticCapture.record({
          at: diagnosticStampAt(clock),
          severity: "error",
          source: "store/session",
          kind: "apply-drain-failed",
          detail: `session ${sessionId}: ${describeFailure(error)}`,
        });
      },
      ...(options.applyCoalesceMs === undefined ? {} : { coalesceMs: options.applyCoalesceMs }),
    });
    this.refreshScheduler = new RefreshScheduler({
      clock,
      perform: async (reasons) => {
        await this.#performRead(options.read, sessionId, reasons);
      },
      // A failed read is a degradation with a named cause. The store also records the failure
      // beside any worse standing cause, so the line under the header says it could not catch up.
      onError: () => {
        this.store.markReadFailed();
      },
      ...(options.refreshDebounceMs === undefined ? {} : { debounceMs: options.refreshDebounceMs }),
      ...(options.refreshMaxWaitMs === undefined ? {} : { maxWaitMs: options.refreshMaxWaitMs }),
    });
    // The cause goes to the window's diagnostic capture, never the screen, which shows only that
    // the window is catching up. One warning per change, recorded here because every writer of
    // the cause lands on this store and this entry holds the clock and the session.
    let recordedCause: SessionDegradedCause | undefined;
    this.#releaseCauseCapture = this.store.readable.subscribe((state) => {
      const cause = state.degradedCause;
      if (cause === recordedCause) {
        return;
      }
      recordedCause = cause;
      if (cause === undefined) {
        return;
      }
      windowDiagnosticCapture.record({
        at: diagnosticStampAt(clock),
        severity: "warning",
        source: "store/session",
        kind: "session-degraded",
        detail: `session ${sessionId}: ${cause}`,
      });
    });
  }

  /** Release the cause capture and dispose the queue and scheduler. */
  public dispose(): void {
    this.#releaseCauseCapture();
    this.applyQueue.dispose();
    this.refreshScheduler.dispose();
  }

  /**
   * One refresh: submit the remembered position, and recover from a refused one. Recovery is a
   * second call to the same reader inside the one `perform` the scheduler awaits, so two reads
   * never overlap. Any other rejection is re-raised, since the scheduler's `onError` marks the
   * store degraded, right for a failed read and wrong for a refused position.
   */
  async #performRead(
    read: SessionBaseStateReader,
    sessionId: string,
    reasons: readonly RefreshReason[],
  ): Promise<void> {
    const resume = this.#nextResume;
    const submitted = resume.outcome === "restart" ? undefined : resume.fromCursor;
    let baseState: SessionBaseState | undefined;
    try {
      baseState = await read(sessionId, reasons, submitted);
    } catch (rejection: unknown) {
      if (submitted === undefined || !isUnresolvableCursorRejection(rejection)) {
        throw rejection;
      }
      // The submitted cursor is tested before the code is believed: the code refuses a request
      // that carried a cursor, so a read with none cannot have raised it about our position.
      this.#unresolvableCursor = submitted;
      this.#nextResume = RESUME_WITH_NO_CURSOR;
      windowDiagnosticCapture.record({
        at: diagnosticStampAt(this.#clock),
        severity: "warning",
        source: "store/session",
        kind: "resume-cursor-unresolvable",
        detail: `session ${sessionId}: ${UNRESOLVABLE_RESUME_DETAIL}`,
      });
      baseState = await read(sessionId, reasons, undefined);
      if (baseState === undefined) {
        return;
      }
      // What the recovering read named is carried forward as the next position.
      this.#rememberNextResume(resolveTranscriptResume(baseState.transcriptCursors));
      // The recovering read submitted nothing, so its window opens at the log's start.
      this.store.initialize(baseState);
      return;
    }
    if (baseState === undefined) {
      return;
    }
    this.#rememberNextResume(resolveTranscriptResume(baseState.transcriptCursors));
    // `initialize` is what clears the sticky degraded flag, so a completed re-pull lands here.
    // An acknowledged position travels with the base state as where this window begins, because
    // only this object knows it and the reply names no oldest row. A read from `earliest` or from
    // no cursor has nothing before its window, so the member is omitted, not passed `undefined`.
    this.store.initialize(
      resume.outcome === "resume-acknowledged"
        ? { ...baseState, readFromCursor: resume.fromCursor }
        : baseState,
    );
  }

  /**
   * Carry a completed read's decision forward to the next read, except a position the daemon
   * just refused, which would be submitted and refused again on every refresh.
   */
  #rememberNextResume(decision: TranscriptResumeDecision): void {
    this.#nextResume =
      decision.outcome !== "restart" && decision.fromCursor === this.#unresolvableCursor
        ? RESUME_WITH_NO_CURSOR
        : decision;
  }
}

/**
 * Whether one `applyBatch` left the projection known-incomplete, so an authoritative re-read is
 * owed. Read off the outcome, not the sticky degraded cause, which would make every batch after
 * the first look repair-worthy. `duplicates` and `refusedForeignSession` are absent on purpose:
 * neither leaves a hole in this store that a read could fill.
 */
function needsAuthoritativeRepull(outcome: ApplyOutcome): boolean {
  return (
    outcome.gapDetected ||
    outcome.droppedBeforeInitialization > 0 ||
    outcome.refusedDivergedSequence > 0 ||
    outcome.projectionFailures > 0
  );
}
