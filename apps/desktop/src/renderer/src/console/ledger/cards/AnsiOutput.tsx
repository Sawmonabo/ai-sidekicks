// Command output — ANSI spans, rendered.
//
// `Spec-023 §Console Design (Meridian)` names command output as one of the tool card's
// bodies, under "#### The surface set". The whole of the styling decision lives in
// `ansi-spans.ts`; this component turns the spans it produced into elements and holds
// one piece of state, which is what keeps the mapper testable without a DOM and this
// file short enough to read.
//
// A `<pre>` and not a `<div>`: command output is preformatted by definition, and the
// element that says so is the one screen readers and copy-paste both already honour.
// The mono face comes from `cards.css`, which reads the same type token every wire
// figure in the console reads.
//
// THE FOLD IS RECOVERABLE, and that is the whole reason this component holds state.
// `ANSI_SPAN_RENDER_CAP` withholds the tail of a colour-heavy build log; reopening the
// card re-parses the same capped sequence, so a notice with no control would leave the
// tail of that log unreachable while the bound's own rationale claimed the reader was
// offered the rest. The control lifts the cap for this block, and the revealed cap is
// keyed to the source it was granted for — a body that changes underneath goes back to
// the default rather than inheriting a reveal the reader asked for about other bytes.

import { useMemo, useState } from "react";

import { Nothing, formatCount } from "../../primitives/index.js";
import { ansiSpanClassNames, parseAnsiSpans } from "./ansi-spans.js";
import { ANSI_SPAN_RENDER_CAP } from "./card-bounds.js";

export interface AnsiOutputProps {
  /** The tool's output, wire-verbatim, escape sequences and all. */
  readonly source: string;
  /** What a screen reader calls this block. */
  readonly label: string;
}

/** The cap this block is rendering under, and the source it was granted for. */
interface RevealedSpanCap {
  readonly source: string;
  readonly spanCap: number;
}

export function AnsiOutput(props: AnsiOutputProps): React.JSX.Element {
  const [revealed, setRevealed] = useState<RevealedSpanCap>({
    source: props.source,
    spanCap: ANSI_SPAN_RENDER_CAP,
  });
  // Derived during render rather than reset by an effect: an effect would paint the
  // previous source's reveal for one frame and then correct it, and a reader watching a
  // streaming body would see the tail flash in and out.
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
          // ONE SENTENCE CARRYING BOTH FIGURES, on `MachineBody`'s reasoning: the badge
          // renders `detail` as a `title` attribute, so the counts — which are the
          // substance of the notice rather than an elaboration of it — would reach a
          // reader only on hover, and neither touch nor keyboard hovers. The badge is
          // still the right shape, because the output it qualifies IS present.
          title={`Showing ${formatCount(spans.length)} styled runs; ${formatCount(elidedSpanCount)} more are not shown.`}
          action={
            <button
              type="button"
              // The ledger family's action-slot control, already the shape a `Nothing`
              // action takes in this family. A second class for one more control would
              // be the second styling of one decision.
              className="meridian-ledger-retry"
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
