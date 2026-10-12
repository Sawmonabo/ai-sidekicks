import { useLayoutEffect, useState } from "react";

import { getWindow } from "@floating-ui/utils/dom";

import { observeElementResize } from "#renderer/lib/element-resize.js";
import type { DiffBlockOverhead } from "../rows/flow.js";

/**
 * What a diff block takes beyond its rows, in CSS pixels: the first footer the card draws, and the
 * space under each block, read again whenever that footer is resized (a text-size change, or a
 * narrower flow wrapping it). `undefined` until a footer is drawn.
 */
export function useDiffBlockOverhead(
  cardElement: HTMLElement | null,
  hasBlocks: boolean,
): DiffBlockOverhead | undefined {
  const [overhead, setOverhead] = useState<DiffBlockOverhead | undefined>(undefined);

  useLayoutEffect(() => {
    const footer = hasBlocks
      ? cardElement?.querySelector<HTMLElement>(".meridian-diff-block__footer")
      : undefined;
    if (cardElement === null || footer === null || footer === undefined) {
      return undefined;
    }
    const readOverhead = (): void => {
      const { rowGap } = getWindow(cardElement).getComputedStyle(cardElement);
      setOverhead({ footerPx: footer.offsetHeight, gapPx: Number.parseFloat(rowGap) });
    };
    readOverhead();
    return observeElementResize(footer, readOverhead);
  }, [cardElement, hasBlocks]);

  return overhead;
}
