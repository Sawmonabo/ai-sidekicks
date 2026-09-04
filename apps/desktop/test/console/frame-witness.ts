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

/** Frames arrived inside the budget. */
export interface FramesWitnessed {
  readonly painting: true;
  /** Wall milliseconds the witness waited, measured on the driver side. */
  readonly waitedMs: number;
  /** Renderer-side milliseconds from the request to the second frame. */
  readonly frameIntervalMs: number;
}

/** No frame arrived inside the budget. */
export interface FramesMissing {
  readonly painting: false;
  readonly waitedMs: number;
}

export type FrameWitnessOutcome = FramesWitnessed | FramesMissing;

/**
 * How long a READY renderer has to deliver two consecutive animation frames.
 *
 * Derived from measurement, and the derivation matters more than the number
 * because the number this replaces was derived from a display refresh interval —
 * "clearly above a refresh interval and clearly below a tier's patience" — which
 * describes an idle desktop and describes no CI runner.
 *
 * What was measured, and what it showed. The harness prints the figure on every
 * launch (`[sidekicks-console-launch]`), so this rests on real launches rather
 * than an estimate. Twenty of them on an eight-core Apple-silicon host: ten
 * deliberate — five idle, five with the GPU disabled and Chromium rendering
 * through SwiftShader, the shape of the CI runner — and ten more harvested from
 * ordinary tier runs while the host was incidentally at a one-minute load
 * average near 280, roughly 35x oversubscribed. Across all twenty the
 * post-readiness interval was 1-18 ms in the renderer and 2-47 ms driver-side.
 *
 * It does not degrade the way an intuition about load would predict. The single
 * 47 ms outlier is driver-side only — its renderer reported 4 ms — so it is a
 * CDP round trip queued behind a busy main thread rather than a frame schedule
 * that slowed down, and the in-renderer figure barely moves at 35x contention
 * because software rendering is not clamped to a display's refresh.
 *
 * Which settles what the failures were, and it is not the frame schedule. Once a
 * renderer is ready its two frames are a matter of milliseconds. What the old
 * 2 000 ms race actually bounded was the driver side: a `Page.evaluate` round
 * trip lands behind whatever the renderer's main thread is already doing, and on
 * a 2-vCPU runner mounting the console — its store, its scenario engine, its
 * persistence — that queue is the quantity that crossed 2 000 ms, on a window
 * that then painted normally. No local host reproduces it, so the bound cannot
 * be derived from the local worst case plus a margin.
 *
 * It is derived from the asymmetry instead, which is decidable without that
 * figure. Over-tight costs a red check on a window that was working, on a job
 * nobody can then read — the defect this replaces. Over-loose costs only how
 * long a genuinely throttled launch takes to report, and a throttled window
 * delivers no frame at ALL, so it spends the whole budget whatever the budget
 * is. So the bound is the largest value that still keeps its two ordering
 * properties, both of which are now checked rather than asserted: it is at most
 * half of `READINESS_BUDGET_MS`, so a launch whose problem is the WINDOW still
 * fails naming the window, and it is RESERVED inside `LAUNCH_BUDGET_MS`, which
 * `launch-deadline.ts` holds against every launching tier's own resolved
 * `testTimeout` — so a reader sees this witness's sentence rather than vitest's.
 *
 * That last property used to be a ratio in this comment and nothing more, and it
 * was false: the readiness ladder handed each of its four phases an independent
 * 30 000 ms, so a launch could spend 135 000 ms inside a 60 000 ms tier and be
 * killed before this witness ever spoke.
 */
export const FRAME_WITNESS_TIMEOUT_MS = 15_000;

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
    // the application — which rejects it. Without this the rejection arrives with
    // no handler attached and vitest fails the tier on an unhandled rejection
    // instead of on the witness's own verdict. Attaching a handler here does not
    // remove `framesDelivered` from the race, so a rejection that arrives BEFORE
    // the budget expires still propagates: a crashed renderer reports as a crash.
    framesDelivered.catch(() => undefined);
    try {
      const frameIntervalMs = await Promise.race([framesDelivered, budgetExpired]);
      const waitedMs = Date.now() - startedAt;
      return frameIntervalMs === null
        ? { painting: false, waitedMs }
        : { painting: true, waitedMs, frameIntervalMs };
    } finally {
      clearTimeout(timeoutHandle);
    }
  }
}
