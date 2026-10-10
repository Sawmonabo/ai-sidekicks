// A call's output as one preformatted box, cut at a quarter of the visible flow with the rest one
// press away, which draws it whole in place: `Show all` under a settled call's output, and under a
// running command's, which shows its last whole lines and follows each new one, `Show full output`
// with the size arrived so far. The cut is set by `useOutputHeightCut`; the box and its content are
// drawn here, the content in a block of its own so its whole height can be read while the box
// stops at the cut. Whether the output is opened is the feed's, so it outlives the row's mount.

import "./OutputHeightCut.css";

import { byteFigurePart } from "#renderer/lib/figure-sentence.js";
import { FullOutputControl } from "./FullOutputControl.js";
import { useOutputHeightCut } from "./hooks/useOutputHeightCut.js";

/** Whether a call's output was opened whole, and the press that opens it. */
export interface OutputOpening {
  readonly isOpened: boolean;
  /** Draws the output whole. */
  readonly open: () => void;
}

/** The output to draw, how it is styled, and whether it is cut. */
export interface OutputHeightCutProps {
  /** The box's own class, which sets the type the cut counts whole lines of. */
  readonly className: string;
  /**
   * A call's output's opening, cut at the visible flow until it is opened; absent, the output is
   * drawn whole.
   */
  readonly opening: OutputOpening | undefined;
  /**
   * The UTF-8 bytes a running command's output holds so far, which makes the cut its tail and its
   * control name the size; absent once the output settled.
   */
  readonly liveByteLength?: number | undefined;
  /** What a screen reader calls the box, where it names one. */
  readonly label?: string | undefined;
  /** The output's text, as elements or text nodes. */
  readonly children: React.ReactNode;
}

/** An output box cut at a share of the visible flow, with the rest one press away past the cut. */
export function OutputHeightCut(props: OutputHeightCutProps): React.JSX.Element {
  const { opening, liveByteLength } = props;
  const cut = useOutputHeightCut(opening !== undefined && !opening.isOpened);
  const cutClassName =
    liveByteLength !== undefined
      ? "meridian-output-cut__body--cut meridian-output-cut__body--tail"
      : "meridian-output-cut__body--cut";
  return (
    <div className="meridian-output-cut">
      <pre
        ref={cut.bodyRef}
        className={
          cut.cutHeightPx === undefined ? props.className : `${props.className} ${cutClassName}`
        }
        style={cut.cutHeightPx === undefined ? undefined : outputCutHeightOf(cut.cutHeightPx)}
        aria-label={props.label}
      >
        <span ref={cut.contentRef} className="meridian-output-cut__content">
          {props.children}
        </span>
      </pre>
      {cut.isCut && opening !== undefined ? (
        <FullOutputControl
          {...(liveByteLength === undefined
            ? {}
            : { measure: byteFigurePart("derived", liveByteLength) })}
          reading="rest"
          onPress={opening.open}
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
