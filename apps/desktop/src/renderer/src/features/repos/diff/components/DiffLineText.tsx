import { type DiffLine, type DiffLineKind } from "../model.js";
import {
  DIFF_FLOW_SIGNS,
  DIFF_LINE_KIND_LABELS,
  DIFF_NO_NEWLINE_AT_END_LABEL,
} from "../rows/row-text.js";
import type { IntralineReading } from "../intraline/segment-cache.js";

/**
 * The sign, then the line's segments. One implementation for both looks: Review's marker column,
 * or the flow's one-character sign cell with its typographic minus, drawn straight into the row's
 * cell so a long diff mounts fewer elements per line.
 */
export function DiffLineText(props: {
  readonly line: DiffLine;
  readonly reading: IntralineReading;
  readonly look: "review" | "flow";
}): React.JSX.Element {
  const { line } = props;
  const parts = (
    <>
      <span
        className={props.look === "flow" ? "meridian-diff__sign" : "meridian-diff__marker"}
        aria-hidden="true"
      >
        {(props.look === "flow" ? DIFF_FLOW_SIGNS : REVIEW_MARKERS)[line.kind]}
      </span>
      <span className="meridian-visually-hidden">{DIFF_LINE_KIND_LABELS[line.kind]}</span>
      <code className="meridian-diff__code">
        {props.reading.segments.map((segment, segmentIndex) =>
          // An unchanged run is the code's own text; only a changed run needs an element of its
          // own. Segments have no identity and never reorder (the list is rebuilt whole), so the
          // position is the key.
          segment.changed ? (
            <span key={segmentIndex} className="meridian-diff__segment--changed">
              {segment.text}
            </span>
          ) : (
            segment.text
          ),
        )}
      </code>
      {line.noNewlineAtEnd === true ? (
        <span className="meridian-diff__no-newline">{DIFF_NO_NEWLINE_AT_END_LABEL}</span>
      ) : null}
    </>
  );
  return props.look === "flow" ? parts : <span className="meridian-diff__text">{parts}</span>;
}

const REVIEW_MARKERS: Readonly<Record<DiffLineKind, string>> = {
  context: " ",
  insert: "+",
  delete: "-",
};
