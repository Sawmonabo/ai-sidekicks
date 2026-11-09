// Where the focus goes after a tab strip closes a tab: to the tab left shown.

import { useLayoutEffect, useRef } from "react";

/** What a strip calls as it sends a close, so the next tab to leave the list moves the focus. */
export interface FocusAfterClose {
  readonly expect: () => void;
}

/**
 * Hands focus to the shown tab's face once a tab a close from the strip expected leaves the list,
 * since the focus went with the closed tab's controls; focus that already landed elsewhere stays.
 */
export function useFocusAfterClose<Key extends string>(
  keys: readonly Key[],
  activeKey: Key | undefined,
  faces: ReadonlyMap<Key, HTMLButtonElement>,
): FocusAfterClose {
  const isExpected = useRef(false);
  const shownKeys = useRef(keys);
  useLayoutEffect(() => {
    const hasLostTab = shownKeys.current.some((key) => !keys.includes(key));
    shownKeys.current = keys;
    if (!hasLostTab || !isExpected.current) {
      return;
    }
    isExpected.current = false;
    const face = activeKey === undefined ? undefined : faces.get(activeKey);
    const focused = face?.ownerDocument.activeElement;
    if (face !== undefined && (focused === null || focused === face.ownerDocument.body)) {
      face.focus();
    }
  }, [keys, activeKey, faces]);
  return {
    expect: () => {
      isExpected.current = true;
    },
  };
}
