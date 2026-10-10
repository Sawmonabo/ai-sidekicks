// One file of a diff in the flow. Its rows are drawn in the conversation itself, never in a
// scroller of their own: cut at the height of as many rows as a third of the visible flow holds
// and faded there, with a footer counting the lines drawn, lifting the cut, and copying the
// file's whole patch. A file inside the cut is drawn whole and its footer has nothing to lift.

// The rows' own sheet, shared with Review's renderer so a change reads the same in both.
import "./DiffRenderer.css";

import { useMemo, useState } from "react";

import { CopyButton } from "#renderer/components/CopyButton/CopyButton.js";
import { formatCount } from "#renderer/lib/wire/figures.js";
import { useClipboardCopy } from "#renderer/services/platform/hooks/useClipboardCopy.js";
import { useDiffModelViewState } from "../hooks/useDiffModelViewState.js";
import { useIntralineSegmentCache } from "../hooks/useIntralineSegmentCache.js";
import { useRowsCut } from "../hooks/useRowsCut.js";
import { useVisibleFlowHeight } from "../hooks/useVisibleFlowHeight.js";
import { DIFF_ROW_HEIGHT_PX } from "../measures.js";
import type { DiffFile, DiffModel } from "../model.js";
import { DiffRowIndex } from "../rows/flat-index.js";
import { DiffRowView } from "./DiffRowView.js";

/** What one file's block is drawn from: the diff it belongs to and the file. */
export interface InlineDiffBlockProps {
  readonly diff: DiffModel;
  readonly file: DiffFile;
}

/** One file's rows in the flow, cut at a third of the visible flow, and its footer. */
export function InlineDiffBlock(props: InlineDiffBlockProps): React.JSX.Element {
  // The block's own one-file model, so two files of the same path each keep their own rows.
  const fileModel = useMemo<DiffModel>(
    () => ({ baseRef: props.diff.baseRef, headRef: props.diff.headRef, files: [props.file] }),
    [props.diff.baseRef, props.diff.headRef, props.file],
  );
  const { expansion, expandGapAt } = useDiffModelViewState(fileModel);
  const index = useMemo(
    () => new DiffRowIndex(fileModel, expansion, undefined, "unified"),
    [fileModel, expansion],
  );
  const intraline = useIntralineSegmentCache(fileModel);
  const [blockElement, setBlockElement] = useState<HTMLElement | null>(null);
  const flowHeightPx = useVisibleFlowHeight(blockElement);
  const [isShowingAll, setIsShowingAll] = useState(false);
  const [rowsElement, setRowsElement] = useState<HTMLDivElement | null>(null);

  // Rows are at least a row tall, so no row past the fitting count can start above the cut.
  const fittingRowCount =
    flowHeightPx === undefined
      ? 0
      : Math.max(1, Math.floor(flowHeightPx / FLOW_SHARE_DIVISOR / DIFF_ROW_HEIGHT_PX));
  const drawnRowCount = isShowingAll ? index.rowCount : Math.min(index.rowCount, fittingRowCount);
  const cutHeightPx = isShowingAll ? undefined : fittingRowCount * DIFF_ROW_HEIGHT_PX;

  const rows: React.JSX.Element[] = [];
  let lineCount = 0;
  for (let rowIndex = 0; rowIndex < index.rowCount; rowIndex += 1) {
    const row = index.rowAt(rowIndex);
    if (row === undefined) {
      continue;
    }
    if (row.kind === "line") {
      lineCount += 1;
    }
    if (rowIndex < drawnRowCount) {
      rows.push(
        <DiffRowView
          key={rowIndex}
          rowIndex={rowIndex}
          row={row}
          index={index}
          intraline={intraline}
          viewMode="unified"
          onExpandGap={expandGapAt}
        />,
      );
    }
  }
  const { isCut, drawnLineCount } = useRowsCut(
    rowsElement,
    cutHeightPx,
    lineCount,
    drawnRowCount < index.rowCount,
  );

  return (
    // No section or footer: either can be a landmark, one per file in the conversation.
    <div className="meridian-diff-block" ref={setBlockElement}>
      <div
        ref={setRowsElement}
        className={`meridian-diff-block__rows meridian-focus-inset${isCut ? " meridian-diff-block__rows--cut" : ""}`}
        role="table"
        aria-label={`Diff of ${props.file.path}`}
        aria-rowcount={index.rowCount}
        tabIndex={-1}
        // The row height has one home, `measures.ts`; the rows' sheet reads it from here.
        style={
          {
            "--meridian-diff-row-height": `${String(DIFF_ROW_HEIGHT_PX)}px`,
            ...(cutHeightPx === undefined ? {} : { maxBlockSize: cutHeightPx }),
          } as React.CSSProperties
        }
      >
        {rows}
      </div>
      <div className="meridian-diff-block__footer">
        <span>{`${formatCount(drawnLineCount)} of ${formatCount(lineCount)} ${lineCount === 1 ? "line" : "lines"}`}</span>
        {isCut ? (
          <>
            <span className="meridian-diff-block__separator" aria-hidden="true">
              ·
            </span>
            <button
              type="button"
              className="meridian-diff-card__control"
              onClick={() => {
                setIsShowingAll(true);
                // The control leaves with the cut, so focus goes to the rows it opened rather
                // than to the page; `preventScroll` keeps the rows above where they were.
                rowsElement?.focus({ preventScroll: true });
              }}
            >
              Show all
            </button>
          </>
        ) : null}
        {props.file.patch === undefined ? null : <PatchCopy patch={props.file.patch} />}
      </div>
    </div>
  );
}

/** How much of the visible flow a block's rows take before the cut: a third. */
const FLOW_SHARE_DIVISOR = 3;

/** The footer's copy of the file's whole patch, after its separator. */
function PatchCopy(props: { readonly patch: string }): React.JSX.Element {
  const clipboardCopy = useClipboardCopy({ text: props.patch });
  return (
    <>
      <span className="meridian-diff-block__separator" aria-hidden="true">
        ·
      </span>
      <CopyButton label="Copy patch" clipboardCopy={clipboardCopy} />
    </>
  );
}
