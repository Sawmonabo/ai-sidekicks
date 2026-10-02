// Phase-one write queue: holds reactive scroll writes until the next frame and computes each
// against that frame's single geometry sample.
// Writes coalesce per caller (two callers both get a turn, in submission order), and a
// request refuses when no frame scheduler is adopted rather than falling back to an
// unordered immediate write.

import { type AnimationFrameScheduler } from "../animation-frame-scheduler.js";
import { type ScrollGeometry } from "./geometry-sample.js";
import { type ScrollCaller } from "./scroll-callers.js";

/**
 * What a phase-one caller computes: the offset it wants, from the frame's geometry sample.
 * `undefined` withdraws the request.
 */
export type ScrollTargetComputation = (geometry: ScrollGeometry) => number | undefined;

/**
 * The narrow port back into the chokepoint: this module decides when to write, the
 * controller decides what a write does (clamp, quantization, publication).
 */
export interface ScrollWriteTarget {
  /** The last published sample, or `undefined` before the first attach. */
  readonly lastGeometry: ScrollGeometry | undefined;
  /** Perform the write through the controller's one `scrollTop` write path. */
  readonly glide: (caller: ScrollCaller, targetScrollTop: number) => void;
}

/** Reactive scroll writes, held for phase one of the next frame. */
export class ScrollFrameWrites {
  readonly #writeTarget: ScrollWriteTarget;
  readonly #taskKeyByCaller = new Map<ScrollCaller, string>();
  readonly #pendingByCaller = new Map<ScrollCaller, ScrollTargetComputation>();

  #frameScheduler: AnimationFrameScheduler | undefined;
  #released = false;

  public constructor(writeTarget: ScrollWriteTarget) {
    this.#writeTarget = writeTarget;
  }

  /**
   * Join a frame. Idempotent; a second, different scheduler would put one controller's
   * writes in two frames, so it throws.
   */
  public adopt(frameScheduler: AnimationFrameScheduler): void {
    if (this.#released || this.#frameScheduler === frameScheduler) {
      return;
    }
    if (this.#frameScheduler !== undefined) {
      throw new Error(
        "ScrollFrameWrites: a second frame scheduler was adopted; one controller writes inside one frame",
      );
    }
    this.#frameScheduler = frameScheduler;
  }

  /**
   * Ask for a write in the next frame's phase one. Returns whether the request was taken,
   * so a caller can tell "queued" from "this controller is in no frame".
   */
  public request(caller: ScrollCaller, computeTarget: ScrollTargetComputation): boolean {
    const frameScheduler = this.#frameScheduler;
    if (frameScheduler === undefined || this.#released) {
      return false;
    }
    this.#pendingByCaller.set(caller, computeTarget);
    frameScheduler.scheduleScrollWrite(this.#taskKeyFor(frameScheduler, caller), () => {
      this.#runPending(caller);
    });
    return true;
  }

  /** Terminal. Cancels every submitted task and drops every pending computation. */
  public release(): void {
    const frameScheduler = this.#frameScheduler;
    if (frameScheduler !== undefined) {
      for (const taskKey of this.#taskKeyByCaller.values()) {
        frameScheduler.cancel("scroll-writes", taskKey);
      }
    }
    this.#taskKeyByCaller.clear();
    this.#pendingByCaller.clear();
    this.#frameScheduler = undefined;
    this.#released = true;
  }

  #runPending(caller: ScrollCaller): void {
    const computeTarget = this.#pendingByCaller.get(caller);
    this.#pendingByCaller.delete(caller);
    if (computeTarget === undefined || this.#released) {
      return;
    }
    const geometry = this.#writeTarget.lastGeometry;
    if (geometry === undefined) {
      // No sample means no attached scroll container: nothing to compute against or write to.
      return;
    }
    const targetScrollTop = computeTarget(geometry);
    if (targetScrollTop === undefined) {
      return;
    }
    this.#writeTarget.glide(caller, targetScrollTop);
  }

  /** One key per caller per scheduler, so two callers never coalesce into one. */
  #taskKeyFor(frameScheduler: AnimationFrameScheduler, caller: ScrollCaller): string {
    const existing = this.#taskKeyByCaller.get(caller);
    if (existing !== undefined) {
      return existing;
    }
    const taskKey = frameScheduler.claimTaskKey(`transcript-scroll-${caller}`);
    this.#taskKeyByCaller.set(caller, taskKey);
    return taskKey;
  }
}
