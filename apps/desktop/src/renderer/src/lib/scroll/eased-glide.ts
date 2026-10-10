// A scroll eased toward a target over a duration, one write a frame in the frame's scroll-writes
// phase. The target is asked again each frame from that frame's geometry, so a target that moves
// mid-glide restarts the ease from where the box stands rather than jumping to it, and a move the
// glide did not make (a compensation, a prune) is eased on from where it left the box. A restarted
// ease counts from the glide's last step, so each frame covers a frame's share of the way even
// while text arriving every frame moves the target every frame. The glide
// only moves forward: a target behind the box is placed at once, never eased toward, so no step
// reads as a scroll back. Idle, it holds no frame.

import { type ScrollCaller } from "./callers.js";
import { type ScrollTargetComputation } from "./frame-writes.js";
import { SCROLL_GEOMETRY_EPSILON_PX, type ScrollGeometry } from "./geometry/sample.js";

/** How a glide moves: its duration and the share of the way it has come at each share of it. */
export interface GlideMotion {
  readonly durationMs: number;
  /** The share of the way covered at `elapsedShare` of the duration, both from 0 to 1. */
  readonly easing: (elapsedShare: number) => number;
}

/** What an `EasedGlide` reads and writes through: the chokepoint's frame and its one writer. */
export interface EasedGlidePort {
  /** The time, in milliseconds, on the clock the chokepoint was built with. */
  readonly now: () => number;
  /** Asks for a write in the next frame's scroll-writes phase; answers whether it was taken. */
  readonly requestFrame: (caller: ScrollCaller, computeTarget: ScrollTargetComputation) => boolean;
}

/** The chokepoint's eased scroll: at most one glide at a time. */
export class EasedGlide {
  readonly #port: EasedGlidePort;
  #run: GlideRun | undefined;

  public constructor(port: EasedGlidePort) {
    this.#port = port;
  }

  /** Whether a glide is under way. */
  public get isGliding(): boolean {
    return this.#run !== undefined;
  }

  /**
   * Glide toward the offset `computeTarget` answers each frame, for `caller`. A glide already
   * under way takes the new target and motion and keeps its ease; `undefined` from the target
   * ends it. Answers whether the glide runs, which it cannot outside a frame.
   */
  public start(
    caller: ScrollCaller,
    computeTarget: ScrollTargetComputation,
    motion: GlideMotion,
  ): boolean {
    const running = this.#run;
    const run: GlideRun = {
      caller,
      computeTarget,
      motion,
      ease: running?.caller === caller ? running.ease : undefined,
      leftAtPx: running?.caller === caller ? running.leftAtPx : undefined,
      steppedAtMs: running?.caller === caller ? running.steppedAtMs : this.#port.now(),
    };
    this.#run = run;
    if (running?.caller === caller) {
      // Its next frame is already asked for and reads the new target.
      return true;
    }
    return this.#requestStep(run);
  }

  /** End the glide where the box stands; a frame already asked for writes nothing. */
  public stop(): void {
    this.#run = undefined;
  }

  #requestStep(run: GlideRun): boolean {
    const isTaken = this.#port.requestFrame(run.caller, (geometry) => this.#step(run, geometry));
    if (!isTaken) {
      this.#run = undefined;
    }
    return isTaken;
  }

  /** One frame's offset, or `undefined` for a glide that ended. Asks for the next frame. */
  #step(run: GlideRun, geometry: ScrollGeometry): number | undefined {
    if (this.#run !== run) {
      return undefined;
    }
    const targetPx = run.computeTarget(geometry);
    const atPx = geometry.scrollTop;
    if (targetPx === undefined) {
      this.#run = undefined;
      return undefined;
    }
    if (targetPx < atPx) {
      // Behind the box: placed at once, since easing back would read as the reader's scroll.
      this.#run = undefined;
      return targetPx;
    }
    const nowMs = this.#port.now();
    const wasMovedElsewhere =
      run.leftAtPx !== undefined && Math.abs(run.leftAtPx - atPx) > SCROLL_GEOMETRY_EPSILON_PX;
    if (
      run.ease === undefined ||
      wasMovedElsewhere ||
      Math.abs(run.ease.toPx - targetPx) > SCROLL_GEOMETRY_EPSILON_PX
    ) {
      run.ease = { fromPx: atPx, startedAtMs: run.steppedAtMs, toPx: targetPx };
    }
    const { fromPx, startedAtMs } = run.ease;
    const elapsedShare = Math.min(1, (nowMs - startedAtMs) / run.motion.durationMs);
    if (elapsedShare >= 1) {
      this.#run = undefined;
      return targetPx;
    }
    // Never behind the box, whatever the easing answers this early.
    const stepPx = Math.max(atPx, fromPx + (targetPx - fromPx) * run.motion.easing(elapsedShare));
    run.leftAtPx = stepPx;
    run.steppedAtMs = nowMs;
    this.#requestStep(run);
    return stepPx;
  }
}

/** One glide under way: whom it moves for, where it aims and where its current ease began. */
interface GlideRun {
  readonly caller: ScrollCaller;
  readonly computeTarget: ScrollTargetComputation;
  readonly motion: GlideMotion;
  /** Where the current ease began and when, or `undefined` until its first frame. */
  ease:
    | { readonly fromPx: number; readonly startedAtMs: number; readonly toPx: number }
    | undefined;
  /** The offset the last step left the box at, so a move the glide did not make is told. */
  leftAtPx: number | undefined;
  /** When the last step was written, or the glide asked for: where a restarted ease counts from. */
  steppedAtMs: number;
}
