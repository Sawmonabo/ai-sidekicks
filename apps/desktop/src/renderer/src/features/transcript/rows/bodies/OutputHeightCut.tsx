// A call's output as one preformatted box, cut at a quarter of the visible flow with the rest one
// press away, which draws it whole in place. The cut is set by `useOutputHeightCut`; the box and
// its content are drawn here, the content in a block of its own so its whole height can be read
// while the box stops at the cut.

import "./OutputHeightCut.css";

import { formatCount } from "#renderer/lib/wire/figures.js";
import { figurePart } from "#renderer/lib/figure-sentence.js";
import { FullOutputControl } from "./FullOutputControl.js";
import { useOutputHeightCut } from "./hooks/useOutputHeightCut.js";

/** The output to draw, how it is styled, and whether it is cut. */
export interface OutputHeightCutProps {
  /** The box's own class, which sets the type the cut counts whole lines of. */
  readonly className: string;
  /** Whether the output is a call's, cut at the visible flow; otherwise it is drawn whole. */
  readonly isCutAtFlowHeight: boolean;
  /** How many lines the program printed, read only while the cut is in force. */
  readonly readPrintedLineCount: () => number;
  /** What a screen reader calls the box, where it names one. */
  readonly label?: string | undefined;
  /**
   * Keep the press's control where it stands while the lines it opens grow below it, called
   * before they do; absent where the box is drawn outside a transcript's list.
   */
  readonly holdControlInPlace?: ((control: HTMLElement) => void) | undefined;
  /** The output's text, as elements or text nodes. */
  readonly children: React.ReactNode;
}

/** An output box cut at a share of the visible flow, with `Show full output` past the cut. */
export function OutputHeightCut(props: OutputHeightCutProps): React.JSX.Element {
  const cut = useOutputHeightCut(props.isCutAtFlowHeight);
  const lineCount = cut.isCut ? props.readPrintedLineCount() : 0;
  return (
    <div className="meridian-output-cut">
      <pre
        ref={cut.bodyRef}
        className={
          cut.cutHeightPx === undefined
            ? props.className
            : `${props.className} meridian-output-cut__body--cut`
        }
        style={cut.cutHeightPx === undefined ? undefined : outputCutHeightOf(cut.cutHeightPx)}
        aria-label={props.label}
      >
        <span ref={cut.contentRef} className="meridian-output-cut__content">
          {props.children}
        </span>
      </pre>
      {cut.isCut ? (
        <FullOutputControl
          measure={figurePart(
            "derived",
            `${formatCount(lineCount)} ${lineCount === 1 ? "line" : "lines"}`,
          )}
          reading="rest"
          onPress={(control) => {
            props.holdControlInPlace?.(control);
            cut.open();
          }}
        />
      ) : null}
    </div>
  );
}

/** Carries the cut's height, before it rounds down to whole lines, into the box's sheet. */
interface OutputCutHeight extends React.CSSProperties {
  readonly "--meridian-output-cut-height": string;
}

function outputCutHeightOf(cutHeightPx: number): OutputCutHeight {
  return { "--meridian-output-cut-height": `${String(cutHeightPx)}px` };
}
