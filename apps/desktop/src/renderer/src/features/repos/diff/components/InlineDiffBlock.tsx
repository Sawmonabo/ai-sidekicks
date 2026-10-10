// One file of a diff in the flow. Its rows are drawn in the conversation itself, never in a
// scroller of their own: cut at the height of as many rows as a third of the visible flow holds
// and faded there, with a footer counting the lines drawn, lifting the cut, and copying the
// file's whole patch. A file inside the cut is drawn whole and its footer has nothing to lift. A
// file with no lines to draw keeps its header and writes what changed where its lines would be.
//
// The rows are drawn in steps of a fixed count, each step one box. Show all mounts the steps the
// flow can show in the press itself and the rest one step per task, each step holding its room
// until its rows land, so the rows above never move and no task mounts thousands of rows. A
// scroll that brings a held step near the screen mounts it and lays it out before that frame
// paints, so a person never sees the room held for it, and the reader stays still as steps above
// them take their real heights. Steps away from the screen skip their layout and paint
// (`content-visibility`), which also keeps a whole long diff cheap to lay out again.

// The rows' own sheet, shared with Review's renderer so a change reads the same in both.
import "./DiffRenderer.css";

import { memo, useState } from "react";

import { CopyButton } from "#renderer/components/CopyButton/CopyButton.js";
import { formatCount } from "#renderer/lib/wire/figures.js";
import { useClipboardCopy } from "#renderer/services/platform/hooks/useClipboardCopy.js";
import { useIntralineSegmentCache } from "../hooks/useIntralineSegmentCache.js";
import { useReaderHeldOverSteps } from "../hooks/useReaderHeldOverSteps.js";
import { useRowsCut } from "../hooks/useRowsCut.js";
import { useRowsMountedInSteps, type RowStepRange } from "../hooks/useRowsMountedInSteps.js";
import { useStepsNearView } from "../hooks/useStepsNearView.js";
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
}

/** One file's rows in the flow, cut at a third of the visible flow, and its footer. */
export function InlineDiffBlock(props: InlineDiffBlockProps): React.JSX.Element {
  const { flowRows, flowHeightPx, rowHeightPx } = props;
  const rowCount = flowRows.rows.length;
  const stepCount = Math.ceil(rowCount / DIFF_FLOW_FILL_STEP_ROWS);
  const intraline = useIntralineSegmentCache(flowRows.index.model);
  const { steps, mountAll, bringNear } = useRowsMountedInSteps(rowCount);
  const [rowsElement, setRowsElement] = useState<HTMLDivElement | null>(null);

  const isShowingAll = steps !== undefined;
  const cutRowCount = diffFlowCutRowCount(flowHeightPx, rowHeightPx);
  const drawnRowCount = isShowingAll ? rowCount : Math.min(rowCount, cutRowCount);
  const cutHeightPx = isShowingAll ? undefined : cutRowCount * rowHeightPx;
  const { isCut, drawnLineCount } = useRowsCut(
    rowsElement,
    cutHeightPx,
    flowRows.lineCount,
    drawnRowCount < rowCount,
  );
  // Half a screen past each edge of the flow, so a quick scroll meets rows already laid out.
  useStepsNearView(rowsElement, isShowingAll, flowHeightPx / 2, bringNear);
  useReaderHeldOverSteps(rowsElement, isShowingAll, stepCount);

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
        isMounted={steps?.mounted[step] ?? true}
        isNear={isWithin(steps?.near, step)}
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
              className="meridian-link-button"
              onClick={() => {
                // The rows from the cut to a screen past it land with the press, so whatever
                // the screen shows is drawn in its first frame.
                mountAll(cutRowCount + Math.ceil(flowHeightPx / rowHeightPx));
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

/**
 * One step of a block's rows, from `step`'s first row to before `end`, numbered by their place in
 * the block. A step whose rows are not mounted yet holds their room at a row's height each.
 */
const FlowRowStep = memo(function FlowRowStep(props: {
  readonly flowRows: DiffFlowRows;
  readonly intraline: IntralineSegmentCache;
  readonly step: number;
  readonly end: number;
  readonly isMounted: boolean;
  readonly isNear: boolean;
}): React.JSX.Element {
  const start = props.step * DIFF_FLOW_FILL_STEP_ROWS;
  const rows: React.JSX.Element[] = [];
  for (let rowIndex = start; props.isMounted && rowIndex < props.end; rowIndex += 1) {
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
  const className = [
    "meridian-diff-block__step",
    props.isMounted ? "" : "meridian-diff-block__step--held",
    props.isNear ? "meridian-diff-block__step--near" : "",
  ]
    .filter((part) => part !== "")
    .join(" ");
  return (
    <div
      className={className}
      {...{ [DIFF_FLOW_STEP_ATTRIBUTE]: props.step }}
      // A held step is room, not rows, so it is no group of the table's.
      {...(props.isMounted ? { role: "rowgroup" } : { "aria-hidden": true })}
      style={{ "--meridian-diff-step-rows": String(props.end - start) } as React.CSSProperties}
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
      {props.hasSeparator ? (
        <span className="meridian-diff-block__separator" aria-hidden="true">
          ·
        </span>
      ) : null}
      <CopyButton label="Copy patch" clipboardCopy={clipboardCopy} look="link" />
    </>
  );
}

function isWithin(range: RowStepRange | undefined, step: number): boolean {
  return range !== undefined && step >= range.first && step <= range.last;
}
