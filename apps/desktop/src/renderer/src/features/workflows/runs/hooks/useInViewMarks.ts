import { getWindow, isHTMLElement } from "@floating-ui/utils/dom";
import { useEffect, useState } from "react";

/**
 * A ref callback that writes whether its element is on screen to the element as `data-in-view`,
 * so the sheet holds the element's own animation still while it is scrolled out of view. Every
 * element it is given shares the one observer this hook holds, however many rows draw one.
 */
export function useInViewMarks(): (element: HTMLElement | null) => (() => void) | undefined {
  const [marks] = useState(() => new InViewMarks());
  useEffect(
    () => () => {
      marks.dispose();
    },
    [marks],
  );
  return marks.mark;
}

/**
 * One intersection observer for many elements, made on the first element and closed with it. Made
 * in that element's own window, since an observer measures against the viewport of the window it
 * was made in.
 */
class InViewMarks {
  #observer: IntersectionObserver | undefined;

  /** Observe `element` until React detaches it. */
  public readonly mark = (element: HTMLElement | null): (() => void) | undefined => {
    if (element === null) {
      return undefined;
    }
    const ObserverConstructor = getWindow(element).IntersectionObserver;
    this.#observer ??= new ObserverConstructor((entries) => {
      for (const entry of entries) {
        if (isHTMLElement(entry.target)) {
          entry.target.dataset["inView"] = String(entry.isIntersecting);
        }
      }
    });
    const observer = this.#observer;
    observer.observe(element);
    return () => {
      observer.unobserve(element);
    };
  };

  public dispose(): void {
    this.#observer?.disconnect();
    this.#observer = undefined;
  }
}
