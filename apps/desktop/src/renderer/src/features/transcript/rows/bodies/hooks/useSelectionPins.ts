import { useEffect, useState } from "react";

import { type MarkdownWindowViewport } from "../../markdown/block-window/context.js";
import { pinnedRangeOf, type PinnedRange } from "../../markdown/block-window/selection-pins.js";

/**
 * The items of one window, marked with `indexAttribute`, that the reader's selection runs across,
 * read again on every selection change the viewport reports. The same range object while the
 * pinned items stay the same, so a selection that only moves inside them re-renders nothing.
 */
export function useSelectionPins(
  viewport: MarkdownWindowViewport,
  readWindowElement: () => Element | null,
  readItemCount: () => number,
  indexAttribute: string,
): PinnedRange | undefined {
  const [pins, setPins] = useState<PinnedRange | undefined>(undefined);
  useEffect(() => {
    const readPins = (): void => {
      const windowElement = readWindowElement();
      const next =
        windowElement === null
          ? undefined
          : pinnedRangeOf(
              viewport.readSelectionRange(),
              windowElement,
              readItemCount(),
              indexAttribute,
            );
      setPins((held) =>
        held?.firstIndex === next?.firstIndex && held?.lastIndex === next?.lastIndex ? held : next,
      );
    };
    readPins();
    return viewport.subscribeToSelection(readPins);
  }, [viewport, readWindowElement, readItemCount, indexAttribute]);
  return pins;
}
