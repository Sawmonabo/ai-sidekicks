import { useEffect, useRef, type RefObject } from "react";

/**
 * Take the caret every time the field is asked for, and select what is in it.
 *
 * Selecting rather than only focusing because the second press is the case that
 * needs it: somebody re-running the chord over a field holding an old query is
 * about to replace it, and a caret parked at one end makes them clear it by hand.
 */
export function useCaretOnOpen(openRequestCount: number): RefObject<HTMLInputElement | null> {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const input = inputRef.current;
    if (input === null) {
      return;
    }
    input.focus();
    input.select();
  }, [openRequestCount]);
  return inputRef;
}
