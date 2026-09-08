// What a windowed row marks itself with, and how those marks are read back.
//
// TWO SIDES OF ONE SEAM SHARE A MODULE. `WindowedListRow` WRITES these attributes and
// the roving keyboard READS them, and neither can be right about a name the other
// spells differently — so the names, the selector composed from them, and the three
// lookups that consume it are declared together here. A rename that reached only one
// side would leave the lookup querying an attribute nothing writes, which is a list
// whose keyboard silently stops finding its rows.
//
// It is a module of its own rather than a section of the hook because it is a
// different job: the hook decides WHERE the keyboard is, and this decides what a row
// is called and which element in it holds the stop. The hook's own header is the
// argument for the first; this file is the whole of the second.

/**
 * The attribute a windowed row carries its absolute index on.
 *
 * `data-index` and not a custom name: it is the attribute a virtualized row already
 * carries in every example the adopted virtualizer publishes, so a caller measuring
 * rows and a reader locating them name the same thing.
 */
export const WINDOWED_ROW_INDEX_ATTRIBUTE = "data-index";

/**
 * The attribute the element holding a row's tab stop carries.
 *
 * It replaced an interactive-element selector, and the replacement is the fix rather
 * than a tidier spelling of it. A selector asks which element in the row COULD take
 * focus and answers with whichever matched first — the wrapper, once the wrapper
 * carried a `tabindex` — while a marker asks which element the row SAID holds its
 * stop. A list whose rows are controls (a file list of buttons) keeps activation on
 * the control and marks it; a list whose rows are options marks the row.
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
 * The mounted row closest to `targetIndex`, or `undefined` when none is mounted.
 *
 * Closest by absolute distance rather than "the first" or "the last", because the
 * window may sit on either side of the target: an anchor below the viewport wants the
 * bottom of the window and one above it wants the top, and both are the same rule.
 * Ties go to the lower index, which is the one a reader reaches first.
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
 * The element a row DECLARED as its focus target, never one a selector happened to
 * match.
 *
 * The row marks its own wrapper where it holds the stop and marks the one control it
 * delegates to where it does not, so this reads a statement rather than a guess. A
 * row that marked none answers `undefined`, and a row the keyboard cannot land on is
 * the honest reading of that.
 */
export function focusTargetWithin(row: HTMLElement): HTMLElement | undefined {
  if (row.matches(WINDOWED_ROW_TARGET_SELECTOR)) {
    return row;
  }
  return row.querySelector<HTMLElement>(WINDOWED_ROW_TARGET_SELECTOR) ?? undefined;
}
