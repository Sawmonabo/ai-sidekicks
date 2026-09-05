// Does a launched window's renderer actually paint?
//
// Every Electron tier launches a window that is never revealed on macOS and
// revealed inactive elsewhere, and Chromium answers a hidden or occluded window
// by throttling its timers and animation frames to nothing. A measurement taken
// there describes a throttled renderer rather than the console, so
// `src/main/window-reveal.ts` switches background throttling off for these
// launches and the harness checks — on every launch, rather than trusting it —
// that frames genuinely arrive.
//
// THE TWO QUESTIONS THIS SEPARATES
//
// "Is the renderer painting at all?" and "did its first frame arrive quickly?"
// are different questions with different answers, and the witness used to fuse
// them into one 2 000 ms race started at window creation. A throttled window
// delivers NO frame, ever; a healthy window on a loaded 2-vCPU Xvfb runner can
// deliver its first one late. Fusing the two made the second failure wear the
// first one's sentence, and it did: run 33914273796 threw "the renderer is not
// painting" for the endurance tier's fourth-plus Electron launch in one job, and
// run 33914986509 threw the same sentence for an e2e launch early in its own
// sequence — two windows that were painting.
//
// The separation is structural first and a bigger number second. The harness
// arms this witness only once the renderer has SIGNALLED readiness — the
// document's `load` event and then the console's own frame element — which is
// the shape the smoke test's boot fix settled for the same runner: wait for a
// signal the application emits, never for a fixed interval. Everything before
// that signal is charged to the cold-start budget, which is what it is for. What
// is left for the budget below to bound is the interval AFTER readiness, which
// is the interval a throttled window never ends.
//
// The class exists so that interval can be tested without an Electron process:
// the frame source is a constructor argument, so a stub that resolves late and a
// stub that never resolves are both one object literal
// (`architecture/frame-witness.test.ts`).

import { FRAME_WITNESS_TIMEOUT_MS } from "./launch-budgets.js";

/**
 * The renderer, reduced to the one question the witness asks it.
 *
 * `awaitTwoFrames` resolves with the renderer-side milliseconds between the
 * request and the second frame. TWO frames rather than one: a single callback
 * can be the tail of a frame the compositor was already producing, while the
 * second proves the schedule is running.
 *
 * It never rejects for lateness — bounding is the witness's job, and a source
 * that enforced its own deadline would be a second budget to keep in step with
 * this one. It MAY reject for a real failure (a closed page, a crashed
 * renderer), and the witness lets that through rather than reporting it as a
 * window that would not paint.
 */
export interface RendererFrameSource {
  readonly awaitTwoFrames: () => Promise<number>;
}

/**
 * What every verdict carries, whichever way the race went.
 *
 * `budgetMs` is here rather than left for a caller to look up, and that is the
 * whole of this shape's reason for existing: the budget is a CONSTRUCTOR
 * argument with a default, so a caller that interpolated the module constant
 * into its sentence would be describing a bound the witness may never have
 * applied — wrong by a factor of 75 against the 200 ms every case in
 * `architecture/frame-witness.test.ts` injects. It is the same rule
 * `CleanupOutcome.budgetMs` states for the close: there is one figure, produced
 * where the bound is computed.
 */
interface FrameWitnessMeasurement {
  /** Wall milliseconds the witness waited, measured on the driver side. */
  readonly waitedMs: number;
  /** The bound this witness was actually held to, in milliseconds. */
  readonly budgetMs: number;
}

/** Frames arrived inside the budget. */
export interface FramesWitnessed extends FrameWitnessMeasurement {
  readonly painting: true;
  /** Renderer-side milliseconds from the request to the second frame. */
  readonly frameIntervalMs: number;
}

/** No frame arrived inside the budget. */
export interface FramesMissing extends FrameWitnessMeasurement {
  readonly painting: false;
}

export type FrameWitnessOutcome = FramesWitnessed | FramesMissing;

/**
 * The worst driver-side post-readiness figure measured locally, in
 * milliseconds — the slowest of the twenty launches described above.
 *
 * Exported rather than left in prose because a number in a comment is not a
 * gate: `architecture/frame-witness.test.ts` holds the budget against it, so
 * shrinking the bound back toward the measured cost fails a test that says why
 * rather than passing quietly and flaking a month later.
 *
 * It was 18 when only the first ten launches had been seen, and it is raised
 * here rather than left standing because the later ten produced a worse figure
 * and a comment claiming to state a worst case has to be re-derived when the set
 * it quantifies over grows. The bound above does not move with it: that bound is
 * derived from the asymmetry between failing early and failing late, never from
 * this figure plus a margin — which is exactly why a 2.6x revision to the worst
 * case leaves it correct, and why the guard is an order-of-magnitude
 * relationship rather than an equality.
 */
export const MEASURED_WORST_LOCAL_MS = 47;

/**
 * Bounds the interval between a renderer signalling readiness and its second
 * animation frame.
 *
 * A class rather than a function because the frame source is a seam: the
 * Playwright adapter is one implementation and a stub is another, and a
 * constructor argument is where a seam belongs.
 */
export class FrameWitness {
  readonly #frameSource: RendererFrameSource;
  readonly #budgetMs: number;

  constructor(frameSource: RendererFrameSource, budgetMs: number = FRAME_WITNESS_TIMEOUT_MS) {
    this.#frameSource = frameSource;
    this.#budgetMs = budgetMs;
  }

  async witness(): Promise<FrameWitnessOutcome> {
    const startedAt = Date.now();
    let timeoutHandle: NodeJS.Timeout | undefined;
    const budgetExpired = new Promise<null>((resolveExpiry) => {
      timeoutHandle = setTimeout(() => {
        resolveExpiry(null);
      }, this.#budgetMs);
    });
    const framesDelivered = this.#frameSource.awaitTwoFrames();
    // An ABANDONED probe must not take the process down. When the budget wins the
    // race the probe is still outstanding, and the caller's next act is to close
    // the application — which rejects it; unhandled, that fails the tier on
    // something other than this witness's verdict.
    //
    // The race is what stops that, and it is the race and nothing else:
    // `Promise.race` calls `then` on BOTH promises, so the loser stays handled
    // for the rest of its life. A bare `framesDelivered.catch(() => undefined)`
    // used to sit here claiming to be the mechanism, and it was a second handler
    // on an already-handled promise — removing it changes nothing, which is how
    // it was found. The claim lives in `architecture/frame-witness.test.ts`
    // instead, where an abandoned probe is rejected and the process is asserted
    // never to have been told: that case fails if this stops being a race.
    //
    // Racing rather than only bounding also keeps the OTHER direction: a
    // rejection arriving before the budget expires still propagates, so a
    // crashed renderer reports as a crash.
    try {
      const frameIntervalMs = await Promise.race([framesDelivered, budgetExpired]);
      const waitedMs = Date.now() - startedAt;
      const budgetMs = this.#budgetMs;
      return frameIntervalMs === null
        ? { painting: false, waitedMs, budgetMs }
        : { painting: true, waitedMs, budgetMs, frameIntervalMs };
    } finally {
      clearTimeout(timeoutHandle);
    }
  }
}
