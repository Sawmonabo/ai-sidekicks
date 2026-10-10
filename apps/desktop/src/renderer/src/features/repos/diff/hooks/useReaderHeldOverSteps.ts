import { useContext, useLayoutEffect } from "react";

import { getWindow } from "@floating-ui/utils/dom";

import { TranscriptBodyViewportContext } from "#renderer/components/TranscriptBodyViewport/context.js";
import { nearestVerticalScrollerOf } from "#renderer/lib/clipping-ancestors.js";
import { observeElementsResize } from "#renderer/lib/element-resize.js";
import { WINDOWED_ROW_INDEX_ATTRIBUTE } from "#renderer/lib/windowed-row-markers.js";
import { DIFF_FLOW_STEP_ATTRIBUTE } from "../rows/flow.js";

/**
 * While a block is open whole inside a transcript viewport, keep the reader still as its steps of
 * rows change height above them: a step mounted or laid out for the first time takes its real
 * height in place of the estimate it was held at, and a long line wraps. The resize observation
 * is delivered after layout and before paint, so the offset moves back by what the steps above
 * the screen's top grew in the same frame, and the rows the reader sees never move.
 *
 * The conversation's own window moves the offset for a row wholly above the screen, so the block
 * moves it only while its row reaches the screen. Outside a viewport there is no scroller to
 * write, and nothing is held.
 */
export function useReaderHeldOverSteps(
  rowsElement: HTMLElement | null,
  isWhole: boolean,
  stepCount: number,
): void {
  const viewport = useContext(TranscriptBodyViewportContext);
  const scrollController = viewport?.scrollController;

  useLayoutEffect(() => {
    const scroller = rowsElement === null ? undefined : nearestVerticalScrollerOf(rowsElement);
    if (
      rowsElement === null ||
      !isWhole ||
      scrollController === undefined ||
      scroller === undefined
    ) {
      return undefined;
    }
    const heightByStep = new Map<Element, number>();
    const observation = observeElementsResize(getWindow(rowsElement), (entries) => {
      const screenTopPx = scroller.getBoundingClientRect().top;
      // In document order, so each step's place before this frame is its place now less what the
      // steps above it grew.
      const grown = entries
        .map((entry) => ({
          step: entry.target,
          heightPx: entry.borderBoxSize[0]?.blockSize ?? 0,
        }))
        .sort((left, right) => stepIndexOf(left.step) - stepIndexOf(right.step));
      let grownAbovePx = 0;
      let grownInBlockPx = 0;
      for (const { step, heightPx } of grown) {
        const previousHeightPx = heightByStep.get(step);
        heightByStep.set(step, heightPx);
        if (previousHeightPx === undefined || heightPx === previousHeightPx) {
          continue;
        }
        const deltaPx = heightPx - previousHeightPx;
        const previousTopPx = step.getBoundingClientRect().top - grownInBlockPx;
        grownInBlockPx += deltaPx;
        if (previousTopPx < screenTopPx) {
          grownAbovePx += deltaPx;
        }
      }
      const row = rowsElement.closest(`[${WINDOWED_ROW_INDEX_ATTRIBUTE}]`);
      const isRowAboveScreen =
        row !== null && row.getBoundingClientRect().bottom - grownInBlockPx <= screenTopPx;
      if (grownAbovePx !== 0 && !isRowAboveScreen) {
        scrollController.glideTo("measurement-compensation", scroller.scrollTop + grownAbovePx);
      }
    });
    // Every step is drawn while the block is whole, holding its room until its rows mount, so
    // each is observed once; its first observation records the height it opens at.
    for (const step of rowsElement.querySelectorAll(`:scope > [${DIFF_FLOW_STEP_ATTRIBUTE}]`)) {
      observation.observe(step);
    }
    return observation.disconnect;
  }, [rowsElement, isWhole, stepCount, scrollController]);
}

function stepIndexOf(step: Element): number {
  return Number(step.getAttribute(DIFF_FLOW_STEP_ATTRIBUTE));
}
