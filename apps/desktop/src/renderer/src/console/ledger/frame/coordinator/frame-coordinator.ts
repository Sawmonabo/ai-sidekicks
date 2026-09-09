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

  #armedFrame: ScheduledHandle | undefined;
  #drainingPhaseIndex: number | undefined;
  #nextTaskKeyOrdinal = 1;
  #disposed = false;

  public constructor(options: LedgerFrameCoordinatorOptions) {
    this.#clock = options.clock;
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
    return `${label}#${String(ordinal)}`;
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

  /** Terminal. A disposed coordinator arms nothing, runs nothing, and reaches nobody. */
  public dispose(): void {
    if (this.#armedFrame !== undefined) {
      this.#clock.cancel(this.#armedFrame);
      this.#armedFrame = undefined;
    }
    for (const queue of this.#queueByPhase.values()) {
      queue.clear();
    }
    this.#diagnosticEmitter.clear();
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
