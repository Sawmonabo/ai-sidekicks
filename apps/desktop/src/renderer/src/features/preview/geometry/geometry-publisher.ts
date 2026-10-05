// The half of pane geometry that touches a document: which invalidation sources are armed, when a
// reading is taken and when it is written. Read now, write next frame, because mutating layout
// inside resize-observer delivery drops the remaining notifications on at least one shipped
// engine. Every source is armed, since a resize observer alone misses a pane that moves.

import type { Unsubscribe } from "@shared/preload-api.js";
import { Emitter } from "@renderer/lib/emitter.js";
import { type Clock, type ScheduledHandle } from "@renderer/lib/clock.js";
import { type Refusal } from "@renderer/lib/refusal.js";
import { clippingAncestorsOf } from "@renderer/lib/clipping-ancestors.js";
import { observeElementResize } from "@renderer/lib/element-resize.js";
import { SCHEME_ATTRIBUTE } from "@shared/appearance.js";
import { observeElementPosition } from "./element-motion.js";
import { overlayMotionObserver } from "./overlay-observation.js";
import {
  composePaneGeometrySample,
  type GeometryInvalidationReason,
  type PaneGeometrySample,
  type PaneOverlaySource,
  type PaneRect,
  roundPaneRect,
} from "./pane-geometry.js";
import type { PageHost } from "./page-host.js";

/** What the last publish attempt did. Rendered by the pane; never inferred. */
export type PaneGeometryOutcome =
  | { readonly status: "published"; readonly sample: PaneGeometrySample }
  | { readonly status: "deduped"; readonly sample: PaneGeometrySample }
  | { readonly status: "suppressed"; readonly refusal: Refusal };

/** What a publisher needs: where it publishes, its frame clock, and the overlay source. */
export interface PaneGeometryPublisherOptions {
  readonly pageHost: PageHost;
  readonly clock: Clock;
  readonly occlusion: PaneOverlaySource;
}

/**
 * Keeps one host element's rectangle published to one page host. A class because arm-once,
 * dispose-once and never-re-arm-after-a-rejection are state invariants with one owner.
 */
export class PaneGeometryPublisher {
  readonly #pageHost: PageHost;
  readonly #clock: Clock;
  readonly #occlusion: PaneOverlaySource;
  readonly #outcomeEmitter = new Emitter<void>("pane geometry outcome");
  #hostElement: HTMLElement | undefined;
  #detachers: Unsubscribe[] = [];
  #queuedFrame: ScheduledHandle | undefined;
  #pendingSample: PaneGeometrySample | undefined;
  #lastPublishedKey: string | undefined;
  #lastOutcome: PaneGeometryOutcome | undefined;
  #publishCount = 0;
  #disposed = false;

  public constructor(options: PaneGeometryPublisherOptions) {
    this.#pageHost = options.pageHost;
    this.#clock = options.clock;
    this.#occlusion = options.occlusion;
  }

  /**
   * Arms every invalidation source against one host element: resize, position, window resize,
   * capture-phase document scroll (a nested scroller's scroll does not bubble), overlays, and
   * theme changes (token-driven chrome heights shift the rectangle). All land on `invalidate`,
   * which reads immediately and queues one write, so several observers firing on one relayout
   * cost one publish.
   */
  public observe(hostElement: HTMLElement): Unsubscribe {
    if (this.#disposed) {
      return () => undefined;
    }
    this.#hostElement = hostElement;
    this.#armResizeObserver(hostElement);
    this.#armPositionObserver(hostElement);
    this.#armViewportListeners();
    this.#armThemeObserver();
    this.#armOverlaySources();
    this.invalidate("attach");
    return () => {
      this.dispose();
    };
  }

  /**
   * Takes a reading now and queues the write. The read is synchronous so it is correct inside
   * observer delivery; the write waits a frame because mutating layout there drops
   * notifications on at least one shipped engine and strands the view. Re-entry before the
   * frame replaces the pending sample rather than queueing a second frame.
   */
  public invalidate(reason: GeometryInvalidationReason): void {
    // Disposal clears the host, so a late event after it reads nothing.
    const element = this.#hostElement;
    if (element === undefined) {
      return;
    }
    this.#pendingSample = composePaneGeometrySample({
      hostRect: readElementRect(element),
      clipRects: readClippingAncestorRects(element),
      overlayRects: this.#occlusion.liveRects(),
      reason,
      sampledAtMs: this.#clock.now(),
    });
    if (this.#queuedFrame !== undefined) {
      return;
    }
    this.#queuedFrame = this.#clock.scheduleFrame(() => {
      this.#queuedFrame = undefined;
      this.#flush();
    });
  }

  /** The last publish attempt's outcome, or `undefined` before the first. */
  public lastOutcome(): PaneGeometryOutcome | undefined {
    return this.#lastOutcome;
  }

  /**
   * Fires whenever a new outcome is recorded, so the pane can render it. A `void` event and a
   * re-read of `lastOutcome()`, the shape `useSyncExternalStore` takes; without it a `pane-gone`
   * rejection landing after the pane's one read at attach would be seen by nobody.
   */
  public subscribeToOutcomes(sink: () => void): Unsubscribe {
    return this.#outcomeEmitter.subscribe(sink);
  }

  /** How many samples reached the page host. Deduped samples do not count. */
  public get publishCount(): number {
    return this.#publishCount;
  }

  /** How many sources are armed; zero after `dispose`. */
  public get armedSourceCount(): number {
    return this.#detachers.length;
  }

  /**
   * Whether this publisher is spent. Disposal is terminal (an unmount, or the page host
   * rejecting a rectangle for a gone pane), so an owner reads this to know to mint a new one.
   */
  public get isDisposed(): boolean {
    return this.#disposed;
  }

  /** Terminal. A disposed publisher never re-arms, however late an event arrives. */
  public dispose(): void {
    this.#disposed = true;
    for (const detach of this.#detachers) {
      detach();
    }
    this.#detachers = [];
    if (this.#queuedFrame !== undefined) {
      this.#clock.cancel(this.#queuedFrame);
      this.#queuedFrame = undefined;
    }
    this.#hostElement = undefined;
    this.#pendingSample = undefined;
  }

  #flush(): void {
    const sample = this.#pendingSample;
    this.#pendingSample = undefined;
    if (sample === undefined) {
      return;
    }
    if (sample.key === this.#lastPublishedKey) {
      this.#recordOutcome({ status: "deduped", sample });
      return;
    }
    const outcome = this.#pageHost.setRect(sample);
    if (outcome.status === "rejected") {
      // Retrying would publish a rectangle for a pane that is gone, once per frame.
      // Dispose before recording: `Emitter` re-raises what a sink throws, and a throwing sink
      // must not leave the publisher armed. `dispose` keeps the sinks, so they still hear it.
      this.dispose();
      this.#recordOutcome({ status: "suppressed", refusal: outcome.refusal });
      return;
    }
    this.#lastPublishedKey = sample.key;
    this.#publishCount += 1;
    this.#recordOutcome({ status: "published", sample });
  }

  /**
   * The one writer of the outcome field, so no arm records a result without announcing it.
   * `dispose` does not clear the sinks: the subscription belongs to whoever opened it, and
   * severing it would drop the notification carrying the refusal that caused the disposal.
   */
  #recordOutcome(outcome: PaneGeometryOutcome): void {
    this.#lastOutcome = outcome;
    this.#outcomeEmitter.emit();
  }

  /**
   * The overlay sources: the set's change stream, and the per-frame motion observation only a
   * native-view consumer needs. Armed with the others so `dispose` retires them on every path.
   */
  #armOverlaySources(): void {
    this.#detachers.push(
      this.#occlusion.subscribeToChanges(() => {
        this.invalidate("overlay-change");
      }),
      this.#occlusion.installMotionObserver(overlayMotionObserver(this.#clock)),
    );
  }

  /** The size source, through the shared resize seam in `lib/element-resize.ts`. */
  #armResizeObserver(hostElement: HTMLElement): void {
    this.#detachers.push(
      observeElementResize(hostElement, () => {
        this.invalidate("resize-observer");
      }),
    );
  }

  /**
   * The move source, producer of `layout-mover`: a pane layout reorder, a shrinking sibling or a
   * sliding rail moves the pane without changing its own box, which no other source reports.
   */
  #armPositionObserver(hostElement: HTMLElement): void {
    this.#detachers.push(
      observeElementPosition({
        element: hostElement,
        clock: this.#clock,
        onMove: () => {
          this.invalidate("layout-mover");
        },
      }),
    );
  }

  #armViewportListeners(): void {
    const onResize = (): void => {
      this.invalidate("window-resize");
    };
    const onScroll = (): void => {
      this.invalidate("document-scroll");
    };
    window.addEventListener("resize", onResize);
    document.addEventListener("scroll", onScroll, { capture: true });
    this.#detachers.push(() => {
      window.removeEventListener("resize", onResize);
      document.removeEventListener("scroll", onScroll, { capture: true });
    });
  }

  #armThemeObserver(): void {
    const observer = new MutationObserver(() => {
      this.invalidate("theme-change");
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: [SCHEME_ATTRIBUTE],
    });
    this.#detachers.push(() => {
      observer.disconnect();
    });
  }
}

function readElementRect(element: Element): PaneRect {
  return roundPaneRect(element.getBoundingClientRect());
}

/**
 * Every clipping ancestor's box, outermost first (the order `PaneGeometryInput` declares).
 * Which ancestors clip is `lib/clipping-ancestors.ts`'s answer.
 */
function readClippingAncestorRects(element: HTMLElement): readonly PaneRect[] {
  return [...clippingAncestorsOf(element)].reverse().map(readElementRect);
}
