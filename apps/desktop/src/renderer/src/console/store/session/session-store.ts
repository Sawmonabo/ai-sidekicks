// The per-session store and its single apply chokepoint.
//
// One store per OPEN session (`Spec-023 §Console Libraries`, the state row), and
// exactly one way into it: `applyBatch`. Every wire event and every read response
// enters through that function, which validates, reconciles the sequence, runs the
// registered projectors, and commits one immutable state transition. No component
// subscribes to the bridge and no component calls `setState`; the zustand store's
// setter is private to this class, so "the chokepoint" is a structural property
// rather than a convention a reviewer has to police.
//
// Why coalescing lives at the SOURCE rather than in the notifier: a store that
// updated its state synchronously but notified on a frame boundary would let
// `snapshot()` and what React last rendered disagree for a frame, and the first bug
// that costs is a control acting on a value the operator cannot see. Instead the
// bridge subscription drains into `ApplyQueue` and hands this class a BATCH, so N
// events in one frame are one transition and one notification, and state and
// notification never diverge.
//
// This module is the ORCHESTRATION and owns none of the rules it applies. Each
// collaborator owns one, and states it where it lives:
//
//   • `sequence-reconciler.ts` — ordering, dedupe, the recorded holes, and the
//     divergence bound past which a sequence is refused rather than admitted.
//   • `pre-initialisation-buffer.ts` — the bounded hold for events that arrive
//     before a base state, and the counted drop at its cap.
//   • `store/entities/entity-projection.ts` — running one event's projector all-or-nothing.
//   • `store/entities/entity-partitions.ts` — the immutable partition merges a mutation performs.
//   • `store/degradation.ts` — which cause survives when more than one is standing.
//   • `session-state.ts` / `selectors.ts` — the committed state and its narrow reads.
//
// What is left here, and is genuinely this class's own:
//
//   • **A gap, a drop, or a projection failure sets a sticky degraded flag.** It
//     clears only when a re-pull completes, never on the next well-ordered event,
//     because a later event proves nothing about the one that never arrived. Which
//     re-pulls count is `admitsSnapshotAt`, in `session-state.ts`.
//   • **A foreign `sessionId` is refused.** Two sessions never share a store.
//   • **A re-entrant apply is queued, drained, and reported.** A subscriber that
//     writes during notification is a defect; losing its event would be a second
//     one, so the event is kept and the tripwire fires.
//   • **The log grows at the head through one door, and only backwards.** A session's
//     stream replays from the position this participant was last acknowledged at, so
//     the rows below `windowHeadCursor` exist and were never delivered here.
//     `prependEarlierEvents` is where a read of them lands, and it is not a second
//     apply chokepoint: it admits no row at or above the log's head, moves no cursor,
//     runs no projector, and clears no degraded flag. `earlier-window.ts` owns the
//     fold and says why each of those is a property rather than an omission. A read
//     of those rows is addressed from a head this store can move underneath it, so
//     `windowGeneration` publishes which window a page was asked under and the merge
//     is settled through it.
//   • **What is outstanding outlives the window.** The `timeline` above is one window
//     and it is capped, so a fold over it loses an approval the moment the row that
//     opened it is pruned or thrown away by the next read. `outstanding-asks/outstanding-ask-journal.ts`
//     holds those lifecycles instead — seeded from each base state, advanced by every
//     admitted row and every recovered one, and cleared by nothing this class does.

import { createStore } from "zustand/vanilla";
import type { StoreApi } from "zustand/vanilla";

import {
  perfMeterNow,
  recordApplyLatency,
  recordStoreSize,
  reportTripwire,
} from "../../core/index.js";
import { ParticipantHueAllocator } from "../../tokens/index.js";
import { foldAppliedBatch } from "./applied-batch-fold.js";
import { worstDegradedCause, type SessionDegradedCause } from "../degradation.js";
import { foldEarlierWindowPage, type EarlierWindowMerge } from "./earlier-window.js";
import {
  EntityProjectionRunner,
  type ConsoleSessionEvent,
  type EntityProjectorRegistry,
} from "../entities/index.js";
import { GenerationLatch, type CurrentGenerationClaim } from "../read/generation-latch.js";
import { OutstandingAskJournal, type OutstandingAskLedger } from "./outstanding-asks/index.js";
import { PreInitialisationBuffer } from "./pre-initialisation-buffer.js";
import { toReadableStore, type ConsoleReadableStore } from "../readable.js";
import { SequenceReconciler, orderBatchBySequence } from "./sequence-reconciler.js";
import {
  admitsSnapshotAt,
  establishedState,
  uninitialisedState,
  type TimelineRetainedEnd,
} from "./session-state.js";
import type { SessionSnapshot, SessionStoreState } from "./session-state.js";
import { NOTHING_APPLIED, type ApplyOutcome } from "./apply-outcome.js";

// The store's own vocabulary, re-exported from the door consumers already use: the
// declarations moved to the collaborators that own them, the names a caller writes
// did not. `SequenceGap` is the one name that does not come back through here — no
// module outside its owner imports it, so a second name for it would be an export
// with no reader, which the dead-code gate rejects. It is reached at its owner.
export type { SessionDegradedCause } from "../degradation.js";
export type { SessionSnapshot, SessionStoreState } from "./session-state.js";
export { selectEntity, selectPartition } from "./selectors.js";
export type { EarlierWindowMerge } from "./earlier-window.js";

/** Construction inputs. */
export interface SessionStoreOptions {
  readonly sessionId: string;
  /** Event-kind to projector. A kind with no projector contributes no entity. */
  readonly projectors?: EntityProjectorRegistry;
  /** Timeline rows retained. Unbounded when omitted; the ledger sets its own cap. */
  readonly timelineCap?: number;
}

const SITE = "console/store/session-store.ts";

/** The one key the window generation is claimed under. A store has one window. */
const WINDOW_GENERATION_KEY = "window";

export class SessionStore {
  readonly #sessionId: string;
  readonly #timelineCap: number | undefined;
  readonly #store: StoreApi<SessionStoreState>;
  readonly #hueAllocator = new ParticipantHueAllocator();
  readonly #reconciler = new SequenceReconciler();
  readonly #preInitialisationBuffer = new PreInitialisationBuffer();
  readonly #projectionRunner: EntityProjectionRunner;
  /**
   * What is still waiting on a person, held apart from the window it was learned from.
   *
   * Constructed here rather than handed in, because its lifetime is this store's and its
   * inputs are this store's: it is advanced by exactly the rows the apply chokepoint
   * admits and the rows the backward walk recovers, and a caller able to supply a second
   * register could publish a count over a session whose rows it never saw.
   */
  readonly #outstandingAsks = new OutstandingAskJournal();
  readonly #reentrantQueue: ConsoleSessionEvent[] = [];
  #applying = false;
  /**
   * Rows this store holds that arrived from behind its window's head.
   *
   * Private, and read by exactly one thing: `#retainedEnd`, which is the whole of what
   * the count is for — a log that has grown at its head is capped from the other end.
   * A count rather than a flag because zero is the same fact as "no backward page has
   * landed", and it resets on `initialise`, which is the one act that re-establishes
   * where the window starts.
   */
  #earlierEventCount = 0;
  readonly #windowGenerations = new GenerationLatch();
  /**
   * Which window this store's log is currently a view of.
   *
   * Re-taken by `initialise` and by nothing else, so it goes stale on exactly the act
   * that re-establishes where the window starts — including the read that answered at
   * the SAME position and still threw the old log away, which no comparison of head
   * cursors can see.
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
      uninitialisedState({ sessionId: options.sessionId, revision: 0 }),
    );
  }

  /** The session this store is bound to. */
  public get sessionId(): string {
    return this.#sessionId;
  }

  /** The zustand store React subscribes to. Read-only by type: no setter escapes. */
  public get readable(): ConsoleReadableStore<SessionStoreState> {
    return toReadableStore(this.#store);
  }

  /** The current state. Always the state React's last notification carried. */
  public snapshot(): SessionStoreState {
    return this.#store.getState();
  }

  /** The session's hue wheel. Allocation happens only through `initialise`/`applyBatch`. */
  public get hueAllocator(): ParticipantHueAllocator {
    return this.#hueAllocator;
  }

  /** Events waiting for a base state. Never more than `PRE_INITIALISATION_BUFFER_CAP`. */
  public get pendingPreInitialisationCount(): number {
    return this.#preInitialisationBuffer.pendingCount;
  }

  /** Events this store dropped from the pre-initialisation buffer at the cap. */
  public get preInitialisationDropCount(): number {
    return this.#preInitialisationBuffer.dropCount;
  }

  /** Sequences still retained for duplicate detection. Bounded by construction. */
  public get retainedDedupeSequenceCount(): number {
    return this.#reconciler.retainedSequenceCount;
  }

  /**
   * What this session still has open, as of every row this store has ever been given.
   *
   * A GETTER RATHER THAN A STATE MEMBER, on `paging-binding.ts`' precedent: the ledger
   * only ever moves on an act that also bumps `revision`, so a reader subscribed to that
   * re-asks exactly when it could have changed — and a mirror on the committed state
   * would be a second copy of a value whose whole point is that it is the register's.
   */
  public get outstandingAskLedger(): OutstandingAskLedger {
    return this.#outstandingAsks.ledger;
  }

  /**
   * A handle on the window this log is a view of, for a caller settling against it.
   *
   * FOR THE READER THAT ASKS FOR ROWS THIS WINDOW DOES NOT HOLD. Such a read is
   * addressed FROM a window head, and it can answer after a completed read has moved
   * that head — at which point its page names rows before a window this store has
   * left. Taking this claim at issue and settling through it is what lets that page be
   * discarded, and it is a handle rather than a number so the caller cannot re-derive
   * the comparison and get it wrong.
   *
   * The NARROW half of a claim: a reader may ask whether its round is still live and
   * may settle against it, and may not give the key back — the window is the store's
   * and ends when the next read re-establishes it.
   */
  public get windowGeneration(): CurrentGenerationClaim {
    return this.#windowGeneration;
  }

  /**
   * Which end of an over-cap log survives, right now.
   *
   * A backward page moves it, and that is the whole of the rule: a reader who asked
   * for the rows before the window's head has moved to the head, so the cap cuts the
   * end they left rather than the end they went to. Cutting the other way would
   * discard the page as it landed, and every press after it.
   */
  get #retainedEnd(): TimelineRetainedEnd {
    return this.#earlierEventCount > 0 ? "oldest" : "newest";
  }

  /**
   * Establish the base state from a read response and drain anything that arrived
   * first.
   *
   * Idempotent against a rewind, and admitting the equal-cursor repair: the whole
   * rule is `admitsSnapshotAt`, which reads the state this store commits.
   */
  public initialise(snapshot: SessionSnapshot): void {
    const current = this.#store.getState();
    if (current.initialised && !admitsSnapshotAt(snapshot.cursor, current)) {
      return;
    }

    for (const participantId of snapshot.participantJoinLog) {
      this.#hueAllocator.admit(participantId);
    }

    // A completed read re-establishes where the window STARTS, so whatever a backward
    // walk had re-admitted below the previous head is no longer a fact about this
    // window: the rows are re-delivered by the read itself or they are once again
    // outside it, and either way the count that decides the retained end is stale.
    this.#earlierEventCount = 0;
    // And the window itself is a NEW one, which is the same fact stated where a caller
    // can act on it: a backward read still in flight was addressed from the head this
    // act just replaced, so the claim it took at issue stops being current here and
    // its page settles nowhere.
    this.#windowGeneration = this.#windowGenerations.supersedeAndClaim(this, WINDOW_GENERATION_KEY);
    // AND THE OUTSTANDING LEDGER TAKES WHAT THIS READ ESTABLISHED WITHOUT LOSING WHAT IT
    // ALREADY HELD. The read re-establishes the WINDOW and says nothing about a request
    // it did not carry, so a register cleared here would throw away exactly the older
    // asks it exists to hold — which is the defect this whole seam answers. What the
    // seed does move is the window-head fact, because that is a property of this read.
    this.#outstandingAsks.seedFrom({
      entities: snapshot.entities,
      cursor: snapshot.cursor,
      windowHeadCursor: snapshot.readFromCursor,
    });
    const timeline = orderBatchBySequence(snapshot.timeline ?? []);
    this.#outstandingAsks.admit(timeline);
    this.#reconciler.rebaseTo(
      snapshot.cursor,
      timeline.map((event) => event.sequence),
    );

    // A re-pull is exactly what clears the sticky flag, and the builder is where that
    // happens: every other path merges the cause upward and never drops it.
    this.#store.setState(
      establishedState({
        sessionId: this.#sessionId,
        snapshot,
        orderedTimeline: timeline,
        timelineCap: this.#timelineCap,
        revision: current.revision + 1,
      }),
    );

    const buffered = this.#preInitialisationBuffer.drain();
    if (buffered.length > 0) {
      this.applyBatch(buffered);
    }
  }

  /**
   * Mark the store degraded without a re-pull — a closed subscription, a failed
   * read.
   *
   * MERGED through the same ladder an apply uses rather than assigned. An
   * assignment would downgrade a `stream-diverged` store to `read-failed` the
   * moment its repair read rejected, and overwrite a recorded sequence gap with a
   * later subscription closure — in both cases reporting a repair that never
   * happened, on a flag only a completed re-pull clears.
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
   * The apply chokepoint. The only writer of this store's state.
   *
   * Takes a BATCH so a frame's worth of events is one transition; `apply` below is
   * sugar for a one-event batch and adds no second door.
   */
  public applyBatch(events: readonly ConsoleSessionEvent[]): ApplyOutcome {
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
    // Sampled inside the define's branch, so a release build folds the read away with
    // the recording below and the chokepoint's cost is one branch on a build-time
    // literal that Rollup removes.
    const startedAt = __SIDEKICKS_CONSOLE_FIXTURES__ ? perfMeterNow() : 0;
    try {
      const current = this.#store.getState();
      const { outcome, nextState } = foldAppliedBatch(current, events, {
        sessionId: this.#sessionId,
        reconciler: this.#reconciler,
        projectionRunner: this.#projectionRunner,
        preInitialisationBuffer: this.#preInitialisationBuffer,
        hueAllocator: this.#hueAllocator,
        outstandingAsks: this.#outstandingAsks,
        timelineCap: this.#timelineCap,
        retainedEnd: this.#retainedEnd,
      });
      if (nextState !== undefined) {
        this.#store.setState(nextState);
      }
      if (__SIDEKICKS_CONSOLE_FIXTURES__) {
        // Both readings under one key, this store's session: the latency is what the
        // fold cost and the size is what it left behind, and reading them under two
        // keys would make the pair impossible to line up.
        //
        // The size is taken from the state that was just SET rather than re-read from
        // the store, and it is the timeline rather than the partitions because the
        // timeline is what the cap bounds and what the ledger mounts from. A batch
        // that admitted nothing leaves `nextState` undefined and the gauge holds its
        // last reading, which is correct: nothing changed.
        recordApplyLatency(this.#sessionId, perfMeterNow() - startedAt);
        if (nextState !== undefined) {
          recordStoreSize(this.#sessionId, nextState.timeline.length);
        }
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
  public apply(event: ConsoleSessionEvent): ApplyOutcome {
    return this.applyBatch([event]);
  }

  /**
   * Grow the log at its head with a page read from behind
   * {@link SessionStoreState.windowHeadCursor}.
   *
   * NOT A SECOND APPLY CHOKEPOINT, and `earlier-window.ts` states every difference
   * from `applyBatch` as a property rather than a shortcut — no sequence reconciled,
   * no projector run, no cursor moved, no gap recorded, and the degraded flag neither
   * set nor cleared. What it DOES advance is the outstanding-ask register, because a
   * recovered row is the one thing a backward page is worth to it.
   *
   * Answers what the merge did, so a caller can tell an exhausted walk (nothing
   * admitted, nothing overlapping) from a page asked for at the wrong position
   * (nothing admitted, every row refused as not-earlier).
   */
  public prependEarlierEvents(events: readonly ConsoleSessionEvent[]): EarlierWindowMerge {
    const current = this.#store.getState();
    const { merge, nextState } = foldEarlierWindowPage(current, events, {
      sessionId: this.#sessionId,
      hueAllocator: this.#hueAllocator,
      outstandingAsks: this.#outstandingAsks,
      timelineCap: this.#timelineCap,
    });
    if (nextState === undefined) {
      return merge;
    }
    this.#earlierEventCount += merge.admitted;
    this.#store.setState(nextState);
    return merge;
  }
}
