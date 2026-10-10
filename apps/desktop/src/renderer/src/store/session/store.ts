// The per-session store and its single apply chokepoint, `applyBatch`: it validates, reconciles
// the sequence, runs the projectors and commits one immutable transition. The zustand setter is
// private, so the chokepoint is structural, and a re-entrant apply is queued and drained, never
// lost.
//
// The store holds a window of the session's log, not the log: a read places it, the reader's pages
// grow it at either edge (`transcript-window.ts`), `releaseOutside` lets go of what lies far from
// the reading position, and `releaseBeyondNewest` bounds a session no screen shows. The stream
// keeps folding into the entities, the waiting-on-person register and the standing events whether
// or not the window's tail follows it, so what is outstanding, and every fact a standing event
// carries, outlives every row the window let go.
//
// The degraded flag is sticky: a gap, a drop or a projection failure sets it, and only a completed
// read clears it, since a later event proves nothing about the one that never arrived. A read that
// places a window (the first, or the snapshot taken past a hole too wide to fill) replaces it
// whole. A repair read keeps the window and takes the stream up again where the window can be
// (`RepairResumePoint`): a whole window stands, and a broken one replays (`repair-replay.ts`)
// from its last whole row, or from its head when nothing else will do. What the stream sends
// again folds off screen while the window keeps its rows and its cause, and the replay is swapped
// in once it passes the newest row the window was sent, so no state between the hole and the
// repair reads as whole or as empty. A repair during a replay is taken up from the replay.

import { createStore } from "zustand/vanilla";
import type { StoreApi } from "zustand/vanilla";
import type { EventCursor } from "@ai-sidekicks/contracts/session/event-cursor";
import type { TranscriptBodyReadResponse } from "@ai-sidekicks/contracts/transcript/content";

import {
  readPerformanceMeterTime,
  recordApplyLatency,
  recordStoreSize,
} from "#renderer/lib/performance-meters/registry.js";
import { reportTripwire } from "#renderer/lib/tripwires/registry.js";
import { AgentHueAllocator } from "#renderer/styles/agent-hue.js";
import { foldAppliedBatch, type AppliedBatch } from "./apply/batch-fold.js";
import {
  isRaisedAgainOnReplay,
  worstDegradedCause,
  type SessionDegradedCause,
} from "./degradation.js";
import {
  admitFullBody,
  foldEarlierWindowPage,
  foldLaterWindowPage,
  foldLogEndPage,
  releaseBeyondNewest,
  releaseOutsideKept,
  type EarlierWindowMerge,
  type LaterWindowMerge,
  type LogEndPageMerge,
  type TranscriptPageDependencies,
} from "./transcript-window.js";
import { EntityProjectionRunner } from "./entities/projection-runner.js";
import { mergeUpsert, type SessionPartitions } from "./entities/partitions.js";
import {
  emptyPartitions,
  type EntityProjectorTable,
  type ProjectedSessionEvent,
  type StoredEntity,
} from "./entities/vocabulary.js";
import {
  WaitingOnPersonRegister,
  type WaitingOnPersonRecords,
} from "./waiting-on-person/register.js";
import { PreInitializationBuffer } from "./pre-initialization-buffer.js";
import { mergeStandingEvents } from "./standing-events.js";
import { admitToHueWheel } from "./hue-admission.js";
import { FailedDependentReads } from "./failed-dependent-reads.js";
import { RememberedRowHeights } from "./remembered-row-heights.js";
import { toReadableStore, type ReadableStore } from "../readable-store.js";
import { RepairReplay } from "./repair-replay.js";
import {
  SequenceReconciler,
  UNPLACED_CURSOR,
  orderBatchBySequence,
} from "./sequence-reconciler.js";
import {
  WHOLE_RESUME_POINT,
  admitsBaseState,
  establishedState,
  liveTailAfter,
  repairResumeRowCursor,
  uninitializedState,
  withDegradedCause,
  type RepairReopening,
  type RepairResumePoint,
  type SessionBaseState,
  type SessionStoreState,
  type TranscriptWindowEdge,
} from "./state.js";
import { NOTHING_APPLIED, type ApplyOutcome } from "./apply/outcome.js";

/** Construction inputs. */
export interface SessionStoreOptions {
  readonly sessionId: string;
  /** Event-kind to projector. A kind with no projector contributes no entity. */
  readonly projectors?: EntityProjectorTable;
}

const SITE = "store/session/store.ts";

/**
 * The per-session store: state, the sequence reconciler and the projectors behind the single
 * `applyBatch` chokepoint. `initialize` places the window and `repair` mends a degraded one; past
 * those, only the page and release methods move the window's edges.
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
  /** The window's run; a repair's replay hands its own over at the swap. */
  #reconciler = new SequenceReconciler();
  /** The repair under way while a repair read's replay has not yet passed the window's rows. */
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

  /** The session's hue wheel. Only the reads, `applyBatch` and the pages allocate on it. */
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
   * The position a repair read reopens the stream after: the checkpoint of the replay under way or
   * of the window, else the newest row either folded; `undefined` when only a replay from the head
   * repairs.
   */
  public get repairResumeRowCursor(): EventCursor | undefined {
    return repairResumeRowCursor(this.#repairSource);
  }

  /**
   * Establish the base state from a read that places the window, and drain anything that arrived
   * first. Taken only by a store with none yet or a degraded one (`admitsBaseState`), whose window
   * the read's replaces whole and whose replay under way it ends. Answers whether the base state
   * was taken, since only then does the stream open after it.
   */
  public initialize(baseState: SessionBaseState): boolean {
    const current = this.#store.getState();
    if (!admitsBaseState(current)) {
      return false;
    }
    this.#replay = undefined;
    this.#store.setState(this.#establish(baseState, current));

    const buffered = this.#preInitializationBuffer.drain();
    if (buffered.length > 0) {
      this.applyBatch(buffered);
    }
    return true;
  }

  /**
   * Repair a degraded window from a repair read that landed, which reopened the stream where
   * `reopening` says. At the head, a replay from the window's head over the read's entities. After
   * a row, which must still be the row the window or its replay is taken up after: a whole window
   * stands whole and a whole replay goes on, since the stream sends what follows, and a checkpoint
   * replays from the state it held there. Answers whether the read was taken; one naming a row the
   * store has moved past is refused, and the stream stays where it is.
   */
  public repair(baseState: SessionBaseState, reopening: RepairReopening): boolean {
    const unseeded = this.#store.getState();
    if (!unseeded.initialized || !admitsBaseState(unseeded)) {
      return false;
    }
    // The read's standing events are as true of the window as of what replays: both take them.
    const window = withStandingEvents(unseeded, baseState.standingEvents ?? []);
    if (reopening.from === "head") {
      this.#replayFromHead(window, baseState);
      return true;
    }
    const source = this.#repairSource;
    if (reopening.rowCursor !== repairResumeRowCursor(source)) {
      return false;
    }
    const point = source.repairResumePoint;
    if (point.kind === "checkpoint") {
      this.#replayFromCheckpoint(window, source, point);
      return true;
    }
    const replay = this.#replay;
    if (replay !== undefined) {
      replay.advance({
        ...withStandingEvents(replay.state, window.standingEvents),
        degradedCause: undefined,
        lastReadFailed: false,
      });
      this.#store.setState({ ...window, lastReadFailed: false, revision: window.revision + 1 });
      return true;
    }
    this.#store.setState({
      ...window,
      degradedCause: undefined,
      lastReadFailed: false,
      revision: window.revision + 1,
    });
    return true;
  }

  /**
   * Mark the store degraded without a read (a closed subscription, a lost stream). The cause is
   * merged through the ladder, on the window and on a replay under way, so a cause raised
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
      const replay = this.#replay;
      let outcome: ApplyOutcome;
      let committed: SessionStoreState | undefined;
      if (replay === undefined) {
        const current = this.#store.getState();
        const folded = this.#fold(current, events, this.#reconciler);
        outcome = folded.outcome;
        committed =
          folded.nextState === undefined
            ? undefined
            : countingRaisedAgainCause(current, folded.nextState, false);
      } else {
        const folded = this.#fold(replay.state, replay.withHeldRows(events), replay.reconciler);
        outcome = folded.outcome;
        if (folded.nextState !== undefined) {
          replay.advance(folded.nextState);
        }
        committed = replay.hasPassedHeldRows ? this.#takeReplay(replay) : undefined;
      }
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
   * Puts a page read at one end of the log, its start or its end, in place of the whole window;
   * returns what it admitted. At the start the head closes; at the end the head takes `edge`, the
   * page's own, and the tail goes live when the page reaches what the stream has delivered. Not a
   * second apply chokepoint, on the terms of {@link prependEarlierEvents}.
   */
  public replaceWithLogEndPage(
    logEnd: "start" | "end",
    events: readonly ProjectedSessionEvent[],
    edge: TranscriptWindowEdge,
  ): LogEndPageMerge {
    const { merge, nextState } = foldLogEndPage(
      this.#store.getState(),
      events,
      logEnd,
      edge,
      this.#pageDependencies,
    );
    if (nextState !== undefined) {
      this.#store.setState(nextState);
      recordStoreSize(this.#sessionId, nextState.transcript.length);
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
    this.#store.setState(next);
    recordStoreSize(this.#sessionId, next.transcript.length);
  }

  /**
   * Puts a large body read in full on the held event `eventId`, in place of its size; an event the
   * window has let go of, or one holding no large body, is left as it is. Not a second apply
   * chokepoint, on the terms of {@link prependEarlierEvents}.
   */
  public admitFullBody(eventId: string, body: TranscriptBodyReadResponse): void {
    const next = admitFullBody(this.#store.getState(), eventId, body);
    if (next !== undefined) {
      this.#store.setState(next);
    }
  }

  /**
   * Lets go of every row but the newest `rowLimit`, detaching the tail after them, so a window no
   * screen shows stops growing with the stream; a window holding no more stays as it is.
   */
  public releaseBeyondNewest(rowLimit: number): void {
    const next = releaseBeyondNewest(this.#store.getState(), rowLimit);
    if (next === undefined) {
      return;
    }
    this.#store.setState(next);
    recordStoreSize(this.#sessionId, next.transcript.length);
  }

  /**
   * The state a read establishes over `current`, with the reconciler re-based onto it. The read's
   * rows project the entities they imply, and the read's records then stand over them, since they
   * are the newest. The hue wheel takes the agents in the order they joined, from the read's
   * standing events, before any its rows bring; the rows advance the register as a page's do; the
   * register keeps the older asks this read did not carry, and the seed moves only the window-head
   * fact. The standing events take the read's own and its rows over the ones held. A base with no
   * sequence seeds below every row the stream delivers after it.
   */
  #establish(baseState: SessionBaseState, current: SessionStoreState): SessionStoreState {
    const transcript = orderBatchBySequence(baseState.transcript ?? []);
    this.#reconciler.rebaseTo(
      baseState.cursor,
      transcript.map((event) => event.sequence),
    );
    for (const event of [...(baseState.standingEvents ?? []), ...transcript]) {
      admitToHueWheel(this.#hueAllocator, event);
    }
    this.#waitingOnPersonRegister.seedFrom({
      entities: baseState.entities,
      cursor: this.#reconciler.cursor,
      isWindowHeadUnread: baseState.transcriptHead?.hasMore ?? false,
    });
    this.#waitingOnPersonRegister.admit(transcript);
    const standingEvents = mergeStandingEvents(current.standingEvents, [
      ...(baseState.standingEvents ?? []),
      ...transcript,
    ]);
    const { partitions, isProjectionFailed } = this.#projectedPartitions(
      transcript,
      baseState.entities,
    );
    return establishedState({
      sessionId: this.#sessionId,
      baseState,
      partitions,
      isProjectionFailed,
      cursor: this.#reconciler.cursor,
      orderedTranscript: transcript,
      standingEvents,
      revision: current.revision + 1,
      readFailureCount: current.readFailureCount,
      raisedAgainCauseCount: current.raisedAgainCauseCount,
      windowPlacementCount: current.windowPlacementCount,
    });
  }

  /**
   * The partitions `transcript` projects with `entities` merged over them, and whether a projector
   * threw on one of its rows.
   */
  #projectedPartitions(
    transcript: readonly ProjectedSessionEvent[],
    entities: readonly StoredEntity[],
  ): { readonly partitions: SessionPartitions; readonly isProjectionFailed: boolean } {
    let partitions: SessionPartitions = emptyPartitions();
    let isProjectionFailed = false;
    for (const event of transcript) {
      const projected = this.#projectionRunner.run(partitions, event);
      if (projected === undefined) {
        isProjectionFailed = true;
      } else {
        partitions = projected;
      }
    }
    for (const entity of entities) {
      partitions = mergeUpsert(partitions, entity);
    }
    return { partitions, isProjectionFailed };
  }

  /**
   * Replay from the window's head: the stream reopened before the window's oldest row sends every
   * row it holds again, folded onto the read's entities, which stand for the runs no row of the
   * window touches. A read naming no sequence places the replay at the first row it sends.
   */
  #replayFromHead(window: SessionStoreState, baseState: SessionBaseState): void {
    const reconciler = new SequenceReconciler();
    reconciler.rebaseTo(baseState.cursor, []);
    this.#startReplay(window, reconciler, {
      ...window,
      ...REPLAY_START,
      partitions: this.#projectedPartitions([], baseState.entities).partitions,
      transcript: [],
      transcriptTail: liveTailAfter([]),
      cursor: reconciler.cursor,
      streamAfterCursor: baseState.streamAfterCursor,
    });
  }

  /**
   * Replay from a checkpoint of the window or of the replay under way: its rows through the
   * checkpoint, the partitions as they stood there, and the stream reopened after its row. The tail
   * grows from there when the checkpoint's row is held, else it stays where `source` had it.
   */
  #replayFromCheckpoint(
    window: SessionStoreState,
    source: SessionStoreState,
    point: Extract<RepairResumePoint, { readonly kind: "checkpoint" }>,
  ): void {
    const reconciler = new SequenceReconciler();
    reconciler.rebaseTo(point.cursor === UNPLACED_CURSOR ? undefined : point.cursor, []);
    const transcript = rowsThrough(source.transcript, point.cursor);
    this.#startReplay(window, reconciler, {
      ...source,
      ...REPLAY_START,
      partitions: point.partitions,
      // A replay under way lacks what the window took since it started and what the read carried.
      standingEvents: mergeStandingEvents(source.standingEvents, window.standingEvents),
      transcript,
      transcriptTail:
        transcript.at(-1)?.sequence === point.cursor
          ? liveTailAfter(transcript)
          : source.transcriptTail,
      cursor: point.cursor,
      streamAfterCursor: point.rowCursor,
    });
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
   * it takes the window's rows and edges as they stand now (`RepairReplay.windowOnto`). The
   * window's counts stand, since a read can fail while the replay runs. A failed read stands only
   * beside a cause, since a whole window says nothing about it.
   */
  #takeReplay(replay: RepairReplay): SessionStoreState {
    const visible = this.#store.getState();
    const replayed = replay.state;
    this.#replay = undefined;
    this.#reconciler = replay.reconciler;
    return countingRaisedAgainCause(
      visible,
      {
        ...replayed,
        ...replay.windowOnto(visible),
        // A page loaded while the replay ran advanced the window's.
        standingEvents: mergeStandingEvents(replayed.standingEvents, visible.standingEvents),
        isReplaying: false,
        lastReadFailed: replayed.degradedCause !== undefined && replayed.lastReadFailed,
        readFailureCount: visible.readFailureCount,
        raisedAgainCauseCount: visible.raisedAgainCauseCount,
        revision: visible.revision + 1,
      },
      true,
    );
  }

  /** One batch folded onto `current` with the run it is reconciled against. */
  #fold(
    current: SessionStoreState,
    events: readonly ProjectedSessionEvent[],
    reconciler: SequenceReconciler,
  ): AppliedBatch {
    return foldAppliedBatch(current, events, {
      sessionId: this.#sessionId,
      reconciler,
      projectionRunner: this.#projectionRunner,
      preInitializationBuffer: this.#preInitializationBuffer,
      hueAllocator: this.#hueAllocator,
      waitingOnPersonRegister: this.#waitingOnPersonRegister,
    });
  }

  /** What a repair is taken up from: the replay under way, else the window. */
  get #repairSource(): SessionStoreState {
    return this.#replay?.state ?? this.#store.getState();
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

/** What a replay's start state clears: it begins whole, with nothing missing and no read failed. */
const REPLAY_START = {
  lastAdmittedEvents: [],
  degradedCause: undefined,
  isReplaying: false,
  lastReadFailed: false,
  gaps: [],
  repairResumePoint: WHOLE_RESUME_POINT,
} as const satisfies Partial<SessionStoreState>;

/**
 * `state` with `events` merged into its standing events, or `state` itself when none changed. The
 * revision is the caller's to move, as each repair branch commits once.
 */
function withStandingEvents(
  state: SessionStoreState,
  events: readonly ProjectedSessionEvent[],
): SessionStoreState {
  const standingEvents = mergeStandingEvents(state.standingEvents, events);
  return standingEvents === state.standingEvents ? state : { ...state, standingEvents };
}

/** The rows at or below `sequence`, from a transcript in sequence order. */
function rowsThrough(
  transcript: readonly ProjectedSessionEvent[],
  sequence: number,
): readonly ProjectedSessionEvent[] {
  const end = transcript.findIndex((row) => row.sequence > sequence);
  return end === -1 ? transcript : transcript.slice(0, end);
}

/**
 * `next` with a cause the stream raises again counted as it comes to stand: newly, or at a
 * replay's swap, which ends a repair that failed on the same row and so is a new failure.
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
