import { useLayoutEffect, useState } from "react";

import { type TranscriptBodyViewport } from "#renderer/components/TranscriptBodyViewport/context.js";
import {
  useMeasuredItemWindow,
  type MeasuredItemWindowView,
} from "#renderer/components/TranscriptBodyViewport/hooks/useMeasuredItemWindow.js";
import { DIFF_FLOW_STEP_ROWS } from "../measures.js";
import { DIFF_FLOW_STEP_ATTRIBUTE, type DiffFlowRows } from "../rows/flow.js";
import { diffFlowRowsText } from "../rows/row-text.js";
import { DiffStepWindowLayout } from "../rows/step-window.js";

/** A diff block's window over its steps of rows, as one render draws it. */
export interface DiffStepWindow extends MeasuredItemWindowView {
  /** The block's layout, whose window measures its steps off screen. */
  readonly layout: DiffStepWindowLayout;
}

/**
 * One diff block's window over its steps of rows, for a block opened whole inside a transcript
 * viewport: only the steps near the scroller's viewport are drawn in `rowsElement`, plus the steps
 * holding the reader's selection's ends; the steps between them are copied from the rows' text.
 * `viewport` and `rowKey` are held for the window's life. `firstStepCount` steps are drawn before
 * the rows' type is read, the rows the block drew cut.
 */
export function useDiffStepWindow(
  flowRows: DiffFlowRows,
  viewport: TranscriptBodyViewport,
  rowKey: string,
  rowsElement: HTMLElement,
  firstStepCount: number,
): DiffStepWindow {
  const [layout] = useState(() => new DiffStepWindowLayout(viewport, rowKey, flowRows));
  layout.setFlowRows(flowRows);
  // Before the window's own effects, which read the rows' element.
  useLayoutEffect(() => {
    layout.attachRows(rowsElement);
    return () => {
      layout.attachRows(null);
    };
  }, [layout, rowsElement]);
  const view = useMeasuredItemWindow({
    window: layout.window,
    viewport,
    itemCount: layout.stepCount,
    isLaidOut: layout.isLaidOut,
    readTypeOnMount: layout.readTypeOnMount,
    firstDrawnCount: firstStepCount,
    estimateSize: layout.estimateSize,
    getScrollElement: layout.getScrollElement,
    indexAttribute: DIFF_FLOW_STEP_ATTRIBUTE,
    itemText: (step) =>
      diffFlowRowsText(
        flowRows,
        step * DIFF_FLOW_STEP_ROWS,
        Math.min(flowRows.rows.length, (step + 1) * DIFF_FLOW_STEP_ROWS),
      ),
    // Each row is a line of its own.
    itemSeparator: "\n",
    revision: flowRows,
  });
  return { ...view, layout };
}
