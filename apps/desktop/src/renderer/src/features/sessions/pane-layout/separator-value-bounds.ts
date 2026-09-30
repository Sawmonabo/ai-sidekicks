// Works around an upstream defect in `react-resizable-panels` 4.12.3: on groups of three or more
// panes, every separator after the first reports `aria-valuemin` and `aria-valuemax` the wrong
// way round (upstream issue #740).
//
// The correction runs over the DOM after each commit, not over props: the library spreads the
// caller's props first and writes its own computed `aria-value*` over them. It swaps the two
// values rather than recomputing them, because only their assignment is crossed and a
// recompute would duplicate the library's constraint solver.
//
// Delete this module when the fix lands upstream; a no-op correction would still run on every
// commit.

/** The selector the panels library marks each of its separators with. */
export const PANEL_SEPARATOR_SELECTOR = "[data-separator]";

/** One separator's announced range, as the DOM currently carries it. */
export interface SeparatorValueBounds {
  readonly valueMin: number;
  readonly valueMax: number;
}

/**
 * Reads a separator's announced range, or `undefined` where it announces none. A separator whose
 * panels are not yet measured carries no range; reading that as `0` would pass the ordering check.
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
 * Whether every separator in `root` announces a range a screen reader can read. The tests and
 * the correction share this predicate, so a test cannot pass against a rule the correction
 * does not enforce.
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
 * Puts every crossed range back the right way round and returns how many it corrected, so a
 * test can tell a patch that stopped matching from a library that was fixed.
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
