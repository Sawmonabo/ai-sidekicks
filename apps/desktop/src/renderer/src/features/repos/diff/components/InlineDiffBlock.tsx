// One file of a diff in the flow. Its rows are drawn in the conversation itself, never in a
// scroller of their own: cut at the height of as many rows as a third of the visible flow holds
// and faded there, with a footer counting the lines drawn, lifting the cut, and copying the
// file's whole patch. A file inside the cut is drawn whole and its footer has nothing to lift. A
// file with no lines to draw keeps its header and writes what changed where its lines would be,
// with a footer only where it has a patch to copy.
//
// The rows are drawn in steps of a fixed count, each step one box. Whether a block is open whole
// is its host's to hold, so it stays open while its row scrolls out and back. Show all mounts the
// rows to a screen past the screen in the press itself and the rest one step per task, so no task
// mounts thousands of rows. Rows not mounted yet hold no room: the block grows at the end of its
// mounted rows as each step lands, so no scroll, however the browser runs it, can reach a part of
// the block with no rows drawn, and the reader stays still as the block grows above them.
// Each step is laid out and painted on its own, so a step that lands costs the browser its own
// rows rather than every row mounted above it.

// The rows' own sheet, shared with Review's renderer so a change reads the same in both, then the
// block's and the flow's look.
import "./DiffRenderer.css";
import "./InlineDiffBlock.css";

import { memo, useState } from "react";

import { CopyButton } from "#renderer/components/CopyButton/CopyButton.js";
import { formatCount } from "#renderer/lib/wire/figures.js";
import { useClipboardCopy } from "#renderer/services/platform/hooks/useClipboardCopy.js";
import { useIntralineSegmentCache } from "../hooks/useIntralineSegmentCache.js";
import { useHoldReaderOverSteps } from "../hooks/useHoldReaderOverSteps.js";
import { useRowsCut } from "../hooks/useRowsCut.js";
import { useRowsMountedInSteps } from "../hooks/useRowsMountedInSteps.js";
import type { IntralineSegmentCache } from "../intraline/segment-cache.js";
import { DIFF_FLOW_FILL_STEP_ROWS, DIFF_ROW_HEIGHT_REM } from "../measures.js";
import type { DiffFile } from "../model.js";
import { DIFF_FLOW_STEP_ATTRIBUTE, diffFlowCutRowCount, type DiffFlowRows } from "../rows/flow.js";
import { DiffRowView } from "./DiffRowView.js";

/** What one file's block is drawn from: the file, its rows in the flow, and the flow's measures. */
export interface InlineDiffBlockProps {
  readonly file: DiffFile;
  readonly flowRows: DiffFlowRows;
  /** The visible flow's height, in CSS pixels, which the cut is read from. */
  readonly flowHeightPx: number;
  /** One row's height at the current text size, in CSS pixels. */
  readonly rowHeightPx: number;
  /** Whether the file is open whole; its host holds it, so it outlives the block's mount. */
  readonly isOpen: boolean;
  /** Open the file whole, which `Show all` asks for. Nothing closes it again. */
  readonly onOpen: () => void;
}

/** One file's rows in the flow, cut at a third of the visible flow, and its footer. */
export function InlineDiffBlock(props: InlineDiffBlockProps): React.JSX.Element {
  const { flowRows, flowHeightPx, rowHeightPx, isOpen } = props;
  const rowCount = flowRows.rows.length;
  const intraline = useIntralineSegmentCache(flowRows.index.model);
  const [rowsElement, setRowsElement] = useState<HTMLDivElement | null>(null);

  const cutRowCount = diffFlowCutRowCount(flowHeightPx, rowHeightPx);
  // Opening draws the rows to a screen past the screen at once, so a scroll that follows the
  // press meets rows rather than the block's end coming up early.
  const mountedRowCount = useRowsMountedInSteps(
    rowCount,
    isOpen,
    cutRowCount + 2 * Math.ceil(flowHeightPx / rowHeightPx),
  );
  const drawnRowCount = mountedRowCount ?? Math.min(rowCount, cutRowCount);
  const cutHeightPx = isOpen ? undefined : cutRowCount * rowHeightPx;
  const { isCut, drawnLineCount } = useRowsCut(
    rowsElement,
    cutHeightPx,
    flowRows.lineCount,
    drawnRowCount < rowCount,
  );
  useHoldReaderOverSteps(rowsElement, isOpen, mountedRowCount);

  // One element per step, so a step mounts its own rows and every other step's memo holds.
  const rowSteps: React.JSX.Element[] = [];
  for (let step = 0; step * DIFF_FLOW_FILL_STEP_ROWS < drawnRowCount; step += 1) {
    const start = step * DIFF_FLOW_FILL_STEP_ROWS;
    rowSteps.push(
      <FlowRowStep
        key={step}
        flowRows={flowRows}
        intraline={intraline}
        step={step}
        end={Math.min(drawnRowCount, start + DIFF_FLOW_FILL_STEP_ROWS)}
      />,
    );
  }
  const rowsClassName = [
    "meridian-diff-block__rows",
    "meridian-focus-inset",
    isCut ? "meridian-diff-block__rows--cut" : "",
  ]
    .filter((part) => part !== "")
    .join(" ");

  return (
    // No section or footer: either can be a landmark, one per file in the conversation.
    <div
      className="meridian-diff-block"
      // The row height has one home, `measures.ts`; the block's sheets read it from here.
      style={
        { "--meridian-diff-row-height": `${String(DIFF_ROW_HEIGHT_REM)}rem` } as React.CSSProperties
      }
    >
      <div
        ref={setRowsElement}
        className={rowsClassName}
        role="table"
        aria-label={`Diff of ${props.file.path}`}
        aria-rowcount={rowCount}
        tabIndex={-1}
        // The gutter is as wide as the widest number this file shows.
        style={
          {
            "--meridian-diff-gutter-digits": String(flowRows.gutterDigitCount),
            ...(cutHeightPx === undefined ? {} : { maxBlockSize: cutHeightPx }),
          } as React.CSSProperties
        }
      >
        {rowSteps}
      </div>
      {flowRows.bodyNotes.length === 0 ? null : (
        <p className="meridian-diff-block__note">{flowRows.bodyNotes.join(", ")}</p>
      )}
      {flowRows.hasFooter ? (
        <div className="meridian-diff-block__footer">
          {flowRows.lineCount === 0 ? null : (
            <span>{`${formatCount(drawnLineCount)} of ${formatCount(flowRows.lineCount)} ${flowRows.lineCount === 1 ? "line" : "lines"}`}</span>
          )}
          {isCut ? (
            <>
              <span aria-hidden="true">·</span>
              <button
                type="button"
                className="meridian-link-button"
                onClick={() => {
                  props.onOpen();
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
            <PatchCopy patch={props.file.patch} hasSeparator={flowRows.lineCount > 0} />
          )}
        </div>
      ) : null}
    </div>
  );
}

/**
 * One step of a block's rows, from `step`'s first row to before `end`, numbered by their place in
 * the block.
 */
const FlowRowStep = memo(function FlowRowStep(props: {
  readonly flowRows: DiffFlowRows;
  readonly intraline: IntralineSegmentCache;
  readonly step: number;
  readonly end: number;
}): React.JSX.Element {
  const start = props.step * DIFF_FLOW_FILL_STEP_ROWS;
  const rows: React.JSX.Element[] = [];
  for (let rowIndex = start; rowIndex < props.end; rowIndex += 1) {
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
  return (
    <div
      role="rowgroup"
      className="meridian-diff-block__step"
      {...{ [DIFF_FLOW_STEP_ATTRIBUTE]: props.step }}
    >
      {rows}
    </div>
  );
});

/** The footer's copy of the file's whole patch, after its separator where words precede it. */
function PatchCopy(props: {
  readonly patch: string;
  readonly hasSeparator: boolean;
}): React.JSX.Element {
  const clipboardCopy = useClipboardCopy({ text: props.patch });
  return (
    <>
      {props.hasSeparator ? <span aria-hidden="true">·</span> : null}
      <CopyButton label="Copy patch" clipboardCopy={clipboardCopy} look="link" />
    </>
  );
}
