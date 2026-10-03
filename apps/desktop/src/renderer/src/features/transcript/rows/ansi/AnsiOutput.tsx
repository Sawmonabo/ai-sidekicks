// Command output: the spans `ansi-spans.ts` produced, as elements in a `<pre>` because the
// output is preformatted. The one piece of state is the fold: `ANSI_SPAN_RENDER_CAP` withholds
// the tail of a color-heavy log, so a control lifts the cap for this block, keyed to the source
// it was granted for so a changed body returns to the default.

import { useMemo, useState } from "react";

import { ANSI_SPAN_RENDER_CAP } from "./ansi-spans.js";
import { Nothing } from "@renderer/components/Nothing/Nothing.js";
import { formatCount } from "@renderer/lib/wire-figures.js";
import { ansiSpanClassNames, parseAnsiSpans } from "./ansi-spans.js";

import "./ansi.css";

/** The tool output to render and the label a screen reader gives its block. */
export interface AnsiOutputProps {
  /** The tool's output, wire-verbatim, escape sequences and all. */
  readonly source: string;
  /** What a screen reader calls this block. */
  readonly label: string;
}

/** Renders ANSI-styled command output, with a control to show the spans past the render cap. */
export function AnsiOutput(props: AnsiOutputProps): React.JSX.Element {
  const [revealed, setRevealed] = useState<RevealedSpanCap>({
    source: props.source,
    spanCap: ANSI_SPAN_RENDER_CAP,
  });
  // Derived during render rather than reset by an effect, which would flash the previous
  // source's reveal for a frame.
  const spanCap = revealed.source === props.source ? revealed.spanCap : ANSI_SPAN_RENDER_CAP;
  const { spans, elidedSpanCount } = useMemo(
    () => parseAnsiSpans(props.source, spanCap),
    [props.source, spanCap],
  );

  return (
    <div className="meridian-ansi">
      <pre className="meridian-ansi__body" aria-label={props.label}>
        {spans.map((span, index) => {
          const classNames = ansiSpanClassNames(span);
          // The index is in the key because identical adjacent runs are distinct; the text is in
          // it so a re-parse that shifts a boundary does not reuse a node whose content changed.
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
          // One sentence carries both figures: an inline badge shows `detail` only as a hover
          // title, and the counts are the substance of the notice. The badge still fits because
          // the output it qualifies is present.
          title={`Showing ${formatCount(spans.length)} styled runs; ${formatCount(elidedSpanCount)} more are not shown.`}
          action={
            <button
              type="button"
              // The transcript's retry control, already the shape a `Nothing` action takes here.
              className="meridian-transcript-retry"
              onClick={() => {
                setRevealed({ source: props.source, spanCap: spans.length + elidedSpanCount });
              }}
            >
              Show the rest
            </button>
          }
        />
      ) : null}
    </div>
  );
}

/** The cap this block is rendering under, and the source it was granted for. */
interface RevealedSpanCap {
  readonly source: string;
  readonly spanCap: number;
}
