import { useLayoutEffect, useState } from "react";

import { getWindow } from "@floating-ui/utils/dom";

import { observeElementResize } from "#renderer/lib/element-resize.js";

/**
 * The height a diff block takes beyond its rows, in CSS pixels: its footer and the space under it,
 * read off the first block the card draws and again whenever that footer is resized (a text-size
 * change, or a narrower flow wrapping it). `undefined` until a block is drawn.
 */
export function useDiffBlockOverhead(
  cardElement: HTMLElement | null,
  hasBlocks: boolean,
): number | undefined {
  const [overheadPx, setOverheadPx] = useState<number | undefined>(undefined);

  useLayoutEffect(() => {
    const footer = hasBlocks
      ? cardElement?.querySelector<HTMLElement>(".meridian-diff-block__footer")
      : undefined;
    if (cardElement === null || footer === null || footer === undefined) {
      return undefined;
    }
    const readOverhead = (): void => {
      const { rowGap } = getWindow(cardElement).getComputedStyle(cardElement);
      setOverheadPx(footer.offsetHeight + Number.parseFloat(rowGap));
    };
    readOverhead();
    return observeElementResize(footer, readOverhead);
  }, [cardElement, hasBlocks]);

  return overheadPx;
}
