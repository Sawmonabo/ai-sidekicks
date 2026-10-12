// One file of a diff in the flow. Its rows are drawn in the conversation itself, never in a
// scroller of their own: cut at the height of as many rows as a third of the visible flow holds
// and faded there, with a footer counting the lines drawn, lifting the cut, and copying the
// file's whole patch. A file inside the cut is drawn whole and its footer has nothing to lift. A
// file with no lines to draw keeps its header and writes what changed where its lines would be,
// with a footer only where it has a patch to copy.
//
// The rows are drawn in steps of a fixed count, each step one box, laid out and painted on its own,
// so a step that lands or wraps again costs the browser its own rows rather than every row above
// it. Whether a block is open whole is its host's to hold, so it stays open while its row scrolls
// out and back. Inside a transcript viewport a block opened whole draws as a window over its steps,
// only those near the reader mounted and a spacer holding the room of each run of the rest, its
// steps measured off screen a slice at a time so the spacers hold their real room, and a copy across
// the undrawn steps reads their rows' text. Outside one, Show all mounts the rows to a screen past
// the screen in the press itself and the rest one step per task, so no task mounts thousands of
// rows; rows not mounted yet hold no room, so no scroll, however the browser runs it, can reach a
// part of the block with no rows drawn.

// The rows' own sheet, shared with Review's renderer so a change reads the same in both, then the
// block's and the flow's look.
import "./DiffRenderer.css";
import "./InlineDiffBlock.css";

import { memo, useContext, useState, useSyncExternalStore } from "react";

import { CopyButton } from "#renderer/components/CopyButton/CopyButton.js";
import { MeasuringFrames } from "#renderer/components/MeasuringFrames/MeasuringFrames.js";
import {
  TranscriptBodyViewportContext,
  type TranscriptBodyViewport,
} from "#renderer/components/TranscriptBodyViewport/context.js";
import {
  FIRST_UNDRAWN_ITEM_ATTRIBUTE,
  LAST_UNDRAWN_ITEM_ATTRIBUTE,
  UNDRAWN_TEXT_SOURCE_ATTRIBUTE,
} from "#renderer/components/TranscriptBodyViewport/drawn-window-sources.js";
import { type OffScreenMeasurement } from "#renderer/lib/off-screen-measurement.js";
import { formatCount } from "#renderer/lib/wire/figures.js";
import { useClipboardCopy } from "#renderer/services/platform/hooks/useClipboardCopy.js";
import { useIntralineSegmentCache } from "../hooks/useIntralineSegmentCache.js";
import { useDiffStepWindow } from "../hooks/useDiffStepWindow.js";
import { useRowsCut } from "../hooks/useRowsCut.js";
import { useRowsMountedInSteps } from "../hooks/useRowsMountedInSteps.js";
import type { IntralineSegmentCache } from "../intraline/segment-cache.js";
import { DIFF_FLOW_STEP_ROWS, DIFF_ROW_HEIGHT_REM } from "../measures.js";
import type { DiffFile } from "../model.js";
import { DIFF_FLOW_STEP_ATTRIBUTE, diffFlowCutRowCount, type DiffFlowRows } from "../rows/flow.js";
import { DiffRowView } from "./DiffRowView.js";

/** What one file's block is drawn from: the file, its rows in the flow, and the flow's measures. */
export interface InlineDiffBlockProps {
  readonly file: DiffFile;
  /** The transcript row the block is drawn in, which a block opened whole lays its rows out from. */
  readonly rowKey: string;
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
  const viewport = useContext(TranscriptBodyViewportContext);
  const isWindowed = isOpen && viewport !== undefined;

  const cutRowCount = diffFlowCutRowCount(flowHeightPx, rowHeightPx);
  // Opening draws the rows to a screen past the screen at once, so a scroll that follows the
  // press meets rows rather than the block's end coming up early.
  const mountedRowCount = useRowsMountedInSteps(
    rowCount,
    isOpen && !isWindowed,
    cutRowCount + 2 * Math.ceil(flowHeightPx / rowHeightPx),
  );
  const drawnRowCount = mountedRowCount ?? Math.min(rowCount, cutRowCount);
  const cutHeightPx = isOpen ? undefined : cutRowCount * rowHeightPx;
  const { isCut, drawnLineCount } = useRowsCut(
    rowsElement,
    cutHeightPx,
    flowRows.lineCount,
    !isWindowed && drawnRowCount < rowCount,
  );

  // One element per step, so a step mounts its own rows and every other step's memo holds. A
  // window draws its own steps once the rows' element it lays them out in is mounted.
  const rowSteps: React.JSX.Element[] = [];
  for (let step = 0; step * DIFF_FLOW_STEP_ROWS < drawnRowCount; step += 1) {
    rowSteps.push(
      <FlowRowStep
        key={step}
        flowRows={flowRows}
        intraline={intraline}
        step={step}
        end={stepEndOf(step, drawnRowCount)}
        attach={undefined}
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
      style={DIFF_BLOCK_STYLE}
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
            ...gutterStyleOf(flowRows),
            ...(cutHeightPx === undefined ? {} : { maxBlockSize: cutHeightPx }),
          } as React.CSSProperties
        }
      >
        {isWindowed && rowsElement !== null ? (
          <WindowedFlowRows
            flowRows={flowRows}
            intraline={intraline}
            viewport={viewport}
            rowKey={props.rowKey}
            rowsElement={rowsElement}
            firstStepCount={Math.ceil(cutRowCount / DIFF_FLOW_STEP_ROWS)}
          />
        ) : (
          rowSteps
        )}
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

/** The row height the block's sheets read, from its one home in `measures.ts`. */
const DIFF_BLOCK_STYLE = {
  "--meridian-diff-row-height": `${String(DIFF_ROW_HEIGHT_REM)}rem`,
} as React.CSSProperties;

/** The width the rows' gutter takes: as many figures as the widest number the file shows. */
function gutterStyleOf(flowRows: DiffFlowRows): React.CSSProperties {
  return {
    "--meridian-diff-gutter-digits": String(flowRows.gutterDigitCount),
  } as React.CSSProperties;
}

/** The row after step `step`'s last, of a block drawing `rowCount` rows. */
function stepEndOf(step: number, rowCount: number): number {
  return Math.min(rowCount, (step + 1) * DIFF_FLOW_STEP_ROWS);
}

/**
 * The steps of a block opened whole inside a transcript viewport, drawn in `rowsElement` where the
 * reader can see them, with a spacer for each run of the rest, and the steps measured off screen.
 */
function WindowedFlowRows(props: {
  readonly flowRows: DiffFlowRows;
  readonly intraline: IntralineSegmentCache;
  /** Held for the window's life. */
  readonly viewport: TranscriptBodyViewport;
  /** Held for the window's life. */
  readonly rowKey: string;
  readonly rowsElement: HTMLElement;
  readonly firstStepCount: number;
}): React.JSX.Element {
  const { flowRows, intraline } = props;
  const stepWindow = useDiffStepWindow(
    flowRows,
    props.viewport,
    props.rowKey,
    props.rowsElement,
    props.firstStepCount,
  );
  const rowCount = flowRows.rows.length;
  return (
    <>
      {stepWindow.rows.map((row) =>
        row.kind === "spacer" ? (
          <div
            key={row.key}
            aria-hidden="true"
            style={{ blockSize: `${String(row.heightPx)}px` }}
            {...{
              [UNDRAWN_TEXT_SOURCE_ATTRIBUTE]: stepWindow.sourceKey,
              [FIRST_UNDRAWN_ITEM_ATTRIBUTE]: row.firstIndex,
              [LAST_UNDRAWN_ITEM_ATTRIBUTE]: row.lastIndex,
            }}
          />
        ) : (
          <FlowRowStep
            key={row.key}
            flowRows={flowRows}
            intraline={intraline}
            step={row.index}
            end={stepEndOf(row.index, rowCount)}
            attach={stepWindow.attachItem}
          />
        ),
      )}
      <FlowStepMeasuringFrame
        measurement={stepWindow.layout.window.measurement}
        intraline={intraline}
      />
    </>
  );
}

/**
 * The steps a block opened whole measures off screen, drawn hidden in the measuring frames at the
 * rows' width, inside a block and a rows box of their own: the blocks' classes, and the type the
 * rows inherit in their conversation row set around them, as the frames stand outside the row.
 */
function FlowStepMeasuringFrame(props: {
  readonly measurement: OffScreenMeasurement<DiffFlowRows>;
  readonly intraline: IntralineSegmentCache;
}): React.JSX.Element | null {
  const { measurement } = props;
  const frame = useSyncExternalStore(measurement.subscribe, measurement.read);
  if (frame === undefined) {
    return null;
  }
  const [first] = frame.items;
  return (
    <MeasuringFrames ownerDocument={frame.box.ownerDocument}>
      <div
        ref={(box) => {
          if (box !== null) {
            box.style.cssText = frame.box.textStyle;
          }
        }}
      >
        <div className="meridian-diff-block" style={DIFF_BLOCK_STYLE}>
          <div
            className="meridian-diff-block__rows"
            style={{
              ...(first === undefined ? {} : gutterStyleOf(first.item)),
              inlineSize: `${String(frame.box.widthPx)}px`,
            }}
          >
            {frame.items.map(({ index, item: flowRows }) => (
              <FlowRowStep
                key={`${String(frame.slice)}:${String(index)}`}
                flowRows={flowRows}
                intraline={props.intraline}
                step={index}
                end={stepEndOf(index, flowRows.rows.length)}
                attach={measurement.attachItem}
              />
            ))}
          </div>
        </div>
      </div>
    </MeasuringFrames>
  );
}

/**
 * One step of a block's rows, from `step`'s first row to before `end`, numbered by their place in
 * the block, and marked with its index, which a window reads back.
 */
const FlowRowStep = memo(function FlowRowStep(props: {
  readonly flowRows: DiffFlowRows;
  readonly intraline: IntralineSegmentCache;
  readonly step: number;
  readonly end: number;
  /** What measures the step in a window, as it mounts and each time it resizes. */
  readonly attach: ((element: HTMLElement | null) => void) | undefined;
}): React.JSX.Element {
  const start = props.step * DIFF_FLOW_STEP_ROWS;
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
      ref={props.attach}
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
