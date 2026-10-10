import { useLayoutEffect, useState } from "react";

import { getWindow } from "@floating-ui/utils/dom";

import { observeElementResize } from "#renderer/lib/element-resize.js";

/**
 * The height a diff block takes beyond its rows, in CSS pixels: its footer and the space under it,
 * read off the first footer the card draws with words in it, and again whenever that footer is
 * resized (a text-size change, or a narrower flow wrapping it). `undefined` until one is drawn.
 */
export function useDiffBlockOverhead(
  cardElement: HTMLElement | null,
  hasBlocks: boolean,
): number | undefined {
  const [overheadPx, setOverheadPx] = useState<number | undefined>(undefined);

  useLayoutEffect(() => {
    const footer = hasBlocks
      ? cardElement?.querySelector<HTMLElement>(".meridian-diff-block__footer:not(:empty)")
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
