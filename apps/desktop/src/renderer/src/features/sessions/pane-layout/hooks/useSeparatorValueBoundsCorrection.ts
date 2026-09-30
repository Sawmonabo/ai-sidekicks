import { useLayoutEffect } from "react";

import { correctSeparatorValueBounds } from "../separator-value-bounds.js";

/**
 * Corrects separator value bounds after every commit that could have re-rendered a separator.
 *
 * Keyed on `layoutRevision` because the library recomputes the range, and reintroduces the
 * swap, whenever the panel set or widths change. A `MutationObserver` would also fire on
 * this correction's own writes.
 */
export function useSeparatorValueBoundsCorrection(
  container: React.RefObject<HTMLElement | null>,
  layoutRevision: number,
): void {
  useLayoutEffect(() => {
    const element = container.current;
    if (element !== null) {
      correctSeparatorValueBounds(element);
    }
  }, [container, layoutRevision]);
}
