// Two windows painting in one display frame each run their own frame step, one after the other;
// the stand-in windows below are stepped by hand in that order.

import { describe, expect, it } from "vitest";
import type { FrameScheduling } from "./clock.js";
import { OpenWindowFrames } from "./open-window-frames.js";

/**
 * A window's frame clock stepped by hand. A step runs what was armed before it began, as a
 * browser does, so what is armed during a step waits for the next one.
 */
class SteppedWindowFrames implements FrameScheduling {
  readonly #armed = new Map<number, (time: number) => void>();
  #nextHandle = 1;

  public readonly requestAnimationFrame = (callback: (time: number) => void): number => {
    const handle = this.#nextHandle;
    this.#nextHandle += 1;
    this.#armed.set(handle, callback);
    return handle;
  };

  public readonly cancelAnimationFrame = (handle: number): void => {
    this.#armed.delete(handle);
  };

  /** Run this window's frame step, then the microtasks it queued. */
  public async step(): Promise<void> {
    const due = [...this.#armed];
    this.#armed.clear();
    for (const [, callback] of due) {
      callback(0);
    }
    await Promise.resolve();
  }
}

describe("the frames shared by the open windows", () => {
  it("runs a self-rearming frame once per display frame, and on the window left open after a close", async () => {
    const frames = new OpenWindowFrames();
    const first = new SteppedWindowFrames();
    const second = new SteppedWindowFrames();
    frames.hold(first);
    frames.hold(second);
    // One frame asks for the next while it runs, the other once it has returned.
    const runs = { inFrame: 0, afterFrame: 0 };
    const inFrame = (): void => {
      runs.inFrame += 1;
      frames.requestAnimationFrame(inFrame);
    };
    const afterFrame = (): void => {
      runs.afterFrame += 1;
      queueMicrotask(() => {
        frames.requestAnimationFrame(afterFrame);
      });
    };
    frames.requestAnimationFrame(inFrame);
    frames.requestAnimationFrame(afterFrame);

    await first.step();
    await second.step();
    expect(runs).toEqual({ inFrame: 1, afterFrame: 1 });
    await second.step();
    await first.step();
    expect(runs).toEqual({ inFrame: 2, afterFrame: 2 });

    // The first window closes in the middle of a display frame: after its step ran both frames, and
    // before the frame asked for once a frame returned.
    const closingStep = first.step();
    frames.release(first);
    await closingStep;
    await second.step();
    expect(runs).toEqual({ inFrame: 3, afterFrame: 3 });
    await second.step();
    expect(runs).toEqual({ inFrame: 4, afterFrame: 4 });
    await second.step();
    expect(runs).toEqual({ inFrame: 5, afterFrame: 5 });
  });
});
