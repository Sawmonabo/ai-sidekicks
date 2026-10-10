// One file of a diff in the flow. Its rows are drawn in the conversation itself, never in a
// scroller of their own: cut at the height of as many rows as a third of the visible flow holds
// and faded there, with a footer counting the lines drawn, lifting the cut, and copying the
// file's whole patch. A file inside the cut is drawn whole and its footer has nothing to lift.
//
// Show all mounts what the flow can show at once in the press itself and the rest a step per
// task, below the screen, over space already held for it, so the rows above never move and no
// task mounts thousands of rows. Rows past the screen skip their layout and paint until they near
// it (`content-visibility`), which also keeps a whole long diff cheap to lay out again.

// The rows' own sheet, shared with Review's renderer so a change reads the same in both.
import "./DiffRenderer.css";

import { memo, useState } from "react";

import { CopyButton } from "#renderer/components/CopyButton/CopyButton.js";
import { formatCount } from "#renderer/lib/wire/figures.js";
import { useClipboardCopy } from "#renderer/services/platform/hooks/useClipboardCopy.js";
import { useIntralineSegmentCache } from "../hooks/useIntralineSegmentCache.js";
import { useRowsCut } from "../hooks/useRowsCut.js";
import { useRowsMountedInSteps } from "../hooks/useRowsMountedInSteps.js";
import type { IntralineSegmentCache } from "../intraline/segment-cache.js";
import { DIFF_FLOW_FILL_STEP_ROWS, DIFF_ROW_HEIGHT_PX } from "../measures.js";
import type { DiffFile } from "../model.js";
import { diffFlowCutRowCount, type DiffFlowRows } from "../rows/flow.js";
import { DiffRowView } from "./DiffRowView.js";

/** What one file's block is drawn from: the file, its rows in the flow, and the flow's height. */
export interface InlineDiffBlockProps {
  readonly file: DiffFile;
  readonly flowRows: DiffFlowRows;
  /** The visible flow's height, in CSS pixels, which the cut is read from. */
  readonly flowHeightPx: number;
}

/** One file's rows in the flow, cut at a third of the visible flow, and its footer. */
export function InlineDiffBlock(props: InlineDiffBlockProps): React.JSX.Element {
  const { flowRows } = props;
  const rowCount = flowRows.rows.length;
  const intraline = useIntralineSegmentCache(flowRows.index.model);
  const { mountedRowCount, mountAll } = useRowsMountedInSteps(rowCount);
  const [rowsElement, setRowsElement] = useState<HTMLDivElement | null>(null);

  const isShowingAll = mountedRowCount !== undefined;
  const cutRowCount = diffFlowCutRowCount(props.flowHeightPx);
  const drawnRowCount = mountedRowCount ?? Math.min(rowCount, cutRowCount);
  const cutHeightPx = isShowingAll ? undefined : cutRowCount * DIFF_ROW_HEIGHT_PX;
  const { isCut, drawnLineCount } = useRowsCut(
    rowsElement,
    cutHeightPx,
    flowRows.lineCount,
    drawnRowCount < rowCount,
  );

  // One element per step of rows, so a step mounts its own rows and every earlier step's memo
  // holds.
  const rowSteps: React.JSX.Element[] = [];
  for (let start = 0; start < drawnRowCount; start += DIFF_FLOW_FILL_STEP_ROWS) {
    rowSteps.push(
      <FlowRowStep
        key={start}
        flowRows={flowRows}
        intraline={intraline}
        start={start}
        end={Math.min(drawnRowCount, start + DIFF_FLOW_FILL_STEP_ROWS)}
      />,
    );
  }
  const rowsClassName = [
    "meridian-diff-block__rows",
    "meridian-focus-inset",
    isCut ? "meridian-diff-block__rows--cut" : "",
    isShowingAll ? "meridian-diff-block__rows--whole" : "",
  ]
    .filter((part) => part !== "")
    .join(" ");

  return (
    // No section or footer: either can be a landmark, one per file in the conversation.
    <div className="meridian-diff-block">
      <div
        ref={setRowsElement}
        className={rowsClassName}
        role="table"
        aria-label={`Diff of ${props.file.path}`}
        aria-rowcount={rowCount}
        tabIndex={-1}
        // The row height has one home, `measures.ts`; the rows' sheet reads it from here, and the
        // gutter's width from the widest number this file shows.
        style={
          {
            "--meridian-diff-row-height": `${String(DIFF_ROW_HEIGHT_PX)}px`,
            "--meridian-diff-gutter-digits": String(flowRows.gutterDigitCount),
            ...(cutHeightPx === undefined ? {} : { maxBlockSize: cutHeightPx }),
          } as React.CSSProperties
        }
      >
        {rowSteps}
      </div>
      {isShowingAll && drawnRowCount < rowCount ? (
        // The rows still to mount hold their place, so nothing below the block moves as they land.
        <div
          aria-hidden="true"
          style={{ blockSize: (rowCount - drawnRowCount) * DIFF_ROW_HEIGHT_PX }}
        />
      ) : null}
      <div className="meridian-diff-block__footer">
        {flowRows.lineCount === 0 ? null : (
          <span>{`${formatCount(drawnLineCount)} of ${formatCount(flowRows.lineCount)} ${flowRows.lineCount === 1 ? "line" : "lines"}`}</span>
        )}
        {isCut ? (
          <>
            <span className="meridian-diff-block__separator" aria-hidden="true">
              ·
            </span>
            <button
              type="button"
              className="meridian-diff-block__control"
              onClick={() => {
                // The rows from the cut to a screen past it land with the press, so whatever
                // the screen shows is drawn in its first frame.
                mountAll(cutRowCount + Math.ceil(props.flowHeightPx / DIFF_ROW_HEIGHT_PX));
                // The control leaves with the cut, so focus goes to the rows it opened rather
                // than to the page; `preventScroll` keeps the rows above where they were.
                rowsElement?.focus({ preventScroll: true });
              }}
            >
              Show all
            </button>
          </>
        ) : null}
        {props.file.patch === undefined ? null : (
          <PatchCopy patch={props.file.patch} hasSeparator={flowRows.lineCount > 0 || isCut} />
        )}
      </div>
    </div>
  );
}

/** One step of a block's rows, `start` to before `end`, numbered by their place in the block. */
const FlowRowStep = memo(function FlowRowStep(props: {
  readonly flowRows: DiffFlowRows;
  readonly intraline: IntralineSegmentCache;
  readonly start: number;
  readonly end: number;
}): React.JSX.Element {
  const rows: React.JSX.Element[] = [];
  for (let rowIndex = props.start; rowIndex < props.end; rowIndex += 1) {
    const row = props.flowRows.rows[rowIndex];
    if (row !== undefined) {
      rows.push(
        <DiffRowView
          key={rowIndex}
          rowIndex={rowIndex}
          row={row}
          index={props.flowRows.index}
          intraline={props.intraline}
          viewMode="unified"
          look="flow"
        />,
      );
    }
  }
  return <>{rows}</>;
});

/** The footer's copy of the file's whole patch, after its separator where words precede it. */
function PatchCopy(props: {
  readonly patch: string;
  readonly hasSeparator: boolean;
}): React.JSX.Element {
  const clipboardCopy = useClipboardCopy({ text: props.patch });
  return (
    <>
      {props.hasSeparator ? (
        <span className="meridian-diff-block__separator" aria-hidden="true">
          ·
        </span>
      ) : null}
      <CopyButton label="Copy patch" clipboardCopy={clipboardCopy} />
    </>
  );
}
