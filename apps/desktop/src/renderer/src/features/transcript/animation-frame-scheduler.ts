// The transcript's two-phase frame scheduler: scroll writes run first against the last clean
// geometry sample, then reveal work, so a write never lands against a height that reveal work
// just changed. Tasks coalesce by key per phase; work for a phase that already ran waits for the
// next frame; a throwing task is quarantined and reported on the diagnostic channel.
//
// A late task waits because draining it now is the out-of-order write this prevents, and looping
// until empty lets one lane's re-arm hold the frame open; a throw is contained so delivery does
// not depend on submission order.

import type { Unsubscribe } from "#shared/preload-api.js";
import { Emitter } from "#renderer/lib/emitter.js";
import { lossyStringify } from "#renderer/lib/wire/errors.js";
import {
  readPerformanceMeterTime,
  recordFrameTime,
  retireFrameTimeSeries,
  retireRevealDrainSeries,
} from "#renderer/lib/performance-meters/performance-meters.js";
import { type Clock, type ScheduledHandle } from "#renderer/lib/clock.js";

/** The frame's phases in run order; a phase's index is its precedence. */
export const ANIMATION_FRAME_PHASES = ["scroll-writes", "reveal-work"] as const;

/**
 * The label every frame meter series carries, before the scheduler's ordinal. There is one
 * series per scheduler (one per feed): a shared key would fold two feeds into one p95.
 */
const FRAME_TIME_METER_LABEL = "transcript-frame";

/** One frame phase. Derived from the enumeration, never restated. */
export type AnimationFramePhase = (typeof ANIMATION_FRAME_PHASES)[number];

/** A task that threw, reported out of band so the phase that held it still finished. */
export interface AnimationFrameDiagnostic {
  readonly phase: AnimationFramePhase;
  readonly taskKey: string;
  readonly detail: string;
}

/** What the scheduler needs to arm frames. */
export interface AnimationFrameSchedulerOptions {
  readonly clock: Clock;
}

/** Per-frame work, ordered by phase and coalesced by task key. */
export class AnimationFrameScheduler {
  readonly #clock: Clock;
  readonly #diagnosticEmitter = new Emitter<AnimationFrameDiagnostic>("animation frame diagnostic");
  /** One insertion-ordered queue per phase; a key holds at most one task. */
  readonly #queueByPhase: Readonly<Record<AnimationFramePhase, Map<string, () => void>>> = {
    "scroll-writes": new Map(),
    "reveal-work": new Map(),
  };

  /** Never resets, so two schedulers in one renderer process keep distinct identities. */
  static #nextSchedulerOrdinal = 1;

  /** This scheduler's identity — the prefix every reading it produces is keyed by. */
  readonly #schedulerId: string;

  /**
   * Every task key handed out, so `dispose` can retire the meter series opened under them.
   * It grows with holders, not frames.
   */
  readonly #claimedTaskKeys = new Set<string>();

  #armedFrame: ScheduledHandle | undefined;
  #drainingPhaseIndex: number | undefined;
  #nextTaskKeyOrdinal = 1;
  #disposed = false;

  public constructor(options: AnimationFrameSchedulerOptions) {
    this.#clock = options.clock;
    this.#schedulerId =
      `${FRAME_TIME_METER_LABEL}#` + String(AnimationFrameScheduler.#nextSchedulerOrdinal);
    AnimationFrameScheduler.#nextSchedulerOrdinal += 1;
  }

  /**
   * This scheduler's identity, for a reader naming which feed a series came from. A holder
   * building a series key uses `meterSeriesKeyFor`: a task key alone repeats across schedulers.
   */
  public get schedulerId(): string {
    return this.#schedulerId;
  }

  /**
   * The meter series key for a holder of one of this scheduler's task keys. The holder
   * records under it and `dispose` retires it, so both must spell the same string.
   */
  public meterSeriesKeyFor(taskKey: string): string {
    return `${this.#schedulerId}/${taskKey}`;
  }

  /**
   * Claim a task key no other holder can collide with. The label is for diagnostics; the
   * ordinal keeps two reveal engines from replacing each other's drain.
   */
  public claimTaskKey(label: string): string {
    const ordinal = this.#nextTaskKeyOrdinal;
    this.#nextTaskKeyOrdinal += 1;
    const taskKey = `${label}#${String(ordinal)}`;
    this.#claimedTaskKeys.add(taskKey);
    return taskKey;
  }

  /**
   * Submit work for a phase of the next frame. A second submit under the same key before
   * then replaces the task and costs one run.
   */
  public schedule(phase: AnimationFramePhase, taskKey: string, task: () => void): void {
    if (this.#disposed) {
      return;
    }
    this.#queueByPhase[phase].set(taskKey, task);
    this.#armFrame();
  }

  /** Phase one. The scroll chokepoint's writes, and nothing else. */
  public scheduleScrollWrite(taskKey: string, task: () => void): void {
    this.schedule("scroll-writes", taskKey, task);
  }

  /** Phase two. Reveal drains, after the offsets have settled. */
  public scheduleRevealWork(taskKey: string, task: () => void): void {
    this.schedule("reveal-work", taskKey, task);
  }

  /**
   * Drop a submitted task. Idempotent, and safe for a key that never ran. Canceling the last
   * pending task also releases the armed frame, so an idle scheduler holds no timer.
   */
  public cancel(phase: AnimationFramePhase, taskKey: string): void {
    this.#queueByPhase[phase].delete(taskKey);
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
    for (const queue of Object.values(this.#queueByPhase)) {
      pending += queue.size;
    }
    return pending;
  }

  /** Watch quarantined tasks. No resend: a diagnostic is an event, not a state. */
  public subscribeToDiagnostics(sink: (diagnostic: AnimationFrameDiagnostic) => void): Unsubscribe {
    return this.#diagnosticEmitter.subscribe(sink);
  }

  /**
   * Terminal: a disposed scheduler arms nothing and runs nothing. It also retires the meter
   * series its identity opened (its `frame-time` key and one `reveal-drain` key per task key),
   * because the ordinal never resets and unretired keys would fill the registry's series bound,
   * after which every further feed is refused. The scheduler owns the drain keys because the
   * engine composes them from this scheduler's identity and its own task key.
   */
  public dispose(): void {
    if (this.#armedFrame !== undefined) {
      this.#clock.cancel(this.#armedFrame);
      this.#armedFrame = undefined;
    }
    for (const queue of Object.values(this.#queueByPhase)) {
      queue.clear();
    }
    this.#diagnosticEmitter.clear();
    retireFrameTimeSeries(this.#schedulerId);
    for (const taskKey of this.#claimedTaskKeys) {
      retireRevealDrainSeries(this.meterSeriesKeyFor(taskKey));
    }
    this.#claimedTaskKeys.clear();
    this.#disposed = true;
  }

  /** Whether this scheduler has been torn down. Read by a holder's re-mint arm. */
  public get isDisposed(): boolean {
    return this.#disposed;
  }

  #armFrame(): void {
    if (this.#armedFrame !== undefined || this.#disposed) {
      return;
    }
    // Arming from inside a drain would be a second frame; the drain's tail arm is the one
    // place a frame is armed once one is running.
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
   * One frame: every phase in order, each over the tasks it held when its turn came. A task
   * submitted while a phase drains lands in the cleared queue and runs in the next frame.
   */
  #drainFrame(): void {
    // The meters are development-only: a built bundle reads `0` here and records nothing.
    const startedAt = readPerformanceMeterTime();
    for (const [phaseIndex, phase] of ANIMATION_FRAME_PHASES.entries()) {
      const queue = this.#queueByPhase[phase];
      if (queue.size === 0) {
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
    recordFrameTime(this.#schedulerId, readPerformanceMeterTime() - startedAt);
    // After the recording: arming first would put the next frame's scheduling inside this
    // frame's reading.
    this.#armFrame();
  }

  #runTask(phase: AnimationFramePhase, taskKey: string, task: () => void): void {
    try {
      task();
    } catch (frameTaskFailure: unknown) {
      this.#diagnosticEmitter.emit({
        phase,
        taskKey,
        detail:
          "frame task threw and was quarantined; the phase " +
          `finished: ${lossyStringify(frameTaskFailure)}`,
      });
    }
  }
}
