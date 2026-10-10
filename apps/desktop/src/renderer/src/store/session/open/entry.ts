// One open session: the store, and the two schedulers bound to its life. Split from
// `store/session/registry.ts`, which owns the set of open sessions.
//
// An entry owns the `SessionStore`, the `ApplyQueue` in front of its chokepoint and the
// `RefreshScheduler` behind its reads, created and disposed together so neither outlives the
// store. One owner also closes the repair loop: the drain reads each `ApplyOutcome` and asks this
// session's scheduler for a read when a hole opened, so a quiet session still repairs itself.
//
// A window opens where the resume rule says, `acknowledged ?? latest`: the session's record, then
// one window of its log, then the stream opened after the window's newest row. A stream lost to a
// hole too wide to fill takes a snapshot: the record and the window at `latest`, which replaces
// the window whole. Every other break is repaired with one read of the record, the window kept:
// the stream reopens after the last row the window or its replay folded whole, or at the window's
// head when no row precedes the fault or the stream refused the row named (`SessionStore.repair`).
// Only a base state the store takes moves the stream: the entry names where it opens next, and
// the session-events subscriber opens it after that position. What the old stream left queued is
// dropped then, since the new stream sends what the base lacks. A whole store asks for no read.
//
// The stream also moves when a forward page brings a detached tail back live behind what the
// stream already delivered: it is opened again after the window's newest row, so it sends again
// the rows the window lacks.
//
// A session no screen shows keeps a bounded share of its log: past `offScreenRowLimit` rows, the
// window lets go of all but the newest and detaches its tail, so the stream folds into the
// entities alone and memory stays flat however long the session runs. A transcript shown again
// reads what was let go forward from the kept edge. The entry applies the bound after every write
// it makes and when the last screen showing the session lets it go, so it also holds for a session
// opened and never shown.
//
// The subscriber reports when the stream cannot be followed: a hole too wide to fill, or a
// position the stream refused. The window is then marked degraded and its one repair read asked
// for; no read opens the stream at a position among the newest refused, so a read never cycles
// between refused ones. A failed read is told to the subscriber too, which asks again for one its
// stream waits on.
//
// It reads no wire; the composition root supplies `read`, keeping `store/` below `services/`.

import type { EventCursor } from "@ai-sidekicks/contracts/session/event-cursor";

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
import {
  admitsBaseState,
  heldRowCursor,
  type RepairReopening,
  type SessionBaseState,
  type SessionStoreState,
} from "../state.js";
import { SessionStore } from "../store.js";

/**
 * What a read does with the window, never opening the stream at a position it refused. A union,
 * so where a repair reopens the stream travels only with a repair.
 */
export type SessionWindowOpening =
  | {
      /**
       * `resume` for a window opening, at `acknowledged ?? latest`; `latest` for the snapshot a
       * stream lost past a hole too wide to fill takes, which replaces the window with the log's
       * newest rows.
       */
      readonly opensAt: "resume" | "latest";
      /** The positions the stream refused, which the read never opens at again. */
      readonly refusedCursors: ReadonlySet<EventCursor>;
      /** The row count the window's read asks for. */
      readonly pageLimit: number;
    }
  | {
      /** A repair, which keeps the window and reads only the record. */
      readonly opensAt: "repair";
      /** Where the stream reopens. */
      readonly reopening: RepairReopening;
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
   * The sequence `afterCursor` names, which a drop's width is measured from: the newest row the
   * window holds. Absent when it holds none, so the width is measured from the first delivery.
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
  /** The row count the window's read asks for, read at each read. */
  readonly openingPageLimit: () => number;
  /** The most rows a window keeps while no screen shows its session, read each time it applies. */
  readonly offScreenRowLimit: () => number;
  readonly refreshDebounceMs?: number;
  readonly refreshMaxWaitMs?: number;
}

/** One open session: its store and the two schedulers bound to it. */
export class OpenSessionEntry {
  public readonly store: SessionStore;
  public readonly applyQueue: ApplyQueue;
  public readonly refreshScheduler: RefreshScheduler;
  /** The positions the stream refused, oldest first, so no read opens the stream at one again. */
  readonly #refusedCursors = new Set<EventCursor>();
  /** Whether the stream was lost past a hole too wide to fill, so the next read is a snapshot. */
  #isSnapshotOwed = false;
  #streamPosition: SessionStreamPosition | undefined = undefined;
  readonly #streamPositions = new Emitter<SessionStreamPosition>("session stream position");
  readonly #readFailures = new Emitter<void>("session read failure");
  readonly #releaseCauseCapture: () => void;
  readonly #releaseTailRejoin: () => void;
  readonly #offScreenRowLimit: () => number;
  /** How many screens show this session now; at none its window keeps the off-screen bound. */
  #onScreenCount = 0;

  public constructor(sessionId: string, options: OpenSessionEntryOptions) {
    const clock = options.clock ?? new RealClock();
    this.#offScreenRowLimit = options.offScreenRowLimit;
    this.store = new SessionStore({
      sessionId,
      ...(options.projectors === undefined ? {} : { projectors: options.projectors }),
    });
    this.applyQueue = new ApplyQueue({
      clock,
      // The only place a batch of wire events reaches the store: the chokepoint is structural.
      drain: (events) => {
        const outcome = this.store.applyBatch(events);
        this.#boundOffScreenWindow();
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
    });
    this.refreshScheduler = new RefreshScheduler({
      clock,
      perform: async (reasons) => {
        await this.#performRead(options, sessionId, reasons);
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
    this.#releaseTailRejoin = this.store.readable.subscribe((state, previous) => {
      this.#reopenAfterRejoinedTail(state, previous);
    });
  }

  /** Release the store subscriptions, drop every listener and dispose the queue and scheduler. */
  public dispose(): void {
    this.#releaseCauseCapture();
    this.#releaseTailRejoin();
    this.#streamPositions.clear();
    this.#readFailures.clear();
    this.applyQueue.dispose();
    this.refreshScheduler.dispose();
  }

  /**
   * Where the stream opens after the last read or rejoined tail that moved it, or `undefined`
   * before one has, or once the stream was lost. Kept so a stream bound later still finds it.
   */
  public get streamPosition(): SessionStreamPosition | undefined {
    return this.#streamPosition;
  }

  /** Be told where the stream opens each time a read or a rejoined tail moves it. */
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
   * Marks the session shown on one screen until the returned call, which ends exactly this mark;
   * once no mark stands, the window keeps the off-screen bound.
   */
  public markOnScreen(): Unsubscribe {
    this.#onScreenCount += 1;
    let isEnded = false;
    return () => {
      if (isEnded) {
        return;
      }
      isEnded = true;
      this.#onScreenCount -= 1;
      this.#boundOffScreenWindow();
    };
  }

  /**
   * The stream dropped a hole too wide to fill: it is lost, and the read that repairs the window
   * is a snapshot of the log's newest rows.
   */
  public loseStream(): void {
    this.#isSnapshotOwed = true;
    this.#forgetStream();
  }

  /**
   * The stream refused the position it was opened after, so the log no longer resolves it: the
   * stream is lost, and no read opens it there again while it is among the newest refused.
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
    this.#forgetStream();
  }

  /**
   * One refresh: the read this store's state asks for, then the stream moved after it when the
   * store took the base state. A whole store takes none, so none is made: a gap or a lost stream
   * marks the store degraded before it asks. Rows the replaced stream left queued are dropped once
   * a live store takes a base: the stream opened after the base sends what the base lacks, and a
   * stale row drained first would fold ahead of rows still to come.
   */
  async #performRead(
    options: OpenSessionEntryOptions,
    sessionId: string,
    reasons: readonly RefreshReason[],
  ): Promise<void> {
    if (!admitsBaseState(this.store.snapshot())) {
      return;
    }
    const opening = this.#nextOpening(options);
    const baseState = await options.read(sessionId, reasons, opening);
    if (baseState === undefined) {
      return;
    }
    const wasInitialized = this.store.snapshot().initialized;
    const isTaken =
      opening.opensAt === "repair"
        ? this.store.repair(baseState, opening.reopening)
        : this.store.initialize(baseState);
    if (!isTaken) {
      return;
    }
    this.#boundOffScreenWindow();
    // The stream this read opens replaces the lost one, so no snapshot is owed past it.
    this.#isSnapshotOwed = false;
    if (wasInitialized) {
      this.applyQueue.discardPending();
    }
    this.#moveStream({ afterCursor: baseState.streamAfterCursor, afterSequence: baseState.cursor });
  }

  /**
   * A store holding no window opens one; a lost stream owes a snapshot; any other repair reopens
   * the stream after the row the store names, else at the window's head. A head the stream refused
   * leaves nothing to reopen at, so that repair is a snapshot too.
   */
  #nextOpening(options: OpenSessionEntryOptions): SessionWindowOpening {
    const refusedCursors: ReadonlySet<EventCursor> = new Set(this.#refusedCursors);
    const state = this.store.snapshot();
    const windowRead = { refusedCursors, pageLimit: options.openingPageLimit() };
    if (!state.initialized) {
      return { opensAt: "resume", ...windowRead };
    }
    if (this.#isSnapshotOwed) {
      return { opensAt: "latest", ...windowRead };
    }
    const rowCursor = this.store.repairResumeRowCursor;
    if (rowCursor !== undefined && !refusedCursors.has(rowCursor)) {
      return { opensAt: "repair", reopening: { from: "row", rowCursor }, refusedCursors };
    }
    const head = state.transcriptHead;
    const headCursor = head.hasMore ? head.cursor : undefined;
    if (headCursor !== undefined && refusedCursors.has(headCursor)) {
      return { opensAt: "latest", ...windowRead };
    }
    return { opensAt: "repair", reopening: { from: "head", headCursor }, refusedCursors };
  }

  /**
   * A forward page brought the tail back live behind the stream: the stream is opened again after
   * the window's newest row, so it sends again the rows the window lacks.
   */
  #reopenAfterRejoinedTail(state: SessionStoreState, previous: SessionStoreState): void {
    if (
      previous.transcriptTail.following !== "detached" ||
      state.transcriptTail.following !== "live"
    ) {
      return;
    }
    const newest = state.transcript.at(-1);
    if (newest === undefined || newest.sequence >= state.cursor) {
      return;
    }
    this.#moveStream({ afterCursor: heldRowCursor(newest), afterSequence: newest.sequence });
  }

  /**
   * The stream can no longer be followed from the window's position: the position is forgotten
   * so no stream opens there, an open window is marked degraded until its repair, and the one read
   * that starts the repair is asked for. Through the scheduler, so a burst of these costs one read.
   */
  #forgetStream(): void {
    this.#streamPosition = undefined;
    if (this.store.snapshot().initialized) {
      this.store.markDegraded("stream-diverged");
    }
    this.refreshScheduler.request("gap-repull");
  }

  /** A window no screen shows lets go of all but its newest rows past the off-screen bound. */
  #boundOffScreenWindow(): void {
    if (this.#onScreenCount === 0) {
      this.store.releaseBeyondNewest(this.#offScreenRowLimit());
    }
  }

  /** Name where the stream opens next, for a stream bound later and for the subscriber now. */
  #moveStream(position: SessionStreamPosition): void {
    this.#streamPosition = position;
    this.#streamPositions.emit(position);
  }
}

// The most refused positions an entry remembers: as many as one read chooses between, the last
// whole row, the head, the acknowledged position and the window's newest row or the floor. Once
// each is refused the read is refused, so a read never cycles between refused ones.
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
