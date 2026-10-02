// The per-session store and its single apply chokepoint. One store per open session, and one
// way in: `applyBatch`, which validates, reconciles the sequence, runs the projectors and commits
// one immutable transition. The zustand setter is private, so the chokepoint is structural.
// Events drain into `ApplyQueue` and arrive as a batch, so N events in one frame are one
// notification and `snapshot()` never disagrees with what React last rendered.
//
// Its dependencies own their rules: `sequence-reconciler.ts` (ordering, dedupe, holes, divergence),
// `pre-initialization-buffer.ts`, `entities/entity-projection-runner.ts`,
// `entities/entity-partitions.ts`, `../session-degradation.ts` and `session-state.ts`.
//
// This class owns:
//   - A sticky degraded flag set by a gap, a drop or a projection failure and cleared only by a
//     completed re-pull (`admitsSnapshotAt`), since a later event proves nothing about the one
//     that never arrived.
//   - Refusal of a foreign `sessionId`.
//   - A re-entrant apply is queued, drained and reported, never lost.
//   - `prependEarlierEvents`, the only way the log grows at its head: rows below
//     `windowHeadCursor` exist but were never delivered here. It admits nothing at or above the
//     head, moves no cursor, runs no projector and clears no flag (`earlier-window.ts`).
//     `windowGeneration` says which window a page was asked under.
//   - What is outstanding outlives the capped timeline: `waiting-on-person/
//     waiting-on-person-register.ts` holds it, seeded by each base state and advanced by every
//     admitted or recovered row.

import { createStore } from "zustand/vanilla";
import type { StoreApi } from "zustand/vanilla";

import {
  readPerformanceMeterTime,
  recordApplyLatency,
  recordStoreSize,
} from "@renderer/lib/performance-meters/performance-meters.js";
import { reportTripwire } from "@renderer/lib/tripwires.js";
import { AgentHueAllocator } from "@renderer/styles/agent-hue.js";
import { foldAppliedBatch } from "./applied-batch-fold.js";
import { worstDegradedCause, type SessionDegradedCause } from "../session-degradation.js";
import { foldEarlierWindowPage, type EarlierWindowMerge } from "./earlier-window.js";
import { EntityProjectionRunner } from "./entities/entity-projection-runner.js";
import { type ProjectedSessionEvent, type EntityProjectorTable } from "./entities/entities.js";
import {
  GenerationLatch,
  type CurrentGenerationClaim,
} from "@renderer/lib/reads/generation-latch.js";
import {
  WaitingOnPersonRegister,
  type WaitingOnPersonRecords,
} from "./waiting-on-person/waiting-on-person-register.js";
import { PreInitializationBuffer } from "./pre-initialization-buffer.js";
import { toReadableStore, type ReadableStore } from "../readable-store.js";
import { SequenceReconciler, orderBatchBySequence } from "./sequence-reconciler.js";
import {
  admitsSnapshotAt,
  establishedState,
  uninitializedState,
  type TimelineRetainedEnd,
} from "./session-state.js";
import type { SessionSnapshot, SessionStoreState } from "./session-state.js";
import { NOTHING_APPLIED, type ApplyOutcome } from "./apply-outcome.js";

// The store's vocabulary, re-exported so callers need not know which dependency declares it.
// `SequenceGap` is not: nothing outside its owner imports it.
export type { SessionDegradedCause } from "../session-degradation.js";
export type { SessionSnapshot, SessionStoreState } from "./session-state.js";
export { selectEntity, selectPartition } from "./session-selectors.js";
export type { EarlierWindowMerge } from "./earlier-window.js";

/** Construction inputs. */
export interface SessionStoreOptions {
  readonly sessionId: string;
  /** Event-kind to projector. A kind with no projector contributes no entity. */
  readonly projectors?: EntityProjectorTable;
  /** Timeline rows retained. Unbounded when omitted; the transcript sets its own cap. */
  readonly timelineCap?: number;
}

const SITE = "store/session/session-store.ts";

/** The one key the window generation is claimed under. A store has one window. */
const WINDOW_GENERATION_KEY = "window";

/**
 * The per-session store: state, the sequence reconciler and the projectors behind the single
 * `applyBatch` chokepoint. `initialize` establishes the base state; nothing else writes.
 */
export class SessionStore {
  readonly #sessionId: string;
  readonly #timelineCap: number | undefined;
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
    this.#timelineCap = options.timelineCap;
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

  /** Events this store dropped from the pre-initialization buffer at the cap. */
  public get preInitializationDropCount(): number {
    return this.#preInitializationBuffer.dropCount;
  }

  /** Sequences still retained for duplicate detection. Bounded by construction. */
  public get retainedDedupeSequenceCount(): number {
    return this.#reconciler.retainedSequenceCount;
  }

  /**
   * What this session still has open, as of every row this store has ever been given. A getter,
   * not a state member: the ledger moves only on an act that also bumps `revision`, so a
   * reader subscribed to that re-asks when it could have changed.
   */
  public get outstandingAskLedger(): WaitingOnPersonRecords {
    return this.#waitingOnPersonRegister.ledger;
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
   * Idempotent against a rewind and admits the equal-cursor repair (`admitsSnapshotAt`).
   */
  public initialize(snapshot: SessionSnapshot): void {
    const current = this.#store.getState();
    if (current.initialized && !admitsSnapshotAt(snapshot.cursor, current)) {
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
      entities: snapshot.entities,
      cursor: snapshot.cursor,
      windowHeadCursor: snapshot.readFromCursor,
    });
    const timeline = orderBatchBySequence(snapshot.timeline ?? []);
    this.#waitingOnPersonRegister.admit(timeline);
    this.#reconciler.rebaseTo(
      snapshot.cursor,
      timeline.map((event) => event.sequence),
    );

    // A re-pull clears the sticky flag here; every other path merges the cause upward.
    this.#store.setState(
      establishedState({
        sessionId: this.#sessionId,
        snapshot,
        orderedTimeline: timeline,
        timelineCap: this.#timelineCap,
        revision: current.revision + 1,
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
   * read failed. The next read that lands clears both.
   */
  public markReadFailed(): void {
    const current = this.#store.getState();
    const merged = worstDegradedCause(current.degradedCause, "read-failed");
    if (merged === current.degradedCause && current.lastReadFailed) {
      return;
    }
    this.#store.setState({
      ...current,
      degradedCause: merged,
      lastReadFailed: true,
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
        `re-entrant applyBatch of ${events.length} event(s) on session ${this.#sessionId}: a subscriber wrote during notification. The events are queued and will be applied, but the writing subscriber is the defect.`,
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
        timelineCap: this.#timelineCap,
        retainedEnd: this.#retainedEnd,
      });
      if (nextState !== undefined) {
        this.#store.setState(nextState);
      }
      // Both readings go under this session's key so the pair lines up. The size is the timeline
      // (what the cap bounds) of the state just set; a batch that admitted nothing leaves the
      // gauge at its last reading.
      recordApplyLatency(this.#sessionId, readPerformanceMeterTime() - startedAt);
      if (nextState !== undefined) {
        recordStoreSize(this.#sessionId, nextState.timeline.length);
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
      timelineCap: this.#timelineCap,
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
  get #retainedEnd(): TimelineRetainedEnd {
    return this.#earlierEventCount > 0 ? "oldest" : "newest";
  }
}
