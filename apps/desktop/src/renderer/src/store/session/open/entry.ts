// One open session: the store, and the two schedulers bound to its life. Split from
// `store/session/registry.ts`, which owns the set of open sessions.
//
// An entry owns the `SessionStore`, the `ApplyQueue` in front of its chokepoint and the
// `RefreshScheduler` behind its re-pull, created and disposed together so neither outlives the
// store. One owner also closes the repair loop: the drain reads each `ApplyOutcome` and asks this
// session's scheduler for a re-pull when a hole opened. The re-pull reopens the stream after the
// last row the window holds whole, or after the newest row a replay under way folded, so the
// daemon sends the hole and what followed it again, and the store replays them off screen until
// it passes the window's rows; a quiet session still repairs itself.
//
// A window opens where the resume rule says, `acknowledged ?? earliest`. A repair reopens it after
// the window's last whole row, or a replay's under way, or at its head when only a replay from
// there can repair it (`RepairResumePoint`); never at a position the stream refused, and once every
// position a read could pick was refused, the stream opens with no position. The read
// answers the base state there, and only a base state the store takes moves the stream: the entry
// names where it opens next, and the session-events subscriber opens it after that position. What
// the old stream left queued is dropped then, since the new stream sends what the base lacks. A
// read the store refuses, a whole live window, moves nothing.
//
// The subscriber reports when the stream cannot be followed: a hole too wide to fill, or a
// position the stream refused. The window is then marked degraded and its one repair read asked
// for; a refused position is never handed out again. A failed read is told to the subscriber
// too, which asks again for one its stream waits on.
//
// It reads no wire; the composition root supplies `read`, keeping `store/` below `services/`.

import type { EventCursor } from "@ai-sidekicks/contracts/session/id";

import { RealClock, type Clock } from "#renderer/lib/clock.js";
import { describeFailure } from "#shared/failure-message.js";
import type { Unsubscribe } from "#shared/preload-api.js";
import { Emitter } from "#renderer/lib/emitter.js";
import {
  diagnosticStampAt,
  windowDiagnosticCapture,
} from "#renderer/lib/diagnostic-capture/capture.js";
import type { SessionDegradedCause } from "../degradation.js";
import type { EntityProjectorTable } from "../entities/vocabulary.js";
import { ApplyQueue } from "../apply/queue.js";
import { RefreshScheduler, type RefreshReason } from "#renderer/lib/reads/refresh/scheduler.js";
import { type ApplyOutcome } from "../apply/outcome.js";
import { type SessionBaseState } from "../state.js";
import { SessionStore } from "../store.js";

/**
 * Where a read places the window, never at a position the stream refused. A union, so the held
 * window's head travels only with the opening that reopens there.
 */
export type SessionWindowOpening =
  | {
      /** A window opening: `acknowledged ?? earliest`, the resume rule. */
      readonly opensAt: "resume";
      /** The positions the stream refused, which the read never opens at again. */
      readonly refusedCursors: ReadonlySet<EventCursor>;
    }
  | {
      /** A repair: after the last whole row of the window or its replay, else at its head. */
      readonly opensAt: "repair";
      /**
       * The held row the stream can be taken up again after, as held, or `undefined` when only a
       * replay from the head can repair the window.
       */
      readonly resumeAfterRowCursor: string | undefined;
      /** The head rows sit before, or `undefined` for a window that opened at the floor. */
      readonly headCursor: EventCursor | undefined;
      /** The positions the stream refused, which the read never opens at again. */
      readonly refusedCursors: ReadonlySet<EventCursor>;
    };

/**
 * The read a refresh performs: the base state where `opening` places the window.
 *
 * Returns the base state to establish, or `undefined` for "nothing was read", deliberately not an
 * empty base state, which would tell the store the session is empty and clear its degraded flag
 * on a read that never happened. A function of fewer parameters is still assignable, so a
 * stand-in that knows one position can ignore `opening`.
 */
export type SessionBaseStateReader = (
  sessionId: string,
  reasons: readonly RefreshReason[],
  opening: SessionWindowOpening,
) => Promise<SessionBaseState | undefined>;

/** Where one session's stream opens after a read placed its window. */
export interface SessionStreamPosition {
  /** The daemon-issued position the stream opens after; `undefined` opens it at the log's start. */
  readonly afterCursor: EventCursor | undefined;
  /**
   * The sequence `afterCursor` names, which a drop's width is measured from, when the read said
   * it; a daemon read does not, so the width is measured from the first delivery.
   */
  readonly afterSequence: number | undefined;
}

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
  /** The positions the stream refused, oldest first, so no read opens the window at one again. */
  readonly #refusedCursors = new Set<EventCursor>();
  #streamPosition: SessionStreamPosition | undefined = undefined;
  readonly #streamPositions = new Emitter<SessionStreamPosition>("session stream position");
  readonly #readFailures = new Emitter<void>("session read failure");
  readonly #releaseCauseCapture: () => void;

  public constructor(sessionId: string, options: OpenSessionEntryOptions) {
    const clock = options.clock ?? new RealClock();
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
        this.#readFailures.emit();
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

  /** Release the cause capture, drop every listener and dispose the queue and scheduler. */
  public dispose(): void {
    this.#releaseCauseCapture();
    this.#streamPositions.clear();
    this.#readFailures.clear();
    this.applyQueue.dispose();
    this.refreshScheduler.dispose();
  }

  /**
   * Where the stream opens after the last read that moved the window, or `undefined` before one
   * has, or once the stream was lost. Kept so a stream bound after that read still finds it.
   */
  public get streamPosition(): SessionStreamPosition | undefined {
    return this.#streamPosition;
  }

  /** Be told where the stream opens each time a read moves the window. */
  public subscribeToStreamPosition(
    listener: (position: SessionStreamPosition) => void,
  ): Unsubscribe {
    return this.#streamPositions.subscribe(listener);
  }

  /** Be told each time a read of this session fails. */
  public subscribeToReadFailure(listener: () => void): Unsubscribe {
    return this.#readFailures.subscribe(listener);
  }

  /**
   * The stream can no longer be followed from the window's position, as when it dropped a hole
   * too wide to fill: the position is forgotten so no stream opens there, an open window is marked
   * degraded until its repair, and the one read that starts the repair is asked for. Through the
   * scheduler, so a burst of these costs one read.
   */
  public loseStream(): void {
    this.#streamPosition = undefined;
    if (this.store.snapshot().initialized) {
      this.store.markDegraded("stream-diverged");
    }
    this.refreshScheduler.request("gap-repull");
  }

  /**
   * The stream refused the position it was opened after, so the log no longer resolves it: the
   * stream is lost, and no read opens the window there again while it is among the newest refused.
   */
  public refuseStreamCursor(cursor: EventCursor): void {
    this.#refusedCursors.delete(cursor);
    this.#refusedCursors.add(cursor);
    for (const oldest of this.#refusedCursors) {
      if (this.#refusedCursors.size <= REFUSED_CURSOR_LIMIT) {
        break;
      }
      this.#refusedCursors.delete(oldest);
    }
    this.loseStream();
  }

  /**
   * One refresh: the read where this store's state places the window, then the stream moved
   * after it when the store took the base state. Rows the replaced stream left queued are dropped
   * once a live store takes a base: the stream opened after the base sends what the base lacks,
   * and a stale row drained first would place the replay past rows still to come.
   */
  async #performRead(
    read: SessionBaseStateReader,
    sessionId: string,
    reasons: readonly RefreshReason[],
  ): Promise<void> {
    const baseState = await read(sessionId, reasons, this.#nextOpening());
    if (baseState === undefined) {
      return;
    }
    const wasInitialized = this.store.snapshot().initialized;
    if (!this.store.initialize(baseState)) {
      return;
    }
    if (wasInitialized) {
      this.applyQueue.discardPending();
    }
    this.#streamPosition = {
      afterCursor: baseState.streamAfterCursor,
      afterSequence: baseState.cursor,
    };
    this.#streamPositions.emit(this.#streamPosition);
  }

  /** A store that holds a window repairs it where it can be taken up; one holding none opens. */
  #nextOpening(): SessionWindowOpening {
    const state = this.store.snapshot();
    return state.initialized
      ? {
          opensAt: "repair",
          resumeAfterRowCursor: this.store.repairResumeRowCursor,
          headCursor: state.windowHeadCursor,
          refusedCursors: new Set(this.#refusedCursors),
        }
      : { opensAt: "resume", refusedCursors: new Set(this.#refusedCursors) };
  }
}

// The most refused positions an entry remembers: as many as one read chooses between, the last
// whole row, the head, the acknowledged position and the floor. Once each is refused the stream
// opens with no position, so a read never cycles between refused ones.
const REFUSED_CURSOR_LIMIT = 4;

/**
 * Whether one `applyBatch` lost rows the stream still holds, so an authoritative re-read is owed:
 * it repairs the window and the stream sends them again. Read off the outcome, not the sticky
 * degraded cause, which would make every batch after the first look repair-worthy. The other
 * counts are absent on purpose: a duplicate or another session's row leaves no hole, and a row
 * whose sequence diverged or whose projector threw comes again on the replay and fails again, so
 * asking would replay in a loop. Those leave it degraded until a person asks again.
 */
function needsAuthoritativeRepull(outcome: ApplyOutcome): boolean {
  return outcome.gapDetected || outcome.droppedBeforeInitialization > 0;
}
