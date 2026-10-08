// One answer on the approval card and, beside it, an arrow that opens the other ways to give the
// same answer, each row saying how far it reaches. With no arrow the answer stands alone. The face
// and its arrow are one control, so a card that withholds the answer removes both.

import { Button } from "@base-ui/react/button";
import { Menu } from "@base-ui/react/menu";

import { Glyph } from "#renderer/components/Glyph/Glyph.js";
import { OverlayMenuPopup } from "#renderer/components/OverlayPopups/OverlayMenuPopup.js";
import { GLYPH_SIZE_ROW } from "#renderer/styles/glyphs.js";
import { HoverLabel } from "#renderer/components/HoverLabel/HoverLabel.js";

/** One row behind the arrow: its words, and what pressing it answers. */
export interface ScopedAnswerRow {
  readonly label: string;
  /** True for the row that gives the face's own answer, which is drawn marked as the default. */
  readonly isFacePress: boolean;
  readonly onPress: () => void;
}

/** The arrow beside a face: its accessible name and the rows it opens. */
export interface ScopedAnswerArrow {
  readonly label: string;
  readonly rows: readonly ScopedAnswerRow[];
}

/** The face's words, look and press, and the arrow beside it, if the answer reaches further. */
export interface ScopedAnswerProps {
  readonly label: string;
  /** The classes the face wears; the arrow wears the same look. */
  readonly faceClassName: string;
  /** Which answer the face gives, for a reader that finds it on the card. */
  readonly answerName?: string | undefined;
  readonly isDisabled: boolean;
  readonly onPress: () => void;
  readonly arrow?: ScopedAnswerArrow | undefined;
}

/** The class every answer face on the card wears, which the row's arrow walk moves between. */
export const APPROVAL_CARD_ACTION_CLASS = "meridian-approval-card__action";

/** An answer button, with an arrow beside it where the answer can reach further. */
export function ScopedAnswer(props: ScopedAnswerProps): React.JSX.Element {
  const face = (
    <button
      type="button"
      className={`${APPROVAL_CARD_ACTION_CLASS} ${props.faceClassName}`}
      data-approval-answer={props.answerName}
      disabled={props.isDisabled}
      onClick={props.onPress}
    >
      {props.label}
    </button>
  );
  const { arrow } = props;
  if (arrow === undefined) {
    return face;
  }
  return (
    <span className="meridian-approval-card__split">
      {face}
      <Menu.Root>
        <HoverLabel text={arrow.label} textIs="name">
          <Menu.Trigger
            className={`meridian-approval-card__arrow ${props.faceClassName}`}
            disabled={props.isDisabled}
            // Disabled yet focusable, so the keyboard still reaches the arrow's name.
            render={<Button focusableWhenDisabled />}
          >
            <Glyph name="chevron-down" size={GLYPH_SIZE_ROW} />
          </Menu.Trigger>
        </HoverLabel>
        <OverlayMenuPopup className="meridian-approval-card__scope-menu">
          {arrow.rows.map((row) => (
            <Menu.Item
              key={row.label}
              className="meridian-approval-card__scope-row"
              onClick={row.onPress}
            >
              {row.label}
              {row.isFacePress ? <Glyph name="check" size={GLYPH_SIZE_ROW} /> : null}
            </Menu.Item>
          ))}
        </OverlayMenuPopup>
      </Menu.Root>
    </span>
  );
}
