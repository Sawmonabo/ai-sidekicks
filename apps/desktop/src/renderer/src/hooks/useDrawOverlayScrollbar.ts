// Draws an element's scrollbar over its content: it takes no layout width in any state, so nothing
// reflows when it shows, it fades once the pointer has rested, it returns on a pointer move or a
// scroll, its thumb drags and its track pages. Every scroller but the conversation draws its bar
// through here.
//
// The element stays its own scroller: the library is handed it as both target and viewport, so a
// virtualizer, a scroll handler and the scroll chokepoint keep the element they already hold. The
// library appends its bars inside the element, so the element's React children must be elements:
// React writes a lone text child through `textContent`, which would delete the bars. Inside the
// element a bar scrolls with the content, and the library moves it back from each scroll event on
// the main thread, a frame after the compositor has moved the content; an animation on the
// element's own scroll timeline moves it back on the compositor instead, in the same frame. The
// library used is the element's own window's copy.
//
// A started bar keeps its own observers and two bar elements, so a scroller that is not reached for
// can wait to start until the first pointer move, wheel, scroll or focus inside it, and bars do not
// grow with the rows and panes a window holds. A bar is built inside the event that starts it, so a
// scroller every session screen shows starts once its window is idle rather than inside a person's
// first wheel. The bar is hidden until a pointer move or a scroll either way, so the wait does not
// show.

import { useCallback } from "react";
import type { OverlayScrollbars, PartialOptions, State } from "overlayscrollbars";

import {
  waitForOverlayScrollbarLibrary,
  type OverlayScrollbarLibrary,
} from "#renderer/lib/overlay-scrollbar-library.js";
import { OVERLAY_SCROLLBAR_REST_MS } from "#renderer/styles/motion.js";

/**
 * When a scroller's bar starts: once its window is idle, or on the first pointer move, wheel,
 * scroll or focus inside it.
 */
export type OverlayScrollbarStart = "when-idle" | "on-first-interaction";

/** How a scroller's overlay bar is attached. */
export interface OverlayScrollbarSettings {
  /** Defaults to `when-idle`. */
  readonly start?: OverlayScrollbarStart;
  /**
   * `false` attaches nothing and leaves the platform's bar, for a scroller that only scrolls
   * past a size or a box whose content scrolls inside it; flipping it attaches or detaches the
   * bar. Defaults to `true`.
   */
  readonly isEnabled?: boolean;
}

/**
 * The ref a scroller attaches to draw its bar over its content; it also writes the element to
 * `elementRef` when the caller needs the scroller itself, such as a virtualizer's scroll element.
 * A window whose library copy failed to load keeps the platform's bar.
 */
export function useDrawOverlayScrollbar<TElement extends HTMLElement>(
  elementRef?: React.RefObject<TElement | null>,
  settings?: OverlayScrollbarSettings,
): React.RefCallback<TElement> {
  // Read apart so a settings object made in render does not reattach the bar every render.
  const start = settings?.start ?? "when-idle";
  const isEnabled = settings?.isEnabled ?? true;
  return useCallback(
    (element: TElement | null) => {
      if (element === null) {
        // A ref callback that returned a cleanup is never called with null.
        return undefined;
      }
      if (elementRef !== undefined) {
        elementRef.current = element;
      }
      const attachment = isEnabled ? new OverlayScrollbarAttachment(element, start) : undefined;
      return () => {
        attachment?.detach();
        if (elementRef !== undefined) {
          elementRef.current = null;
        }
      };
    },
    [elementRef, start, isEnabled],
  );
}

/**
 * Drawn in the console's tokens, faded once the pointer rests and back on a pointer move or a
 * scroll, its thumb dragged and its track paging. The library takes the theme as a string, so
 * `styles/overlay-scrollbar.css` repeats it.
 */
const OVERLAY_SCROLLBAR_OPTIONS: PartialOptions = {
  scrollbars: {
    theme: "os-theme-meridian",
    autoHide: "move",
    autoHideDelay: OVERLAY_SCROLLBAR_REST_MS,
    dragScroll: true,
    clickScroll: true,
  },
};

/**
 * The latest a `when-idle` bar starts after its scroller attaches, in milliseconds, in a window
 * that never idles: a streaming window still gets its bars before a person reaches for one.
 */
const OVERLAY_SCROLLBAR_START_DEADLINE_MS = 500;

/**
 * The events that start an `on-first-interaction` bar. `pointermove` rather than `pointerenter`,
 * so a pointer already inside when the library loads starts it on its next move.
 */
const FIRST_INTERACTION_EVENTS = ["pointermove", "wheel", "scroll", "focusin"] as const;

/**
 * The library's marker for an element it is about to start on: its sheet hides the platform's bar
 * there, so the scroller takes no width for a bar before its overlay starts either.
 */
const AWAITING_OVERLAY_ATTRIBUTE = "data-overlayscrollbars-initialize";

/** A scroll axis, as the library and a scroll timeline both name it. */
type ScrollAxis = "x" | "y";

/** How far a scroller scrolls on each axis, in pixels, as the library measures it. */
type ScrollRange = State["overflowAmount"];

/** One way a bar is moved back along a scroll axis, and when the scroller's overflow needs it. */
interface BarPlacement {
  readonly axis: ScrollAxis;
  /**
   * The property animated. A `transform` animation outranks the library's inline `transform`
   * whole, both axes of it, so a scroller that scrolls both ways takes its sideways move on
   * `translate`: two animations of one property would leave only the later one.
   */
  readonly property: "transform" | "translate";
  readonly isNeeded: (overflow: ScrollRange) => boolean;
}

const BAR_PLACEMENTS: readonly BarPlacement[] = [
  { axis: "y", property: "transform", isNeeded: (overflow) => overflow.y > 0 },
  {
    axis: "x",
    property: "transform",
    isNeeded: (overflow) => overflow.x > 0 && overflow.y === 0,
  },
  {
    axis: "x",
    property: "translate",
    isNeeded: (overflow) => overflow.x > 0 && overflow.y > 0,
  },
];

/** One element's overlay scrollbar, from attach until detach. */
class OverlayScrollbarAttachment {
  readonly #element: HTMLElement;
  readonly #view: Window & typeof globalThis;
  readonly #start: OverlayScrollbarStart;
  readonly #interactionListeners = new AbortController();
  #idleStart: number | undefined;
  #instance: OverlayScrollbars | undefined;
  #heldBars: HeldBars | undefined;
  #isDetached = false;

  public constructor(element: HTMLElement, start: OverlayScrollbarStart) {
    const view = element.ownerDocument.defaultView;
    if (view === null) {
      throw new Error("A scroller was attached in a document with no window.");
    }
    this.#element = element;
    this.#view = view;
    this.#start = start;
    const library = waitForOverlayScrollbarLibrary(element.ownerDocument);
    if (library !== undefined) {
      element.setAttribute(AWAITING_OVERLAY_ATTRIBUTE, "");
      void library.then((loaded) => {
        this.#scheduleStart(loaded);
      });
    }
  }

  /** Remove the bar, or stop it from starting. */
  public detach(): void {
    this.#isDetached = true;
    if (this.#idleStart !== undefined) {
      this.#view.cancelIdleCallback(this.#idleStart);
    }
    this.#interactionListeners.abort();
    this.#heldBars?.release();
    this.#instance?.destroy();
    this.#element.removeAttribute(AWAITING_OVERLAY_ATTRIBUTE);
  }

  #scheduleStart(library: OverlayScrollbarLibrary | undefined): void {
    if (this.#isDetached) {
      return;
    }
    if (library === undefined) {
      // The platform's bar comes back; the installer has recorded the failure.
      this.#element.removeAttribute(AWAITING_OVERLAY_ATTRIBUTE);
      return;
    }
    if (this.#start === "on-first-interaction") {
      // Started inside the first event, so the next move or scroll already shows the bar.
      const startOnInteraction = (): void => {
        this.#interactionListeners.abort();
        this.#startOn(library);
      };
      for (const eventName of FIRST_INTERACTION_EVENTS) {
        this.#element.addEventListener(eventName, startOnInteraction, {
          passive: true,
          signal: this.#interactionListeners.signal,
        });
      }
      return;
    }
    // The element's own window's idle time: the console document's never comes.
    this.#idleStart = this.#view.requestIdleCallback(
      () => {
        this.#idleStart = undefined;
        this.#startOn(library);
      },
      { timeout: OVERLAY_SCROLLBAR_START_DEADLINE_MS },
    );
  }

  #startOn(library: OverlayScrollbarLibrary): void {
    // The library merges only objects made by its own window's `Object`, and replaces any other
    // whole, dropping the defaults beside it; a bar left without its visibility default is never
    // drawn. The options are made here, in the console's realm, so they are copied into the
    // element's.
    this.#instance = library.OverlayScrollbars(
      { target: this.#element, elements: { viewport: this.#element } },
      this.#view.structuredClone(OVERLAY_SCROLLBAR_OPTIONS),
    );
    this.#heldBars = new HeldBars(this.#view, this.#element, this.#instance);
  }
}

/**
 * An instance's two bars, held still in their scroller's box while the content scrolls under them:
 * each bar is moved back by the scroll offset on the scroller's own scroll timelines, which the
 * compositor runs in the frame it scrolls in. A scroll timeline runs from the start of the scroll
 * range to its end, so each animation ends at the range, kept current from every library update.
 */
class HeldBars {
  readonly #animations: readonly {
    readonly placement: BarPlacement;
    readonly animation: Animation;
  }[];
  readonly #stopFollowing: () => void;

  public constructor(
    view: Window & typeof globalThis,
    element: HTMLElement,
    instance: OverlayScrollbars,
  ) {
    const timelines = {
      x: new view.ScrollTimeline({ source: element, axis: "x" }),
      y: new view.ScrollTimeline({ source: element, axis: "y" }),
    };
    const { scrollbarHorizontal, scrollbarVertical } = instance.elements();
    this.#animations = [scrollbarHorizontal.scrollbar, scrollbarVertical.scrollbar].flatMap((bar) =>
      BAR_PLACEMENTS.map((placement) => ({
        placement,
        // Filled at both ends, so the bar stays held at the very end of the range too.
        animation: bar.animate(null, { timeline: timelines[placement.axis], fill: "both" }),
      })),
    );
    this.#follow(instance);
    // Set again only when the range moved, so a change that leaves it alone costs nothing here.
    this.#stopFollowing = instance.on("updated", (updated, { updateHints }) => {
      if (updateHints.overflowAmountChanged) {
        this.#follow(updated);
      }
    });
  }

  /** Stop holding the bars. */
  public release(): void {
    this.#stopFollowing();
    for (const { animation } of this.#animations) {
      animation.cancel();
    }
  }

  #follow(instance: OverlayScrollbars): void {
    const { overflowAmount } = instance.state();
    for (const { placement, animation } of this.#animations) {
      const effect = animation.effect as KeyframeEffect;
      effect.setKeyframes(
        placement.isNeeded(overflowAmount) ? barKeyframes(placement, overflowAmount) : [],
      );
    }
  }
}

/** A bar's move back along one axis, from the start of the scroll range to its end. */
function barKeyframes(placement: BarPlacement, overflow: ScrollRange): PropertyIndexedKeyframes {
  const range = `${String(overflow[placement.axis])}px`;
  if (placement.property === "translate") {
    return { translate: ["0 0", `${range} 0`] };
  }
  const translateFunction = placement.axis === "x" ? "translateX" : "translateY";
  return { transform: [`${translateFunction}(0)`, `${translateFunction}(${range})`] };
}
