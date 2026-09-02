// Command output — ANSI spans, rendered.
//
// `Spec-023 §Console Design (Meridian)` §5.9 names command output as one of the tool
// card's bodies. The whole of the styling decision lives in `ansi-spans.ts`; this
// component turns the spans it produced into elements and does nothing else, which is
// what keeps the mapper testable without a DOM and this file short enough to read.
//
// A `<pre>` and not a `<div>`: command output is preformatted by definition, and the
// element that says so is the one screen readers and copy-paste both already honour.
// The mono face comes from `ledger.css`, which reads the same type token every wire
// figure in the console reads.

import { useMemo } from "react";

import { Nothing } from "../../primitives/index.js";
import { ansiSpanClassNames, parseAnsiSpans } from "./ansi-spans.js";

export interface AnsiOutputProps {
  /** The tool's output, wire-verbatim, escape sequences and all. */
  readonly source: string;
  /** What a screen reader calls this block. */
  readonly label: string;
}

export function AnsiOutput(props: AnsiOutputProps): React.JSX.Element {
  const { spans, elidedSpanCount } = useMemo(() => parseAnsiSpans(props.source), [props.source]);

  return (
    <div className="meridian-ansi">
      <pre className="meridian-ansi__body" aria-label={props.label}>
        {spans.map((span, index) => {
          const classNames = ansiSpanClassNames(span);
          // The index is part of the key rather than the whole of it because two runs
          // of identical text with identical styling are genuinely two runs; the text
          // is in the key so a re-parse that shifts a boundary does not reuse a node
          // whose content changed.
          return (
            <span key={`${String(index)}:${span.text}`} className={classNames.join(" ")}>
              {span.text}
            </span>
          );
        })}
      </pre>
      {elidedSpanCount > 0 ? (
        <Nothing
          kind="empty"
          placement="inline"
          title="This output is longer than the card renders."
          detail={`${String(elidedSpanCount)} further styled runs are not shown.`}
        />
      ) : null}
    </div>
  );
}
