// Command output: the spans `spans.ts` parses from the output's handle, as elements in one output
// box, which a call's output takes cut at the visible flow until its opening is pressed. The block
// keeps one parser, so a streaming output is parsed only past what earlier revisions parsed.

import { useMemo, useState } from "react";

import { type PublishedText } from "../../reveal/published-text.js";
import { OutputHeightCut, type OutputOpening } from "../bodies/OutputHeightCut.js";
import { AnsiSpanParser, ansiSpanClassNames } from "./spans.js";

import "./AnsiOutput.css";

/** The tool output to render and the label a screen reader gives its block. */
export interface AnsiOutputProps {
  /** The tool's output, wire-verbatim, escape sequences and all, read through its handle. */
  readonly publishedText: PublishedText;
  /** What a screen reader calls this block. */
  readonly label: string;
  /** A call's output's opening, cut at the visible flow until opened; absent, drawn whole. */
  readonly opening?: OutputOpening | undefined;
  /** The bytes a running command's output holds so far; absent once it settled. */
  readonly liveByteLength?: number | undefined;
}

/** Renders ANSI-styled command output in one output box. */
export function AnsiOutput(props: AnsiOutputProps): React.JSX.Element {
  const publishedText = props.publishedText;
  const revision = publishedText.revision;
  const [parser] = useState(() => new AnsiSpanParser());
  const spans = useMemo(
    () => parser.read(publishedText),
    // The handle stays the same while a streaming output grows; its revision is what changed.
    [parser, publishedText, revision],
  );

  return (
    <OutputHeightCut
      className="meridian-ansi__body"
      label={props.label}
      opening={props.opening}
      liveByteLength={props.liveByteLength}
    >
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
    </OutputHeightCut>
  );
}
