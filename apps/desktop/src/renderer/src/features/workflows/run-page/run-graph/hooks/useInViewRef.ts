import { useEffect, useRef } from "react";

/**
 * Whether an element is on screen, held in a ref so a change re-renders nothing: it is read only
 * at the moment a motion would start. True until the first reading arrives, so a canvas mounted
 * in view never waits on it. Each reading is also written to the element as `data-in-view`, so
 * the sheet holds the element's own animations still while it is scrolled out of view.
 */
export function useInViewRef(
  elementRef: React.RefObject<HTMLElement | null>,
): React.RefObject<boolean> {
  const isInViewRef = useRef(true);

  useEffect(() => {
    const element = elementRef.current;
    if (element === null) {
      return undefined;
    }
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        isInViewRef.current = entry.isIntersecting;
        element.dataset["inView"] = String(entry.isIntersecting);
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [elementRef]);

  return isInViewRef;
}
