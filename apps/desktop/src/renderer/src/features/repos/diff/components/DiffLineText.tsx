import { type DiffLine, type DiffLineKind } from "../model.js";
import type { IntralineReading } from "../intraline/segment-cache.js";

/** The marker, then the line's segments. One implementation for both layouts. */
export function DiffLineText(props: {
  readonly line: DiffLine;
  readonly reading: IntralineReading;
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
            // Segments have no identity and never reorder (the list is rebuilt whole), so the
            // position is the key.
            key={segmentIndex}
            className={segment.changed ? "meridian-diff__segment--changed" : undefined}
          >
            {segment.text}
          </span>
        ))}
      </code>
      {props.line.noNewlineAtEnd === true ? (
        <span className="meridian-diff__no-newline">{NO_NEWLINE_AT_END_LABEL}</span>
      ) : null}
    </span>
  );
}

const LINE_KIND_MARKERS: Readonly<Record<DiffLineKind, string>> = {
  context: " ",
  insert: "+",
  delete: "-",
};

/** Announced text per line kind, so the marker is not the only carrier. */
const LINE_KIND_LABELS: Readonly<Record<DiffLineKind, string>> = {
  context: "unchanged",
  insert: "added",
  delete: "removed",
};

/**
 * The patch's `\ No newline at end of file` without the leading `\`, which the row already
 * conveys by drawing it inside the line. On a newline-only change it is the only thing that
 * tells the two rows apart.
 */
const NO_NEWLINE_AT_END_LABEL = "No newline at end of file";
