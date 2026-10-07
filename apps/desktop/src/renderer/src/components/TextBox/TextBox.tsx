// A text box a person writes several lines in. The text area grows with its text and never
// scrolls; the box around it is the scroller, so its bar is drawn over the text like every other
// scroller's, which a text area cannot host. Typing past the box's height keeps the caret in
// view: the browser's caret reveal scrolls the box.
import "./TextBox.css";

import { useRef } from "react";

import { useOverlayScrollbar } from "#renderer/hooks/useOverlayScrollbar.js";

/** Props for `TextBox`: the box's classes and height, and everything a text area takes. */
export interface TextBoxProps extends Omit<
  React.ComponentProps<"textarea">,
  "className" | "rows" | "style" | "ref"
> {
  /** The box's own classes: its edge, ground, padding and type, drawn on the box that scrolls. */
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
}

/** A multi-line text box that scrolls in its own box, measured in lines of its own text. */
export function TextBox(props: TextBoxProps): React.JSX.Element {
  const { className, fieldClassName, rows, maxRows, fieldRef, ...fieldProps } = props;
  const ownFieldRef = useRef<HTMLTextAreaElement | null>(null);
  const textAreaRef = fieldRef ?? ownFieldRef;
  const boxRef = useOverlayScrollbar<HTMLDivElement>();
  const sizeClassName = maxRows === undefined ? "" : " meridian-text-box--grows";
  const lines: TextBoxLines = {
    "--meridian-text-box-rows": String(rows),
    ...(maxRows === undefined ? {} : { "--meridian-text-box-max-rows": String(maxRows) }),
  };

  return (
    <div
      ref={boxRef}
      className={`meridian-text-box${sizeClassName} ${className}`}
      style={lines}
      onClick={(event) => {
        // The box's padding lies outside the text area; a click there still puts the caret in it.
        // A click, not a press, so a press on the resize grip still drags it.
        if (event.target === event.currentTarget) {
          textAreaRef.current?.focus();
        }
      }}
    >
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
  );
}

/** Carries the box's line counts into its sheet. */
interface TextBoxLines extends React.CSSProperties {
  readonly "--meridian-text-box-rows": string;
  readonly "--meridian-text-box-max-rows"?: string;
}
