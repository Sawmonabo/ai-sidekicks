import { useLayoutEffect } from "react";

/**
 * Have the strings past the list's end read once its last drawn row is in the window, before the
 * frame that drew it paints, so the list grows ahead of the reader.
 */
export function useLastRowReadAhead(isLastRow: boolean, readAhead: () => void): void {
  useLayoutEffect(() => {
    if (isLastRow) {
      readAhead();
    }
  }, [isLastRow, readAhead]);
}
