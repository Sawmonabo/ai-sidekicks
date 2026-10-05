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

/** One intersection observer for many elements, made on the first element and closed with it. */
class InViewMarks {
  #observer: IntersectionObserver | undefined;

  /** Observe `element` until React detaches it. */
  public readonly mark = (element: HTMLElement | null): (() => void) | undefined => {
    if (element === null) {
      return undefined;
    }
    this.#observer ??= new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.target instanceof HTMLElement) {
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
