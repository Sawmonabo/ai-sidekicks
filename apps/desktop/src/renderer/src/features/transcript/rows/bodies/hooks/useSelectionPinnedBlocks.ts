import { useEffect, useState } from "react";

import { type MarkdownWindowViewport } from "../../markdown/block-window/context.js";
import {
  pinnedBlockRangeOf,
  type PinnedBlockRange,
} from "../../markdown/block-window/selection-pins.js";

/**
 * The blocks of one windowed body the reader's selection runs across, read again on every
 * selection change the viewport reports. The same range object while the pinned blocks stay the
 * same, so a selection that only moves inside them re-renders nothing.
 */
export function useSelectionPinnedBlocks(
  viewport: MarkdownWindowViewport,
  readWindowElement: () => Element | null,
  readBlockCount: () => number,
): PinnedBlockRange | undefined {
  const [pins, setPins] = useState<PinnedBlockRange | undefined>(undefined);
  useEffect(() => {
    const readPins = (): void => {
      const windowElement = readWindowElement();
      const next =
        windowElement === null
          ? undefined
          : pinnedBlockRangeOf(viewport.readSelectionRange(), windowElement, readBlockCount());
      setPins((held) =>
        held?.firstIndex === next?.firstIndex && held?.lastIndex === next?.lastIndex ? held : next,
      );
    };
    readPins();
    return viewport.subscribeToSelection(readPins);
  }, [viewport, readWindowElement, readBlockCount]);
  return pins;
}
