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

import { createStore } from "zustand/vanilla";
import type { StoreApi } from "zustand/vanilla";

import { reportTripwire } from "../core/index.js";
import { ParticipantHueAllocator } from "../tokens/index.js";
import { worstDegradedCause, type SessionDegradedCause } from "./degradation.js";
import type { ConsoleSessionEvent, EntityProjectorRegistry } from "./entities.js";
import { emptyPartitions } from "./entities.js";
import { mergeUpsert, type SessionPartitions } from "./entity-partitions.js";
import { EntityProjectionRunner } from "./entity-projection.js";
import { PreInitialisationBuffer } from "./pre-initialisation-buffer.js";
import { toReadableStore, type ConsoleReadableStore } from "./readable.js";
import {
  SequenceReconciler,
  isReconcilableSequence,
  orderBatchBySequence,
} from "./sequence-reconciler.js";
import { admitsSnapshotAt } from "./session-state.js";
import type { SessionSnapshot, SessionStoreState } from "./session-state.js";

// The store's own vocabulary, re-exported from the door consumers already use: the
// declarations moved to the collaborators that own them, the names a caller writes
// did not. `SequenceGap` is the one name that does not come back through here — no
// module outside its owner imports it, so a second name for it would be an export
// with no reader, which the dead-code gate rejects. It is reached at its owner.
export type { SessionDegradedCause } from "./degradation.js";
export type { SessionSnapshot, SessionStoreState } from "./session-state.js";
export { selectEntity, selectPartition } from "./selectors.js";

/** Construction inputs. */
export interface SessionStoreOptions {
  readonly sessionId: string;
  /** Event-kind to projector. A kind with no projector contributes no entity. */
  readonly projectors?: EntityProjectorRegistry;
  /** Timeline rows retained. Unbounded when omitted; the ledger sets its own cap. */
  readonly timelineCap?: number;
}

/** What one `applyBatch` call did. Returned so callers can count rather than infer. */
export interface ApplyOutcome {
  readonly admitted: number;
  readonly duplicates: number;
  readonly buffered: number;
  readonly refusedForeignSession: number;
  readonly gapDetected: boolean;
  /** Buffered events this batch pushed past `PRE_INITIALISATION_BUFFER_CAP`. */
  readonly droppedBeforeInitialisation: number;
  /**
   * Events refused because their sequence cannot be reconciled with this store's:
   * a jump past `MAX_REPAIRABLE_SEQUENCE_GAP` of accumulated loss, or a value no
   * cursor arithmetic can survive.
   */
  readonly refusedDivergedSequence: number;
  /** Events whose registered projector threw. The event landed; its entities did not. */
  readonly projectionFailures: number;
}

const SITE = "console/store/session-store.ts";

/** Nothing reached the state. `buffered` is the caller's, because only it knows. */
const NOTHING_APPLIED: Omit<ApplyOutcome, "buffered"> = {
  admitted: 0,
  duplicates: 0,
  refusedForeignSession: 0,
  gapDetected: false,
  droppedBeforeInitialisation: 0,
  refusedDivergedSequence: 0,
  projectionFailures: 0,
};

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

  public constructor(options: SessionStoreOptions) {
    this.#sessionId = options.sessionId;
    this.#timelineCap = options.timelineCap;
    this.#projectionRunner = new EntityProjectionRunner(options.projectors ?? {});
    this.#store = createStore<SessionStoreState>(() => ({
      sessionId: options.sessionId,
      initialised: false,
      partitions: emptyPartitions(),
      timeline: [],
      cursor: -1,
      degradedCause: undefined,
      gaps: [],
      revision: 0,
    }));
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

    let partitions: SessionPartitions = emptyPartitions();
    for (const entity of snapshot.entities) {
      partitions = mergeUpsert(partitions, entity);
    }

    const timeline = orderBatchBySequence(snapshot.timeline ?? []);
    this.#reconciler.rebaseTo(
      snapshot.cursor,
      timeline.map((event) => event.sequence),
    );

    this.#store.setState({
      sessionId: this.#sessionId,
      initialised: true,
      partitions,
      timeline: capTimeline(timeline, this.#timelineCap),
      cursor: snapshot.cursor,
      // A re-pull is exactly what clears the sticky flag.
      degradedCause: undefined,
      gaps: [],
      revision: current.revision + 1,
    });

    const buffered = this.#preInitialisationBuffer.drain();
    if (buffered.length > 0) {
      this.applyBatch(buffered);
    }
  }

  /** Mark the store degraded without a re-pull — a closed subscription, a failed read. */
  public markDegraded(cause: SessionDegradedCause): void {
    const current = this.#store.getState();
    if (current.degradedCause === cause) {
      return;
    }
    this.#store.setState({ ...current, degradedCause: cause, revision: current.revision + 1 });
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

      if (event.actorParticipantId !== undefined) {
        this.#hueAllocator.admit(event.actorParticipantId);
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
        appended === undefined ? current.timeline : capTimeline(appended, this.#timelineCap),
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

function capTimeline(
  timeline: readonly ConsoleSessionEvent[],
  cap: number | undefined,
): readonly ConsoleSessionEvent[] {
  if (cap === undefined || timeline.length <= cap) {
    return timeline;
  }
  return timeline.slice(timeline.length - cap);
}
