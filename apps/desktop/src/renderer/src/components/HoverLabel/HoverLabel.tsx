// The app's one hover label, used for every hover text in place of the browser's title tooltip.
// This component only marks its trigger with the words; the window's one `WindowHoverLabel` draws
// the label, so a list of a thousand figures carries a thousand attributes, not a thousand
// tooltips.
//
// The drawn label is hidden from assistive technology, so its words are spoken once, by the one
// path `textRole` names: as the trigger's name, as its description through `aria-describedby`, or
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

/** The sides of its trigger a hover label can prefer. */
export const HOVER_LABEL_SIDES = ["top", "right", "bottom", "left"] as const;

/** The side of its trigger a hover label prefers; it flips when that side has no room. */
export type HoverLabelSide = (typeof HOVER_LABEL_SIDES)[number];

/** The trigger attribute holding a hover label's words, which the window's label reads. */
export const HOVER_LABEL_TEXT_ATTRIBUTE = "data-hover-label";

/** The trigger attribute holding the side a hover label prefers. */
export const HOVER_LABEL_SIDE_ATTRIBUTE = "data-hover-label-side";

/** Props for `HoverLabel`. */
export interface HoverLabelProps {
  /** The label's words; `undefined` or an empty string draws the trigger with no label. */
  readonly text: string | undefined;
  readonly textRole: HoverLabelTextRole;
  /** Defaults to `top`. */
  readonly side?: HoverLabelSide;
  /**
   * The one element the label belongs to. It passes the props it is handed onto its own element,
   * and sets no `aria-label` of its own when `textRole` is `name`.
   */
  readonly children: React.ReactElement<HoverLabelTriggerProps>;
}

/** A trigger's attributes: the words and side the window's label reads, and the spoken path. */
export interface HoverLabelTriggerProps {
  readonly [HOVER_LABEL_TEXT_ATTRIBUTE]?: string | undefined;
  readonly [HOVER_LABEL_SIDE_ATTRIBUTE]?: HoverLabelSide | undefined;
  readonly "aria-label"?: string | undefined;
  readonly "aria-describedby"?: string | undefined;
}

/** Draws `children` with the app's hover label of `text`, spoken once as `textRole` says. */
export function HoverLabel(props: HoverLabelProps): React.JSX.Element {
  const ownerWindow = useOwnerWindow();
  const descriptionId = useId();
  // An empty string draws no label: there are no words to show.
  const text = props.text === "" ? undefined : props.text;
  const isDescription = props.textRole === "description" && text !== undefined;
  // Only the keys this label sets: one it leaves unset keeps the trigger's own value, and one it
  // sets replaces it.
  const labelProps: HoverLabelTriggerProps =
    text === undefined
      ? {}
      : {
          [HOVER_LABEL_TEXT_ATTRIBUTE]: text,
          ...(props.side === undefined ? {} : { [HOVER_LABEL_SIDE_ATTRIBUTE]: props.side }),
          ...(props.textRole === "name" ? { "aria-label": text } : {}),
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
