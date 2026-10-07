// The per-session store and its single apply chokepoint, `applyBatch`: it validates, reconciles
// the sequence, runs the projectors and commits one immutable transition. The zustand setter is
// private, so the chokepoint is structural, and a re-entrant apply is queued and drained, never
// lost.
//
// The degraded flag is sticky: a gap, a drop or a projection failure sets it, and only a
// completed re-pull clears it, since a later event proves nothing about the one that never
// arrived. A re-pull on a store that holds a window repairs it from where the window can be taken
// up again (`RepairResumePoint`): a whole window stands, and a broken one replays
// (`repair-replay.ts`) from its last whole row, or from its head when nothing else will do. What
// the stream sends again folds off screen while the window keeps its rows and its cause, and the
// replay replaces the window once it passes the newest row the window holds, so no state between
// the hole and the repair reads as whole or as empty; rows the window held before the replay's
// first, as a backward page loaded, stay. A re-pull during a replay is taken up from the replay,
// so one that lost its stream goes on after the newest row it folded. `prependEarlierEvents` is
// the only way the log grows at its head, and what is outstanding outlives the capped transcript
// in the waiting-on-person register.

import { createStore } from "zustand/vanilla";
import type { StoreApi } from "zustand/vanilla";

import {
  readPerformanceMeterTime,
  recordApplyLatency,
  recordStoreSize,
} from "#renderer/lib/performance-meters/registry.js";
import { reportTripwire } from "#renderer/lib/tripwires/registry.js";
import { AgentHueAllocator } from "#renderer/styles/agent-hue.js";
import { foldAppliedBatch } from "./apply/batch-fold.js";
import {
  isRaisedAgainOnReplay,
  worstDegradedCause,
  type SessionDegradedCause,
} from "./degradation.js";
import { foldEarlierWindowPage, type EarlierWindowMerge } from "./earlier-window.js";
import { EntityProjectionRunner } from "./entities/projection-runner.js";
import { type ProjectedSessionEvent, type EntityProjectorTable } from "./entities/vocabulary.js";
import {
  GenerationLatch,
  type CurrentGenerationClaim,
} from "#renderer/lib/reads/generation-latch.js";
import {
  WaitingOnPersonRegister,
  type WaitingOnPersonRecords,
} from "./waiting-on-person/register.js";
import { PreInitializationBuffer } from "./pre-initialization-buffer.js";
import { FailedDependentReads } from "./failed-dependent-reads.js";
import { RememberedRowHeights } from "./remembered-row-heights.js";
import { toReadableStore, type ReadableStore } from "../readable-store.js";
import { RepairReplay } from "./repair-replay.js";
import { SequenceReconciler, orderBatchBySequence } from "./sequence-reconciler.js";
import {
  WHOLE_RESUME_POINT,
  admitsBaseState,
  capTranscript,
  establishedState,
  repairResumeRowCursor,
  uninitializedState,
  withDegradedCause,
  type TranscriptRetainedEnd,
} from "./state.js";
import type { SessionBaseState, SessionStoreState } from "./state.js";
import { NOTHING_APPLIED, type ApplyOutcome } from "./apply/outcome.js";

/** Construction inputs. */
export interface SessionStoreOptions {
  readonly sessionId: string;
  /** Event-kind to projector. A kind with no projector contributes no entity. */
  readonly projectors?: EntityProjectorTable;
  /** Transcript rows retained. Unbounded when omitted; the transcript sets its own cap. */
  readonly transcriptCap?: number;
}

const SITE = "store/session/store.ts";

/** The one key the window generation is claimed under. A store has one window. */
const WINDOW_GENERATION_KEY = "window";

/**
 * The per-session store: state, the sequence reconciler and the projectors behind the single
 * `applyBatch` chokepoint. `initialize` establishes the base state; nothing else writes.
 */
export class SessionStore {
  /**
   * The reads this session's screen depends on beside its own that failed. Outside the state,
   * so `initialize` cannot clear a failure only that read's own success clears.
   */
  public readonly failedDependentReads: FailedDependentReads = new FailedDependentReads();
  /**
   * The transcript row heights this session measured. Held here rather than by the transcript,
   * so a transcript mounted again lays its rows out at the heights they had.
   */
  public readonly rememberedRowHeights: RememberedRowHeights = new RememberedRowHeights();
  readonly #sessionId: string;
  readonly #transcriptCap: number | undefined;
  readonly #store: StoreApi<SessionStoreState>;
  readonly #hueAllocator = new AgentHueAllocator();
  /** The window's run; a repair's replay hands its own over at the swap. */
  #reconciler = new SequenceReconciler();
  /** The repair under way while a re-pull's replay has not yet passed the window's rows. */
  #replay: RepairReplay | undefined;
  readonly #preInitializationBuffer = new PreInitializationBuffer();
  readonly #projectionRunner: EntityProjectionRunner;
  /**
   * What is still waiting on a person, held apart from the window it was learned from.
   * Constructed here so its inputs are exactly the rows this store admits or recovers; a
   * supplied register could publish a count over rows it never saw.
   */
  readonly #waitingOnPersonRegister = new WaitingOnPersonRegister();
  readonly #reentrantQueue: ProjectedSessionEvent[] = [];
  #applying = false;
  /**
   * Rows this store holds that arrived from behind its window's head. Read only by
   * `#retainedEnd`, since a log that grew at its head is capped from the other end. A count
   * because zero means no backward page has landed; the first read and a repair that moved the
   * window's head reset it.
   */
  #earlierEventCount = 0;
  readonly #windowGenerations = new GenerationLatch();
  /**
   * Which window this store's log is currently a view of. Re-taken by the reads that start the
   * log over, the first and a repair that moved the window's head; a repair that keeps the head
   * keeps the rows before it, so a backward page in flight still lands.
   */
  #windowGeneration: CurrentGenerationClaim = this.#windowGenerations.supersedeAndClaim(
    this,
    WINDOW_GENERATION_KEY,
  );

  public constructor(options: SessionStoreOptions) {
    this.#sessionId = options.sessionId;
    this.#transcriptCap = options.transcriptCap;
    this.#projectionRunner = new EntityProjectionRunner(options.projectors ?? {});
    this.#store = createStore<SessionStoreState>(() =>
      uninitializedState({ sessionId: options.sessionId, revision: 0 }),
    );
  }

  /** The session this store is bound to. */
  public get sessionId(): string {
    return this.#sessionId;
  }

  /** The zustand store React subscribes to. Read-only by type: no setter escapes. */
  public get readable(): ReadableStore<SessionStoreState> {
    return toReadableStore(this.#store);
  }

  /** The current state. Always the state React's last notification carried. */
  public snapshot(): SessionStoreState {
    return this.#store.getState();
  }

  /** The session's hue wheel. Allocation happens only through `applyBatch`. */
  public get hueAllocator(): AgentHueAllocator {
    return this.#hueAllocator;
  }

  /** Events waiting for a base state. Never more than `PRE_INITIALIZATION_BUFFER_CAP`. */
  public get pendingPreInitializationCount(): number {
    return this.#preInitializationBuffer.pendingCount;
  }

  /**
   * What this session still has open, as of every row this store has ever been given. A getter,
   * not a state member: the records move only on an act that also bumps `revision`, so a
   * reader subscribed to that re-asks when it could have changed.
   */
  public get waitingOnPersonRecords(): WaitingOnPersonRecords {
    return this.#waitingOnPersonRegister.records;
  }

  /**
   * A handle on the window this log is a view of, for a caller settling against it.
   *
   * A read for rows before the window head can answer after a completed read moved that head.
   * Taking this claim at issue and settling through it lets that page be discarded. The handle
   * is narrow: a reader may check it and settle, but cannot give the key back.
   */
  public get windowGeneration(): CurrentGenerationClaim {
    return this.#windowGeneration;
  }

  /**
   * The held row a repair read reopens the stream after: the newest row a replay under way folded
   * whole, else the window's last whole row; `undefined` when only a replay from the head repairs.
   */
  public get repairResumeRowCursor(): string | undefined {
    return repairResumeRowCursor(this.#repairSource);
  }

  /**
   * Establish the base state from a read response and drain anything that arrived first. Taken
   * only by a store with none yet or a degraded one (`admitsBaseState`); on a store that holds a
   * window it repairs that window instead. Answers whether the base state was taken, since only
   * then does the stream open after it.
   */
  public initialize(baseState: SessionBaseState): boolean {
    const current = this.#store.getState();
    if (!admitsBaseState(current)) {
      return false;
    }
    if (current.initialized) {
      return this.#repair(current, baseState);
    }

    this.#earlierEventCount = 0;
    this.#windowGeneration = this.#windowGenerations.supersedeAndClaim(this, WINDOW_GENERATION_KEY);
    this.#store.setState(this.#establish(baseState, this.#reconciler, current.revision + 1));

    const buffered = this.#preInitializationBuffer.drain();
    if (buffered.length > 0) {
      this.applyBatch(buffered);
    }
    return true;
  }

  /**
   * Mark the store degraded without a re-pull (a closed subscription, a lost stream). The cause
   * is merged through the ladder, on the window and on a replay under way, so a cause raised
   * mid-replay survives the swap.
   */
  public markDegraded(cause: SessionDegradedCause): void {
    if (this.#replay !== undefined) {
      this.#replay.advance(withDegradedCause(this.#replay.state, cause));
    }
    const current = this.#store.getState();
    const next = withDegradedCause(current, cause);
    if (next !== current) {
      this.#store.setState(countingRaisedAgainCause(current, next, false));
    }
  }

  /**
   * Record that a read of this session failed: `read-failed` merged through the ladder, and the
   * failure kept beside it so a store already behind for a worse cause still says its repair
   * read failed. Every failure is counted, so a retry that fails again is a new one. The next read
   * that lands clears the cause and the flag; the count stays. A replay under way keeps only the
   * failure, which stands after the swap only if the replay is degraded too.
   */
  public markReadFailed(): void {
    const replay = this.#replay;
    if (replay !== undefined && !replay.state.lastReadFailed) {
      replay.advance({ ...replay.state, lastReadFailed: true });
    }
    const current = this.#store.getState();
    this.#store.setState({
      ...current,
      degradedCause: worstDegradedCause(current.degradedCause, "read-failed"),
      lastReadFailed: true,
      readFailureCount: current.readFailureCount + 1,
      revision: current.revision + 1,
    });
  }

  /**
   * The apply chokepoint and the only writer of this store's state. A batch makes a frame's
   * worth of events one transition; `apply` adds no second write path.
   */
  public applyBatch(events: readonly ProjectedSessionEvent[]): ApplyOutcome {
    if (this.#applying) {
      this.#reentrantQueue.push(...events);
      reportTripwire(
        "apply-chokepoint-bypass",
        SITE,
        `re-entrant applyBatch of ${events.length} event(s) on session ` +
          `${this.#sessionId}: a subscriber wrote during notification. The events ` +
          `are queued and will be applied, but the writing subscriber is the defect.`,
      );
      return { ...NOTHING_APPLIED, buffered: events.length };
    }

    this.#applying = true;
    // The meters are development-only: in a built bundle this reads `0` and records nothing.
    const startedAt = readPerformanceMeterTime();
    try {
      const replay = this.#replay;
      const { outcome, nextState } =
        replay === undefined
          ? this.#fold(this.#store.getState(), events, this.#reconciler, this.#retainedEnd)
          : this.#fold(
              replay.state,
              replay.withHeldRows(events),
              replay.reconciler,
              this.#retainedEnd,
            );
      let committed: SessionStoreState | undefined;
      if (replay === undefined) {
        committed =
          nextState === undefined
            ? undefined
            : countingRaisedAgainCause(this.#store.getState(), nextState, false);
      } else {
        if (nextState !== undefined) {
          replay.advance(nextState);
        }
        committed = replay.hasPassedHeldRows ? this.#takeReplay(replay) : undefined;
      }
      if (committed !== undefined) {
        this.#store.setState(committed);
      }
      // Both readings go under this session's key so the pair lines up. The size is the transcript
      // (what the cap bounds) of the state just set; a batch that set nothing leaves the gauge at
      // its last reading.
      recordApplyLatency(this.#sessionId, readPerformanceMeterTime() - startedAt);
      if (committed !== undefined) {
        recordStoreSize(this.#sessionId, committed.transcript.length);
      }
      return outcome;
    } finally {
      this.#applying = false;
      const queued = this.#reentrantQueue.splice(0, this.#reentrantQueue.length);
      if (queued.length > 0) {
        this.applyBatch(queued);
      }
    }
  }

  /** One-event convenience over `applyBatch`. Not a second chokepoint. */
  public apply(event: ProjectedSessionEvent): ApplyOutcome {
    return this.applyBatch([event]);
  }

  /**
   * Grow the log at its head with a page read from behind
   * {@link SessionStoreState.windowHeadCursor}.
   *
   * Not a second apply chokepoint (`earlier-window.ts`): no sequence reconciled, no projector
   * run, no cursor moved, no gap recorded, and the degraded flag neither set nor cleared. It
   * does advance the waiting-on-person register, since a recovered row is what a backward page
   * is worth to it. The merge result tells an exhausted walk (nothing admitted, nothing
   * overlapping) from a page asked at the wrong position (every row refused as not-earlier).
   */
  public prependEarlierEvents(events: readonly ProjectedSessionEvent[]): EarlierWindowMerge {
    const current = this.#store.getState();
    const { merge, nextState } = foldEarlierWindowPage(current, events, {
      sessionId: this.#sessionId,
      hueAllocator: this.#hueAllocator,
      waitingOnPersonRegister: this.#waitingOnPersonRegister,
      transcriptCap: this.#transcriptCap,
    });
    if (nextState === undefined) {
      return merge;
    }
    this.#earlierEventCount += merge.admitted;
    this.#store.setState(nextState);
    return merge;
  }

  /**
   * The state a read establishes, with `reconciler` re-based onto it. The register keeps the older
   * asks this read did not carry; the seed moves only the window-head fact, which is a property of
   * this read. A base with no sequence seeds below every row the stream delivers after it.
   */
  #establish(
    baseState: SessionBaseState,
    reconciler: SequenceReconciler,
    revision: number,
  ): SessionStoreState {
    const transcript = orderBatchBySequence(baseState.transcript ?? []);
    reconciler.rebaseTo(
      baseState.cursor,
      transcript.map((event) => event.sequence),
    );
    this.#waitingOnPersonRegister.seedFrom({
      entities: baseState.entities,
      cursor: reconciler.cursor,
      windowHeadCursor: baseState.readFromCursor,
    });
    this.#waitingOnPersonRegister.admit(transcript);
    // A re-pull clears the sticky flag here; every other path merges the cause upward.
    return establishedState({
      sessionId: this.#sessionId,
      baseState,
      cursor: reconciler.cursor,
      orderedTranscript: transcript,
      transcriptCap: this.#transcriptCap,
      revision,
      readFailureCount: this.#store.getState().readFailureCount,
      raisedAgainCauseCount: this.#store.getState().raisedAgainCauseCount,
    });
  }

  /**
   * Repair a held window from a read that landed, taken up from a replay under way when there is
   * one, so a replay that lost its stream goes on from what it folded. A read at the window's head
   * replays from it. A read reopening the stream after a held row takes the repair up there: a
   * whole window stands whole and a whole replay goes on, since the stream sends what follows, and
   * one holding a checkpoint at or after that row replays from the checkpoint. A read after a row
   * that cannot be taken up, as when the fault came before any row held, is refused and the stream
   * stays where it is.
   */
  #repair(window: SessionStoreState, baseState: SessionBaseState): boolean {
    const replay = this.#replay;
    const source = this.#repairSource;
    const resumeRow = heldRowAt(source.transcript, baseState.streamAfterCursor);
    // A read at the head replays from it, even when a backward page brought in the row there.
    if (resumeRow === undefined || baseState.readFromCursor !== undefined) {
      const reconciler = new SequenceReconciler();
      this.#startReplay(
        window,
        reconciler,
        this.#establish(baseState, reconciler, window.revision),
      );
      return true;
    }
    const point = source.repairResumePoint;
    if (point.kind === "whole" && replay !== undefined) {
      replay.advance({ ...replay.state, degradedCause: undefined, lastReadFailed: false });
      this.#store.setState({ ...window, lastReadFailed: false, revision: window.revision + 1 });
      return true;
    }
    if (point.kind === "whole") {
      this.#store.setState({
        ...window,
        degradedCause: undefined,
        isReplaying: false,
        lastReadFailed: false,
        revision: window.revision + 1,
      });
      return true;
    }
    if (point.kind === "checkpoint" && resumeRow.sequence <= point.cursor) {
      const reconciler = new SequenceReconciler();
      reconciler.rebaseTo(point.cursor, []);
      this.#startReplay(window, reconciler, {
        ...source,
        partitions: point.partitions,
        transcript: rowsThrough(source.transcript, point.cursor),
        cursor: point.cursor,
        degradedCause: undefined,
        isReplaying: false,
        lastReadFailed: false,
        gaps: [],
        repairResumePoint: WHOLE_RESUME_POINT,
      });
      return true;
    }
    return false;
  }

  /**
   * Start a replay from `startState`, folded with `reconciler`, while the window keeps its rows
   * and its cause and says it is replaying. The read did land, so it no longer counts as failed.
   * A replay already under way is replaced, since its stream was replaced.
   */
  #startReplay(
    window: SessionStoreState,
    reconciler: SequenceReconciler,
    startState: SessionStoreState,
  ): void {
    const replay = new RepairReplay({ window, reconciler, startState });
    if (replay.hasPassedHeldRows) {
      this.#store.setState(this.#takeReplay(replay));
      return;
    }
    this.#replay = replay;
    this.#store.setState({
      ...window,
      isReplaying: true,
      lastReadFailed: false,
      revision: window.revision + 1,
    });
  }

  /**
   * The window a replay that passed the held rows becomes: its run is the store's from here, and
   * the rows the window holds before the replay's first, as backward pages loaded before or during
   * it, stay in front of it. A replay that moved the window's head re-sent those rows itself, so
   * the backward reads addressed from the old head settle nowhere. The window's counts stand, since
   * a read can fail while the replay runs. A failed read stands only beside a cause, since a whole
   * window says nothing about it.
   */
  #takeReplay(replay: RepairReplay): SessionStoreState {
    const visible = this.#store.getState();
    const replayed = replay.state;
    this.#replay = undefined;
    this.#reconciler = replay.reconciler;
    const isHeadMoved = replayed.windowHeadCursor !== visible.windowHeadCursor;
    if (isHeadMoved) {
      this.#earlierEventCount = 0;
      this.#windowGeneration = this.#windowGenerations.supersedeAndClaim(
        this,
        WINDOW_GENERATION_KEY,
      );
    }
    const carried = isHeadMoved
      ? []
      : rowsBefore(visible.transcript, replayed.transcript[0]?.sequence);
    return countingRaisedAgainCause(
      visible,
      {
        ...replayed,
        transcript:
          carried.length === 0
            ? replayed.transcript
            : capTranscript(
                [...carried, ...replayed.transcript],
                this.#transcriptCap,
                this.#retainedEnd,
              ),
        lastReadFailed: replayed.degradedCause !== undefined && replayed.lastReadFailed,
        readFailureCount: visible.readFailureCount,
        raisedAgainCauseCount: visible.raisedAgainCauseCount,
        revision: visible.revision + 1,
      },
      true,
    );
  }

  /** One batch folded onto `current` with the run and retained end it is reconciled against. */
  #fold(
    current: SessionStoreState,
    events: readonly ProjectedSessionEvent[],
    reconciler: SequenceReconciler,
    retainedEnd: TranscriptRetainedEnd,
  ): ReturnType<typeof foldAppliedBatch> {
    return foldAppliedBatch(current, events, {
      sessionId: this.#sessionId,
      reconciler,
      projectionRunner: this.#projectionRunner,
      preInitializationBuffer: this.#preInitializationBuffer,
      hueAllocator: this.#hueAllocator,
      waitingOnPersonRegister: this.#waitingOnPersonRegister,
      transcriptCap: this.#transcriptCap,
      retainedEnd,
    });
  }

  /** What a repair is taken up from: the replay under way, else the window. */
  get #repairSource(): SessionStoreState {
    return this.#replay?.state ?? this.#store.getState();
  }

  /**
   * Which end of an over-cap log survives. A backward page moves the reader to the head, so the
   * cap cuts the end they left; cutting the other way would discard the page as it landed.
   */
  get #retainedEnd(): TranscriptRetainedEnd {
    return this.#earlierEventCount > 0 ? "oldest" : "newest";
  }
}

/** The held row whose position is `cursor`, searched from the newest end, where a resume sits. */
function heldRowAt(
  transcript: readonly ProjectedSessionEvent[],
  cursor: string | undefined,
): ProjectedSessionEvent | undefined {
  return cursor === undefined ? undefined : transcript.findLast((row) => row.cursor === cursor);
}

/** The rows at or below `sequence`, from a transcript in sequence order. */
function rowsThrough(
  transcript: readonly ProjectedSessionEvent[],
  sequence: number,
): readonly ProjectedSessionEvent[] {
  const end = transcript.findIndex((row) => row.sequence > sequence);
  return end === -1 ? transcript : transcript.slice(0, end);
}

/** The rows below `sequence`, from a transcript in sequence order; all of them for none. */
function rowsBefore(
  transcript: readonly ProjectedSessionEvent[],
  sequence: number | undefined,
): readonly ProjectedSessionEvent[] {
  if (sequence === undefined) {
    return transcript;
  }
  const end = transcript.findIndex((row) => row.sequence >= sequence);
  return end === -1 ? transcript : transcript.slice(0, end);
}

/**
 * `next` with a cause a replay raises again counted as it comes to stand: newly, or at a replay's
 * swap, which ends a repair that failed on the same row and so is a new failure.
 */
function countingRaisedAgainCause(
  current: SessionStoreState,
  next: SessionStoreState,
  isSwap: boolean,
): SessionStoreState {
  const cause = next.degradedCause;
  if (
    cause === undefined ||
    !isRaisedAgainOnReplay(cause) ||
    (!isSwap && cause === current.degradedCause)
  ) {
    return next;
  }
  return { ...next, raisedAgainCauseCount: current.raisedAgainCauseCount + 1 };
}
