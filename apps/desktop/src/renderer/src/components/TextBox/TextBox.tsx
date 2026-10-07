// A text box a person writes several lines in. The text area grows with its text and never
// scrolls; a box around it is the scroller, so its bar is drawn over the text like every other
// scroller's, which a text area cannot host. Typing past the box's height keeps the caret in
// view: the browser's caret reveal scrolls the box.
//
// The caller's edge, ground and rounded corners sit on a frame around the scroller, never on the
// scroller itself: Chromium cannot hit-test a point inside a scroller with rounded corners on its
// compositor, so every wheel turn and touch over one would wait for the main thread before it
// moved. The padding sits on the scroller, inside the frame, so the text still scrolls under it to
// the edge.
import "./TextBox.css";

import { useRef } from "react";

import { useDrawOverlayScrollbar } from "#renderer/hooks/useDrawOverlayScrollbar.js";

/** Props for `TextBox`: the box's classes and height, and everything a text area takes. */
export interface TextBoxProps extends Omit<
  React.ComponentProps<"textarea">,
  "className" | "rows" | "style" | "ref"
> {
  /**
   * The box's own classes: its edge, ground, corners and type, drawn on the frame around the
   * scroller. Its padding is `--meridian-text-box-padding`, which the scroller wears inside the
   * frame, and a `resize` it sets drags the scroller.
   */
  readonly className: string;
  /** Classes for the text area itself, such as one that colors its placeholder. */
  readonly fieldClassName?: string;
  /** The lines the box shows when it opens. */
  readonly rows: number;
  /**
   * When set, the box grows with its text from `rows` to this many lines and scrolls past them;
   * otherwise it keeps `rows` lines and scrolls past those.
   */
  readonly maxRows?: number;
  /** The text area itself, for a caller that puts the caret in it. */
  readonly fieldRef?: React.RefObject<HTMLTextAreaElement | null>;
  /** The box that scrolls, for a caller that measures how much of the text it shows. */
  readonly scrollerRef?: React.RefObject<HTMLDivElement | null>;
}

/** A multi-line text box that scrolls in its own box, measured in lines of its own text. */
export function TextBox(props: TextBoxProps): React.JSX.Element {
  const { className, fieldClassName, rows, maxRows, fieldRef, scrollerRef, ...fieldProps } = props;
  const ownFieldRef = useRef<HTMLTextAreaElement | null>(null);
  const textAreaRef = fieldRef ?? ownFieldRef;
  const ownScrollerRef = useRef<HTMLDivElement | null>(null);
  const boxScrollerRef = scrollerRef ?? ownScrollerRef;
  const scrollbarRef = useDrawOverlayScrollbar(boxScrollerRef);
  const sizeClassName = maxRows === undefined ? "" : " meridian-text-box--grows";
  const lines: TextBoxLines = {
    "--meridian-text-box-rows": String(rows),
    ...(maxRows === undefined ? {} : { "--meridian-text-box-max-rows": String(maxRows) }),
  };

  return (
    <div
      className={`meridian-text-box${sizeClassName} ${className}`}
      style={lines}
      onClick={(event) => {
        // The frame's edge and the scroller's padding lie outside the text area; a click there
        // still puts the caret in it. A click, not a press, so a press on the resize grip still
        // drags it.
        if (event.target === event.currentTarget || event.target === boxScrollerRef.current) {
          textAreaRef.current?.focus();
        }
      }}
    >
      <div ref={scrollbarRef} className="meridian-text-box__scroller">
        <textarea
          ref={textAreaRef}
          className={
            fieldClassName === undefined
              ? "meridian-text-box__field"
              : `meridian-text-box__field ${fieldClassName}`
          }
          {...fieldProps}
        />
      </div>
    </div>
  );
}

/** Carries the box's line counts into its sheet. */
interface TextBoxLines extends React.CSSProperties {
  readonly "--meridian-text-box-rows": string;
  readonly "--meridian-text-box-max-rows"?: string;
}
