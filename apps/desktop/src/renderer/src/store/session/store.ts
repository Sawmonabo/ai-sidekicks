// The per-session store and its single apply chokepoint, `applyBatch`: it validates, reconciles
// the sequence, runs the projectors and commits one immutable transition. The zustand setter is
// private, so the chokepoint is structural, and a re-entrant apply is queued and drained, never
// lost.
//
// The store holds a window of the session's log, not the log: a read places it, the reader's pages
// grow it at either edge (`transcript-window.ts`), and `releaseOutside` lets go of what lies far
// from the reading position. The stream keeps folding into the entities and the waiting-on-person
// register whether or not the window's tail follows it, so what is outstanding outlives every row
// the window let go.
//
// The degraded flag is sticky: a gap, a drop or a projection failure sets it, and only a completed
// read clears it, since a later event proves nothing about the one that never arrived. A read on a
// degraded store replaces its window with the read's, so the window on screen stays as it was, and
// says it is behind, until the read lands.

import { createStore } from "zustand/vanilla";
import type { StoreApi } from "zustand/vanilla";
import type { EventCursor } from "@ai-sidekicks/contracts/session/event-cursor";

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
import {
  foldEarlierWindowPage,
  foldLaterWindowPage,
  releaseOutsideKept,
  type EarlierWindowMerge,
  type LaterWindowMerge,
  type TranscriptPageDependencies,
} from "./transcript-window.js";
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
import { SequenceReconciler, orderBatchBySequence } from "./sequence-reconciler.js";
import {
  admitsBaseState,
  establishedState,
  uninitializedState,
  withDegradedCause,
  type TranscriptWindowEdge,
} from "./state.js";
import type { SessionBaseState, SessionStoreState } from "./state.js";
import { NOTHING_APPLIED, type ApplyOutcome } from "./apply/outcome.js";

/** Construction inputs. */
export interface SessionStoreOptions {
  readonly sessionId: string;
  /** Event-kind to projector. A kind with no projector contributes no entity. */
  readonly projectors?: EntityProjectorTable;
}

const SITE = "store/session/store.ts";

/** The one key the window generation is claimed under. A store has one window. */
const WINDOW_GENERATION_KEY = "window";

/**
 * The per-session store: state, the sequence reconciler and the projectors behind the single
 * `applyBatch` chokepoint. `initialize` establishes the base state; the window's edges move only
 * through the page and release methods.
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
  readonly #store: StoreApi<SessionStoreState>;
  readonly #hueAllocator = new AgentHueAllocator();
  readonly #reconciler = new SequenceReconciler();
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
  readonly #windowGenerations = new GenerationLatch();
  /**
   * Which window this store's log is currently a view of. Re-taken whenever an edge moves other
   * than by a page landing at it, a read or a release, so a page asked from the old edge settles
   * nowhere instead of landing beside a hole.
   */
  #windowGeneration: CurrentGenerationClaim = this.#windowGenerations.supersedeAndClaim(
    this,
    WINDOW_GENERATION_KEY,
  );

  public constructor(options: SessionStoreOptions) {
    this.#sessionId = options.sessionId;
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

  /** The session's hue wheel. Allocation happens only through `applyBatch` and the pages. */
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
   * A handle on the window this log is a view of, for a caller settling a page against it.
   *
   * A page read beyond an edge can answer after a read replaced the window or a release moved
   * that edge. Taking this claim at issue and settling through it lets that page be discarded.
   * The handle is narrow: a reader may check it and settle, but cannot give the key back.
   */
  public get windowGeneration(): CurrentGenerationClaim {
    return this.#windowGeneration;
  }

  /**
   * Establish the base state from a read response and drain anything that arrived first. Taken
   * only by a store with none yet or a degraded one (`admitsBaseState`), whose window the read's
   * replaces whole. Answers whether the base state was taken, since only then does the stream
   * open after it.
   */
  public initialize(baseState: SessionBaseState): boolean {
    const current = this.#store.getState();
    if (!admitsBaseState(current)) {
      return false;
    }
    this.#windowGeneration = this.#windowGenerations.supersedeAndClaim(this, WINDOW_GENERATION_KEY);
    this.#store.setState(this.#establish(baseState, current));

    const buffered = this.#preInitializationBuffer.drain();
    if (buffered.length > 0) {
      this.applyBatch(buffered);
    }
    return true;
  }

  /** Mark the store degraded without a read (a closed subscription, a lost stream). */
  public markDegraded(cause: SessionDegradedCause): void {
    const current = this.#store.getState();
    const next = withDegradedCause(current, cause);
    if (next !== current) {
      this.#store.setState(countingRaisedAgainCause(current, next));
    }
  }

  /**
   * Record that a read of this session failed: `read-failed` merged through the ladder, and the
   * failure kept beside it so a store already behind for a worse cause still says its repair
   * read failed. Every failure is counted, so a retry that fails again is a new one. The next read
   * that lands clears the cause and the flag; the count stays.
   */
  public markReadFailed(): void {
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
   * The apply chokepoint and the only writer of this store's state from the stream. A batch makes
   * a frame's worth of events one transition; `apply` adds no second write path.
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
      const current = this.#store.getState();
      const { outcome, nextState } = foldAppliedBatch(current, events, {
        sessionId: this.#sessionId,
        reconciler: this.#reconciler,
        projectionRunner: this.#projectionRunner,
        preInitializationBuffer: this.#preInitializationBuffer,
        hueAllocator: this.#hueAllocator,
        waitingOnPersonRegister: this.#waitingOnPersonRegister,
      });
      const committed =
        nextState === undefined ? undefined : countingRaisedAgainCause(current, nextState);
      if (committed !== undefined) {
        this.#store.setState(committed);
      }
      // Both readings go under this session's key so the pair lines up. The size is the window
      // of the state just set; a batch that set nothing leaves the gauge at its last reading.
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
   * Adds a backward `transcript.read` page before the head; returns what it admitted. The head
   * takes `edge`, the page's own, once the page admitted rows or carried none.
   *
   * Not a second apply chokepoint: no sequence reconciled, no projector run, no stream cursor
   * moved, and the degraded flag neither set nor cleared. It does advance the waiting-on-person
   * register, since a recovered row is what a page is worth to it.
   */
  public prependEarlierEvents(
    events: readonly ProjectedSessionEvent[],
    edge: TranscriptWindowEdge,
  ): EarlierWindowMerge {
    const { merge, nextState } = foldEarlierWindowPage(
      this.#store.getState(),
      events,
      edge,
      this.#pageDependencies,
    );
    if (nextState !== undefined) {
      this.#store.setState(nextState);
    }
    return merge;
  }

  /**
   * Adds a forward page after a detached tail; returns what it admitted. When `edge.hasMore` is
   * false, or the window reaches what the stream has delivered, the tail goes live again; the
   * open session then reopens the stream after the newest row when the stream ran past it.
   * Not a second apply chokepoint, on the terms of {@link prependEarlierEvents}.
   */
  public appendLaterEvents(
    events: readonly ProjectedSessionEvent[],
    edge: TranscriptWindowEdge,
  ): LaterWindowMerge {
    const { merge, nextState } = foldLaterWindowPage(
      this.#store.getState(),
      events,
      edge,
      this.#pageDependencies,
    );
    if (nextState !== undefined) {
      this.#store.setState(nextState);
    }
    return merge;
  }

  /**
   * Lets go of the events outside `[firstKeptCursor, lastKeptCursor]` (by sequence), recording
   * each edge so a later read brings them back; letting go past the tail detaches it. A cursor the
   * window does not hold, as after a read replaced it, lets go of nothing.
   */
  public releaseOutside(firstKeptCursor: EventCursor, lastKeptCursor: EventCursor): void {
    const next = releaseOutsideKept(this.#store.getState(), firstKeptCursor, lastKeptCursor);
    if (next === undefined) {
      return;
    }
    this.#windowGeneration = this.#windowGenerations.supersedeAndClaim(this, WINDOW_GENERATION_KEY);
    this.#store.setState(next);
    recordStoreSize(this.#sessionId, next.transcript.length);
  }

  /**
   * The state a read establishes over `current`, with the reconciler re-based onto it. The read's
   * rows advance the hue wheel and the register as a page's do; the register keeps the older asks
   * this read did not carry, and the seed moves only the window-head fact. A base with no sequence
   * seeds below every row the stream delivers after it.
   */
  #establish(baseState: SessionBaseState, current: SessionStoreState): SessionStoreState {
    const transcript = orderBatchBySequence(baseState.transcript ?? []);
    this.#reconciler.rebaseTo(
      baseState.cursor,
      transcript.map((event) => event.sequence),
    );
    for (const event of transcript) {
      if (event.actorId !== undefined) {
        this.#hueAllocator.admit(event.actorId);
      }
    }
    this.#waitingOnPersonRegister.seedFrom({
      entities: baseState.entities,
      cursor: this.#reconciler.cursor,
      isWindowHeadUnread: baseState.transcriptHead?.hasMore ?? false,
    });
    this.#waitingOnPersonRegister.admit(transcript);
    // A read clears the sticky flag here; every other path merges the cause upward.
    return establishedState({
      sessionId: this.#sessionId,
      baseState,
      cursor: this.#reconciler.cursor,
      orderedTranscript: transcript,
      revision: current.revision + 1,
      readFailureCount: current.readFailureCount,
      raisedAgainCauseCount: current.raisedAgainCauseCount,
    });
  }

  /** What a page fold advances beside the state. */
  get #pageDependencies(): TranscriptPageDependencies {
    return {
      sessionId: this.#sessionId,
      hueAllocator: this.#hueAllocator,
      waitingOnPersonRegister: this.#waitingOnPersonRegister,
    };
  }
}

/** `next` with a cause the stream raises again counted as it newly comes to stand. */
function countingRaisedAgainCause(
  current: SessionStoreState,
  next: SessionStoreState,
): SessionStoreState {
  const cause = next.degradedCause;
  if (cause === undefined || !isRaisedAgainOnReplay(cause) || cause === current.degradedCause) {
    return next;
  }
  return { ...next, raisedAgainCauseCount: current.raisedAgainCauseCount + 1 };
}
