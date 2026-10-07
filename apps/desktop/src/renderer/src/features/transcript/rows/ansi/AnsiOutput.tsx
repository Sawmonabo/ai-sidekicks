// Command output: the spans `spans.ts` parses from the output's handle, as elements in a `<pre>`
// because the output is preformatted. The block keeps one parser, so a streaming output is parsed
// only past what earlier revisions parsed. The other piece of state is the fold:
// `ANSI_SPAN_RENDER_CAP` withholds the tail of a color-heavy log, so a control lifts the cap for
// this block, keyed to the handle and revision it was granted for so a changed body returns to the
// default.

import { useMemo, useState } from "react";

import { ANSI_SPAN_RENDER_CAP } from "./spans.js";
import { Nothing } from "#renderer/components/Nothing/Nothing.js";
import { formatCount } from "#renderer/lib/wire/figures.js";
import { type PublishedText } from "../../reveal/published-text.js";
import { AnsiSpanParser, ansiSpanClassNames } from "./spans.js";

import "./AnsiOutput.css";

/** The tool output to render and the label a screen reader gives its block. */
export interface AnsiOutputProps {
  /** The tool's output, wire-verbatim, escape sequences and all, read through its handle. */
  readonly publishedText: PublishedText;
  /** What a screen reader calls this block. */
  readonly label: string;
}

/** Renders ANSI-styled command output, with a control to show the spans past the render cap. */
export function AnsiOutput(props: AnsiOutputProps): React.JSX.Element {
  const publishedText = props.publishedText;
  const revision = publishedText.revision;
  const [parser] = useState(() => new AnsiSpanParser());
  const [revealed, setRevealed] = useState<RevealedSpanCap>({
    publishedText,
    revision,
    spanCap: ANSI_SPAN_RENDER_CAP,
  });
  // Derived during render rather than reset by an effect, which would flash the previous
  // text's reveal for a frame.
  const spanCap =
    revealed.publishedText === publishedText && revealed.revision === revision
      ? revealed.spanCap
      : ANSI_SPAN_RENDER_CAP;
  const { spans, elidedSpanCount } = useMemo(
    () => parser.read(publishedText, spanCap),
    // The handle stays the same while a streaming output grows; its revision is what changed.
    [parser, publishedText, revision, spanCap],
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
          // One sentence carries both figures: an inline badge shows `detail` only in its hover
          // label, and the counts are the substance of the notice. The badge still fits because
          // the output it qualifies is present.
          title={[
            "Showing ",
            { derived: formatCount(spans.length) },
            " styled runs; ",
            { derived: formatCount(elidedSpanCount) },
            " more are not shown.",
          ]}
          action={
            <button
              type="button"
              // The transcript's retry control, already the shape a `Nothing` action takes here.
              className="meridian-transcript-retry"
              onClick={() => {
                setRevealed({
                  publishedText,
                  revision,
                  spanCap: spans.length + elidedSpanCount,
                });
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

/** The cap this block is rendering under, and the text and revision it was granted for. */
interface RevealedSpanCap {
  readonly publishedText: PublishedText;
  readonly revision: number;
  readonly spanCap: number;
}
