// The per-session store and its single apply chokepoint, `applyBatch`: it validates, reconciles
// the sequence, runs the projectors and commits one immutable transition. The zustand setter is
// private, so the chokepoint is structural, and a re-entrant apply is queued and drained, never
// lost.
//
// The degraded flag is sticky: a gap, a drop or a projection failure sets it, and only a
// completed re-pull clears it, since a later event proves nothing about the one that never
// arrived. `prependEarlierEvents` is the only way the log grows at its head, and what is
// outstanding outlives the capped transcript in the waiting-on-person register.

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
import { worstDegradedCause, type SessionDegradedCause } from "./degradation.js";
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
import { toReadableStore, type ReadableStore } from "../readable-store.js";
import { SequenceReconciler, orderBatchBySequence } from "./sequence-reconciler.js";
import {
  admitsBaseStateAt,
  establishedState,
  uninitializedState,
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
  readonly #sessionId: string;
  readonly #transcriptCap: number | undefined;
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
  /**
   * Rows this store holds that arrived from behind its window's head. Read only by
   * `#retainedEnd`, since a log that grew at its head is capped from the other end. A count
   * because zero means no backward page has landed; `initialize` resets it.
   */
  #earlierEventCount = 0;
  readonly #windowGenerations = new GenerationLatch();
  /**
   * Which window this store's log is currently a view of. Re-taken by `initialize` only, so it
   * goes stale even when a read answers at the same position yet replaces the log, which head
   * cursors cannot show.
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
   * Establish the base state from a read response and drain anything that arrived first.
   * Idempotent against a rewind and admits the equal-cursor repair (`admitsBaseStateAt`).
   */
  public initialize(baseState: SessionBaseState): void {
    const current = this.#store.getState();
    if (current.initialized && !admitsBaseStateAt(baseState.cursor, current)) {
      return;
    }

    // A completed read re-establishes where the window starts, so the count that decides the
    // retained end is stale.
    this.#earlierEventCount = 0;
    // A backward read still in flight was addressed from the replaced head, so its claim stops
    // being current and its page settles nowhere.
    this.#windowGeneration = this.#windowGenerations.supersedeAndClaim(this, WINDOW_GENERATION_KEY);
    // The register keeps the older asks this read did not carry; the seed moves only the
    // window-head fact, which is a property of this read.
    this.#waitingOnPersonRegister.seedFrom({
      entities: baseState.entities,
      cursor: baseState.cursor,
      windowHeadCursor: baseState.readFromCursor,
    });
    const transcript = orderBatchBySequence(baseState.transcript ?? []);
    this.#waitingOnPersonRegister.admit(transcript);
    this.#reconciler.rebaseTo(
      baseState.cursor,
      transcript.map((event) => event.sequence),
    );

    // A re-pull clears the sticky flag here; every other path merges the cause upward.
    this.#store.setState(
      establishedState({
        sessionId: this.#sessionId,
        baseState,
        orderedTranscript: transcript,
        transcriptCap: this.#transcriptCap,
        revision: current.revision + 1,
        readFailureCount: current.readFailureCount,
      }),
    );

    const buffered = this.#preInitializationBuffer.drain();
    if (buffered.length > 0) {
      this.applyBatch(buffered);
    }
  }

  /**
   * Mark the store degraded without a re-pull (a closed subscription, a failed read). The cause
   * is merged through the ladder, not assigned: an assignment would downgrade `stream-diverged`
   * to `read-failed` when its repair read rejects.
   */
  public markDegraded(cause: SessionDegradedCause): void {
    const current = this.#store.getState();
    const merged = worstDegradedCause(current.degradedCause, cause);
    if (merged === current.degradedCause) {
      return;
    }
    this.#store.setState({ ...current, degradedCause: merged, revision: current.revision + 1 });
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
      const current = this.#store.getState();
      const { outcome, nextState } = foldAppliedBatch(current, events, {
        sessionId: this.#sessionId,
        reconciler: this.#reconciler,
        projectionRunner: this.#projectionRunner,
        preInitializationBuffer: this.#preInitializationBuffer,
        hueAllocator: this.#hueAllocator,
        waitingOnPersonRegister: this.#waitingOnPersonRegister,
        transcriptCap: this.#transcriptCap,
        retainedEnd: this.#retainedEnd,
      });
      if (nextState !== undefined) {
        this.#store.setState(nextState);
      }
      // Both readings go under this session's key so the pair lines up. The size is the transcript
      // (what the cap bounds) of the state just set; a batch that admitted nothing leaves the
      // gauge at its last reading.
      recordApplyLatency(this.#sessionId, readPerformanceMeterTime() - startedAt);
      if (nextState !== undefined) {
        recordStoreSize(this.#sessionId, nextState.transcript.length);
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
   * Which end of an over-cap log survives. A backward page moves the reader to the head, so the
   * cap cuts the end they left; cutting the other way would discard the page as it landed.
   */
  get #retainedEnd(): TranscriptRetainedEnd {
    return this.#earlierEventCount > 0 ? "oldest" : "newest";
  }
}
