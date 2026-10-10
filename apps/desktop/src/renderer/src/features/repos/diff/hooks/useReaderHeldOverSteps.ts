import { useContext, useLayoutEffect, useRef } from "react";

import { getWindow } from "@floating-ui/utils/dom";

import { TranscriptBodyViewportContext } from "#renderer/components/TranscriptBodyViewport/context.js";
import { nearestVerticalScrollerOf } from "#renderer/lib/clipping-ancestors.js";
import {
  observeElementsResize,
  type ElementsResizeObservation,
} from "#renderer/lib/element-resize.js";
import { WINDOWED_ROW_INDEX_ATTRIBUTE } from "#renderer/lib/windowed-row-markers.js";
import { DIFF_FLOW_STEP_ATTRIBUTE } from "../rows/flow.js";

/**
 * While a block is open whole inside a transcript viewport, keep the reader still as its rows
 * change height above them: a step of rows that lands grows the block at the end of its mounted
 * rows, and a long line wraps again when the flow's width or the text size changes. The resize
 * observation is delivered after layout and before paint, so the offset moves back by what grew
 * above the screen's top in the same frame, and the rows the reader sees never move.
 *
 * The conversation's own window moves the offset for a row wholly above the screen, so the block
 * moves it only while its row reaches the screen. Outside a viewport there is no scroller to
 * write, and nothing is held. `mountedRowCount` is how many rows are mounted, so each step that
 * lands is observed from its first frame.
 */
export function useReaderHeldOverSteps(
  rowsElement: HTMLElement | null,
  isWhole: boolean,
  mountedRowCount: number | undefined,
): void {
  const viewport = useContext(TranscriptBodyViewportContext);
  const scrollController = viewport?.scrollController;
  const held = useRef<HeldSteps | undefined>(undefined);

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
        const previousHeightPx = heightByStep.get(step) ?? heightPx;
        heightByStep.set(step, heightPx);
        if (heightPx === previousHeightPx) {
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
    // The steps drawn when the block opens are where its growth starts from: their heights now.
    for (const step of stepsOf(rowsElement)) {
      heightByStep.set(step, step.getBoundingClientRect().height);
      observation.observe(step);
    }
    held.current = { heightByStep, observation };
    return () => {
      observation.disconnect();
      held.current = undefined;
    };
  }, [rowsElement, isWhole, scrollController]);

  useLayoutEffect(() => {
    const current = held.current;
    if (current === undefined || rowsElement === null) {
      return;
    }
    // A step that landed after the block opened took no room before, so all of it is growth.
    for (const step of stepsOf(rowsElement)) {
      if (!current.heightByStep.has(step)) {
        current.heightByStep.set(step, 0);
        current.observation.observe(step);
      }
    }
  }, [rowsElement, mountedRowCount]);
}

/** The observation over an open block's steps, and each step's height as last seen. */
interface HeldSteps {
  readonly heightByStep: Map<Element, number>;
  readonly observation: ElementsResizeObservation;
}

function stepsOf(rowsElement: HTMLElement): NodeListOf<HTMLElement> {
  return rowsElement.querySelectorAll<HTMLElement>(`:scope > [${DIFF_FLOW_STEP_ATTRIBUTE}]`);
}

function stepIndexOf(step: Element): number {
  return Number(step.getAttribute(DIFF_FLOW_STEP_ATTRIBUTE));
}
