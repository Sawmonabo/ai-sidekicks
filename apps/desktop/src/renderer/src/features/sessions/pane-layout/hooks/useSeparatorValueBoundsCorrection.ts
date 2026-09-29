import { useLayoutEffect } from "react";

import { correctSeparatorValueBounds } from "../separator-value-bounds.js";

/**
 * Run the correction after every commit that could have re-rendered a separator.
 *
 * `layoutRevision` is the dependency rather than an empty list: the library
 * recomputes the range whenever the panel set or the widths change, and each
 * recompute reintroduces the swap. A `MutationObserver` would catch the same
 * changes and would also fire on its own writes, which is a loop this does not have.
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
