// The app's one hover label, used for every hover text in place of the browser's title tooltip.
// This component only marks its trigger with the words; the window's one `HoverLabelHost` draws
// the label, so a list of a thousand figures carries a thousand attributes, not a thousand
// tooltips.
//
// The drawn label is hidden from assistive technology, so its words are spoken once, by the one
// path `textIs` names: as the trigger's name, as its description through `aria-describedby`, or
// not at all where the trigger already shows them. The description is a `hidden` element at the
// end of the window's body, always there, so it is read on focus and on a disabled control as
// well, and it adds nothing to the text or the shape of the trigger's own surroundings.

import { cloneElement, useId } from "react";
import { createPortal } from "react-dom";

import { useOwnerWindow } from "#renderer/hooks/useOwnerWindow.js";

/**
 * What a hover label's words are to assistive technology: `name`, the trigger's accessible name,
 * which the label writes as its `aria-label`; `description`, words the trigger does not say, such
 * as an exact figure under a formatted one; `visible-text`, the trigger's own text again, such as
 * a truncated path.
 */
export type HoverLabelTextRole = "name" | "description" | "visible-text";

/** The side of its trigger a hover label prefers; it flips when that side has no room. */
export type HoverLabelSide = "top" | "right" | "bottom" | "left";

/** Props for `HoverLabel`. */
export interface HoverLabelProps {
  /** The label's words; `undefined` draws the trigger with no label. */
  readonly text: string | undefined;
  readonly textIs: HoverLabelTextRole;
  /** Defaults to `top`. */
  readonly side?: HoverLabelSide;
  /**
   * The one element the label belongs to. It passes the props it is handed onto its own element,
   * and sets no `aria-label` of its own when `textIs` is `name`.
   */
  readonly children: React.ReactElement<HoverLabelTriggerProps>;
}

/** The attributes a trigger takes: the words and side the host reads, and the spoken path. */
export interface HoverLabelTriggerProps {
  readonly "data-hover-label"?: string | undefined;
  readonly "data-hover-label-side"?: HoverLabelSide | undefined;
  readonly "aria-label"?: string | undefined;
  readonly "aria-describedby"?: string | undefined;
}

/** Draws `children` with the app's hover label of `text`, spoken once as `textIs` says. */
export function HoverLabel(props: HoverLabelProps): React.JSX.Element {
  const ownerWindow = useOwnerWindow();
  const descriptionId = useId();
  const { text } = props;
  const isDescription = props.textIs === "description" && text !== undefined;
  // Only the keys that hold a value, so a trigger's own attribute is never written over.
  const labelProps: HoverLabelTriggerProps =
    text === undefined
      ? {}
      : {
          "data-hover-label": text,
          ...(props.side === undefined ? {} : { "data-hover-label-side": props.side }),
          ...(props.textIs === "name" ? { "aria-label": text } : {}),
          ...(isDescription ? { "aria-describedby": descriptionId } : {}),
        };
  return (
    <>
      {cloneElement(props.children, labelProps)}
      {isDescription
        ? createPortal(
            <span id={descriptionId} hidden>
              {text}
            </span>,
            ownerWindow.document.body,
          )
        : null}
    </>
  );
}
