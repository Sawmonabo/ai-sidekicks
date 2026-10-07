// Draws an element's scrollbar over its content: it takes no layout width in any state, so nothing
// reflows when it shows, it fades once the pointer has rested, it returns on a pointer move or a
// scroll, its thumb drags and its track pages. Every scroller but the conversation draws its bar
// through here.
//
// The element stays its own scroller: the library is handed it as both target and viewport, so a
// virtualizer, a scroll handler and the scroll chokepoint keep the element they already hold. The
// library appends its bars inside the element, so the element's React children must be elements:
// React writes a lone text child through `textContent`, which would delete the bars. The library
// used is the element's own window's copy, started when that window is idle.

import { useCallback } from "react";
import type { OverlayScrollbars, PartialOptions } from "overlayscrollbars";

import {
  loadOverlayScrollbarLibrary,
  type OverlayScrollbarLibrary,
} from "#renderer/lib/overlay-scrollbar-library.js";
import { OVERLAY_SCROLLBAR_REST_MS } from "#renderer/styles/motion.js";

/**
 * The ref a scroller attaches to draw its bar over its content; it also writes the element to
 * `elementRef` when the caller needs the scroller itself, such as a virtualizer's scroll element.
 * A load failure of the window's library copy is raised as an unhandled rejection.
 */
export function useOverlayScrollbar<TElement extends HTMLElement>(
  elementRef?: React.RefObject<TElement | null>,
): React.RefCallback<TElement> {
  return useCallback(
    (element: TElement | null) => {
      if (element === null) {
        // A ref callback that returned a cleanup is never called with null.
        return undefined;
      }
      if (elementRef !== undefined) {
        elementRef.current = element;
      }
      const attachment = new OverlayScrollbarAttachment(element);
      return () => {
        attachment.detach();
        if (elementRef !== undefined) {
          elementRef.current = null;
        }
      };
    },
    [elementRef],
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
 * The latest a bar starts after its scroller attaches, in milliseconds, in a window that never
 * idles: a streaming window still gets its bars before a person reaches for one.
 */
const OVERLAY_SCROLLBAR_START_DEADLINE_MS = 500;

/**
 * The library's marker for an element it is about to start on: its sheet hides the platform's bar
 * there, so the scroller takes no width for a bar before its overlay starts either.
 */
const AWAITING_OVERLAY_ATTRIBUTE = "data-overlayscrollbars-initialize";

/** One element's overlay scrollbar, from attach until detach. */
class OverlayScrollbarAttachment {
  readonly #element: HTMLElement;
  readonly #view: Window;
  #idleStart: number | undefined;
  #instance: OverlayScrollbars | undefined;
  #isDetached = false;

  public constructor(element: HTMLElement) {
    const view = element.ownerDocument.defaultView;
    if (view === null) {
      throw new Error("A scroller was attached in a document with no window.");
    }
    this.#element = element;
    this.#view = view;
    const library = loadOverlayScrollbarLibrary(element.ownerDocument);
    if (library !== undefined) {
      element.setAttribute(AWAITING_OVERLAY_ATTRIBUTE, "");
      void library.then((loaded) => {
        this.#startWhenIdle(loaded);
      });
    }
  }

  /** Remove the bar, or stop it from starting. */
  public detach(): void {
    this.#isDetached = true;
    if (this.#idleStart !== undefined) {
      this.#view.cancelIdleCallback(this.#idleStart);
    }
    this.#instance?.destroy();
    this.#element.removeAttribute(AWAITING_OVERLAY_ATTRIBUTE);
  }

  #startWhenIdle(library: OverlayScrollbarLibrary): void {
    if (this.#isDetached) {
      return;
    }
    // The element's own window's idle time: the console document's never comes.
    this.#idleStart = this.#view.requestIdleCallback(
      () => {
        this.#idleStart = undefined;
        this.#instance = library.OverlayScrollbars(
          { target: this.#element, elements: { viewport: this.#element } },
          OVERLAY_SCROLLBAR_OPTIONS,
        );
      },
      { timeout: OVERLAY_SCROLLBAR_START_DEADLINE_MS },
    );
  }
}
