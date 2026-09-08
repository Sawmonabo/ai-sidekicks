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
//   • `entity-projection.ts` — running one event's projector all-or-nothing.
//   • `entity-partitions.ts` — the immutable partition merges a mutation performs.
//   • `degradation.ts` — which cause survives when more than one is standing.
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

import { createStore } from "zustand/vanilla";
import type { StoreApi } from "zustand/vanilla";

import { reportTripwire } from "../core/index.js";
import { ParticipantHueAllocator } from "../tokens/index.js";
import { worstDegradedCause, type SessionDegradedCause } from "./degradation.js";
import { mergeEarlierWindow, type EarlierWindowMerge } from "./earlier-window.js";
import type { ConsoleSessionEvent, EntityProjectorRegistry } from "./entities.js";
import { EntityProjectionRunner } from "./entity-projection.js";
import { GenerationLatch, type CurrentGenerationClaim } from "./generation-latch.js";
import { PreInitialisationBuffer } from "./pre-initialisation-buffer.js";
import { toReadableStore, type ConsoleReadableStore } from "./readable.js";
import {
  SequenceReconciler,
  isReconcilableSequence,
  orderBatchBySequence,
} from "./sequence-reconciler.js";
import {
  admitsSnapshotAt,
  capTimeline,
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
export type { SessionDegradedCause } from "./degradation.js";
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
  readonly #reentrantQueue: ConsoleSessionEvent[] = [];
  #applying = false;
  /**
   * Rows this store holds that arrived from behind its window's head.
   *
   * Held as a count rather than as a flag because it is the reading a surface wants —
   * how much history has been re-admitted — and because zero is the same fact as "no
   * backward page has landed". It resets on `initialise`, which is the one act that
   * re-establishes where the window starts.
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

  /** Rows admitted from behind this window's head since the last read established it. */
  public get earlierEventCount(): number {
    return this.#earlierEventCount;
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
    const timeline = orderBatchBySequence(snapshot.timeline ?? []);
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
    try {
      return this.#applyBatchInner(events);
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
   * NOT A SECOND APPLY CHOKEPOINT, and every difference from `applyBatch` is a
   * property rather than a shortcut. It reconciles no sequence — every row is below
   * the cursor by construction, so the reconciler would classify each one as a
   * duplicate or a divergence and refuse the page wholesale. It runs no projector —
   * a partition holds the NEWEST state of an entity, and an older event's projector
   * would replace a run's current state with the one it was in before this window
   * opened. It moves no cursor, records no gap, and neither sets nor clears the
   * degraded flag: nothing about what this window is missing at the TAIL is decided
   * by a page from its head.
   *
   * A foreign session is refused here as it is there, and for the same reason: two
   * sessions never share a store, and a page routed to the wrong one would put
   * another session's rows under this session's ids.
   *
   * Answers what the merge did, so a caller can tell an exhausted walk (nothing
   * admitted, nothing overlapping) from a page asked for at the wrong position
   * (nothing admitted, every row refused as not-earlier).
   */
  public prependEarlierEvents(events: readonly ConsoleSessionEvent[]): EarlierWindowMerge {
    const current = this.#store.getState();
    const admissible = orderBatchBySequence(
      events.filter(
        (event) => event.sessionId === this.#sessionId && isReconcilableSequence(event.sequence),
      ),
    );
    const merge = mergeEarlierWindow(current.timeline, admissible);
    if (merge.admitted === 0) {
      return merge;
    }
    // Counted BEFORE the cap runs, because the count is what decides which end the
    // cap keeps: reading it back off the capped array would let the cap answer its
    // own question and cut the rows that just arrived.
    this.#earlierEventCount += merge.admitted;
    for (const event of admissible) {
      if (event.actorId !== undefined) {
        this.#hueAllocator.admit(event.actorId);
      }
    }
    this.#store.setState({
      ...current,
      timeline: capTimeline(merge.timeline, this.#timelineCap, this.#retainedEnd),
      revision: current.revision + 1,
    });
    return merge;
  }

  #applyBatchInner(events: readonly ConsoleSessionEvent[]): ApplyOutcome {
    const current = this.#store.getState();
    let admitted = 0;
    let duplicates = 0;
    let buffered = 0;
    let refusedForeignSession = 0;
    let gapDetected = false;
    let droppedBeforeInitialisation = 0;
    let refusedDivergedSequence = 0;
    let projectionFailures = 0;

    let partitions = current.partitions;
    let appended: ConsoleSessionEvent[] | undefined;

    for (const event of orderBatchBySequence(events)) {
      if (event.sessionId !== this.#sessionId) {
        refusedForeignSession += 1;
        continue;
      }
      if (!isReconcilableSequence(event.sequence)) {
        // Refused BEFORE the buffer: no base state makes such a sequence
        // applicable, so buffering it would only defer the same refusal.
        refusedDivergedSequence += 1;
        continue;
      }
      if (!current.initialised) {
        buffered += 1;
        if (this.#preInitialisationBuffer.push(event)) {
          droppedBeforeInitialisation += 1;
        }
        continue;
      }

      const admission = this.#reconciler.reconcile(event.sequence);
      if (admission.outcome === "duplicate") {
        duplicates += 1;
        continue;
      }
      if (admission.outcome === "diverged") {
        refusedDivergedSequence += 1;
        continue;
      }
      if (admission.openedGap !== undefined) {
        gapDetected = true;
      }

      const projected = this.#projectionRunner.run(partitions, event);
      if (projected === undefined) {
        projectionFailures += 1;
      } else {
        partitions = projected;
      }

      if (event.actorId !== undefined) {
        this.#hueAllocator.admit(event.actorId);
      }
      appended ??= [...current.timeline];
      appended.push(event);
      admitted += 1;
    }

    // The dedupe set answers only for sequences the cursor cannot. Released here
    // rather than never, so a session that runs all day holds a batch's worth of
    // numbers instead of its whole history.
    this.#reconciler.releaseSequencesAtOrBelowCursor();

    const outcome: ApplyOutcome = {
      admitted,
      duplicates,
      buffered,
      refusedForeignSession,
      gapDetected,
      droppedBeforeInitialisation,
      refusedDivergedSequence,
      projectionFailures,
    };
    if (
      admitted === 0 &&
      !gapDetected &&
      droppedBeforeInitialisation === 0 &&
      refusedDivergedSequence === 0
    ) {
      return outcome;
    }

    this.#store.setState({
      ...current,
      partitions,
      timeline:
        appended === undefined
          ? current.timeline
          : capTimeline(appended, this.#timelineCap, this.#retainedEnd),
      cursor: this.#reconciler.cursor,
      // A drop at the cap is a known-incomplete projection for the same reason a
      // skipped sequence is, so it takes the same cause. The sequences it cost are
      // deliberately NOT recorded here — the drain re-derives them against the base
      // state as an ordinary range.
      degradedCause: worstDegradedCause(
        current.degradedCause,
        refusedDivergedSequence > 0 ? "stream-diverged" : undefined,
        gapDetected || droppedBeforeInitialisation > 0 ? "sequence-gap" : undefined,
        projectionFailures > 0 ? "projection-failed" : undefined,
      ),
      gaps: this.#reconciler.gaps(),
      revision: current.revision + 1,
    });

    return outcome;
  }
}
