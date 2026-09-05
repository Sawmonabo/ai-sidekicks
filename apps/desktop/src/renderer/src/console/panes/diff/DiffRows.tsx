import { memo } from "react";
import { Glyph } from "../../primitives/index.js";
import { diffFileChangeNotes, type DiffViewMode } from "./diff-model.js";
import type { DiffRow, DiffRowIndex } from "./hunk-virtualization.js";
import type { IntralineSegmentCache } from "./intraline-segments.js";
import { DiffSplitCell } from "./DiffSplitCell.js";
import { DiffGutter } from "./DiffGutter.js";
import { DiffLineText } from "./DiffLineText.js";

/** Glyph edge length in a diff row's chrome, matching the primitives' own inline size. */
const DIFF_ROW_GLYPH_SIZE = 12;

export interface DiffRowViewProps {
  readonly rowIndex: number;
  readonly row: DiffRow;
  readonly index: DiffRowIndex;
  /**
   * Where this row's word-level segmentation comes from.
   *
   * Held per MODEL rather than per index, so a gap expansion — which builds a new
   * index and changes no line's text — keeps everything already computed.
   */
  readonly intraline: IntralineSegmentCache;
  readonly viewMode: DiffViewMode;
  readonly showAttributionMarks: boolean;
  readonly showWhitespaceChanges: boolean;
  /** Reveal one more band of this row's gap. Only a `gap` row calls it. */
  readonly onExpandGap: (fileIndex: number, hunkIndex: number) => void;
  /**
   * The virtualizer's measurement callback, in wrap mode only.
   *
   * Absent, the row is left to the fixed estimate the sheet also paints it at.
   * Present, the row reports its own height — which is what a wrapped line three
   * lines tall has to do for the offsets below it to be true. It is one stable
   * function for the life of the virtualizer, so the memo above still holds.
   */
  readonly rowElementRef?: ((element: HTMLDivElement | null) => void) | undefined;
}

export const DiffRowView: React.MemoExoticComponent<
  (props: DiffRowViewProps) => React.JSX.Element
> = memo(function DiffRowView(props: DiffRowViewProps): React.JSX.Element {
  const { row, index, rowIndex } = props;
  // `data-index` is the virtualizer's own contract for a measured node: it reads
  // the row's index back off the element it was handed, so the attribute rides
  // every row rather than only the wrapped ones — an attribute that appears and
  // disappears with a view toggle is one more thing to get wrong, and it paints
  // nothing either way.
  const rowProps = {
    role: "row",
    "aria-rowindex": rowIndex + 1,
    "data-index": rowIndex,
    ref: props.rowElementRef,
  } as const;

  if (row.kind === "file-header") {
    const file = index.model.files[row.fileIndex];
    // What the patch's extended headers said, where they said anything. A
    // rename-only, copy-only, mode-only, or binary file has no hunks at all, so this
    // row is the ONLY row it has and the note is the only place its change appears.
    const changeNotes = file === undefined ? [] : diffFileChangeNotes(file);
    return (
      <div {...rowProps} className="meridian-diff__row meridian-diff__row--file">
        <span className="meridian-diff__file-path" role="cell" title={file?.path}>
          <Glyph name="diff" size={DIFF_ROW_GLYPH_SIZE} />
          {file?.path ?? ""}
          {changeNotes.length === 0 ? null : (
            <span className="meridian-diff__file-change">{changeNotes.join(", ")}</span>
          )}
        </span>
      </div>
    );
  }

  if (row.kind === "hunk-header") {
    const hunk = index.model.files[row.fileIndex]?.hunks[row.hunkIndex];
    return (
      <div {...rowProps} className="meridian-diff__row meridian-diff__row--hunk">
        {/* Wire-verbatim: an `@@` header is the daemon's own string and the
            console neither re-parses nor re-renders its numbers. */}
        <span className="meridian-diff__hunk-header" role="cell">
          {hunk?.header ?? ""}
        </span>
      </div>
    );
  }

  if (row.kind === "gap") {
    return (
      <div {...rowProps} className="meridian-diff__row meridian-diff__row--gap">
        <span role="cell">
          <button
            type="button"
            className="meridian-diff__gap-button"
            onClick={() => {
              props.onExpandGap(row.fileIndex, row.hunkIndex);
            }}
          >
            <Glyph name="more" size={DIFF_ROW_GLYPH_SIZE} />
            {`Expand ${String(row.hiddenLineCount)} hidden lines`}
          </button>
        </span>
      </div>
    );
  }

  const line = index.lineFor(row);
  if (line === undefined) {
    // Unreachable while the index and the model agree, and rendered rather than
    // thrown: a row that cannot find its line is a defect in the flattening, and
    // a blank row with a stable height keeps the rest of the diff readable while
    // it is diagnosed.
    return <div {...rowProps} className="meridian-diff__row meridian-diff__row--line" />;
  }

  const reading = props.intraline.readingFor(row, row.lineIndex);
  if (props.viewMode === "split") {
    // WHICH LINE EACH SIDE HOLDS FOLLOWS FROM THE ROW, and the row was paired by
    // the flattening. A deletion occupies the base side and carries its paired
    // insertion — if the index found one — on the head side; an insertion that
    // paired with nothing occupies the head side alone; a context line occupies
    // both. So the two cells can carry DIFFERENT text, which is the one thing
    // split view exists to show.
    const pairedLine = index.pairedLineFor(row);
    // The head cell of a paired deletion draws the INSERTION, so it asks for that
    // line's own reading — the two sides of one comparison, taken from one cache by
    // the two addresses the flattening paired.
    const pairedReading =
      pairedLine === undefined || row.pairedLineIndex === undefined
        ? undefined
        : props.intraline.readingFor(row, row.pairedLineIndex);
    return (
      <div {...rowProps} className="meridian-diff__row meridian-diff__row--line">
        <DiffSplitCell
          line={line.kind === "insert" ? undefined : line}
          reading={reading}
          side="base"
          showAttributionMarks={props.showAttributionMarks}
          showWhitespaceChanges={props.showWhitespaceChanges}
        />
        <DiffSplitCell
          line={line.kind === "delete" ? pairedLine : line}
          reading={line.kind === "delete" ? pairedReading : reading}
          side="head"
          showAttributionMarks={props.showAttributionMarks}
          showWhitespaceChanges={props.showWhitespaceChanges}
        />
      </div>
    );
  }

  return (
    <div {...rowProps} className="meridian-diff__row meridian-diff__row--line">
      {/* One cell, not three: `role="row"` admits only cells as children, and the
          gutters are part of the line rather than columns a reader navigates. */}
      <span
        className={`meridian-diff__side meridian-diff__side--unified meridian-diff__side--${line.kind}`}
        role="cell"
      >
        <DiffGutter line={line} side="base" showAttributionMarks={props.showAttributionMarks} />
        <DiffGutter line={line} side="head" showAttributionMarks={false} />
        <DiffLineText
          line={line}
          reading={reading}
          showWhitespaceChanges={props.showWhitespaceChanges}
        />
      </span>
    </div>
  );
});
