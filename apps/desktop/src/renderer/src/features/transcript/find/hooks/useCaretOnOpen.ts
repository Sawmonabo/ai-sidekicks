import { useEffect, useRef, type RefObject } from "react";

/**
 * Takes the caret and selects the field's text on every open request. Selecting matters on a
 * repeat press: re-running the chord over an old query is about to replace it.
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
