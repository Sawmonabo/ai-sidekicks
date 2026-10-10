import { useLayoutEffect } from "react";

import { getWindow } from "@floating-ui/utils/dom";

import { nearestVerticalScrollerOf } from "#renderer/lib/clipping-ancestors.js";
import { DIFF_FLOW_STEP_ATTRIBUTE } from "../rows/flow.js";
import type { RowStepRange } from "./useRowsMountedInSteps.js";

/**
 * While a block is open whole, hand `bringNear` the steps of its rows within `bandPx` of the
 * screen on every scroll of the flow it is drawn in; the press that opens it mounts what the screen
 * shows then, and a step's first relevance is decided in the frame it starts. A scroll event is
 * dispatched in the frame's rendering update ahead of style, layout and paint, so steps that
 * `bringNear` commits there are drawn in the very frame the scroll is: a person never sees the room
 * held for rows that are not mounted yet.
 */
export function useStepsNearView(
  rowsElement: HTMLElement | null,
  isWhole: boolean,
  bandPx: number,
  bringNear: (near: RowStepRange | undefined) => void,
): void {
  useLayoutEffect(() => {
    if (rowsElement === null || !isWhole) {
      return undefined;
    }
    const ownerWindow = getWindow(rowsElement);
    const scroller = nearestVerticalScrollerOf(rowsElement);
    const onScroll = (): void => {
      const screen =
        scroller === undefined
          ? { top: 0, bottom: ownerWindow.innerHeight }
          : scroller.getBoundingClientRect();
      bringNear(stepsWithin(rowsElement, screen.top - bandPx, screen.bottom + bandPx));
    };
    const scrolled = scroller ?? ownerWindow;
    scrolled.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      scrolled.removeEventListener("scroll", onScroll);
    };
  }, [rowsElement, isWhole, bandPx, bringNear]);
}

/** The block's steps whose boxes reach between `top` and `bottom`, in viewport pixels. */
function stepsWithin(
  rowsElement: HTMLElement,
  top: number,
  bottom: number,
): RowStepRange | undefined {
  let first: number | undefined;
  let last: number | undefined;
  for (const step of rowsElement.querySelectorAll<HTMLElement>(
    `:scope > [${DIFF_FLOW_STEP_ATTRIBUTE}]`,
  )) {
    const box = step.getBoundingClientRect();
    if (box.bottom > top && box.top < bottom) {
      const stepIndex = Number(step.getAttribute(DIFF_FLOW_STEP_ATTRIBUTE));
      first ??= stepIndex;
      last = stepIndex;
    } else if (last !== undefined) {
      break;
    }
  }
  return first === undefined || last === undefined ? undefined : { first, last };
}
