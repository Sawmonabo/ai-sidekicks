// One open session: the store, and the two schedulers bound to its life. Split from
// `store/session/registry.ts`, which owns the set of open sessions.
//
// An entry owns the `SessionStore`, the `ApplyQueue` in front of its chokepoint and the
// `RefreshScheduler` behind its re-pull, created and disposed together so neither outlives the
// store. One owner also closes the repair loop: the drain reads each `ApplyOutcome` and asks this
// session's scheduler for a re-pull when a hole opened, so a quiet session still repairs itself.
//
// Where the window opens is decided here, per read, and handed to the read: at the resume rule's
// `acknowledged ?? earliest`, or, once the store could not follow the stream, at the newest
// position, past a hole too wide to fill, which the store keeps as a gap. The read answers the
// base state at that position, and only a base state the store takes moves the stream: the entry
// names where it opens next, and the session-events subscriber opens it after that position. A
// read the store refuses, a live window already past it, moves nothing.
//
// The subscriber reports when the stream cannot be followed: a hole too wide to fill, or a
// position the stream refused. An open window then skips past to the newest position; a refused
// position is never handed out again, so a window not yet open resumes from the floor instead.
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
import type { SessionBaseState } from "../state.js";
import { SessionStore } from "../store.js";

/**
 * Which position of a read's cursor block the window opens at. A union, so the position the
 * stream refused travels only with the opening that could hand it out.
 */
export type SessionWindowOpening =
  | {
      /** `acknowledged ?? earliest`, the resume rule. */
      readonly opensAt: "resume";
      /** The one position the stream refused, which the read never opens at again. */
      readonly refusedCursor: EventCursor | undefined;
    }
  | {
      /** The newest position: a snapshot past a hole too wide to fill. */
      readonly opensAt: "latest";
    };

/**
 * The read a refresh performs: the base state at the position `opening` names.
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
  /** The sequence `afterCursor` names, which a drop's width is measured from. */
  readonly afterSequence: number;
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
  /**
   * The one position the stream refused, so no read opens the window there again. One value, not
   * a set: a read hands out one position, so only the last could be handed out again, and a set
   * would grow without bound in a long session.
   */
  #refusedCursor: EventCursor | undefined = undefined;
  #streamPosition: SessionStreamPosition | undefined = undefined;
  readonly #streamPositions = new Emitter<SessionStreamPosition>("session stream position");
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

  /** Release the cause capture, drop the position listeners and dispose the queue and scheduler. */
  public dispose(): void {
    this.#releaseCauseCapture();
    this.#streamPositions.clear();
    this.applyQueue.dispose();
    this.refreshScheduler.dispose();
  }

  /**
   * Where the stream opens after the last read that moved the window, or `undefined` before one
   * has, or once the stream refused it. Kept so a stream bound after that read still finds it.
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

  /**
   * The stream dropped a hole too wide to fill, so the window cannot follow it from where it is:
   * marked so, its re-read skips to the newest position and moves the stream there.
   */
  public skipPastStream(): void {
    this.#loseStream();
  }

  /**
   * The stream refused the position it was opened after, so the log no longer resolves it. An
   * open window cannot follow the stream from there, so its re-read skips to the newest position;
   * a window not yet open re-reads from the floor.
   */
  public refuseStreamCursor(cursor: EventCursor): void {
    this.#refusedCursor = cursor;
    this.#loseStream();
  }

  /**
   * One refresh: the read at the position this store's state calls for, then the stream moved
   * after it when the store took the base state. A snapshot is always taken, since it only moves
   * the window forward.
   */
  async #performRead(
    read: SessionBaseStateReader,
    sessionId: string,
    reasons: readonly RefreshReason[],
  ): Promise<void> {
    const opening = this.#nextOpening();
    const baseState = await read(sessionId, reasons, opening);
    if (baseState === undefined) {
      return;
    }
    if (opening.opensAt === "latest") {
      this.store.skipToSnapshot(baseState);
    } else if (!this.store.initialize(baseState)) {
      return;
    }
    this.#streamPosition = {
      afterCursor: baseState.streamAfterCursor,
      afterSequence: baseState.cursor,
    };
    this.#streamPositions.emit(this.#streamPosition);
  }

  /**
   * The stream can no longer be followed from the window's position: the position is forgotten so
   * no stream opens there, an open window is marked unable to follow, and the read that places
   * the window again is asked for.
   */
  #loseStream(): void {
    this.#streamPosition = undefined;
    if (this.store.snapshot().initialized) {
      this.store.markDegraded("stream-diverged");
    }
    this.refreshScheduler.request("gap-repull");
  }

  /**
   * The newest position once an open window could not follow the stream, since filling that hole
   * is past what a read repairs; otherwise the resume rule, never at the refused position.
   */
  #nextOpening(): SessionWindowOpening {
    const state = this.store.snapshot();
    return state.initialized && state.degradedCause === "stream-diverged"
      ? { opensAt: "latest" }
      : { opensAt: "resume", refusedCursor: this.#refusedCursor };
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
