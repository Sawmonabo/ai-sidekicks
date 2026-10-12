// The reader's gesture, read off the time stamps of their input and scroll samples, how far each
// sample moved the box, and the box's `scrollend`. Once the reader's scroll has moved the box, the
// platform owes a `scrollend`, which it sends only when the scroll sequence is over: after a
// fling's or a trackpad's momentum, never between the frames a busy machine draws late. Until it
// comes every input and sample carries the gesture on, however long the gap. Where none is owed a
// gesture ends at a pause of `TRANSCRIPT_GESTURE_GAP_MS`, a hand that let go with the box still,
// and the reader's next wheel, key or touch after it starts the next. A scrollend the
// transcript's own write fired clears what is owed too, since the platform sends a write's and a
// gesture's in one event when they fall in the same frame; the scroll's next sample owes one
// again. Between the two, a sample whose box moved through a long gap at half the gesture's pace or
// more carries the gesture on when no input came in the gap, as none does in a fling's momentum:
// half keeps a fling's late frame of up to about 430 ms, over which the platform's fling curve
// still averages more than half the speed it entered at. A touch that begins a gesture times the
// first sample's travel from where the hand landed, since a hand moves the box steadily from then
// on, so a drag a busy page first meets late, in one burst, reads the speed it carried the box at.
// A wheel or a key moves the box in one jump, which only the samples time.

import { TRANSCRIPT_GESTURE_GAP_MS } from "./caps.js";

/** One sample of the reader's gesture, as `ReaderGesture.observe` read it. */
export interface ReaderGestureSample {
  /** The time since the sample before, in milliseconds; `undefined` for the first one read. */
  readonly gapMs: number | undefined;
  /**
   * The box's speed since the sample before, in pixels a millisecond; `undefined` for the first
   * sample, one that says no travel, or one stamped no later than the sample before.
   */
  readonly speedPxPerMs: number | undefined;
  /** Whether the sample carries on the gesture of the sample before it. */
  readonly continuesGesture: boolean;
}

/** The reader's gesture over their samples: each sample's speed and whether it ends a gesture. */
export class ReaderGesture {
  #lastAtMs: number | undefined;
  /** The speeds of the gesture's last two samples, its pace; empty as a gesture starts. */
  #paceSpeedsPxPerMs: readonly number[] = [];
  /** Whether a sample moved the box since its last `scrollend`, so the platform owes one. */
  #isScrollEndOwed = false;

  /**
   * Folds in a sample at `atMs`, on the page's performance timeline, that moved the box
   * `travelPx` since the sample before, or `undefined` for an input that moves no box itself.
   */
  public observe(atMs: number, travelPx: number | undefined): ReaderGestureSample {
    const lastAtMs = this.#lastAtMs;
    this.#lastAtMs = atMs;
    const gapMs = lastAtMs === undefined ? undefined : atMs - lastAtMs;
    const speedPxPerMs =
      gapMs === undefined || gapMs <= 0 || travelPx === undefined ? undefined : travelPx / gapMs;
    const continuesGesture =
      gapMs !== undefined &&
      (this.#isScrollEndOwed ||
        gapMs < TRANSCRIPT_GESTURE_GAP_MS ||
        this.#isCarriedOnAt(speedPxPerMs));
    if (!continuesGesture) {
      this.#paceSpeedsPxPerMs = [];
    } else if (speedPxPerMs !== undefined) {
      this.#paceSpeedsPxPerMs = [...this.#paceSpeedsPxPerMs.slice(-1), speedPxPerMs];
    }
    if (travelPx !== undefined && travelPx > 0) {
      this.#isScrollEndOwed = true;
    }
    return { gapMs, speedPxPerMs, continuesGesture };
  }

  /**
   * The reader's touch landed at `atMs`. When it begins a gesture the next sample's travel is
   * timed from it; within one, a hand that catches a fling, it times nothing.
   */
  public noteTouchStart(atMs: number): void {
    const lastAtMs = this.#lastAtMs;
    if (
      lastAtMs !== undefined &&
      (this.#isScrollEndOwed || atMs - lastAtMs < TRANSCRIPT_GESTURE_GAP_MS)
    ) {
      return;
    }
    this.#lastAtMs = atMs;
    this.#paceSpeedsPxPerMs = [];
  }

  /** The box's `scrollend` arrived: nothing is owed until a sample moves the box again. */
  public noteScrollEnd(): void {
    this.#isScrollEndOwed = false;
  }

  /** Forgets the samples read, so the next one starts a gesture. */
  public forget(): void {
    this.#lastAtMs = undefined;
    this.#paceSpeedsPxPerMs = [];
    this.#isScrollEndOwed = false;
  }

  /**
   * Whether a sample a gesture gap or more after the one before moved the box on at half the
   * gesture's pace or more; the slower of its last two speeds, so one sample a burst of input
   * sped up ends nothing.
   */
  #isCarriedOnAt(speedPxPerMs: number | undefined): boolean {
    if (speedPxPerMs === undefined || this.#paceSpeedsPxPerMs.length === 0) {
      return false;
    }
    return speedPxPerMs >= Math.min(...this.#paceSpeedsPxPerMs) / 2;
  }
}
