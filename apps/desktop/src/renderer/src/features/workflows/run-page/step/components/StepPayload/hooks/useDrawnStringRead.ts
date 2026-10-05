import { useLayoutEffect } from "react";

/**
 * Have a drawn row's string read as markdown or text before the frame that drew it paints, so
 * the row is never seen unread.
 */
export function useDrawnStringRead(
  stringIndex: number,
  readString: (stringIndex: number) => void,
): void {
  useLayoutEffect(() => {
    readString(stringIndex);
  }, [stringIndex, readString]);
}
