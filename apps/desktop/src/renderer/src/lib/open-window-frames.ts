// The frame clock of the work no one window owns: the session stores and the other state every
// window shares. Their document is the hidden one that opens the windows, and it never paints, so
// its own `requestAnimationFrame` never fires. A frame asked of this is armed on every window a
// person can see and runs on the first of them to paint, so one minimized or covered window does
// not hold back the rest; with no window open it runs on the next task, since nothing is drawn.
// Windows painting in the same display frame run their frame steps one after another, so once a
// window has run a frame, a frame asked for is armed on that window and skips the other windows'
// next step, which may belong to the display frame that just ran. The first frame to run on
// another window makes that window the one armed on directly.

import type { FrameScheduling } from "./clock.js";

/**
 * Frames paced by whichever open window paints first, for a `RealClock` over shared state; a frame
 * that asks for the next one runs once per display frame however many windows are open.
 *
 * A window that closes with a frame armed on it hands that frame to the windows still open, or to
 * the next task when none is, so a frame armed before a close still runs.
 */
export class OpenWindowFrames implements FrameScheduling {
  readonly #windows = new Set<FrameScheduling>();
  readonly #pending = new Map<number, PendingFrame>();
  #nextHandle = 1;
  /** The window that ran the last frame; none before any has. */
  #lastRanOn: FrameScheduling | undefined;

  /** Pace frames by `frames` too, from the next frame armed on, until `release`. */
  public hold(frames: FrameScheduling): void {
    this.#windows.add(frames);
  }

  /** Stop pacing frames by `frames`, re-arming each frame only it held. */
  public release(frames: FrameScheduling): void {
    if (!this.#windows.delete(frames)) {
      return;
    }
    if (this.#lastRanOn === frames) {
      this.#lastRanOn = closedWindow;
    }
    for (const [handle, pending] of this.#pending) {
      const remaining = pending.armings.filter((arming) => arming.frames !== frames);
      if (remaining.length === pending.armings.length) {
        continue;
      }
      this.#pending.set(handle, { ...pending, armings: remaining });
      if (remaining.length === 0 && pending.timeout === undefined) {
        this.#arm(handle, pending.callback);
      }
    }
  }

  public requestAnimationFrame(callback: (time: number) => void): number {
    const handle = this.#nextHandle;
    this.#nextHandle += 1;
    this.#arm(handle, callback);
    return handle;
  }

  public cancelAnimationFrame(handle: number): void {
    const pending = this.#pending.get(handle);
    if (pending === undefined) {
      return;
    }
    this.#pending.delete(handle);
    disarm(pending);
  }

  #arm(handle: number, callback: (time: number) => void): void {
    const run = (frames: FrameScheduling | undefined, time: number): void => {
      const pending = this.#pending.get(handle);
      if (pending === undefined) {
        return;
      }
      this.#pending.delete(handle);
      disarm(pending);
      this.#lastRanOn = frames;
      callback(time);
    };
    if (this.#windows.size === 0) {
      const timeout = globalThis.setTimeout(() => {
        run(undefined, globalThis.performance.now());
      }, 0);
      this.#pending.set(handle, { callback, armings: [], timeout });
      return;
    }
    const lastRanOn = this.#lastRanOn;
    const armings = [...this.#windows].flatMap((frames): FrameArming[] => {
      const { requestAnimationFrame } = frames;
      if (requestAnimationFrame === undefined) {
        return [];
      }
      const arming: FrameArming = { frames, platformHandle: 0 };
      const runHere = (time: number): void => {
        run(frames, time);
      };
      const skipStep = (): void => {
        arming.platformHandle = requestAnimationFrame.call(frames, runHere);
      };
      // Called on its owner: a window's `requestAnimationFrame` throws when called detached.
      arming.platformHandle = requestAnimationFrame.call(
        frames,
        lastRanOn === undefined || lastRanOn === frames ? runHere : skipStep,
      );
      return [arming];
    });
    this.#pending.set(handle, { callback, armings, timeout: undefined });
  }
}

/**
 * Stands for a window that ran the last frame and has since closed, so every open window skips the
 * step that may share its display frame without the closed window being kept.
 */
const closedWindow: FrameScheduling = {};

/** One window's arming of a pending frame, its handle moving on when a skipped step re-arms it. */
interface FrameArming {
  readonly frames: FrameScheduling;
  platformHandle: number;
}

/** A frame not yet run: where it is armed, and what runs it. */
interface PendingFrame {
  readonly callback: (time: number) => void;
  readonly armings: readonly FrameArming[];
  readonly timeout: ReturnType<typeof setTimeout> | undefined;
}

function disarm(pending: PendingFrame): void {
  for (const arming of pending.armings) {
    arming.frames.cancelAnimationFrame?.(arming.platformHandle);
  }
  if (pending.timeout !== undefined) {
    globalThis.clearTimeout(pending.timeout);
  }
}
