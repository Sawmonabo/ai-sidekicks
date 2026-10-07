// Draws an element's scrollbar over its content: it takes no layout width in any state, so nothing
// reflows when it shows, it fades once the pointer has rested, it returns on a pointer move or a
// scroll, its thumb drags and its track pages. Every scroller but the conversation draws its bar
// through here.
//
// The element stays its own scroller: the library is handed it as both target and viewport, so a
// virtualizer, a scroll handler and the scroll chokepoint keep the element they already hold. The
// library appends its bars inside the element, so the element's React children must be elements:
// React writes a lone text child through `textContent`, which would delete the bars. The library
// used is the element's own window's copy.
//
// A started bar makes every layout pass under its element dearer, even while it is hidden, so a
// scroller that is not reached for can wait to start until the first pointer move, wheel, scroll
// or focus inside it. The bar is hidden until a pointer move or a scroll either way, so the wait
// does not show.

import { useCallback } from "react";
import type { OverlayScrollbars, PartialOptions } from "overlayscrollbars";

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
   * past a size; flipping it attaches or detaches the bar. Defaults to `true`.
   */
  readonly isEnabled?: boolean;
}

/**
 * The ref a scroller attaches to draw its bar over its content; it also writes the element to
 * `elementRef` when the caller needs the scroller itself, such as a virtualizer's scroll element.
 * A window whose library copy failed to load keeps the platform's bar.
 */
export function useOverlayScrollbar<TElement extends HTMLElement>(
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

/** One element's overlay scrollbar, from attach until detach. */
class OverlayScrollbarAttachment {
  readonly #element: HTMLElement;
  readonly #view: Window;
  readonly #start: OverlayScrollbarStart;
  readonly #interactionListeners = new AbortController();
  #idleStart: number | undefined;
  #instance: OverlayScrollbars | undefined;
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
    this.#instance = library.OverlayScrollbars(
      { target: this.#element, elements: { viewport: this.#element } },
      OVERLAY_SCROLLBAR_OPTIONS,
    );
  }
}
