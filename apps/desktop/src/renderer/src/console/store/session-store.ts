// The per-session store and its single apply chokepoint.
//
// One store per OPEN session (`Spec-023 §Console Libraries`, the state row), and
// exactly one way into it: `applyBatch`. Every wire event and every read response
// enters through that function, which validates, dedupes on
// `(sessionId, sequence)`, detects gaps, runs the registered projectors, and
// commits one immutable state transition. No component subscribes to the bridge
// and no component calls `setState`; the zustand store's setter is private to
// this class, so "the chokepoint" is a structural property rather than a
// convention a reviewer has to police.
//
// Why coalescing lives at the SOURCE rather than in the notifier: a store that
// updated its state synchronously but notified on a frame boundary would let
// `snapshot()` and what React last rendered disagree for a frame, and the first
// bug that costs is a control acting on a value the operator cannot see. Instead
// the bridge subscription drains into `ApplyQueue` and hands this class a BATCH,
// so N events in one frame are one transition and one notification, and state and
// notification never diverge.
//
// Sequencing rules, each of them a failure this store is required to survive:
//
//   • **An event before initialisation is buffered, never applied.** A store with
//     no base snapshot cannot tell a first event from a resumed stream, and
//     applying against an empty base renders a session that looks complete and is
//     not. Events buffer until `initialise()` supplies the read response, then
//     drain, with anything at or below the snapshot cursor dropped as already
//     included. That buffer is BOUNDED at `PRE_INITIALISATION_BUFFER_CAP`: a wait
//     longer than a handful of events is a read that is not coming rather than a
//     race, and a store that grew for it would hold a whole session's stream in
//     memory to project none of it. Past the bound the oldest is dropped, counted,
//     and the store marks itself degraded — and the drain re-derives exactly which
//     sequences the drop cost, because a hole between the snapshot cursor and the
//     oldest survivor is an ordinary gap.
//   • **A duplicate sequence is dropped, silently and countably.** Re-delivery is
//     ordinary on a resumed subscription.
//   • **A gap sets a sticky degraded flag.** A skipped sequence means the store's
//     projection is missing something; the flag clears only when a re-pull
//     completes, never on the next well-ordered event, because a later event
//     proves nothing about the one that never arrived. The re-pull that clears it
//     commonly answers at the cursor the store already reached — admitting event 7
//     over a cursor of 5 advances the cursor to 7 and leaves 6 missing, and 7 is
//     still the newest sequence that exists — so an EQUAL-cursor snapshot repairs a
//     degraded store. A snapshot BEHIND the cursor is still refused, which is the
//     idempotence the guard exists for.
//   • **A foreign `sessionId` is refused.** Two sessions never share a store.
//   • **A re-entrant apply is queued, drained, and reported.** A subscriber that
//     writes during notification is a defect; losing its event would be a second
//     one, so the event is kept and the tripwire fires.

import { createStore } from "zustand/vanilla";
import type { StoreApi } from "zustand/vanilla";

import { PRE_INITIALISATION_BUFFER_CAP, reportTripwire } from "../core/index.js";
import { ParticipantHueAllocator } from "../tokens/index.js";
import type {
  ConsoleEntity,
  ConsoleEntityKind,
  ConsoleEntityRef,
  ConsoleSessionEvent,
  EntityProjectorRegistry,
} from "./entities.js";
import { emptyPartitions } from "./entities.js";
import { toReadableStore, type ConsoleReadableStore } from "./readable.js";

/** Why a store is degraded. Rendered; never silently absorbed. */
export type SessionDegradedCause = "sequence-gap" | "subscription-closed" | "read-failed";

/** The immutable state one session store holds. */
export interface SessionStoreState {
  readonly sessionId: string;
  /** `false` until `initialise()` supplies a read response. */
  readonly initialised: boolean;
  /** Entity maps, one per kind. Only touched partitions change identity. */
  readonly partitions: Readonly<Record<ConsoleEntityKind, Readonly<Record<string, ConsoleEntity>>>>;
  /** Append-only ordered event log for the session, the ledger's source. */
  readonly timeline: readonly ConsoleSessionEvent[];
  /** The highest sequence this store has admitted. */
  readonly cursor: number;
  /** Sticky while the projection is known-incomplete; cleared only by a re-pull. */
  readonly degradedCause: SessionDegradedCause | undefined;
  /** Sequences observed as missing. Rendered by the degraded banner, not guessed at. */
  readonly gapSequences: readonly number[];
  /** Monotonic transition counter, so a test can assert coalescing by counting. */
  readonly revision: number;
}

/** Construction inputs. */
export interface SessionStoreOptions {
  readonly sessionId: string;
  /** Event-kind to projector. A kind with no projector contributes no entity. */
  readonly projectors?: EntityProjectorRegistry;
  /** Timeline rows retained. Unbounded when omitted; the ledger sets its own cap. */
  readonly timelineCap?: number;
}

/** The base state a read response establishes. */
export interface SessionSnapshot {
  /** The sequence the snapshot is current as of. */
  readonly cursor: number;
  /** Entities the read response carried. */
  readonly entities: readonly ConsoleEntity[];
  /** Participants in join-log order — the order the hue wheel is allocated in. */
  readonly participantJoinLog: readonly string[];
  /** Events the read response carried, ordered by sequence. */
  readonly timeline?: readonly ConsoleSessionEvent[];
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
}

const SITE = "console/store/session-store.ts";

export class SessionStore {
  readonly #sessionId: string;
  readonly #projectors: EntityProjectorRegistry;
  readonly #timelineCap: number | undefined;
  readonly #store: StoreApi<SessionStoreState>;
  readonly #hueAllocator = new ParticipantHueAllocator();
  readonly #admittedSequences = new Set<number>();
  readonly #preInitialisationBuffer: ConsoleSessionEvent[] = [];
  readonly #reentrantQueue: ConsoleSessionEvent[] = [];
  #preInitialisationDropCount = 0;
  #applying = false;

  public constructor(options: SessionStoreOptions) {
    this.#sessionId = options.sessionId;
    this.#projectors = options.projectors ?? {};
    this.#timelineCap = options.timelineCap;
    this.#store = createStore<SessionStoreState>(() => ({
      sessionId: options.sessionId,
      initialised: false,
      partitions: emptyPartitions(),
      timeline: [],
      cursor: -1,
      degradedCause: undefined,
      gapSequences: [],
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
    return this.#preInitialisationBuffer.length;
  }

  /**
   * Events this store dropped from the pre-initialisation buffer at the cap.
   *
   * Counted rather than merely dropped, on the posture the queue and the binder
   * already take one layer up: the drop is the correct response to a read that is
   * not coming, but a stream still filling a store nothing can project is a fault
   * upstream, and a count is how it becomes visible before any read lands.
   */
  public get preInitialisationDropCount(): number {
    return this.#preInitialisationDropCount;
  }

  /**
   * Establish the base state from a read response and drain anything that
   * arrived first.
   *
   * Idempotent against a rewind: a snapshot BEHIND the current cursor is refused,
   * so a racing re-read that has not seen the newest events cannot undo them. An
   * EQUAL-cursor snapshot is refused too while the store is healthy — it would
   * rebuild the whole projection on every ordinary focus refresh — but ADMITTED
   * while it is degraded, which is the one case where the two cursors agreeing
   * means the repair arrived rather than nothing changed: a store that admitted
   * event 7 over a cursor of 5 sits at cursor 7 with sequence 6 missing, and the
   * authoritative re-pull that carries 6 answers at cursor 7 because 7 is the
   * newest sequence there is. Refusing it left the projection short a row and the
   * sticky flag set until unrelated later activity happened to push the session
   * past 7.
   */
  public initialise(snapshot: SessionSnapshot): void {
    const current = this.#store.getState();
    if (current.initialised && !admitsSnapshotAt(snapshot.cursor, current)) {
      return;
    }

    for (const participantId of snapshot.participantJoinLog) {
      this.#hueAllocator.admit(participantId);
    }

    let partitions = emptyPartitions();
    for (const entity of snapshot.entities) {
      partitions = mergeUpsert(partitions, entity);
    }

    const timeline = [...(snapshot.timeline ?? [])].sort(
      (left, right) => left.sequence - right.sequence,
    );
    this.#admittedSequences.clear();
    for (const event of timeline) {
      this.#admittedSequences.add(event.sequence);
    }

    this.#store.setState({
      sessionId: this.#sessionId,
      initialised: true,
      partitions,
      timeline: capTimeline(timeline, this.#timelineCap),
      cursor: snapshot.cursor,
      // A re-pull is exactly what clears the sticky flag.
      degradedCause: undefined,
      gapSequences: [],
      revision: current.revision + 1,
    });

    const buffered = this.#preInitialisationBuffer.splice(0, this.#preInitialisationBuffer.length);
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
   * Takes a BATCH so a frame's worth of events is one transition; `apply` below
   * is sugar for a one-event batch and adds no second door.
   */
  public applyBatch(events: readonly ConsoleSessionEvent[]): ApplyOutcome {
    if (this.#applying) {
      this.#reentrantQueue.push(...events);
      reportTripwire(
        "apply-chokepoint-bypass",
        SITE,
        `re-entrant applyBatch of ${events.length} event(s) on session ${this.#sessionId}: a subscriber wrote during notification. The events are queued and will be applied, but the writing subscriber is the defect.`,
      );
      return {
        admitted: 0,
        duplicates: 0,
        buffered: events.length,
        refusedForeignSession: 0,
        gapDetected: false,
        droppedBeforeInitialisation: 0,
      };
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

    let partitions = current.partitions;
    let timeline = current.timeline;
    let cursor = current.cursor;
    const gapSequences: number[] = [...current.gapSequences];
    let appended: ConsoleSessionEvent[] | undefined;

    const ordered = [...events].sort((left, right) => left.sequence - right.sequence);

    for (const event of ordered) {
      if (event.sessionId !== this.#sessionId) {
        refusedForeignSession += 1;
        continue;
      }
      if (!current.initialised) {
        this.#preInitialisationBuffer.push(event);
        buffered += 1;
        if (this.#preInitialisationBuffer.length > PRE_INITIALISATION_BUFFER_CAP) {
          // The OLDEST goes, not the newest. The newest rows are the ones a person
          // is about to look at, and the loss the drop causes is reported either
          // way — as the gap between the snapshot cursor and the oldest survivor.
          this.#preInitialisationBuffer.shift();
          this.#preInitialisationDropCount += 1;
          droppedBeforeInitialisation += 1;
        }
        continue;
      }
      if (this.#admittedSequences.has(event.sequence) || event.sequence <= current.cursor) {
        duplicates += 1;
        continue;
      }
      if (event.sequence > cursor + 1) {
        for (let missing = cursor + 1; missing < event.sequence; missing += 1) {
          gapSequences.push(missing);
        }
        gapDetected = true;
      }

      if (event.actorParticipantId !== undefined) {
        this.#hueAllocator.admit(event.actorParticipantId);
      }

      const projector = Object.hasOwn(this.#projectors, event.kind)
        ? this.#projectors[event.kind]
        : undefined;
      if (projector !== undefined) {
        for (const mutation of projector(event)) {
          partitions =
            mutation.operation === "upsert"
              ? mergeUpsert(partitions, mutation.entity)
              : mergeRemoval(partitions, mutation.ref);
        }
      }

      this.#admittedSequences.add(event.sequence);
      cursor = Math.max(cursor, event.sequence);
      appended ??= [...timeline];
      appended.push(event);
      admitted += 1;
    }

    const outcome: ApplyOutcome = {
      admitted,
      duplicates,
      buffered,
      refusedForeignSession,
      gapDetected,
      droppedBeforeInitialisation,
    };
    if (admitted === 0 && !gapDetected && droppedBeforeInitialisation === 0) {
      return outcome;
    }

    if (appended !== undefined) {
      timeline = capTimeline(appended, this.#timelineCap);
    }

    this.#store.setState({
      ...current,
      partitions,
      timeline,
      cursor,
      // A drop at the cap is a known-incomplete projection for the same reason a
      // skipped sequence is, so it takes the same cause. The sequences it cost are
      // deliberately NOT pushed into `gapSequences` here — the drain re-derives
      // them against the base state, and pushing one row per dropped event would
      // trade a bounded buffer for an unbounded list.
      degradedCause:
        gapDetected || droppedBeforeInitialisation > 0 ? "sequence-gap" : current.degradedCause,
      gapSequences,
      revision: current.revision + 1,
    });

    return outcome;
  }
}

/**
 * Whether an initialised store takes a read response answering at this cursor.
 *
 * Ahead of the cursor is new state and always admitted. AT the cursor is admitted
 * only while the store is degraded, which is the repair case — and every cause
 * qualifies rather than `sequence-gap` alone, because a failed read and a closed
 * subscription are cleared by exactly the same completed re-pull and each of them
 * can leave the cursor standing still. Behind the cursor is never admitted.
 */
function admitsSnapshotAt(cursor: number, current: SessionStoreState): boolean {
  if (cursor > current.cursor) {
    return true;
  }
  return cursor === current.cursor && current.degradedCause !== undefined;
}

/** Every entity of one kind. A narrow pick, never a whole-pane object. */
export function selectPartition(
  state: SessionStoreState,
  kind: ConsoleEntityKind,
): Readonly<Record<string, ConsoleEntity>> {
  return state.partitions[kind];
}

/** One entity, or `undefined` when the store has never seen it. */
export function selectEntity(
  state: SessionStoreState,
  ref: ConsoleEntityRef,
): ConsoleEntity | undefined {
  return state.partitions[ref.kind][ref.id];
}

function mergeUpsert(
  partitions: Readonly<Record<ConsoleEntityKind, Readonly<Record<string, ConsoleEntity>>>>,
  entity: ConsoleEntity,
): Record<ConsoleEntityKind, Readonly<Record<string, ConsoleEntity>>> {
  const partition = partitions[entity.kind];
  const existing = partition[entity.id];
  const merged: ConsoleEntity = existing === undefined ? entity : { ...existing, ...entity };
  return {
    ...partitions,
    [entity.kind]: { ...partition, [entity.id]: merged },
  };
}

function mergeRemoval(
  partitions: Readonly<Record<ConsoleEntityKind, Readonly<Record<string, ConsoleEntity>>>>,
  ref: ConsoleEntityRef,
): Record<ConsoleEntityKind, Readonly<Record<string, ConsoleEntity>>> {
  const partition = partitions[ref.kind];
  if (!Object.hasOwn(partition, ref.id)) {
    return { ...partitions };
  }
  const next: Record<string, ConsoleEntity> = { ...partition };
  delete next[ref.id];
  return { ...partitions, [ref.kind]: next };
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
