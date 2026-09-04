// One row of a diff, in either layout — and the two-hue rule applied to the one
// surface in the console that is traditionally painted red and green.
//
// WHY NOT RED AND GREEN. `Spec-023 §Meridian, the design language` rule 3, the
// two-hue rule: "Amber means a person is needed. Red means something failed.
// Nothing else is colored for attention." A deleted line is not a failure and an inserted line is
// not a success, so neither may spend a hue — and a diff that spent red on
// deletions would make every large change set look like an incident, which is
// exactly the legibility the rule exists to protect. Meridian's answer uses three
// signals that are not hue and that survive both schemes and colour blindness:
//
//   • the SIGN, in the marker column, in mono at full text weight — the signal a
//     patch file itself uses, and the only one that is unambiguous;
//   • the GROUND weight — an insertion sits on a lighter tint of the surface, a
//     deletion on a heavier one, both mixed from `--meridian-text` so the pair
//     tracks the scheme rather than being two greys chosen by hand;
//   • the RULE on the marker column — solid for an insertion, dashed for a
//     deletion, which is the signal that survives a screenshot in greyscale.
//
// INTRALINE IS ASKED FOR, NEVER COMPUTED HERE. `intraline-segments.ts` owns the
// word diff and its bounds; this file asks it for the segmentation of the line
// each cell is drawing and renders spans. The cache is what makes that safe on a
// scroll: it is keyed by hunk and line index, so a row asked for on every scroll
// tick is computed once — and where a pair is too long to compare, the reading
// says so and the cell draws the note beside the whole line rather than a
// highlight the console did not make.
//
// THE ROW IS MEMOISED because a five-thousand-row change set re-renders its whole
// window on every scroll tick otherwise, and the window is the only thing that
// changed. The props are all primitives or stable references, so the default
// shallow comparison is the correct one.

import { memo } from "react";

import { Glyph, Nothing } from "../../primitives/index.js";
import {
  diffFileChangeNotes,
  type DiffLine,
  type DiffLineKind,
  type DiffViewMode,
} from "./diff-model.js";
import type { DiffRow, DiffRowIndex } from "./hunk-virtualization.js";
import type { IntralineReading, IntralineSegmentCache } from "./intraline-segments.js";

/** The marker each line kind carries, and the class its ground is painted by. */
const LINE_KIND_MARKERS: Readonly<Record<DiffLineKind, string>> = {
  context: " ",
  insert: "+",
  delete: "-",
};

/** How each line kind is announced, so the marker is not the only carrier. */
const LINE_KIND_LABELS: Readonly<Record<DiffLineKind, string>> = {
  context: "unchanged",
  insert: "added",
  delete: "removed",
};

/** Glyph edge length in a diff row's chrome, matching the primitives' own inline size. */
const DIFF_ROW_GLYPH_SIZE = 12;

/** Glyph edge length in the gutter, where the mark sits beside a line number. */
const DIFF_GUTTER_GLYPH_SIZE = 10;

/**
 * What the badge on an over-bound line says when a reader hovers it.
 *
 * SAID RATHER THAN LEFT BLANK. A line drawn with no highlight is what a line with no
 * intraline change looks like, so a row whose comparison was declined for size and
 * said nothing would be the console reporting "nothing changed inside this line" about
 * a line it never compared.
 */
const INTRALINE_SKIPPED_DETAIL =
  "This line is longer than the word-level comparison is run for, so the whole line is marked changed rather than the words within it.";

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

/**
 * One side of a split row.
 *
 * THE GROUND WEIGHT IS PAINTED HERE AND NOT ON THE ROW. A paired row holds a
 * deletion and an insertion at once, so a single modifier on the row would have
 * to name one of two kinds — and would paint the whole width in it. The kind
 * modifier rides the CELL, in both layouts, so the unified row keeps exactly the
 * ground it had (its one cell fills the row) and a split row paints each side
 * its own.
 *
 * An absent line renders an empty cell that still occupies its gutter, so the
 * two sides stay in column even where only one of them has a line.
 */
function DiffSplitCell(props: {
  readonly line: DiffLine | undefined;
  /** Absent exactly where the line is: an empty cell has nothing to segment. */
  readonly reading: IntralineReading | undefined;
  readonly side: "base" | "head";
  readonly showAttributionMarks: boolean;
  readonly showWhitespaceChanges: boolean;
}): React.JSX.Element {
  const { line } = props;
  const className = [
    "meridian-diff__side",
    `meridian-diff__side--${props.side}`,
    line === undefined ? "" : `meridian-diff__side--${line.kind}`,
  ]
    .filter((part) => part !== "")
    .join(" ");
  const { reading } = props;
  if (line === undefined || reading === undefined) {
    return (
      <span className={className} role="cell">
        <span className="meridian-diff__gutter" />
        <span className="meridian-diff__text" />
      </span>
    );
  }
  return (
    <span className={className} role="cell">
      <DiffGutter line={line} side={props.side} showAttributionMarks={props.showAttributionMarks} />
      <DiffLineText
        line={line}
        reading={reading}
        showWhitespaceChanges={props.showWhitespaceChanges}
      />
    </span>
  );
}

/**
 * The line-number gutter, and the attribution mark when the trailers named
 * somebody.
 *
 * The mark is a glyph with a hover card rather than a name in the gutter, because
 * a name in the gutter costs the measure the diff's content needs, and
 * `DiffToolbar.tsx` puts per-line attribution behind a toggle rather than in the
 * default reading.
 * It is `aria-hidden` only when it is decoration; when it is on, it carries the
 * agent's name as its accessible name so the hover card is not the only way to it.
 */
function DiffGutter(props: {
  readonly line: DiffLine;
  readonly side: "base" | "head";
  readonly showAttributionMarks: boolean;
}): React.JSX.Element {
  const lineNumber = props.side === "base" ? props.line.baseLineNumber : props.line.headLineNumber;
  const attribution = props.line.agentAttribution;
  const showMark = props.showAttributionMarks && attribution !== undefined;
  return (
    <span className="meridian-diff__gutter">
      <span className="meridian-diff__line-number">
        {lineNumber === undefined ? "" : String(lineNumber)}
      </span>
      {showMark && attribution !== undefined ? (
        <span
          className="meridian-diff__attribution-mark"
          title={`${attribution.agentName} — ${attribution.agentRunId}`}
        >
          <Glyph
            name="agent"
            size={DIFF_GUTTER_GLYPH_SIZE}
            title={`Attributed to ${attribution.agentName}`}
          />
        </span>
      ) : null}
    </span>
  );
}

/**
 * The marker, then the line's segments. One implementation for both layouts.
 *
 * With whitespace changes off, a changed segment whose text is entirely
 * whitespace renders as carried-over: the segment is still drawn, so the line's
 * characters are all present and the column positions are unmoved, and only the
 * emphasis is withheld. Dropping the segment instead would silently shorten the
 * line, which is a diff lying about its content to honour a view preference.
 */
function DiffLineText(props: {
  readonly line: DiffLine;
  readonly reading: IntralineReading;
  readonly showWhitespaceChanges: boolean;
}): React.JSX.Element {
  return (
    <span className="meridian-diff__text">
      <span className="meridian-diff__marker" aria-hidden="true">
        {LINE_KIND_MARKERS[props.line.kind]}
      </span>
      <span className="meridian-visually-hidden">{LINE_KIND_LABELS[props.line.kind]}</span>
      <code className="meridian-diff__code">
        {props.reading.segments.map((segment, segmentIndex) => (
          <span
            // Segments have no identity of their own and never reorder — the list
            // is rebuilt whole whenever the line changes — so the position IS the
            // key, and inventing one would be a claim about stability nothing
            // upstream makes.
            key={segmentIndex}
            className={
              segment.changed && (props.showWhitespaceChanges || segment.text.trim() !== "")
                ? "meridian-diff__segment meridian-diff__segment--changed"
                : undefined
            }
          >
            {segment.text}
          </span>
        ))}
      </code>
      {props.reading.skipped ? (
        <span className="meridian-diff__intraline-skipped">
          <Nothing
            kind="not-checked"
            placement="inline"
            title="No word-level comparison"
            detail={INTRALINE_SKIPPED_DETAIL}
          />
        </span>
      ) : null}
    </span>
  );
}
