// The ledger's global two-phase frame coordinator — the one scheduler the frame's
// per-frame work is ordered through.
//
// `Spec-023 §Console Design (Meridian)`'s fourth product bar ("light on the
// machine") prices the console at one frame for four streaming lanes, and the frame
// that has to hold that budget is shared: the scroll chokepoint wants to write an
// offset, the reveal engine wants to publish characters, and the provenance rail
// wants to paint ticks — all in the same paint. THE SENTENCE THIS MODULE ADDS,
// because no committed document states it: phase one performs scroll writes against
// the last clean geometry sample, phase two performs reveal and rail work, and no
// frame ever runs them the other way round.
//
// WHY AN ORDER IS NEEDED AT ALL. Both subsystems armed their own frame through the
// clock seam, so which ran first was whichever armed first — a fact about the order
// deltas happened to arrive in, not a decision anybody made. That is visible as a
// class of defect rather than as a preference: reveal work grows a row, the row's
// growth changes the content height, and a scroll write computed against the height
// from before the growth lands the reader somewhere they did not ask to be. Doing
// the writes FIRST, against a geometry sample nothing in this frame has invalidated
// yet, is what makes a write mean what its caller meant.
//
// FOUR DECISIONS THIS MODULE MAKES:
//
//   • **Two phases, closed, in this file.** `LEDGER_FRAME_PHASES` is the order, and
//     the order IS the array. A third phase is a change to one line and to every
//     reader at once, rather than a comparison scattered over the callers.
//   • **A task is coalesced by its key, per phase.** Ten ingests in one frame arm one
//     drain: the queue holds the LAST task submitted under a key, so a subsystem may
//     submit freely and still cost one run. A key is claimed from this coordinator
//     (`claimTaskKey`) rather than spelled by the caller, because two holders that
//     picked the same string would silently delete each other's work.
//   • **Re-entrancy defers to the NEXT frame, never re-orders this one.** Work
//     submitted for a phase that has already run in this frame — including the phase
//     that is running — is held for the next frame. Draining it here is exactly the
//     out-of-order write the coordinator exists to prevent, and looping until the
//     queues empty would let one lane's re-arm hold the frame open indefinitely.
//     Work submitted for a LATER phase joins this frame, which is what makes "the
//     scroll write happened, now reveal" one paint rather than two.
//   • **A throwing task is quarantined and the phase finishes.** `reveal-engine.ts`
//     reasons this way about lanes and `core/emitter.ts` about sinks, for the same
//     reason: letting the first throw escape would make delivery depend on
//     submission order. Failures are reported out of band on the diagnostic channel.
//
// WHAT IT IS NOT. It holds no geometry, measures nothing, and knows what none of its
// tasks do. "Against the last clean geometry sample" is a property the scroll
// chokepoint supplies by sampling once before its phase-one writes; this module only
// guarantees that the writes precede the work that would invalidate the sample.

import {
  Emitter,
  lossyStringify,
  perfMeterNow,
  recordFrameTime,
  retireFrameTimeSeries,
  retireRevealDrainSeries,
  type ConsoleClock,
  type ScheduledHandle,
  type Unsubscribe,
} from "../../../core/index.js";

/**
 * The frame's phases, in the order every frame runs them.
 *
 * Declared as the ordering rather than described by one: the index of a phase in
 * this array is its precedence, and `#drainFrame` walks it forwards.
 */
export const LEDGER_FRAME_PHASES = ["scroll-writes", "reveal-and-rail"] as const;

/**
 * The label every frame meter series carries, before this coordinator's own ordinal.
 *
 * One key per COORDINATOR rather than one per phase or one per window. Per phase is
 * wrong because the budget the reading is compared against is a FRAME budget, and a
 * split would be two series neither of which is the number the budget names. Per
 * window is wrong because there is one coordinator per FEED — `coordinator-binding.ts`
 * says so in its first line and `ledger/pane/feed/model/ledger-feed-windows.ts` mints
 * one per feed model — so two feeds open side by side would have folded two feeds'
 * frames into one series, and the p95 an author read would have been an average over
 * a feed that was blowing the budget and one that was idle, with no second series
 * anywhere to notice it by.
 */
const FRAME_TIME_METER_LABEL = "ledger-frame";

/** One frame phase. Derived from the enumeration, never restated. */
export type LedgerFramePhase = (typeof LEDGER_FRAME_PHASES)[number];

/** A task that threw, reported out of band so the phase that held it still finished. */
export interface LedgerFrameDiagnostic {
  readonly phase: LedgerFramePhase;
  readonly taskKey: string;
  readonly detail: string;
}

export interface LedgerFrameCoordinatorOptions {
  readonly clock: ConsoleClock;
}

/** Per-frame work, ordered by phase and coalesced by task key. */
export class LedgerFrameCoordinator {
  readonly #clock: ConsoleClock;
  readonly #diagnosticEmitter = new Emitter<LedgerFrameDiagnostic>("ledger frame diagnostic");
  /** One insertion-ordered queue per phase; a key holds at most one task. */
  readonly #queueByPhase = new Map<LedgerFramePhase, Map<string, () => void>>(
    LEDGER_FRAME_PHASES.map((phase) => [phase, new Map<string, () => void>()]),
  );

  /**
   * The ordinal the next coordinator takes.
   *
   * On the CLASS rather than in a module binding, which is the package's rule for a
   * counter that has to be shared: a class field is state a reader meets where the
   * thing it identifies is declared. It never resets, which is what makes two
   * coordinators in one renderer process two identities for the life of that process.
   */
  static #nextCoordinatorOrdinal = 1;

  /** This coordinator's identity — the prefix every reading it produces is keyed by. */
  readonly #coordinatorId: string;

  /**
   * Every task key this coordinator has handed out.
   *
   * Held so `dispose` can retire the meter series its holders opened under them. It
   * grows with HOLDERS rather than with frames — a feed's reveal engine and its
   * scroll chokepoint claim one each at construction — so this set is a handful of
   * short strings for the coordinator's lifetime and is dropped whole with it.
   */
  readonly #claimedTaskKeys = new Set<string>();

  #armedFrame: ScheduledHandle | undefined;
  #drainingPhaseIndex: number | undefined;
  #nextTaskKeyOrdinal = 1;
  #disposed = false;

  public constructor(options: LedgerFrameCoordinatorOptions) {
    this.#clock = options.clock;
    this.#coordinatorId = `${FRAME_TIME_METER_LABEL}#${String(LedgerFrameCoordinator.#nextCoordinatorOrdinal)}`;
    LedgerFrameCoordinator.#nextCoordinatorOrdinal += 1;
  }

  /**
   * This coordinator's identity, for a reader that has to name which feed a series
   * came from.
   *
   * A holder composing a series key of its own takes `meterSeriesKeyFor` below and
   * not this: its own task key is unique per coordinator and not across them — every
   * feed's first engine claims the same ordinal — so a reading keyed by the task key
   * alone merged every feed's drains into one series.
   */
  public get coordinatorId(): string {
    return this.#coordinatorId;
  }

  /**
   * The meter series key a holder of one of this coordinator's task keys records
   * under. One composer for both sides of that key.
   *
   * The holder records with it and this coordinator's `dispose` retires with it, and
   * the two have to spell the identical string or the retirement silently closes
   * nothing. Composed HERE rather than at each end because the two ends are one seam:
   * a separator changed at one of them and not the other reads as a working key set
   * that never shrinks.
   *
   * Kind-agnostic on purpose — which meter a holder records into is the holder's
   * concern, and this answers only "who, under which coordinator".
   */
  public meterSeriesKeyFor(taskKey: string): string {
    return `${this.#coordinatorId}/${taskKey}`;
  }

  /**
   * Claim a key no other holder can collide with.
   *
   * The label is for a reader of a diagnostic; the ordinal is what makes the key
   * unique. Two reveal engines on one coordinator would otherwise both submit under
   * `"reveal-engine"` and the second would silently replace the first's drain.
   */
  public claimTaskKey(label: string): string {
    const ordinal = this.#nextTaskKeyOrdinal;
    this.#nextTaskKeyOrdinal += 1;
    const taskKey = `${label}#${String(ordinal)}`;
    this.#claimedTaskKeys.add(taskKey);
    return taskKey;
  }

  /**
   * Submit work for a phase of the next frame.
   *
   * Submitting again under the same key before that frame runs replaces the task and
   * costs one run, which is what lets a subsystem arm on every delta.
   */
  public schedule(phase: LedgerFramePhase, taskKey: string, task: () => void): void {
    if (this.#disposed) {
      return;
    }
    const queue = this.#queueByPhase.get(phase);
    if (queue === undefined) {
      return;
    }
    queue.set(taskKey, task);
    this.#armFrame();
  }

  /** Phase one. The scroll chokepoint's writes, and nothing else. */
  public scheduleScrollWrite(taskKey: string, task: () => void): void {
    this.schedule("scroll-writes", taskKey, task);
  }

  /** Phase two. Reveal drains and rail paints, after the offsets have settled. */
  public scheduleRevealAndRailWork(taskKey: string, task: () => void): void {
    this.schedule("reveal-and-rail", taskKey, task);
  }

  /**
   * Drop a submitted task. Idempotent, and safe for a key that never ran.
   *
   * Cancelling the LAST pending task releases the armed frame too. That is the
   * idle-CPU budget's precondition moving with the scheduler: the claim used to be
   * each subsystem's — "a settled engine has no timer armed" — and once every one of
   * them submits here instead, a coordinator holding a frame for an empty queue is
   * the only timer left to fire.
   */
  public cancel(phase: LedgerFramePhase, taskKey: string): void {
    this.#queueByPhase.get(phase)?.delete(taskKey);
    if (this.#armedFrame !== undefined && this.pendingTaskCount === 0) {
      this.#clock.cancel(this.#armedFrame);
      this.#armedFrame = undefined;
    }
  }

  /** True while a frame is armed or one is mid-drain. */
  public get isFrameArmed(): boolean {
    return this.#armedFrame !== undefined || this.#drainingPhaseIndex !== undefined;
  }

  /** Tasks waiting across every phase. Zero is the idle-CPU budget's precondition. */
  public get pendingTaskCount(): number {
    let pending = 0;
    for (const queue of this.#queueByPhase.values()) {
      pending += queue.size;
    }
    return pending;
  }

  /** Watch quarantined tasks. No replay: a diagnostic is an event, not a state. */
  public subscribeToDiagnostics(sink: (diagnostic: LedgerFrameDiagnostic) => void): Unsubscribe {
    return this.#diagnosticEmitter.subscribe(sink);
  }

  /**
   * Terminal. A disposed coordinator arms nothing, runs nothing, and reaches nobody.
   *
   * AND IT RETIRES THE METER SERIES ITS IDENTITY OPENED — its own `frame-time` key
   * and one `reveal-drain` key per task key it handed out. The ordinal never resets,
   * so without this the live key set is bounded by how many feeds this renderer has
   * ever mounted rather than by how many are open: past the registry's series bound
   * every further feed is refused, and the p95 an author reads is the p95 of feeds
   * that closed while the feed on screen contributes nothing.
   *
   * THE COORDINATOR RETIRES THE DRAIN KEYS AND THE ENGINE DOES NOT, because the
   * engine composes its key out of this coordinator's identity and its own task key:
   * one owner for a composed key is what keeps the two halves from disagreeing, and
   * an engine outliving its coordinator is not a state `coordinator-binding.ts`
   * produces. A task key whose holder never recorded a drain retires nothing, which
   * is what `PerfMeterRegistry.retire` answering `false` means.
   */
  public dispose(): void {
    if (this.#armedFrame !== undefined) {
      this.#clock.cancel(this.#armedFrame);
      this.#armedFrame = undefined;
    }
    for (const queue of this.#queueByPhase.values()) {
      queue.clear();
    }
    this.#diagnosticEmitter.clear();
    retireFrameTimeSeries(this.#coordinatorId);
    for (const taskKey of this.#claimedTaskKeys) {
      retireRevealDrainSeries(this.meterSeriesKeyFor(taskKey));
    }
    this.#claimedTaskKeys.clear();
    this.#disposed = true;
  }

  /** Whether this coordinator has been torn down. Read by a holder's re-mint arm. */
  public get isDisposed(): boolean {
    return this.#disposed;
  }

  #armFrame(): void {
    if (this.#armedFrame !== undefined || this.#disposed) {
      return;
    }
    // Arming from inside a drain would be a second frame for work the drain's own
    // tail arm is about to schedule; that arm is the single place a frame is armed
    // from once one is running.
    if (this.#drainingPhaseIndex !== undefined) {
      return;
    }
    if (this.pendingTaskCount === 0) {
      return;
    }
    this.#armedFrame = this.#clock.scheduleFrame(() => {
      this.#armedFrame = undefined;
      this.#drainFrame();
    });
  }

  /**
   * One frame: every phase in order, each over the tasks it held when its own turn
   * came.
   *
   * The snapshot-then-clear is what implements the deferral rule — a task submitted
   * while a phase is draining lands in the cleared queue and is picked up by the arm
   * at the end, which is the next frame.
   */
  #drainFrame(): void {
    // Sampled inside the define's branch so a release build folds the read away with
    // the recording it feeds — the whole cost of the meter in a shipped bundle is
    // this branch on a build-time literal, which Rollup removes.
    const startedAt = __SIDEKICKS_CONSOLE_FIXTURES__ ? perfMeterNow() : 0;
    for (const [phaseIndex, phase] of LEDGER_FRAME_PHASES.entries()) {
      const queue = this.#queueByPhase.get(phase);
      if (queue === undefined || queue.size === 0) {
        continue;
      }
      this.#drainingPhaseIndex = phaseIndex;
      const tasks = [...queue.entries()];
      queue.clear();
      for (const [taskKey, task] of tasks) {
        this.#runTask(phase, taskKey, task);
      }
    }
    this.#drainingPhaseIndex = undefined;
    if (__SIDEKICKS_CONSOLE_FIXTURES__) {
      recordFrameTime(this.#coordinatorId, perfMeterNow() - startedAt);
    }
    // AFTER the recording and before the next frame is armed: the sample belongs to
    // the frame that has just finished, and arming first would put the next frame's
    // scheduling inside this one's reading.
    this.#armFrame();
  }

  #runTask(phase: LedgerFramePhase, taskKey: string, task: () => void): void {
    try {
      task();
    } catch (frameTaskFailure: unknown) {
      this.#diagnosticEmitter.emit({
        phase,
        taskKey,
        detail: `frame task threw and was quarantined; the phase finished: ${lossyStringify(frameTaskFailure)}`,
      });
    }
  }
}
