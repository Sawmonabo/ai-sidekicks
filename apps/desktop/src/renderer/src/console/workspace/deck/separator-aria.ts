// The one defect the deck's panel library is admitted with, and the wrap over it.
//
// `Spec-023 §Console Libraries`, row "Layout, panes, drag", adopts
// `react-resizable-panels` 4.12.3 under the constraint "pin or patch the open ARIA
// min/max swap on three-plus pane groups", and its §References entry names the
// defect: upstream issue #740 — at 4.12.3 every separator after the first reports
// `aria-valuemin` and `aria-valuemax` the wrong way round, open since 2026-08-28
// with a pending fix. There is no later release to pin to, so the swap is corrected
// here.
//
// WHY THE CORRECTION IS OVER THE DOM AND NOT OVER A PROP. The library's separator
// spreads the caller's props FIRST and then writes its own computed
// `aria-valuemin` / `aria-valuemax` / `aria-valuenow` over them, so a value passed
// as a prop is discarded before it reaches the element. Measured against the
// pinned dist, not assumed. What is left is the rendered element, corrected after
// each commit — which is also the narrowest possible patch: it touches two
// attributes on elements the library owns and nothing else about how it behaves.
//
// WHY IT IS A SWAP AND NOT A RECOMPUTE. The two numbers the library produces are
// correct; only their assignment is crossed. Recomputing them here would put a
// second implementation of the library's constraint solver in this tree — and one
// that would go silently wrong the moment the library's own changed. Swapping is
// the whole of the defect, so swapping is the whole of the fix.
//
// WHEN THE FIX LANDS UPSTREAM, THIS MODULE IS DELETED, not left in place as a
// belt-and-braces guard: a correction that has become a no-op still runs on every
// commit, and the assertion below would then be passing for the wrong reason.

import { useLayoutEffect } from "react";

/** The attribute the panels library marks each of its separators with. */
export const PANEL_SEPARATOR_SELECTOR = "[data-separator]";

/** One separator's announced range, as the DOM currently carries it. */
export interface SeparatorValueBounds {
  readonly valueMin: number;
  readonly valueMax: number;
}

/**
 * Read a separator's announced range, or `undefined` where it announces none.
 *
 * Absent rather than zero for a missing attribute: a separator whose panels have
 * not been measured yet legitimately carries no range, and reading that as `0` would
 * make the ordering assertion below pass on a separator that announces nothing.
 */
export function readSeparatorValueBounds(separator: Element): SeparatorValueBounds | undefined {
  const minimumAttribute = separator.getAttribute("aria-valuemin");
  const maximumAttribute = separator.getAttribute("aria-valuemax");
  if (minimumAttribute === null || maximumAttribute === null) {
    return undefined;
  }
  const valueMin = Number(minimumAttribute);
  const valueMax = Number(maximumAttribute);
  if (!Number.isFinite(valueMin) || !Number.isFinite(valueMax)) {
    return undefined;
  }
  return { valueMin, valueMax };
}

/**
 * Whether every separator in `root` announces a range a screen reader can read.
 *
 * The predicate the deck's test asserts and the predicate the correction restores,
 * in one function — so the test cannot pass against a rule the correction does not
 * enforce, and a negative control that swaps the attributes by hand fails it.
 */
export function separatorValueBoundsAreOrdered(root: ParentNode): boolean {
  for (const separator of root.querySelectorAll(PANEL_SEPARATOR_SELECTOR)) {
    const bounds = readSeparatorValueBounds(separator);
    if (bounds !== undefined && bounds.valueMin > bounds.valueMax) {
      return false;
    }
  }
  return true;
}

/**
 * Put every crossed range back the right way round. Returns how many it corrected.
 *
 * Counted rather than silent, so the deck's test can assert the correction fired at
 * least once on a three-pane group — a patch that quietly stopped matching would
 * otherwise look identical to a library that had been fixed.
 */
export function correctSeparatorValueBounds(root: ParentNode): number {
  let corrected = 0;
  for (const separator of root.querySelectorAll(PANEL_SEPARATOR_SELECTOR)) {
    const bounds = readSeparatorValueBounds(separator);
    if (bounds === undefined || bounds.valueMin <= bounds.valueMax) {
      continue;
    }
    separator.setAttribute("aria-valuemin", String(bounds.valueMax));
    separator.setAttribute("aria-valuemax", String(bounds.valueMin));
    corrected += 1;
  }
  return corrected;
}

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
