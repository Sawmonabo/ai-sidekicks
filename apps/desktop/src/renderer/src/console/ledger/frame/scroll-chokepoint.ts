// The ledger's scroll chokepoint — the one module in the console that writes a
// scroll offset.
//
// `Spec-023 §Console Design (Meridian)` §5.8: "A single scroll controller per
// timeline pane owns `scrollTop` writes; every caller is a member of a closed
// caller union and is named in the write; glides replace `scrollIntoView`
// everywhere." `test/console/architecture/scroll-chokepoint.test.ts` is what makes
// that a fact rather than an intention: it reads every console module and fails on
// a second writer.
//
// FOUR DECISIONS THIS MODULE MAKES, each of which §5.8 forces:
//
//   • **The caller is named in the write.** Not for a log — for arbitration. Four
//     subsystems want the offset (following, the reading anchor, find, replay), and
//     when two want it in one frame the loser has to be identifiable. A write from
//     an anonymous caller cannot be arbitrated, only overwritten.
//   • **Quantization is LEARNED, never assumed.** Skipping a "no-op" write is safe
//     on a display that rounds a written offset and wrong on one that does not, and
//     nothing in the platform reports which. `scroll-quantization.ts` answers it by
//     writing and reading back; this controller only consults the answer, and skips
//     nothing while it is still open.
//   • **Geometry is published, not polled.** A replayable, instance-bound
//     subscription: a subscriber gets the last sample immediately rather than
//     waiting for the next scroll, which is what lets a pane mount mid-stream
//     already knowing whether it is at the tail. Nothing here arms a timer.
//   • **Following costs no hit test.** The sample reads `scrollTop`,
//     `clientHeight`, and `scrollHeight` and nothing else — no row rect, no
//     `elementFromPoint` — because those three are the only reads a scroll event
//     handler can afford at 60 Hz with four lanes streaming.
//
// Overflow measurement for clamped rows is batched and pre-paint: triggers
// accumulate, one frame is armed through the clock seam, and the sink runs once
// with the surface's geometry. Font loading re-runs it, because a webfont swap
// changes every clamped row's height after the layout that measured them.

import {
  Emitter,
  type ConsoleClock,
  type ScheduledHandle,
  type Unsubscribe,
} from "../../core/index.js";
import { LEDGER_GEOMETRY_EPSILON_PX, LEDGER_TAIL_TOLERANCE_PX } from "./frame-bounds.js";
import { WholePixelQuantizationLearner } from "./scroll-quantization.js";

/**
 * Every subsystem allowed to move the ledger. Closed, and closed here.
 *
 * A caller that is not on this list has not decided how it arbitrates against the
 * ones that are — which is the question the union exists to force.
 *
 * `measurement-compensation` is the virtualizer's: when a row above the fold
 * measures taller or shorter than it was estimated, every offset below it moves,
 * and the library offers to subtract the difference from the offset so the reader
 * does not. The reading anchor decides WHETHER that happens; the library computes
 * how much; this controller performs it. A library that wrote the offset itself
 * would be the second writer this union exists to prevent.
 */
export const LEDGER_SCROLL_CALLERS = [
  "follow-tail",
  "jump-to-tail",
  "hold-reading-position",
  "deep-link",
  "find-match",
  "replay-seek",
  "prune-compensation",
  "measurement-compensation",
] as const;

/** One scroll caller. Derived from the enumeration, never restated. */
export type LedgerScrollCaller = (typeof LEDGER_SCROLL_CALLERS)[number];

/**
 * The three numbers a scroll sample reads, and the two facts derived from them.
 *
 * `sampledAt` comes from the clock seam rather than `Date.now`, so a frozen
 * fixture clock names one exact frame.
 */
export interface LedgerGeometry {
  readonly scrollTop: number;
  readonly viewportHeight: number;
  readonly contentHeight: number;
  readonly distanceFromTailPx: number;
  readonly isAtTail: boolean;
  readonly sampledAt: number;
}

/** What one glide did, including the arm that did nothing. */
export interface LedgerScrollWrite {
  readonly caller: LedgerScrollCaller;
  readonly requestedScrollTop: number;
  readonly appliedScrollTop: number;
  /** True when the controller had confirmed quantization and the write was a no-op. */
  readonly wasSkipped: boolean;
}

/**
 * The surface the controller drives.
 *
 * Structural rather than `HTMLElement` so the unit tier can drive a surface whose
 * property reads it counts — which is how "no hit test per scroll event" is
 * checked rather than asserted. A real element satisfies it.
 */
export interface LedgerScrollSurface {
  scrollTop: number;
  readonly clientHeight: number;
  readonly scrollHeight: number;
  addEventListener(type: string, listener: () => void, options?: AddEventListenerOptions): void;
  removeEventListener(type: string, listener: () => void): void;
}

/** Called once per batched overflow pass, with the geometry it was measured at. */
export type OverflowMeasurementSink = (geometry: LedgerGeometry) => void;

export interface LedgerScrollControllerOptions {
  readonly clock: ConsoleClock;
  /** Within this many pixels of the bottom counts as the tail. */
  readonly tailTolerancePx?: number;
}

/**
 * Fonts, as much of the API as this module uses.
 *
 * Declared rather than reached through `document.fonts` typing, because the console
 * runs under a DOM shim in the unit tier where the set is absent, and an optional
 * declaration is the honest statement of that.
 */
interface FontLoadingDocument {
  readonly fonts?: { readonly ready: Promise<unknown> };
}

export class LedgerScrollController {
  readonly #clock: ConsoleClock;
  readonly #tailTolerancePx: number;
  readonly #geometryEmitter = new Emitter<LedgerGeometry>("ledger geometry");
  readonly #writeCountByCaller = new Map<LedgerScrollCaller, number>();
  readonly #quantization = new WholePixelQuantizationLearner();

  #surface: LedgerScrollSurface | undefined;
  #onSurfaceScroll: (() => void) | undefined;
  #resizeObserver: ResizeObserver | undefined;
  #lastGeometry: LedgerGeometry | undefined;
  #overflowSink: OverflowMeasurementSink | undefined;
  #overflowFrame: ScheduledHandle | undefined;
  #writeDepth = 0;
  #disposed = false;

  public constructor(options: LedgerScrollControllerOptions) {
    this.#clock = options.clock;
    this.#tailTolerancePx = options.tailTolerancePx ?? LEDGER_TAIL_TOLERANCE_PX;
  }

  /**
   * Take ownership of a scroll surface.
   *
   * Re-attaching detaches the previous surface first: a pane that re-mounts must
   * not leave a listener on a node React has already dropped.
   */
  public attach(surface: LedgerScrollSurface): void {
    if (this.#disposed) {
      return;
    }
    this.detach();
    this.#surface = surface;
    const onScroll = (): void => {
      this.#publishGeometry();
    };
    this.#onSurfaceScroll = onScroll;
    surface.addEventListener("scroll", onScroll, { passive: true });
    this.#observeSurfaceResize(surface);
    this.#observeFontLoading();
    this.#publishGeometry();
  }

  /**
   * Release the surface.
   *
   * Every read here is null-safe (`Spec-023 §Console Design (Meridian)` §5.17,
   * "teardown reads are null-safe"): teardown runs on an unmount that may follow a
   * failed attach, so the listener, the observer, and the armed frame may each be
   * absent independently.
   */
  public detach(): void {
    const surface = this.#surface;
    const onScroll = this.#onSurfaceScroll;
    if (surface !== undefined && onScroll !== undefined) {
      surface.removeEventListener("scroll", onScroll);
    }
    this.#resizeObserver?.disconnect();
    this.#resizeObserver = undefined;
    this.#onSurfaceScroll = undefined;
    this.#surface = undefined;
    this.#cancelOverflowFrame();
  }

  /** Terminal. A disposed controller attaches nothing and arms nothing. */
  public dispose(): void {
    this.detach();
    this.#geometryEmitter.clear();
    this.#disposed = true;
  }

  /**
   * Watch the geometry, and receive the last sample immediately.
   *
   * The replay is the point: a pane mounted mid-stream needs to know whether it is
   * at the tail before the next scroll event, and polling for that is exactly what
   * the budgets forbid.
   */
  public subscribeToGeometry(sink: (geometry: LedgerGeometry) => void): Unsubscribe {
    const unsubscribe = this.#geometryEmitter.subscribe(sink);
    const lastGeometry = this.#lastGeometry;
    if (lastGeometry !== undefined) {
      sink(lastGeometry);
    }
    return unsubscribe;
  }

  /** The last published sample, or `undefined` before the first attach. */
  public get geometry(): LedgerGeometry | undefined {
    return this.#lastGeometry;
  }

  /**
   * Move the ledger. The only `scrollTop` write in the console.
   *
   * Returns what happened rather than `void` so a caller can tell a skipped no-op
   * from a write that landed somewhere else — which is the difference between "the
   * anchor held" and "the browser clamped us to the end of the content".
   */
  public glideTo(
    caller: LedgerScrollCaller,
    targetScrollTop: number,
  ): LedgerScrollWrite | undefined {
    const surface = this.#surface;
    if (surface === undefined || this.#disposed) {
      return undefined;
    }
    const requestedScrollTop = this.#clampToContent(surface, targetScrollTop);
    const currentScrollTop = surface.scrollTop;
    this.#writeCountByCaller.set(caller, (this.#writeCountByCaller.get(caller) ?? 0) + 1);
    if (this.#quantization.isNoOpWrite(requestedScrollTop, currentScrollTop)) {
      return { caller, requestedScrollTop, appliedScrollTop: currentScrollTop, wasSkipped: true };
    }
    // The veto covers the WHOLE glide, publication included: a prune that landed
    // while subscribers were reacting to this write would change the content height
    // under the offset the write had just chosen.
    this.#writeDepth += 1;
    try {
      surface.scrollTop = requestedScrollTop;
      const appliedScrollTop = surface.scrollTop;
      this.#quantization.observe(requestedScrollTop, appliedScrollTop);
      this.#publishGeometry();
      return { caller, requestedScrollTop, appliedScrollTop, wasSkipped: false };
    } finally {
      this.#writeDepth -= 1;
    }
  }

  /** The glide that replaces `scrollIntoView` for the bottom of the log. */
  public glideToTail(caller: LedgerScrollCaller): LedgerScrollWrite | undefined {
    const surface = this.#surface;
    if (surface === undefined) {
      return undefined;
    }
    return this.glideTo(caller, surface.scrollHeight - surface.clientHeight);
  }

  /**
   * Whether a prune may land right now.
   *
   * `Spec-023 §Console Design (Meridian)` §5.16 gives the scroll controller a veto
   * over prune, and this is it: removing rows above the fold while a programmatic
   * write is mid-flight changes the content height under the offset that write
   * just chose.
   */
  public vetoesPrune(): boolean {
    return this.#writeDepth > 0;
  }

  /**
   * Install the batched overflow-measurement pass.
   *
   * One sink per controller: two would be two passes over one layout, which is the
   * cost this batching exists to avoid.
   */
  public observeOverflow(sink: OverflowMeasurementSink): Unsubscribe {
    this.#overflowSink = sink;
    return () => {
      if (this.#overflowSink === sink) {
        this.#overflowSink = undefined;
      }
    };
  }

  /**
   * Ask for an overflow pass. Repeated calls inside one frame cost one pass.
   *
   * Pre-paint through the clock's frame seam rather than a microtask, so the
   * measurement reads a layout the browser has settled.
   */
  public requestOverflowMeasurement(): void {
    if (this.#disposed || this.#overflowFrame !== undefined) {
      return;
    }
    this.#overflowFrame = this.#clock.scheduleFrame(() => {
      this.#overflowFrame = undefined;
      const geometry = this.#sampleGeometry();
      if (geometry !== undefined) {
        this.#overflowSink?.(geometry);
      }
    });
  }

  /** How many times a caller has written. Read by diagnostics and by tests. */
  public writeCount(caller: LedgerScrollCaller): number {
    return this.#writeCountByCaller.get(caller) ?? 0;
  }

  /**
   * Whether this display quantizes programmatic writes, or `undefined` while the
   * question is still open. Skipping is gated on `true`, never on `undefined`.
   */
  public get quantizesToWholePixels(): boolean | undefined {
    return this.#quantization.verdict;
  }

  #clampToContent(surface: LedgerScrollSurface, targetScrollTop: number): number {
    const maximum = Math.max(0, surface.scrollHeight - surface.clientHeight);
    if (!Number.isFinite(targetScrollTop)) {
      // Fail closed rather than handing `NaN` to the platform, which silently
      // becomes zero and teleports the reader to the top of the log.
      return 0;
    }
    return Math.min(Math.max(0, targetScrollTop), maximum);
  }

  /**
   * Read the three numbers, and nothing else.
   *
   * Every derived fact below comes from these three. A row rect read here would be
   * a hit test on the scroll path, which §5.8 forbids while following.
   */
  #sampleGeometry(): LedgerGeometry | undefined {
    const surface = this.#surface;
    if (surface === undefined) {
      return undefined;
    }
    const scrollTop = surface.scrollTop;
    const viewportHeight = surface.clientHeight;
    const contentHeight = surface.scrollHeight;
    const distanceFromTailPx = Math.max(0, contentHeight - viewportHeight - scrollTop);
    return {
      scrollTop,
      viewportHeight,
      contentHeight,
      distanceFromTailPx,
      isAtTail: distanceFromTailPx <= this.#tailTolerancePx + LEDGER_GEOMETRY_EPSILON_PX,
      sampledAt: this.#clock.now(),
    };
  }

  #publishGeometry(): void {
    const geometry = this.#sampleGeometry();
    if (geometry === undefined) {
      return;
    }
    this.#lastGeometry = geometry;
    this.#geometryEmitter.emit(geometry);
  }

  #observeSurfaceResize(surface: LedgerScrollSurface): void {
    // Only an element can be observed; a structural surface driven by a test
    // cannot, and asking for an observer it can never feed would be a subscription
    // held open against nothing.
    if (!(surface instanceof Element)) {
      return;
    }
    const observerHost = globalThis as { readonly ResizeObserver?: typeof ResizeObserver };
    const ObserverConstructor = observerHost.ResizeObserver;
    if (ObserverConstructor === undefined) {
      // A DOM shim without a resize observer. The pass still runs on font loading
      // and on the viewport's own row-measurement calls, so the absence costs a
      // trigger rather than the feature.
      return;
    }
    const observer = new ObserverConstructor(() => {
      this.requestOverflowMeasurement();
    });
    observer.observe(surface);
    this.#resizeObserver = observer;
  }

  /**
   * Re-run the pass once the webfonts have swapped.
   *
   * A clamped row's height is a function of its font, so the measurements taken
   * before the swap describe a layout that no longer exists.
   */
  #observeFontLoading(): void {
    const fonts = (globalThis as { readonly document?: FontLoadingDocument }).document?.fonts;
    if (fonts === undefined) {
      return;
    }
    void fonts.ready.then(() => {
      this.requestOverflowMeasurement();
    });
  }

  #cancelOverflowFrame(): void {
    if (this.#overflowFrame === undefined) {
      return;
    }
    this.#clock.cancel(this.#overflowFrame);
    this.#overflowFrame = undefined;
  }
}
