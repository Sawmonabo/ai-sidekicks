// Reports the window's floor as the frame lays it out. The floor is a box the stylesheet sizes from
// the width tokens, the macOS title-bar inset and the height floor, so the sum is the layout
// engine's and never a figure here. A text-size change or a new inset resizes the box, and the
// observer reports it again; it reports only on a change, so nothing is re-sent between them.

import { useCallback } from "react";

import { useLatestRef } from "#renderer/hooks/useLatestRef.js";
import { observeElementResize } from "#renderer/lib/element-resize.js";
import type { WindowSize } from "#shared/window/size.js";

/**
 * Hand `onWindowFloorChange` the attached box's size, in CSS px, when it is first laid out and
 * whenever it changes. The ref's identity is stable, so a re-render keeps one observer.
 */
export function useReportWindowFloor(
  onWindowFloorChange: (floor: WindowSize) => void,
): React.RefCallback<Element> {
  const onWindowFloorChangeRef = useLatestRef(onWindowFloorChange);
  return useCallback(
    (element: Element | null) => {
      if (element === null) {
        // A ref callback that returned a cleanup is never called with null.
        return undefined;
      }
      return observeElementResize(element, () => {
        const box = element.getBoundingClientRect();
        onWindowFloorChangeRef.current({ width: box.width, height: box.height });
      });
    },
    [onWindowFloorChangeRef],
  );
}
