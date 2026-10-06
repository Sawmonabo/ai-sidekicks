// Does a launched window's renderer actually paint?
//
// Chromium throttles timers and animation frames in a hidden or occluded window, so a measurement
// there describes a throttled renderer. `src/main/windows/reveal.ts` turns background
// throttling off for these launches, and the harness checks on every launch that frames arrive.
//
// "Is the renderer painting at all?" and "did its first frame arrive quickly?" are separate
// questions: a throttled window delivers no frame ever, while a healthy window on a loaded 2-vCPU
// runner can deliver its first one late. The harness arms this paint probe only after the renderer
// signals readiness (the document `load` event, then the app's frame element); everything
// before that is charged to the cold-start budget and this paint probe bounds the interval after
// it.

import { FRAME_PAINT_PROBE_TIMEOUT_MS } from "./launch/budgets.js";

/**
 * The renderer, reduced to the one question the paint probe asks it.
 *
 * `awaitTwoFrames` resolves with the renderer-side milliseconds between the request and the
 * second frame; two, because a single callback can be the tail of a frame already in production.
 * It never rejects for lateness, since the paint probe owns the bound, but may reject for a real
 * failure such as a closed page, which the paint probe lets through.
 */
export interface RendererFrameSource {
  readonly awaitTwoFrames: () => Promise<number>;
}

/** What every verdict carries, whichever way the race went. */
interface FramePaintMeasurement {
  /** Wall milliseconds the paint probe waited, measured on the driver side. */
  readonly waitedMs: number;
  /** The bound this paint probe was actually held to, in milliseconds. */
  readonly budgetMs: number;
}

/** Frames arrived inside the budget. */
export interface FramesPainted extends FramePaintMeasurement {
  readonly painting: true;
  /** Renderer-side milliseconds from the request to the second frame. */
  readonly frameIntervalMs: number;
}

/** No frame arrived inside the budget. */
export interface FramesMissing extends FramePaintMeasurement {
  readonly painting: false;
}

/** The paint probe's verdict: frames painted inside the budget, or missing. */
export type FramePaintProbeOutcome = FramesPainted | FramesMissing;

/**
 * Bounds the interval between a renderer signaling readiness and its second animation frame.
 *
 * The worst local figure over twenty launches was 47 ms; the budget is derived from the cost of
 * failing early versus late, not from that figure.
 */
export class FramePaintProbe {
  readonly #frameSource: RendererFrameSource;

  constructor(frameSource: RendererFrameSource) {
    this.#frameSource = frameSource;
  }

  async probe(): Promise<FramePaintProbeOutcome> {
    const startedAt = Date.now();
    let timeoutHandle: NodeJS.Timeout | undefined;
    const budgetExpired = new Promise<null>((resolveExpiry) => {
      timeoutHandle = setTimeout(() => {
        resolveExpiry(null);
      }, FRAME_PAINT_PROBE_TIMEOUT_MS);
    });
    const framesDelivered = this.#frameSource.awaitTwoFrames();
    // Racing, not only bounding, keeps an abandoned probe handled: `Promise.race` calls `then` on
    // both promises. When the budget wins and the caller closes the application, the late
    // rejection then cannot fail the tier. A rejection before the budget expires still
    // propagates, so a crashed renderer reports as a crash.
    try {
      const frameIntervalMs = await Promise.race([framesDelivered, budgetExpired]);
      const waitedMs = Date.now() - startedAt;
      const budgetMs = FRAME_PAINT_PROBE_TIMEOUT_MS;
      return frameIntervalMs === null
        ? { painting: false, waitedMs, budgetMs }
        : { painting: true, waitedMs, budgetMs, frameIntervalMs };
    } finally {
      clearTimeout(timeoutHandle);
    }
  }
}
