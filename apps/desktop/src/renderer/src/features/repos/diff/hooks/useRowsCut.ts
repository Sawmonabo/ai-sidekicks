import { useLayoutEffect, useState } from "react";

import { observeElementResize } from "#renderer/lib/element-resize.js";

/** Where a box of diff rows is cut, read off its drawn rows. */
export interface RowsCut {
  /** True while the rows run past the cut height and are clipped there. */
  readonly isCut: boolean;
  /** The line rows that start above the cut: the lines a person sees, some under the fade. */
  readonly drawnLineCount: number;
}

/**
 * Where a box of rows is cut at `cutHeightPx`, or that it is not cut where `cutHeightPx` is
 * `undefined`: cut when rows were left undrawn or the drawn ones run past the height. Read after
 * layout, and again whenever the box is resized, since a narrower box wraps more lines and holds
 * fewer of them.
 */
export function useRowsCut(
  rowsElement: HTMLElement | null,
  cutHeightPx: number | undefined,
  lineCount: number,
  hasUndrawnRows: boolean,
): RowsCut {
  const [cut, setCut] = useState<RowsCut>({ isCut: false, drawnLineCount: lineCount });

  useLayoutEffect(() => {
    if (rowsElement === null) {
      return undefined;
    }
    const readCut = (): void => {
      setCut(cutOf(rowsElement, cutHeightPx, lineCount, hasUndrawnRows));
    };
    readCut();
    return observeElementResize(rowsElement, readCut);
  }, [rowsElement, cutHeightPx, lineCount, hasUndrawnRows]);

  return cut;
}

function cutOf(
  rowsElement: HTMLElement,
  cutHeightPx: number | undefined,
  lineCount: number,
  hasUndrawnRows: boolean,
): RowsCut {
  if (cutHeightPx === undefined || (!hasUndrawnRows && rowsElement.scrollHeight <= cutHeightPx)) {
    return { isCut: false, drawnLineCount: lineCount };
  }
  let drawnLineCount = 0;
  for (const row of rowsElement.querySelectorAll<HTMLElement>(".meridian-diff__row--line")) {
    if (row.offsetTop < cutHeightPx) {
      drawnLineCount += 1;
    }
  }
  return { isCut: true, drawnLineCount };
}
