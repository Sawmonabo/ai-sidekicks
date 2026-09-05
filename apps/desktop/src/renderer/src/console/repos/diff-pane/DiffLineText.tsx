import { Nothing } from "../../primitives/index.js";
import { type DiffLine, type DiffLineKind } from "./diff-model.js";
import type { IntralineReading } from "./intraline-segments.js";

/**
 * The marker, then the line's segments. One implementation for both layouts.
 *
 * With whitespace changes off, a changed segment whose text is entirely
 * whitespace renders as carried-over: the segment is still drawn, so the line's
 * characters are all present and the column positions are unmoved, and only the
 * emphasis is withheld. Dropping the segment instead would silently shorten the
 * line, which is a diff lying about its content to honour a view preference.
 */
export function DiffLineText(props: {
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
      {props.line.noNewlineAtEnd === true ? (
        <span className="meridian-diff__no-newline">{NO_NEWLINE_AT_END_LABEL}</span>
      ) : null}
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

/** The marker each line kind carries, and the class its ground is painted by. */
export const LINE_KIND_MARKERS: Readonly<Record<DiffLineKind, string>> = {
  context: " ",
  insert: "+",
  delete: "-",
};

/** How each line kind is announced, so the marker is not the only carrier. */
export const LINE_KIND_LABELS: Readonly<Record<DiffLineKind, string>> = {
  context: "unchanged",
  insert: "added",
  delete: "removed",
};

/**
 * What the patch's own terminator marker says, beside the line it annotates.
 *
 * THE PATCH'S SENTENCE WITHOUT THE FORMAT'S PREFIX. A unified patch writes
 * `\ No newline at end of file`, where the leading `\` is the format's way of saying
 * "this is an annotation and not a line" — a job the row already does by drawing it
 * inside the line rather than under it. The words are kept because they are the ones
 * every other diff tool a reader has used says, and because on a newline-only change
 * they are the ONLY thing that distinguishes the two rows.
 */
export const NO_NEWLINE_AT_END_LABEL = "No newline at end of file";

/**
 * What the badge on an over-bound line says when a reader hovers it.
 *
 * SAID RATHER THAN LEFT BLANK. A line drawn with no highlight is what a line with no
 * intraline change looks like, so a row whose comparison was declined for size and
 * said nothing would be the console reporting "nothing changed inside this line" about
 * a line it never compared.
 */
export const INTRALINE_SKIPPED_DETAIL =
  "This line is longer than the word-level comparison is run for, so the whole line is marked changed rather than the words within it.";
