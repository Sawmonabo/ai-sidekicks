// The half of 12.3 that has to touch a document.
//
// `Spec-023 §Console Design (Meridian)` 12.3, sampling half. `pane-geometry.ts` holds
// the arithmetic; this module holds the part that cannot be pure — which invalidation
// sources are armed, when a reading is taken, and when it is allowed to be written.
// Two rules live here and nowhere else:
//
//   * ARM EVERY SOURCE. A resize observer alone misses a pane that MOVES without
//     changing size, which is most of them — so a position observer sits beside it,
//     and neither of the two replaces the viewport, theme, or overlay sources.
//   * READ NOW, WRITE NEXT FRAME. Mutating layout from inside resize-observer delivery
//     drops the remaining notifications on at least one shipped engine.
//
// WHAT IS NOT INVENTED HERE. 12.3 names `browser.setRect` as the publish. That method
// is on `Plan-023 §Console growth slate` row `browser-pane-namespace` with no
// growth-port operation registered for it — the port carries the five navigation verbs
// and the navigation subscription, and nothing else — so the publish target is 12.11's
// host seam in `view-host.ts` rather than a fabricated method string.

import {
  Emitter,
  type ConsoleClock,
  type ConsoleRefusal,
  type ScheduledHandle,
  type Unsubscribe,
} from "../core/index.js";
import { observeElementResize } from "../primitives/index.js";
import { SCHEME_ATTRIBUTE } from "../tokens/index.js";
import { observeElementPosition } from "./element-motion.js";
import {
  composePaneGeometrySample,
  type GeometryInvalidationReason,
  type PaneGeometrySample,
  type PaneOverlaySource,
  type PaneRect,
  roundPaneRect,
} from "./pane-geometry.js";
import type { PaneViewHost } from "./view-host.js";

/** What the last publish attempt did. Rendered by the pane; never inferred. */
export type PaneGeometryOutcome =
  | { readonly status: "published"; readonly sample: PaneGeometrySample }
  | { readonly status: "deduped"; readonly sample: PaneGeometrySample }
  | { readonly status: "suppressed"; readonly refusal: ConsoleRefusal };

export interface PaneGeometryPublisherOptions {
  readonly host: PaneViewHost;
  readonly clock: ConsoleClock;
  readonly occlusion: PaneOverlaySource;
}

/**
 * Keeps one host element's rectangle published to one view host. A class with private
 * fields because its invariants — arm once, dispose once, never re-arm after a
 * rejection — are properties of that state and need a single owner.
 */
export class PaneGeometryPublisher {
  readonly #host: PaneViewHost;
  readonly #clock: ConsoleClock;
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
    this.#host = options.host;
    this.#clock = options.clock;
    this.#occlusion = options.occlusion;
  }

  /**
   * Arm every invalidation source against one host element, and all of them are
   * required: a resize observer misses a pane that MOVES without changing size — a
   * rail collapse, a sidebar drag, a sibling pane's width — so a POSITION observer
   * covers the ways the pane is carried while its own box stays the shape it was,
   * window resize and CAPTURE-PHASE document scroll cover the viewport (a scroll
   * inside a nested scroller does not bubble, so a bubbling listener would miss most
   * of them), an overlay opening or moving makes the view yield, and a theme change
   * moves the rectangle because token-driven chrome heights shift it.
   *
   * Every one of them lands on the same `invalidate`, which reads immediately and
   * queues ONE write, so three observers firing on a single relayout still cost one
   * publish.
   *
   * On an unavailable host it arms NOTHING and records why: 12.3's empty state is "no
   * view attached, publishes are suppressed", and rectangles a host cannot take are
   * work thrown away.
   */
  public observe(hostElement: HTMLElement): Unsubscribe {
    if (this.#disposed) {
      return () => undefined;
    }
    if (this.#host.state === "unavailable") {
      this.#recordOutcome({ status: "suppressed", refusal: this.#host.refusal });
      return () => undefined;
    }
    this.#hostElement = hostElement;
    this.#armResizeObserver(hostElement);
    this.#armPositionObserver(hostElement);
    this.#armViewportListeners();
    this.#armThemeObserver();
    this.#detachers.push(
      this.#occlusion.subscribeToChanges(() => {
        this.invalidate("overlay-change");
      }),
    );
    this.invalidate("attach");
    return () => {
      this.dispose();
    };
  }

  /**
   * Take a reading now and queue the write. The read is synchronous because that is
   * where it is correct — inside observer delivery, before anything else has moved —
   * and the write waits for the next frame because mutating layout from inside
   * resize-observer delivery drops the remaining notifications on at least one shipped
   * engine and strands the view. Re-entry before the frame runs replaces the pending
   * sample rather than queueing a second frame, which is what makes over-firing free.
   */
  public invalidate(reason: GeometryInvalidationReason): void {
    const element = this.#hostElement;
    if (this.#disposed || element === undefined || this.#host.state === "unavailable") {
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
   * Fires whenever a new outcome is recorded, so a surface can RENDER one.
   *
   * Without it `lastOutcome()` is only readable by whoever happens to ask, and the
   * pane asks exactly once — at attach, before the first frame has run, when the
   * answer is still `undefined`. Everything after that, the `pane-gone` rejection
   * most of all, would land in this private field and be seen by nobody, leaving the
   * pane rendering "no page yet" over a host that has said the pane is destroyed.
   *
   * A `void` event and a re-read rather than the outcome as a payload, which is the
   * shape `subscribeToChanges` next door already uses and what `useSyncExternalStore`
   * takes: one snapshot accessor, one notification, and no second copy of the value
   * to fall out of step with the first.
   */
  public subscribeToOutcomes(sink: () => void): Unsubscribe {
    return this.#outcomeEmitter.subscribe(sink);
  }

  /** How many samples reached the host. Deduped samples do not count. */
  public get publishCount(): number {
    return this.#publishCount;
  }

  /** Whether anything is still armed. Zero after `dispose`, and it stays zero. */
  public get armedSourceCount(): number {
    return this.#detachers.length;
  }

  /**
   * Whether this publisher is spent. Read by the owner that has to decide whether to
   * mint a fresh one — a disposal is terminal, and the two ways one happens are an
   * unmount and the host rejecting a rectangle for a pane that is gone.
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
    if (this.#disposed || sample === undefined || this.#host.state === "unavailable") {
      return;
    }
    if (sample.key === this.#lastPublishedKey) {
      this.#recordOutcome({ status: "deduped", sample });
      return;
    }
    const outcome = this.#host.setRect(sample);
    if (outcome.status === "rejected") {
      // 12.3's degraded arm. Retrying would publish a rectangle for a pane that no
      // longer exists, once per frame, forever. The outcome is recorded BEFORE the
      // disposal, so the surface that has to render this sentence is told about it
      // while it is still subscribed.
      this.#recordOutcome({ status: "suppressed", refusal: outcome.refusal });
      this.dispose();
      return;
    }
    this.#lastPublishedKey = sample.key;
    this.#publishCount += 1;
    this.#recordOutcome({ status: "published", sample });
  }

  /**
   * The one writer of the outcome field, so no arm can record a result without
   * announcing it. `dispose` deliberately does NOT clear the sinks: the subscription
   * belongs to whoever opened it, and severing it here would silently drop the
   * notification carrying the very refusal that caused the disposal.
   */
  #recordOutcome(outcome: PaneGeometryOutcome): void {
    this.#lastOutcome = outcome;
    this.#outcomeEmitter.emit();
  }

  /**
   * The size source, through the console's one resize seam.
   *
   * `primitives/element-resize.ts` owns the observer construction, its feature
   * detection, and its disconnect; a second construction here would be the same four
   * lines free to drift from those. A platform with no `ResizeObserver` degrades
   * inside the helper and hands back a disposer that does nothing, so this arm never
   * branches on it.
   */
  #armResizeObserver(hostElement: HTMLElement): void {
    this.#detachers.push(
      observeElementResize(hostElement, () => {
        this.invalidate("resize-observer");
      }),
    );
  }

  /**
   * The move source — `layout-mover`'s producer, and the reason that reason exists.
   *
   * Until this arm the enumeration named a mover no production path ever raised: a
   * deck reorder, a sibling pane shrinking, and a rail sliding in all move the pane
   * without changing its own box, and none of them reaches a size observer, a window
   * resize, a scroll, a theme attribute, or an overlay registration. The native view
   * therefore stayed at its old coordinates — painted over whatever chrome the pane
   * had just moved away from — until something unrelated happened to invalidate.
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
    if (typeof window === "undefined") {
      return;
    }
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
    if (typeof MutationObserver === "undefined" || typeof document === "undefined") {
      return;
    }
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
 * Which computed `overflow` values actually clip.
 *
 * Named as a closed positive set rather than tested as `!== "visible"`, because the
 * negative form calls an ancestor a clipper on any value it does not recognise — and
 * a stylesheet-free document reports the empty string for every box. Under that
 * reading every pane is clipped by an unlaid-out ancestor to a zero rectangle and
 * hides itself, which looks exactly like a pane that never attached.
 */
const CLIPPING_OVERFLOW_VALUES: ReadonlySet<string> = new Set([
  "hidden",
  "clip",
  "scroll",
  "auto",
  "overlay",
]);

/** Every ancestor that clips, outermost first. Both axes are read, because
 *  `overflow-x: hidden` alone clips and a shorthand check would miss it. */
function readClippingAncestorRects(element: HTMLElement): readonly PaneRect[] {
  if (typeof window === "undefined") {
    return [];
  }
  const rects: PaneRect[] = [];
  let ancestor: HTMLElement | null = element.parentElement;
  while (ancestor !== null) {
    const style = window.getComputedStyle(ancestor);
    if (
      CLIPPING_OVERFLOW_VALUES.has(style.overflowX) ||
      CLIPPING_OVERFLOW_VALUES.has(style.overflowY)
    ) {
      rects.push(readElementRect(ancestor));
    }
    ancestor = ancestor.parentElement;
  }
  return rects.reverse();
}
