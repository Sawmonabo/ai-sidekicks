// What a windowed row marks itself with, and how the marks are read back. `WindowedListRow` writes
// these attributes and the roving keyboard (`hooks/useWindowedRovingIndex.ts`) reads them, so the
// names, the selector and the lookups live together: a rename reaching only one side would leave
// the keyboard silently unable to find its rows.

/**
 * The attribute a windowed row carries its absolute index on. `data-index` is the attribute the
 * virtualizer's own rows carry, so measuring and locating rows name the same thing.
 */
export const WINDOWED_ROW_INDEX_ATTRIBUTE = "data-index";

/**
 * The attribute the element holding a row's tab stop carries. A marker names the element the row
 * declared, where an interactive-element selector would match whichever came first (the wrapper,
 * once it has a `tabindex`). A list of controls marks the control; a list of options marks the row.
 */
export const WINDOWED_ROW_TARGET_ATTRIBUTE = "data-row-target";

/** How the marked element is found, inside a row or as the row. */
const WINDOWED_ROW_TARGET_SELECTOR = `[${WINDOWED_ROW_TARGET_ATTRIBUTE}]`;

/** The mounted element for one absolute row index, or `undefined`. */
export function rowElementAt(
  container: HTMLElement | null,
  rowIndex: number,
): HTMLElement | undefined {
  return (
    container?.querySelector<HTMLElement>(
      `[${WINDOWED_ROW_INDEX_ATTRIBUTE}="${String(rowIndex)}"]`,
    ) ?? undefined
  );
}

/**
 * The mounted row index closest to `targetIndex`, or `undefined` when none is mounted. Closest by
 * absolute distance because the window may sit on either side of the target; ties go to the lower
 * index.
 */
export function nearestMountedRowIndex(
  container: HTMLElement | null,
  targetIndex: number,
): number | undefined {
  const mountedRows = container?.querySelectorAll<HTMLElement>(`[${WINDOWED_ROW_INDEX_ATTRIBUTE}]`);
  let nearestIndex: number | undefined;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const row of mountedRows ?? []) {
    const mountedIndex = Number(row.getAttribute(WINDOWED_ROW_INDEX_ATTRIBUTE));
    if (!Number.isInteger(mountedIndex)) {
      continue;
    }
    const distance = Math.abs(mountedIndex - targetIndex);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestIndex = mountedIndex;
    }
  }
  return nearestIndex;
}

/**
 * The element a row declared as its focus target: the row itself where it holds the stop, else the
 * one control it marked. A row that marked none answers `undefined`; the keyboard skips it.
 */
export function focusTargetWithin(row: HTMLElement): HTMLElement | undefined {
  if (row.matches(WINDOWED_ROW_TARGET_SELECTOR)) {
    return row;
  }
  return row.querySelector<HTMLElement>(WINDOWED_ROW_TARGET_SELECTOR) ?? undefined;
}
