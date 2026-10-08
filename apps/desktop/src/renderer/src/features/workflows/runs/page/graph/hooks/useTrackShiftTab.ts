import { useEffect, useRef, type RefObject } from "react";

import { useOwnerWindow } from "#renderer/hooks/useOwnerWindow.js";

/**
 * Tracks a Shift+Tab press in the owner window: the ref is true from the press until its key comes
 * up, while the browser moves focus by it.
 */
export function useTrackShiftTab(): RefObject<boolean> {
  const isShiftTabbingRef = useRef(false);
  const ownerWindow = useOwnerWindow();
  useEffect(() => {
    const { document: ownerDocument } = ownerWindow;
    const onKeyDown = (event: KeyboardEvent): void => {
      isShiftTabbingRef.current = event.key === "Tab" && event.shiftKey;
    };
    const onKeyUp = (event: KeyboardEvent): void => {
      if (event.key === "Tab") {
        isShiftTabbingRef.current = false;
      }
    };
    // A window left mid-press never sees its key come up.
    const onBlur = (): void => {
      isShiftTabbingRef.current = false;
    };
    ownerDocument.addEventListener("keydown", onKeyDown, { capture: true });
    ownerDocument.addEventListener("keyup", onKeyUp, { capture: true });
    ownerWindow.addEventListener("blur", onBlur);
    return () => {
      ownerDocument.removeEventListener("keydown", onKeyDown, { capture: true });
      ownerDocument.removeEventListener("keyup", onKeyUp, { capture: true });
      ownerWindow.removeEventListener("blur", onBlur);
    };
  }, [ownerWindow]);
  return isShiftTabbingRef;
}
