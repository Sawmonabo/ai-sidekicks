import { memo, useSyncExternalStore } from "react";
import { GLYPH_SIZE_ROW } from "#renderer/styles/glyphs.js";
import { Glyph } from "#renderer/components/Glyph/Glyph.js";
import { formatCount } from "#renderer/lib/wire/figures.js";
import { diffFileChangeNotes, diffFileUnshownReason, type DiffViewMode } from "../model.js";
import type { DiffRow } from "../rows/model.js";
import type { DiffRowIndex } from "../rows/flat-index.js";
import type { IntralineSegmentCache } from "../intraline/segment-cache.js";
import { DiffSplitCell } from "./DiffSplitCell.js";
import { DiffGutter } from "./DiffGutter.js";
import { DiffLineText } from "./DiffLineText.js";
import { DiffStepMark } from "./DiffStepMark.js";
import { diffFlowLineNumber } from "../rows/flow.js";

/**
 * How a row is drawn, and what that look needs. Review's rows carry both sides' numbers and a gap
 * a person can open; the conversation's flow draws one gutter of the new file's numbers, a sign
 * cell, and a quiet separator where lines are skipped, which nothing opens.
 */
export type DiffRowLook =
  | {
      readonly look: "review";
      /** Reveal one more band of this row's gap. Only a `gap` row calls it. */
      readonly onExpandGap: (fileIndex: number, hunkIndex: number) => void;
      /** Figures each line-number column of this row's file is wide. */
      readonly gutterDigitCount: number;
    }
  | { readonly look: "flow" };

/** What one diff row is drawn from. */
export type DiffRowViewProps = DiffRowFacts & DiffRowLook;

/** What every diff row is drawn from, whatever its look. */
export interface DiffRowFacts {
  readonly rowIndex: number;
  readonly row: DiffRow;
  readonly index: DiffRowIndex;
  /**
   * Where this row's word-level segmentation comes from. Held per model, not per index, so a
   * gap expansion keeps everything already computed.
   */
  readonly intraline: IntralineSegmentCache;
  readonly viewMode: DiffViewMode;
  /**
   * The virtualizer's measurement callback, where a window draws the row: each row reports its
   * own height so offsets stay true under wrapped lines. Stable for the virtualizer's life, so
   * the memo holds. Absent where every row is drawn in the flow.
   */
  readonly rowElementRef?: (element: HTMLDivElement | null) => void;
}

/** One diff row, memoized so a scroll re-renders only the rows that entered a window. */
export const DiffRowView: React.MemoExoticComponent<
  (props: DiffRowViewProps) => React.JSX.Element
> = memo(function DiffRowView(props: DiffRowViewProps): React.JSX.Element {
  const { row, index, rowIndex } = props;
  // A long pair's marks land after the row first draws; reading the landing re-renders this row
  // alone when they do.
  useSyncExternalStore(props.intraline.subscribe, () => props.intraline.landingFor(row));
  // `data-index` is the virtualizer's contract for a measured node; it paints nothing.
  const rowProps: RowElementProps = {
    role: "row",
    "aria-rowindex": rowIndex + 1,
    "data-index": rowIndex,
    ref: props.rowElementRef,
  } as const;

  if (row.kind === "file-header") {
    const file = index.model.files[row.fileIndex];
    // The patch's extended-header kind words. A rename-only, copy-only or mode-only file has no
    // hunks, so in Review this row is the only place its change appears; the flow writes such a
    // file's notes where its lines would be instead (`InlineDiffBlock.tsx`).
    const changeNotes =
      file === undefined || (props.look === "flow" && file.hunks.length === 0)
        ? []
        : diffFileChangeNotes(file);
    return (
      <div {...rowProps} className="meridian-diff__row meridian-diff__row--file">
        <span className="meridian-diff__file-path" role="cell">
          <Glyph name="diff" size={GLYPH_SIZE_ROW} />
          {file?.path ?? ""}
          {file?.stepName === undefined ? null : <DiffStepMark stepName={file.stepName} />}
          {changeNotes.length === 0 ? null : (
            <span className="meridian-diff__file-change">{changeNotes.join(", ")}</span>
          )}
        </span>
      </div>
    );
  }

  if (row.kind === "unshown-reason") {
    const file = index.model.files[row.fileIndex];
    return (
      <div {...rowProps} className="meridian-diff__row meridian-diff__row--unshown">
        <span role="cell">{file === undefined ? "" : diffFileUnshownReason(file)}</span>
      </div>
    );
  }

  if (row.kind === "hunk-header") {
    if (props.look === "flow") {
      return <FlowSeparatorRow rowProps={rowProps} />;
    }
    const hunk = index.model.files[row.fileIndex]?.hunks[row.hunkIndex];
    return (
      <div {...rowProps} className="meridian-diff__row meridian-diff__row--hunk">
        {/* Wire-verbatim: the `@@` header is the daemon's string and its numbers are not
            re-parsed. */}
        <span role="cell">{hunk?.header ?? ""}</span>
      </div>
    );
  }

  if (row.kind === "gap") {
    if (props.look === "flow") {
      return <FlowSeparatorRow rowProps={rowProps} />;
    }
    const { onExpandGap } = props;
    return (
      <div {...rowProps} className="meridian-diff__row meridian-diff__row--gap">
        <span role="cell">
          <button
            type="button"
            className="meridian-diff__gap-button"
            onClick={() => {
              onExpandGap(row.fileIndex, row.hunkIndex);
            }}
          >
            <Glyph name="more" size={GLYPH_SIZE_ROW} />
            {`Expand ${formatCount(row.hiddenLineCount)} hidden lines`}
          </button>
        </span>
      </div>
    );
  }

  const line = index.lineFor(row);
  const reading = props.intraline.readingFor(row, row.lineIndex);
  if (props.look === "flow") {
    const lineNumber = diffFlowLineNumber(line);
    return (
      <div {...rowProps} className="meridian-diff__row meridian-diff__row--line">
        <span
          className={`meridian-diff__side meridian-diff__side--flow meridian-diff__side--${line.kind}`}
          role="cell"
        >
          <span className="meridian-diff__flow-gutter">
            {lineNumber === undefined ? "" : String(lineNumber)}
          </span>
          <DiffLineText line={line} reading={reading} look="flow" />
        </span>
      </div>
    );
  }
  // The file's gutter width, which the columns' sheet reads; both halves of a split row take it.
  const gutterStyle = {
    "--meridian-diff-gutter-digits": String(props.gutterDigitCount),
  } as React.CSSProperties;
  if (props.viewMode === "split") {
    // The flattening paired the row: a deletion fills the base side and carries its paired
    // insertion, if any, on the head side; an unpaired insertion fills the head alone; context
    // fills both. So the two cells can carry different text, which split view exists to show.
    const pairedLine = index.pairedLineFor(row);
    // The head cell of a paired deletion draws the insertion, so it takes that line's own
    // reading from the same cache.
    const pairedReading =
      pairedLine === undefined || row.pairedLineIndex === undefined
        ? undefined
        : props.intraline.readingFor(row, row.pairedLineIndex);
    return (
      <div
        {...rowProps}
        className="meridian-diff__row meridian-diff__row--line"
        style={gutterStyle}
      >
        <DiffSplitCell
          line={line.kind === "insert" ? undefined : line}
          reading={reading}
          side="base"
        />
        <DiffSplitCell
          line={line.kind === "delete" ? pairedLine : line}
          reading={line.kind === "delete" ? pairedReading : reading}
          side="head"
        />
      </div>
    );
  }

  return (
    <div {...rowProps} className="meridian-diff__row meridian-diff__row--line" style={gutterStyle}>
      {/* One cell, not three: `role="row"` admits only cells, and the gutters belong to the
          line. */}
      <span
        className={[
          "meridian-diff__side",
          "meridian-diff__side--unified",
          `meridian-diff__side--${line.kind}`,
        ].join(" ")}
        role="cell"
      >
        <DiffGutter line={line} side="base" />
        <DiffGutter line={line} side="head" />
        <DiffLineText line={line} reading={reading} look="review" />
      </span>
    </div>
  );
});

/** What every row element carries: its role, its place among the rows, and its measurement. */
interface RowElementProps {
  readonly role: "row";
  readonly "aria-rowindex": number;
  readonly "data-index": number;
  readonly ref: ((element: HTMLDivElement | null) => void) | undefined;
}

/**
 * The flow's quiet separator where the file's lines are skipped: no number, no wash and nothing to
 * press, and never the hunk's own `@@` spelling.
 */
function FlowSeparatorRow(props: { readonly rowProps: RowElementProps }): React.JSX.Element {
  return (
    <div {...props.rowProps} className="meridian-diff__row meridian-diff__row--separator">
      <span className="meridian-diff__separator" role="cell">
        <span aria-hidden="true">⋯</span>
        <span className="meridian-visually-hidden">Lines skipped</span>
      </span>
    </div>
  );
}
