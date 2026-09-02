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
//     ordinary on a resumed subscription. The dedupe set answers only for
//     sequences the CURSOR cannot — anything at or below it is refused without
//     help — so entries are released at each batch boundary and the set stays a
//     batch wide rather than growing one number per event for the session's life,
//     behind a timeline the cap has already trimmed.
//   • **A gap is a bounded RANGE, and past a bound it is a different stream.** A
//     hole is recorded as `[from, to]` and never enumerated: a delivered sequence
//     is untrusted arithmetic, and walking from the cursor to it would let one
//     event cost the renderer a billion allocations before the store could say
//     anything at all. Past `MAX_REPAIRABLE_SEQUENCE_GAP` of ACCUMULATED loss —
//     and for any sequence too large or too malformed to increment reliably — the
//     event is refused rather than admitted, because admitting it would move the
//     cursor to a position an authoritative read may never answer at and every
//     later repair would then be refused as a rewind. The refusal is neither a
//     throw nor silent: it is the `stream-diverged` cause, and a snapshot read is
//     the repair.
//   • **A projector that throws costs its own event's entities and nothing else.**
//     A projector is required to be pure and total; one that rejects a malformed
//     payload is a defect in the view family that registered it, and letting it
//     escape would take the whole batch with it and leave the store half-mutated.
//     The mutation list is applied all-or-nothing, the event is still admitted —
//     it arrived, and the timeline is the ledger — and the missing projection is
//     NAMED as `projection-failed`, which only a re-pull clears.
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

import {
  MAX_REPAIRABLE_SEQUENCE_GAP,
  PRE_INITIALISATION_BUFFER_CAP,
  reportTripwire,
} from "../core/index.js";
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

/**
 * Why a store is degraded, worst first. Rendered; never silently absorbed.
 *
 * The ORDER is load-bearing rather than incidental, which is why this is a tuple
 * and the union below is derived from it: a batch can raise more than one at
 * once and the banner states one fact, so the cause that survives is the worst
 * standing one. `stream-diverged` says the store could not follow the stream at
 * all; `sequence-gap` that named rows are missing from it; `projection-failed`
 * that a row landed and its entity contribution did not; the last two are set by
 * `markDegraded` for a wire that stopped rather than for anything the apply saw.
 * Every one of them is cleared by the same completed re-pull, and by nothing
 * else — so a later, milder fact never downgrades an earlier one.
 */
const SESSION_DEGRADED_CAUSES = [
  "stream-diverged",
  "sequence-gap",
  "projection-failed",
  "subscription-closed",
  "read-failed",
] as const;

/** One degraded cause, derived from the ordered enumeration above. */
export type SessionDegradedCause = (typeof SESSION_DEGRADED_CAUSES)[number];

/**
 * A contiguous run of sequences the store never saw, inclusive at both ends.
 *
 * A RANGE rather than one entry per sequence, and that is the whole point: the
 * width comes from a delivered event, so enumerating it hands untrusted
 * arithmetic control of how much the renderer allocates.
 */
export interface SequenceGap {
  readonly fromSequence: number;
  readonly toSequence: number;
}

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
  /**
   * Runs of sequences observed as missing, oldest first. Rendered by the degraded
   * banner, not guessed at — and bounded, because the accumulated width they
   * describe is what `MAX_REPAIRABLE_SEQUENCE_GAP` caps.
   */
  readonly gaps: readonly SequenceGap[];
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
   * Sequences still retained for duplicate detection.
   *
   * Bounded by construction: everything at or below the cursor is released at the
   * batch boundary, because the cursor test already refuses it. Exposed so the
   * steady-heap claim is COUNTED rather than asserted — a set that grew with the
   * session would be invisible behind a capped timeline.
   */
  public get retainedDedupeSequenceCount(): number {
    return this.#admittedSequences.size;
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
    this.#releaseAdmittedSequencesAtOrBelow(snapshot.cursor);

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
        refusedDivergedSequence: 0,
        projectionFailures: 0,
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
    let refusedDivergedSequence = 0;
    let projectionFailures = 0;

    let partitions = current.partitions;
    let timeline = current.timeline;
    let cursor = current.cursor;
    const gaps: SequenceGap[] = [...current.gaps];
    // Re-derived from the ranges rather than held as a second state field, so the
    // bound can never disagree with the list it bounds. Normally there are no
    // ranges at all, which makes this free.
    let missingSequenceCount = totalMissingIn(gaps);
    let appended: ConsoleSessionEvent[] | undefined;

    const ordered = [...events].sort(compareBySequence);

    for (const event of ordered) {
      if (event.sessionId !== this.#sessionId) {
        refusedForeignSession += 1;
        continue;
      }
      if (!Number.isSafeInteger(event.sequence)) {
        // Refused BEFORE the buffer, because no base state makes such a sequence
        // applicable: `Math.max(cursor, NaN)` is `NaN` and every comparison
        // against that cursor is false afterwards, so one of these admitted would
        // silently disarm dedupe, gap detection, and the rewind guard together —
        // for the rest of the session, with nothing to see.
        refusedDivergedSequence += 1;
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
      const missingBefore = event.sequence - (cursor + 1);
      if (missingSequenceCount + missingBefore > MAX_REPAIRABLE_SEQUENCE_GAP) {
        // Refused rather than admitted with a wider hole recorded. Admitting it
        // would put the cursor somewhere no authoritative read need ever answer
        // at, and `admitsSnapshotAt` would then refuse every real repair as a
        // rewind — a store degraded with no way back.
        refusedDivergedSequence += 1;
        continue;
      }
      if (missingBefore > 0) {
        gaps.push({ fromSequence: cursor + 1, toSequence: event.sequence - 1 });
        missingSequenceCount += missingBefore;
        gapDetected = true;
      }

      const projected = this.#project(partitions, event);
      if (projected === undefined) {
        projectionFailures += 1;
      } else {
        partitions = projected;
      }

      if (event.actorParticipantId !== undefined) {
        this.#hueAllocator.admit(event.actorParticipantId);
      }
      this.#admittedSequences.add(event.sequence);
      cursor = Math.max(cursor, event.sequence);
      appended ??= [...timeline];
      appended.push(event);
      admitted += 1;
    }

    // The dedupe set answers only for sequences the cursor cannot. Released here
    // rather than never, so a session that runs all day holds a batch's worth of
    // numbers instead of its whole history.
    this.#releaseAdmittedSequencesAtOrBelow(cursor);

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
      // deliberately NOT recorded here — the drain re-derives them against the
      // base state as an ordinary range.
      degradedCause: worstCause(current.degradedCause, {
        diverged: refusedDivergedSequence > 0,
        gapped: gapDetected || droppedBeforeInitialisation > 0,
        projectionFailed: projectionFailures > 0,
      }),
      gaps,
      revision: current.revision + 1,
    });

    return outcome;
  }

  /**
   * Apply one event's projection, or answer `undefined` when the projector
   * rejected it.
   *
   * All-or-nothing: the merges accumulate onto a scratch value and only the
   * completed one is returned, so a projector that throws — or a mutation naming
   * a kind that does not exist — leaves the caller's partitions exactly as they
   * were. Half a transition nothing will ever complete is worse than none of it,
   * and the store's own degraded vocabulary is where the loss is reported.
   */
  #project(
    partitions: Readonly<Record<ConsoleEntityKind, Readonly<Record<string, ConsoleEntity>>>>,
    event: ConsoleSessionEvent,
  ): Readonly<Record<ConsoleEntityKind, Readonly<Record<string, ConsoleEntity>>>> | undefined {
    const projector = Object.hasOwn(this.#projectors, event.kind)
      ? this.#projectors[event.kind]
      : undefined;
    if (projector === undefined) {
      return partitions;
    }
    let projected = partitions;
    try {
      for (const mutation of projector(event)) {
        projected =
          mutation.operation === "upsert"
            ? mergeUpsert(projected, mutation.entity)
            : mergeRemoval(projected, mutation.ref);
      }
    } catch {
      return undefined;
    }
    return projected;
  }

  /** Forget dedupe entries the cursor now refuses on its own. */
  #releaseAdmittedSequencesAtOrBelow(cursor: number): void {
    for (const sequence of this.#admittedSequences) {
      if (sequence <= cursor) {
        this.#admittedSequences.delete(sequence);
      }
    }
  }
}

/**
 * Batch order, by sequence.
 *
 * Total on purpose. The obvious `left.sequence - right.sequence` returns `NaN`
 * for a malformed sequence, and a comparator that answers `NaN` leaves the sort
 * order of the whole batch undefined — so one hostile event would decide the
 * order of every well-formed one beside it. Anything the cursor cannot carry
 * sorts last, together, and the loop refuses each of them.
 */
function compareBySequence(left: ConsoleSessionEvent, right: ConsoleSessionEvent): number {
  const leftKey = sortKeyFor(left.sequence);
  const rightKey = sortKeyFor(right.sequence);
  if (leftKey < rightKey) {
    return -1;
  }
  return leftKey > rightKey ? 1 : 0;
}

function sortKeyFor(sequence: number): number {
  return Number.isSafeInteger(sequence) ? sequence : Number.MAX_SAFE_INTEGER;
}

/** Sequences the recorded ranges say are missing. Ranges are inclusive and disjoint. */
function totalMissingIn(gaps: readonly SequenceGap[]): number {
  let total = 0;
  for (const gap of gaps) {
    total += gap.toSequence - gap.fromSequence + 1;
  }
  return total;
}

/** What one batch observed about its own completeness. */
interface RaisedCauses {
  readonly diverged: boolean;
  readonly gapped: boolean;
  readonly projectionFailed: boolean;
}

/**
 * The cause the store carries after a batch: the worst of what it already had
 * and what this batch raised.
 *
 * Taking the worst rather than the newest is what keeps the flag honest. Only a
 * re-pull clears it, so a store that could not follow the stream and then took an
 * ordinary one-row hole has not become less broken — reporting the hole would
 * describe a repair that never happened.
 */
function worstCause(
  existing: SessionDegradedCause | undefined,
  raised: RaisedCauses,
): SessionDegradedCause | undefined {
  const candidates: SessionDegradedCause[] = [];
  if (existing !== undefined) {
    candidates.push(existing);
  }
  if (raised.diverged) {
    candidates.push("stream-diverged");
  }
  if (raised.gapped) {
    candidates.push("sequence-gap");
  }
  if (raised.projectionFailed) {
    candidates.push("projection-failed");
  }
  let worst: SessionDegradedCause | undefined;
  for (const candidate of candidates) {
    if (
      worst === undefined ||
      SESSION_DEGRADED_CAUSES.indexOf(candidate) < SESSION_DEGRADED_CAUSES.indexOf(worst)
    ) {
      worst = candidate;
    }
  }
  return worst;
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
  const merged: ConsoleEntity = existing === undefined ? entity : mergeOnto(existing, entity);
  return {
    ...partitions,
    [entity.kind]: { ...partition, [entity.id]: merged },
  };
}

/**
 * One upsert onto the entity already stored, ONE LEVEL DEEP THROUGH `body`.
 *
 * The top-level spread is what makes an incremental projector expressible at all:
 * an upsert that names only `touchedAt` keeps the `state` the last transition
 * established. The body is merged on the same terms rather than replaced, because
 * a projector is PURE — it cannot read the stored entity — so a wholesale
 * replacement would make "add this member, keep the rest" unexpressible and every
 * event would have to restate every member the wire happens not to repeat. A run
 * whose `run.queued` named its agent would lose the agent on its next transition,
 * silently and looking exactly like a run that never had one.
 *
 * A projector that means to CLEAR a member removes the entity and upserts it
 * fresh, which is the mutation pair the vocabulary already has.
 */
function mergeOnto(existing: ConsoleEntity, upsert: ConsoleEntity): ConsoleEntity {
  const mergedBody =
    existing.body === undefined || upsert.body === undefined
      ? undefined
      : { ...existing.body, ...upsert.body };
  return {
    ...existing,
    ...upsert,
    ...(mergedBody === undefined ? {} : { body: mergedBody }),
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
